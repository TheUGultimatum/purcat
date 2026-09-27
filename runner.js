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
const AUTO_SUBMIT = process.env.PURRCAT_AUTO_SUBMIT === '1';
const STATS_MS = Math.max(1000, Number(process.env.PURRCAT_STATS_INTERVAL || '5000'));

function die(message) {
  console.error('\nERROR: ' + message);
  process.exit(1);
}

function commandOutput(command, args) {
  const r = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return r.status === 0 ? r.stdout.trim() : '';
}

function gpuRows() {
  const out = commandOutput('nvidia-smi', [
    '--query-gpu=index,name,driver_version,utilization.gpu,temperature.gpu,power.draw,memory.used,memory.total',
    '--format=csv,noheader,nounits'
  ]);
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((line) => {
    const p = line.split(',').map((x) => x.trim());
    return { index:p[0], name:p[1], driver:p[2], util:p[3], temp:p[4], power:p[5], used:p[6], total:p[7] };
  });
}

function printGpu() {
  const rows = gpuRows();
  for (const g of rows) {
    console.log('[GPU'+g.index+'] '+g.name+' | util '+g.util+'% | temp '+g.temp+'C | power '+g.power+'W | VRAM '+g.used+'/'+g.total+' MiB | driver '+g.driver);
  }
  return rows;
}

function startXvfb() {
  if (process.env.DISPLAY) return null;
  const existing = commandOutput('pgrep', ['-f', 'Xvfb '+DISPLAY]);
  if (existing) { process.env.DISPLAY = DISPLAY; return null; }

  const xvfb = spawn('Xvfb', [
    DISPLAY,'-screen','0','1920x1080x24','-ac','+extension','GLX','+render','-noreset','-nolisten','tcp'
  ], { stdio:'ignore' });

  xvfb.on('error', (error) => die('Xvfb failed: '+error.message));
  process.env.DISPLAY = DISPLAY;
  return xvfb;
}

function providerScript(address) {
  return [
    '(() => {',
    'const account = '+JSON.stringify(address)+';',
    'const chainId = "0x3e7";',
    'const listeners = new Map();',
    'const emit = (event, value) => { for (const fn of listeners.get(event) || []) { try { fn(value); } catch {} } };',
    'const ethereum = {',
    '  isPurrCatCLI:true, isMetaMask:true, isRabby:true, chainId, selectedAddress:account||null, isConnected:()=>true,',
    '  request({method,params}) {',
    '    if (method==="eth_chainId") return Promise.resolve(chainId);',
    '    if (method==="net_version") return Promise.resolve("999");',
    '    if (method==="eth_accounts" || method==="eth_requestAccounts") { if (account) { this.selectedAddress=account; queueMicrotask(()=>emit("accountsChanged",[account])); } return Promise.resolve(account?[account]:[]); }',
    '    if (method==="eth_coinbase") return Promise.resolve(account||null);',
    '    if (method==="wallet_switchEthereumChain" || method==="wallet_addEthereumChain") { queueMicrotask(()=>emit("chainChanged",chainId)); return Promise.resolve(null); }',
    '    if (method==="wallet_getPermissions" || method==="wallet_requestPermissions") return Promise.resolve([]);',
    '    return window.__purrcat_rpc(method,params||[]);',
    '  },',
    '  on(event,fn) { if(!listeners.has(event)) listeners.set(event,[]); listeners.get(event).push(fn); return this; },',
    '  removeListener(event,fn) { listeners.set(event,(listeners.get(event)||[]).filter(x=>x!==fn)); return this; },',
    '  removeAllListeners(event) { if(event) listeners.delete(event); else listeners.clear(); return this; }',
    '};',
    'window.ethereum=ethereum;',
    'window.dispatchEvent(new Event("ethereum#initialized"));',
    'if(account) setTimeout(()=>{ emit("accountsChanged",[account]); emit("chainChanged",chainId); },0);',
    '})();'
  ].join('\n');
}

function gpuModuleWrapper() {
  return [
    '',
    '// CLI instrumentation wrapper',
    'export async function createGpuMiner(args = {}) {',
    '  const originalProgress = args.onProgress;',
    '  const originalFound = args.onFound;',
    '  const originalError = args.onError;',
    '  const miner = await createGpuMinerOriginal({',
    '    ...args,',
    '    onProgress(count) {',
    '      window.__purrcatHashCount = (window.__purrcatHashCount || 0) + Number(count || 0);',
    '      if (originalProgress) originalProgress(count);',
    '    },',
    '    onFound(hit) {',
    '      window.__purrcatFound = hit;',
    '      if (originalFound) originalFound(hit);',
    '    },',
    '    onError(error) {',
    '      window.__purrcatMinerError = String(error && error.message ? error.message : error);',
    '      if (originalError) originalError(error);',
    '    }',
    '  });',
    '  const originalSetJob = miner.setJob.bind(miner);',
    '  miner.setJob = (job) => {',
    '    window.__purrcatJob = { jobId:job?.jobId ?? null, targetHi:job?.targetHi ?? null, targetLo:job?.targetLo ?? null };',
    '    return originalSetJob(job);',
    '  };',
    '  window.__purrcatGpuMiner = miner;',
    '  return miner;',
    '}',
    ''
  ].join('\n');
}

async function attachGpuModuleInterceptor(context) {
  await context.route(/https:\/\/purrcat\.xyz\/miner\/gpu_miner\.js(?:\?.*)?$/i, async (route) => {
    try {
      const response = await route.fetch();
      let body = await response.text();
      const needle = 'export async function createGpuMiner({';
      if (body.includes(needle)) {
        body = body.replace(needle, 'async function createGpuMinerOriginal({');
        body += gpuModuleWrapper();
      }
      await route.fulfill({ response, body });
    } catch (error) {
      console.log('[ROUTE] gpu_miner.js intercept failed: '+error.message);
      await route.abort('failed');
    }
  });
}

async function webgpuInfo(page) {
  return page.evaluate(async () => {
    if (!navigator.gpu) return {available:false,adapter:null};
    const adapter = await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
    if (!adapter) return {available:true,adapter:null};
    return {available:true,adapter:{
      vendor:adapter.info?.vendor||null,
      architecture:adapter.info?.architecture||null,
      device:adapter.info?.device||null,
      description:adapter.info?.description||null
    }};
  });
}

function isNvidiaAdapter(info) {
  const t=JSON.stringify(info||{}).toLowerCase();
  return /nvidia|geforce|10de/.test(t) && !/swiftshader|llvmpipe|software/.test(t);
}

function profiles() {
  const common=[
    '--no-sandbox','--disable-dev-shm-usage','--enable-gpu','--ignore-gpu-blocklist',
    '--disable-software-rasterizer','--force_high_performance_gpu',
    '--use-webgpu-power-preference=high-performance','--enable-unsafe-webgpu',
    '--window-size=1440,900'
  ];
  return [
    common.concat(['--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan,UseOzonePlatform','--use-gl=angle','--use-angle=vulkan','--disable-vulkan-surface']),
    common.concat(['--enable-features=UseOzonePlatform','--use-gl=angle','--use-angle=gl']),
    common.concat(['--enable-features=UseOzonePlatform','--use-gl=egl'])
  ];
}

async function launchBrowser(address) {
  for (const [i,args] of profiles().entries()) {
    let browser=null;
    try {
      console.log('[GPU] Trying Chromium GPU profile '+(i+1));
      browser=await chromium.launch({
        headless:HEADLESS,
        executablePath:chromium.executablePath(),
        args:args.concat(HEADLESS?[]:['--ozone-platform=x11']),
        env:Object.assign({},process.env,{DISPLAY:process.env.DISPLAY||DISPLAY})
      });
      const context=await browser.newContext({viewport:{width:1440,height:900}});
      await context.addInitScript({content:providerScript(address)});
      await attachGpuModuleInterceptor(context);
      const page=await context.newPage();
      page.on('console',(msg)=>{const t=msg.text();if(/hash|mine|hunt|gpu|webgpu|nonce|difficulty|keccak|error|mint|wallet|job/i.test(t))console.log('[PAGE] '+t);});
      page.on('pageerror',(e)=>console.log('[PAGEERROR] '+e.message));
      await page.goto(SITE,{waitUntil:'domcontentloaded',timeout:120000});
      const gpu=await webgpuInfo(page);
      console.log('[WEBGPU] profile '+(i+1)+': '+JSON.stringify(gpu));
      if(gpu.available&&gpu.adapter&&isNvidiaAdapter(gpu.adapter)) return {browser,context,page,gpu,profile:i+1};
      await context.close().catch(()=>{});
      await browser.close().catch(()=>{});
    } catch(e) {
      console.log('[GPU] profile '+(i+1)+' failed: '+e.message);
      if(browser) await browser.close().catch(()=>{});
    }
  }
  die('No Chromium profile produced a hardware NVIDIA WebGPU adapter.');
}

async function installRpc(page,rpc,wallet,address) {
  await page.exposeFunction('__purrcat_rpc',async(method,params)=>{
    if(method==='eth_chainId') return CHAIN_HEX;
    if(method==='net_version') return '999';
    if(method==='eth_accounts'||method==='eth_requestAccounts') return address?[address]:[];
    if(method==='eth_coinbase') return address||null;
    if(method==='wallet_switchEthereumChain'||method==='wallet_addEthereumChain') return null;
    if(method==='eth_getBalance') { const b=await rpc.getBalance(params?.[0]||address,params?.[1]||'latest'); return '0x'+b.toString(16); }
    if(method==='eth_blockNumber') return '0x'+(await rpc.getBlockNumber()).toString(16);
    if(method==='eth_getCode') return rpc.getCode(params?.[0],params?.[1]||'latest');
    if(method==='eth_getTransactionCount') return '0x'+(await rpc.getTransactionCount(params?.[0]||address,params?.[1]||'latest')).toString(16);
    if(method==='eth_estimateGas') { const t=params?.[0]||{}; return '0x'+(await rpc.estimateGas({from:t.from,to:t.to,data:t.data,value:t.value})).toString(16); }
    if(method==='eth_call') { const t=params?.[0]||{}; return rpc.call({from:t.from,to:t.to,data:t.data,value:t.value},params?.[1]||'latest'); }
    if(method==='eth_gasPrice') { const f=await rpc.getFeeData(); return f.gasPrice?'0x'+f.gasPrice.toString(16):'0x0'; }
    if(method==='eth_maxPriorityFeePerGas') return '0x0';
    if(['eth_feeHistory','eth_getLogs','eth_getBlockByNumber','eth_getTransactionByHash','eth_getTransactionReceipt','web3_clientVersion'].includes(method)) return rpc.send(method,params||[]);

    if(method==='eth_sendTransaction') {
      if(!wallet||!AUTO_SUBMIT) throw new Error('Transaction signing disabled. Set PURRCAT_AUTO_SUBMIT=1.');
      const t={...(params?.[0]||{})};
      delete t.from;
      if(t.gas){t.gasLimit=BigInt(t.gas);delete t.gas;}
      const balance=await rpc.getBalance(address);
      const gasLimit=t.gasLimit||await rpc.estimateGas(t);
      const fee=await rpc.getFeeData();
      const gasPrice=fee.maxFeePerGas||fee.gasPrice||0n;
      const value=BigInt(t.value||0);
      const maxCost=value+gasLimit*gasPrice;
      console.log('[TX] balance='+ethers.formatEther(balance)+' HYPE | max='+ethers.formatEther(maxCost)+' HYPE');
      if(balance<maxCost) throw new Error('Insufficient HYPE for transaction plus gas.');
      const sent=await wallet.sendTransaction(t);
      console.log('[TX SENT] '+sent.hash);
      return sent.hash;
    }

    if(method==='personal_sign'||method==='eth_sign') {
      if(!wallet||!AUTO_SUBMIT) throw new Error('Signing disabled. Set PURRCAT_AUTO_SUBMIT=1.');
      const message=method==='personal_sign'?(params?.[0]||'0x'):(params?.[1]||'0x');
      return wallet.signMessage(ethers.getBytes(message));
    }

    if(method==='eth_signTypedData_v4'||method==='eth_signTypedData') {
      if(!wallet||!AUTO_SUBMIT) throw new Error('Typed-data signing disabled. Set PURRCAT_AUTO_SUBMIT=1.');
      const p=params||[];
      const typed=typeof p[p.length-1]==='string'?JSON.parse(p[p.length-1]):p[p.length-1];
      const types={...(typed?.types||{})};
      delete types.EIP712Domain;
      return wallet.signTypedData(typed?.domain||{},types,typed?.message||{});
    }

    if(method==='eth_sendRawTransaction') {
      if(!wallet||!AUTO_SUBMIT) throw new Error('Raw transaction submission disabled. Set PURRCAT_AUTO_SUBMIT=1.');
      return rpc.send(method,params||[]);
    }

    if(method.startsWith('eth_')||method.startsWith('net_')||method.startsWith('web3_')) return rpc.send(method,params||[]);
    throw new Error('Unsupported RPC method: '+method);
  });
}

async function main() {
  console.log('==============================================');
  console.log('        PURRCAT UNIVERSAL GPU RUNTIME');
  console.log('==============================================');

  const rows=printGpu();
  if(!rows.length) die('No NVIDIA GPU detected.');

  const privateKey=process.env.PURRCAT_PRIVATE_KEY||'';
  let address=process.env.PURRCAT_ADDRESS||'';
  let wallet=null;

  if(privateKey){
    if(!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) die('PURRCAT_PRIVATE_KEY format is invalid.');
    wallet=ethers.Wallet.fromPhrase ? null : null;
    wallet=new ethers.Wallet(privateKey);
    address=wallet.address;
    console.log('[WALLET] '+address);
  } else if(address) {
    if(!/^0x[0-9a-fA-F]{40}$/.test(address)) die('PURRCAT_ADDRESS is not a valid EVM address.');
    console.log('[WALLET] '+address);
  } else {
    die('Set PURRCAT_PRIVATE_KEY before starting.');
  }

  const rpc=new ethers.JsonRpcProvider(RPC_URL,CHAIN_ID,{staticNetwork:true});
  const network=await rpc.getNetwork();
  if(Number(network.chainId)!==CHAIN_ID) die('Wrong HyperEVM chain ID: '+network.chainId);

  if(wallet) wallet=wallet.connect(rpc);
  console.log('[WALLET] HYPE balance: '+ethers.formatEther(await rpc.getBalance(address))+' HYPE');
  console.log('[SUBMIT] '+(AUTO_SUBMIT?'ENABLED':'DISABLED'));

  const xvfb=HEADLESS?null:startXvfb();
  const launched=await launchBrowser(address);
  const {browser,context,page,gpu,profile}=launched;

  await installRpc(page,rpc,wallet,address);
  await page.reload({waitUntil:'domcontentloaded',timeout:120000});

  await page.evaluate(async()=>{
    try { if(window.ethereum) await window.ethereum.request({method:'eth_requestAccounts'}); } catch {}
  }).catch(()=>{});

  await page.waitForTimeout(8000);

  console.log('[RUN] WebGPU profile '+profile+' active on '+(gpu.adapter.vendor||'NVIDIA'));
  const clientText=await page.locator('body').innerText().catch(()=>'');
  console.log('[CLIENT] '+clientText.split('\n').map(x=>x.trim()).filter(Boolean).slice(0,14).join(' | '));

  let lastHashes=0;
  let lastAt=Date.now();

  const timer=setInterval(async()=>{
    try {
      const state=await page.evaluate(()=>({
        hashes:Number(window.__purrcatHashCount||0),
        job:window.__purrcatJob||null,
        found:window.__purrcatFound||null,
        error:window.__purrcatMinerError||null,
        miner:!!window.__purrcatGpuMiner
      }));

      const now=Date.now();
      const elapsed=Math.max(0.001,(now-lastAt)/1000);
      const rate=Math.max(0,Math.round((state.hashes-lastHashes)/elapsed));
      lastHashes=state.hashes;
      lastAt=now;

      console.log('\n[HASH] '+rate.toLocaleString()+' H/s | gpuMiner='+(state.miner?'ready':'waiting'));
      if(state.job) console.log('[JOB] '+JSON.stringify(state.job));
      else console.log('[JOB] waiting for the PurrCat client to assign work');
      if(state.found) console.log('[FOUND] '+JSON.stringify(state.found));
      if(state.error) console.log('[MINER ERROR] '+state.error);

      printGpu();
    } catch(error) {
      console.log('[STATS ERROR] '+error.message);
    }
  },STATS_MS);

  const stop=async()=>{
    clearInterval(timer);
    console.log('\nStopping...');
    await context.close().catch(()=>{});
    await browser.close().catch(()=>{});
    if(xvfb) xvfb.kill('SIGTERM');
    process.exit(0);
  };

  process.once('SIGINT',stop);
  process.once('SIGTERM',stop);
  await new Promise(()=>{});
}

main().catch(error=>die(error.stack||error.message));
