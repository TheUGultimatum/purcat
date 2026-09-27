#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const { ethers } = require('ethers');

const SITE = process.env.PURRCAT_SITE || 'https://purrcat.xyz/#hunt';
const RPC_URL = process.env.PURRCAT_RPC_URL || 'https://rpc.hyperliquid.xyz/evm';
const CHAIN_ID = 999;
const CHAIN_HEX = '0x3e7';
const DISPLAY = process.env.DISPLAY || ':99';
const HEADLESS = process.env.PURRCAT_HEADLESS === '1';
const AUTO_START = process.env.PURRCAT_AUTO_START !== '0';
const STATS_MS = Math.max(1000, Number(process.env.PURRCAT_STATS_INTERVAL || '5000'));

function die(s) {
  console.error('\nERROR:', s);
  process.exit(1);
}

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

async function rpcCall(method, params) {
  const res = await fetch(RPC_URL, {
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:params||[]})
  });
  if (!res.ok) throw new Error('RPC HTTP '+res.status);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
  return body.result;
}

function providerScript() {
  return `(() => {
    const rpc = (method, params) => window.__purrcat_rpc(method, params || []);
    const listeners = new Map();
    const ethereum = {
      isPurrCatCLI: true,
      isMetaMask: true,
      request({method, params}) { return rpc(method, params || []); },
      on(event, fn) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(fn);
        return this;
      },
      removeListener(event, fn) {
        listeners.set(event, (listeners.get(event) || []).filter(x => x !== fn));
        return this;
      }
    };
    window.ethereum = ethereum;
    window.dispatchEvent(new Event('ethereum#initialized'));
  })();`;
}

async function webgpuInfo(page) {
  return page.evaluate(async()=>{
    if(!navigator.gpu)return {available:false,adapter:null};
    const a=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
    if(!a)return {available:true,adapter:null};
    return {available:true,adapter:{
      vendor:a.info?.vendor||null,
      architecture:a.info?.architecture||null,
      device:a.info?.device||null,
      description:a.info?.description||null
    }};
  });
}

function hardwareAdapter(info) {
  const s=JSON.stringify(info||{}).toLowerCase();
  return /nvidia|geforce|10de/.test(s)&&!/swiftshader|llvmpipe|software/.test(s);
}

function chromiumProfiles() {
  const common = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--disable-software-rasterizer',
    '--force_high_performance_gpu',
    '--use-webgpu-power-preference=high-performance',
    '--enable-unsafe-webgpu',
    '--window-size=1440,900'
  ];

  return [
    [
      ...common,
      '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan,UseOzonePlatform',
      '--use-gl=angle',
      '--use-angle=vulkan',
      '--disable-vulkan-surface'
    ],
    [
      ...common,
      '--enable-features=UseOzonePlatform',
      '--use-gl=angle',
      '--use-angle=gl'
    ],
    [
      ...common,
      '--enable-features=UseOzonePlatform',
      '--use-gl=egl'
    ]
  ];
}

async function launchGpuBrowser() {
  const profiles = chromiumProfiles();

  for (let i=0;i<profiles.length;i++) {
    let browser;
    try {
      console.log('[GPU] Trying Chromium GPU profile '+(i+1)+'/'+profiles.length);
      browser = await chromium.launch({
        headless: HEADLESS,
        executablePath: chromium.executablePath(),
        args:[
          ...profiles[i],
          ...(HEADLESS ? [] : ['--ozone-platform=x11'])
        ],
        env:{...process.env,DISPLAY:process.env.DISPLAY||DISPLAY}
      });

      const context = await browser.newContext({viewport:{width:1440,height:900}});
      const page = await context.newPage();
      await page.goto(SITE,{waitUntil:'domcontentloaded',timeout:120000});

      const gpu = await webgpuInfo(page);
      console.log('[WEBGPU] profile '+(i+1)+': '+JSON.stringify(gpu));

      if (gpu.available && gpu.adapter && hardwareAdapter(gpu.adapter)) {
        return {browser,context,page,gpu,profile:i+1};
      }

      await context.close().catch(()=>{});
      await browser.close().catch(()=>{});
    } catch (e) {
      console.log('[GPU] profile '+(i+1)+' failed: '+e.message);
      if (browser) await browser.close().catch(()=>{});
    }
  }

  die('No Chromium profile produced a hardware NVIDIA WebGPU adapter.');
}

async function clickConnect(page) {
  const buttons=page.locator('button');
  const n=await buttons.count();
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
  const buttons=page.locator('button');
  const n=await buttons.count();
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


function gpuTelemetryScript() {
  return \`
(() => {
  const state = {
    attempts: 0,
    workgroups: 0,
    lastDispatchMs: 0,
    patched: false
  };

  window.__purrcatGpuTelemetry = state;

  const KEY = '__purrcatDispatchWrapped_v1';

  function patch() {
    try {
      const proto = globalThis.GPUComputePassEncoder &&
        globalThis.GPUComputePassEncoder.prototype;

      if (!proto || typeof proto.dispatchWorkgroups !== 'function') return;
      if (proto[KEY]) {
        state.patched = true;
        return;
      }

      const original = proto.dispatchWorkgroups;

      function wrapped(x = 1, y = 1, z = 1) {
        const groups = Math.max(1, Number(x) || 1) *
          Math.max(1, Number(y) || 1) *
          Math.max(1, Number(z) || 1);

        state.workgroups += groups;
        state.attempts += groups * 256;
        state.lastDispatchMs = performance.now();

        return original.call(this, x, y, z);
      }

      Object.defineProperty(wrapped, KEY, { value: true });

      try {
        Object.defineProperty(proto, 'dispatchWorkgroups', {
          configurable: true,
          writable: true,
          value: wrapped
        });
      } catch {
        proto.dispatchWorkgroups = wrapped;
      }

      state.patched = proto.dispatchWorkgroups === wrapped;
    } catch {}
  }

  patch();
  setInterval(patch, 50);
})();
  \`;
}

async function main() {
  console.log('==============================================');
  console.log('          PURRCAT UNIVERSAL GPU RUNTIME');
  console.log('==============================================');

  const gpus=showGpu();
  if(!gpus.length)die('No NVIDIA GPU detected.');

  const privateKey = process.env.PURRCAT_PRIVATE_KEY || '';
  let address = process.env.PURRCAT_ADDRESS || '';

  if (privateKey) {
    if(!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) die('PURRCAT_PRIVATE_KEY format is invalid.');
    address = new ethers.Wallet(privateKey).address;
    console.log('[WALLET] address derived from supplied private key: '+address);
  } else if(address) {
    if(!/^0x[0-9a-fA-F]{40}$/.test(address)) die('PURRCAT_ADDRESS is not a valid EVM address.');
    console.log('[WALLET] address: '+address);
  } else {
    console.log('[WALLET] No key/address supplied. Client may remain disconnected.');
  }

  const rpc = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, {staticNetwork:true});
  const network = await rpc.getNetwork();
  if(Number(network.chainId)!==CHAIN_ID)die('Wrong HyperEVM RPC chain id: '+network.chainId);
  if(address){
    console.log('[WALLET] HYPE balance: '+ethers.formatEther(await rpc.getBalance(address)));
  }

  const xvfb=HEADLESS?null:startXvfb();
  const launched=await launchGpuBrowser();
  const {browser,context,page,gpu,profile}=launched;

  await context.addInitScript({content:providerScript()});
  await context.addInitScript({content:gpuTelemetryScript()});

  // Re-load after the provider has been installed.
  page.on('console',msg=>{const t=msg.text();if(/hash|mine|hunt|gpu|webgpu|nonce|difficulty|keccak|error|mint|wallet/i.test(t))console.log('[PAGE] '+t)});
  page.on('pageerror',e=>console.log('[PAGEERROR] '+e.message));

  await page.exposeFunction('__purrcat_rpc', async (method, params) => {
    if(method==='eth_chainId')return CHAIN_HEX;
    if(method==='net_version')return String(CHAIN_ID);
    if(method==='eth_accounts'||method==='eth_requestAccounts')return address?[address]:[];
    if(method==='eth_coinbase')return address||null;
    if(method==='wallet_switchEthereumChain'||method==='wallet_addEthereumChain')return null;
    if(method==='eth_getBalance')return rpc.getBalance(params?.[0]||address,params?.[1]||'latest').then(x=>'0x'+x.toString(16));
    if(method==='eth_blockNumber')return rpc.getBlockNumber().then(x=>'0x'+x.toString(16));
    if(method==='eth_gasPrice')return rpc.getFeeData().then(x=>x.gasPrice?'0x'+x.gasPrice.toString(16):'0x0');
    if(method==='eth_getCode')return rpc.getCode(params?.[0],params?.[1]||'latest');
    if(method==='eth_getTransactionCount')return rpc.getTransactionCount(params?.[0]||address,params?.[1]||'latest').then(x=>'0x'+x.toString(16));
    if(method==='eth_estimateGas'){
      const t=params?.[0]||{};
      return rpc.estimateGas({from:t.from,to:t.to,data:t.data,value:t.value}).then(x=>'0x'+x.toString(16));
    }
    if(method==='eth_call'){
      const t=params?.[0]||{};
      return rpc.call({from:t.from,to:t.to,data:t.data,value:t.value},params?.[1]||'latest');
    }
    if(method==='eth_getLogs')return rpc.send('eth_getLogs',params||[]);
    if(method==='eth_feeHistory')return rpc.send('eth_feeHistory',params||[]);
    if(method==='eth_getBlockByNumber')return rpc.send('eth_getBlockByNumber',params||[]);
    if(method==='eth_getTransactionByHash')return rpc.send('eth_getTransactionByHash',params||[]);
    if(method==='eth_getTransactionReceipt')return rpc.send('eth_getTransactionReceipt',params||[]);
    if(method==='web3_clientVersion')return rpc.send('web3_clientVersion',params||[]);
    if(method.startsWith('net_')||method.startsWith('web3_')||method.startsWith('eth_'))return rpc.send(method,params||[]);
    throw new Error('Unsupported RPC method: '+method);
  });

  await page.reload({waitUntil:'domcontentloaded',timeout:120000});

  await page.waitForTimeout(4000);

  if(address){
    await clickConnect(page);
    await page.waitForTimeout(1500);
  }

  const body=await page.locator('body').innerText().catch(()=>'');
  console.log('[CLIENT] '+body.split(/\n/).map(s=>s.trim()).filter(Boolean).slice(0,14).join(' | '));

  if(AUTO_START){
    const started=await clickStart(page);
    if(!started)console.log('[RUN] No explicit start control; waiting for the client to auto-start.');
  }

  console.log('[RUN] WebGPU profile '+profile+' active on '+gpu.adapter.vendor+' '+(gpu.adapter.architecture||''));
  console.log('[RUN] Watching PurrCat client and GPU.');

  const startedAt=Date.now();
  const timer=setInterval(async()=>{
    try{
      const text=await page.locator('body').innerText().catch(()=>'');
      const lines=text.split(/\n/).map(s=>s.trim()).filter(Boolean).filter(s=>/hashrate|H\/s|KH\/s|MH\/s|GH\/s|difficulty|expected|streak|found|won|mint|anchor|nonce|error/i.test(s)).slice(0,20);
      console.log('\n[STATS] uptime='+Math.floor((Date.now()-startedAt)/1000)+'s');
      if(lines.length)console.log(lines.join(' | '));
      const telemetry = await page.evaluate(() => {
        const t = window.__purrcatGpuTelemetry;
        if (!t) return null;
        return {
          attempts: t.attempts,
          workgroups: t.workgroups,
          patched: t.patched,
          lastDispatchMs: t.lastDispatchMs
        };
      }).catch(() => null);

      if (telemetry) {
        const nowAttempts = Number(telemetry.attempts || 0);
        const previousAttempts = Number(page.__purrcatLastAttempts || 0);
        const elapsedSec = Math.max(0.001, (Date.now() - Number(page.__purrcatLastSample || Date.now())) / 1000);
        const rate = Math.max(0, Math.round((nowAttempts - previousAttempts) / elapsedSec));
        page.__purrcatLastAttempts = nowAttempts;
        page.__purrcatLastSample = Date.now();

        console.log('[HASHRATE] ' + rate.toLocaleString() + ' H/s | dispatch wrapper ' + (telemetry.patched ? 'active' : 'inactive'));

        if (rate === 0 && telemetry.patched) {
          console.log('[HASHRATE] No GPU compute dispatches observed in the last interval.');
        }
      }

      showGpu();
    }catch(e){console.log('[STATS ERROR] '+e.message);}
  },STATS_MS);

  const stop=async()=>{
    clearInterval(timer);
    console.log('\nStopping...');
    await context.close().catch(()=>{});
    await browser.close().catch(()=>{});
    if(xvfb)xvfb.kill('SIGTERM');
    process.exit(0);
  };
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  await new Promise(()=>{});
}

main().catch(e=>die(e.stack||e.message));
