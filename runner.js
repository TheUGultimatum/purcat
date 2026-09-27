#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const SITE = process.env.PURRCAT_SITE || 'https://purrcat.xyz/#hunt';
const DISPLAY = process.env.DISPLAY || ':99';
const HEADLESS = process.env.PURRCAT_HEADLESS === '1';
const AUTO_START = process.env.PURRCAT_AUTO_START !== '0';
const STATS_MS = Math.max(1000, Number(process.env.PURRCAT_STATS_INTERVAL || '5000'));
const ADDRESS = process.env.PURRCAT_ADDRESS || '';

function die(s) { console.error('\nERROR:', s); process.exit(1); }

function exec(command, args) {
  return spawnSync(command, args, { encoding:'utf8', stdio:['ignore','pipe','pipe'] });
}

function gpuRows() {
  const r = exec('nvidia-smi', [
    '--query-gpu=index,name,driver_version,utilization.gpu,temperature.gpu,power.draw,memory.used,memory.total',
    '--format=csv,noheader,nounits'
  ]);
  if (r.status !== 0 || !r.stdout.trim()) return [];
  return r.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const p = line.split(',').map((x) => x.trim());
    return {index:p[0],name:p[1],driver:p[2],util:p[3],temp:p[4],power:p[5],used:p[6],total:p[7]};
  });
}

function showGpu() {
  const rows = gpuRows();
  if (!rows.length) return rows;
  for (const g of rows) {
    console.log('[GPU'+g.index+'] '+g.name+' | util '+g.util+'% | temp '+g.temp+'C | power '+g.power+'W | VRAM '+g.used+'/'+g.total+' MiB');
  }
  return rows;
}

function startXvfb() {
  if (process.env.DISPLAY) return null;
  const already = exec('pgrep',['-f','Xvfb '+DISPLAY]);
  if (already.status === 0) { process.env.DISPLAY=DISPLAY; return null; }
  const p = spawn('Xvfb',[DISPLAY,'-screen','0','1440x900x24','-ac','+extension','GLX','+render','-noreset','-nolisten','tcp'],{stdio:'ignore'});
  p.on('error',(e)=>die('Xvfb: '+e.message));
  process.env.DISPLAY=DISPLAY;
  return p;
}

function providerScript(address) {
  return '(()=>{const account='+JSON.stringify(address)+',chainId="0x3e7",listeners=new Map();const ethereum={isPurrCatCLI:true,isMetaMask:true,chainId,selectedAddress:account||null,request({method}){if(method==="eth_chainId")return Promise.resolve(chainId);if(method==="net_version")return Promise.resolve("999");if(method==="eth_accounts"||method==="eth_requestAccounts")return Promise.resolve(account?[account]:[]);if(method==="eth_coinbase")return Promise.resolve(account||null);if(method==="wallet_switchEthereumChain"||method==="wallet_addEthereumChain")return Promise.resolve(null);if(method==="wallet_getPermissions")return Promise.resolve([]);throw new Error("CLI provider method not implemented: "+method)},on(event,fn){if(!listeners.has(event))listeners.set(event,[]);listeners.get(event).push(fn);return this},removeListener(event,fn){listeners.set(event,(listeners.get(event)||[]).filter(x=>x!==fn));return this}};window.ethereum=ethereum;window.dispatchEvent(new Event("ethereum#initialized"));})();';
}

async function webgpuInfo(page) {
  return page.evaluate(async()=>{
    if(!navigator.gpu)return {available:false,adapter:null};
    const a=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
    if(!a)return {available:true,adapter:null};
    return {available:true,adapter:{vendor:a.info?.vendor||null,architecture:a.info?.architecture||null,device:a.info?.device||null,description:a.info?.description||null}};
  });
}

function hardwareAdapter(info) {
  const s=JSON.stringify(info||{}).toLowerCase();
  return /nvidia|geforce|10de/.test(s)&&!/swiftshader|llvmpipe|software/.test(s);
}

async function clickConnect(page) {
  const buttons=page.locator('button'); const n=await buttons.count();
  for(let i=0;i<n;i++){
    const b=buttons.nth(i);
    if(!(await b.isVisible().catch(()=>false)))continue;
    const text=((await b.innerText().catch(()=>''))||'').trim();
    if(/connect wallet|connect/i.test(text)&&!/disconnect/i.test(text)){
      await b.click({force:true}).catch(async()=>b.evaluate(el=>el.click()));
      console.log('[WALLET] clicked: '+text);
      return true;
    }
  }
  return false;
}

async function clickStart(page) {
  const pattern=/start mining|start hunt|begin hunt|hunt|mine/i;
  const buttons=page.locator('button'); const n=await buttons.count();
  for(let i=0;i<n;i++){
    const b=buttons.nth(i);
    if(!(await b.isVisible().catch(()=>false)))continue;
    if(await b.isDisabled().catch(()=>true))continue;
    const text=((await b.innerText().catch(()=>''))||'').trim();
    if(!text||/connect|disconnect|wallet/i.test(text)||!pattern.test(text))continue;
    await b.click({force:true}).catch(async()=>b.evaluate(el=>el.click()));
    console.log('[RUN] clicked: '+text);
    return true;
  }
  return false;
}

async function main() {
  console.log('==============================================');
  console.log('           PURRCAT CLI RUNTIME');
  console.log('==============================================');

  if(!ADDRESS) console.log('[WALLET] PURRCAT_ADDRESS not set.');
  else console.log('[WALLET] '+ADDRESS);
  if(ADDRESS && !/^0x[0-9a-fA-F]{40}$/.test(ADDRESS)) die('PURRCAT_ADDRESS is not a valid EVM address.');

  const gpus=showGpu();
  if(!gpus.length)die('No NVIDIA GPU detected.');

  const xvfb=HEADLESS?null:startXvfb();

  const browser=await chromium.launch({
    headless:HEADLESS,
    executablePath:chromium.executablePath(),
    args:[
      '--no-sandbox','--disable-dev-shm-usage','--enable-gpu','--ignore-gpu-blocklist',
      '--disable-software-rasterizer','--force_high_performance_gpu',
      '--use-webgpu-power-preference=high-performance','--enable-unsafe-webgpu',
      '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan,UseOzonePlatform',
      '--use-angle=vulkan','--use-gl=angle','--disable-vulkan-surface',
      ...(HEADLESS?[]:['--ozone-platform=x11']),
      '--window-size=1440,900'
    ],
    env:{...process.env,DISPLAY:process.env.DISPLAY||DISPLAY}
  });

  const context=await browser.newContext({viewport:{width:1440,height:900}});
  if(ADDRESS)await context.addInitScript({content:providerScript(ADDRESS)});

  const page=await context.newPage();
  page.on('console',msg=>{const t=msg.text();if(/hash|mine|hunt|gpu|webgpu|nonce|difficulty|keccak|error|mint|wallet/i.test(t))console.log('[PAGE] '+t)});
  page.on('pageerror',e=>console.log('[PAGEERROR] '+e.message));

  await page.goto(SITE,{waitUntil:'domcontentloaded',timeout:120000});

  const gpu=await webgpuInfo(page);
  console.log('[WEBGPU] '+JSON.stringify(gpu));
  if(!gpu.available||!gpu.adapter)die('WebGPU adapter unavailable.');
  if(!hardwareAdapter(gpu.adapter))die('WebGPU adapter is not NVIDIA hardware.');

  await page.waitForTimeout(4000);

  if(ADDRESS){await clickConnect(page);await page.waitForTimeout(1500);}

  const before=await page.locator('body').innerText().catch(()=>'');
  console.log('[CLIENT] '+before.split(/\n/).map(s=>s.trim()).filter(Boolean).slice(0,12).join(' | '));

  if(AUTO_START){
    const started=await clickStart(page);
    if(!started)console.log('[RUN] No explicit start control; waiting for client auto-start.');
  }

  console.log('[RUN] Runtime active. Watching client + GPU.');

  const startedAt=Date.now();
  const timer=setInterval(async()=>{
    try{
      const body=await page.locator('body').innerText().catch(()=>'');
      const lines=body.split(/\n/).map(s=>s.trim()).filter(Boolean).filter(s=>/hashrate|H\/s|KH\/s|MH\/s|GH\/s|difficulty|expected|streak|found|won|error|mint|anchor|nonce/i.test(s)).slice(0,20);
      console.log('\n[STATS] uptime='+Math.floor((Date.now()-startedAt)/1000)+'s');
      if(lines.length)console.log(lines.join(' | '));
      showGpu();
    }catch(e){console.log('[STATS ERROR] '+e.message);}
  },STATS_MS);

  const stop=async()=>{
    clearInterval(timer);console.log('\nStopping...');
    await context.close().catch(()=>{});await browser.close().catch(()=>{});
    if(xvfb)xvfb.kill('SIGTERM');process.exit(0);
  };
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  await new Promise(()=>{});
}

main().catch(e=>die(e.stack||e.message));
