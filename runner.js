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

function providerScript(address) {
  return `(() => {
    const account = ${JSON.stringify(address)};
    const chainId = '0x3e7';
    const listeners = new Map();

    function emit(event, payload) {
      for (const fn of listeners.get(event) || []) {
        try { fn(payload); } catch {}
      }
    }

    const ethereum = {
      isPurrCatCLI: true,
      isMetaMask: true,
      isRabby: true,
      chainId,
      selectedAddress: account || null,
      isConnected: () => true,

      request({method, params}) {
        if (method === 'eth_chainId') return Promise.resolve(chainId);
        if (method === 'net_version') return Promise.resolve('999');

        if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
          if (account) {
            this.selectedAddress = account;
            queueMicrotask(() => emit('accountsChanged', [account]));
          }
          return Promise.resolve(account ? [account] : []);
        }

        if (method === 'eth_coinbase') return Promise.resolve(account || null);

        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') {
          queueMicrotask(() => emit('chainChanged', chainId));
          return Promise.resolve(null);
        }

        if (method === 'wallet_getPermissions') return Promise.resolve([]);
        if (method === 'wallet_requestPermissions') return Promise.resolve([]);

        return window.__purrcat_rpc(method, params || []);
      },

      on(event, fn) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(fn);
        return this;
      },

      removeListener(event, fn) {
        listeners.set(event, (listeners.get(event) || []).filter(x => x !== fn));
        return this;
      },

      removeAllListeners(event) {
        if (event) listeners.delete(event);
        else listeners.clear();
        return this;
      }
    };

    window.ethereum = ethereum;
    window.dispatchEvent(new Event('ethereum#initialized'));

    if (account) {
      setTimeout(() => {
        emit('accountsChanged', [account]);
        emit('chainChanged', chainId);
      }, 0);
    }
  })()`;
}


async function installNetworkCapture(page) {
  await page.addInitScript({
    content: `
(() => {
  const captured = [];
  const MAX = 2000000;
  window.__purrcatNetwork = captured;

  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    const ws = protocols === undefined ? new OriginalWebSocket(url) : new OriginalWebSocket(url, protocols);
    try {
      ws.addEventListener('message', (event) => {
        if (typeof event.data === 'string') save(String(url), 101, event.data);
      });
    } catch {}
    return ws;
  };
  window.WebSocket.prototype = OriginalWebSocket.prototype;
  window.WebSocket.OPEN = OriginalWebSocket.OPEN;
  window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;
  window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
  window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;

  function save(url, status, text) {
    try {
      if (!text || text.length > MAX) return;
      if (/anchorHash|nonceHigh|targetHi|targetLo|difficulty|jobId|domain|contract/i.test(text)) {
        captured.push({url, status, text});
        if (captured.length > 80) captured.shift();
      }
    } catch {}
  }

  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const clone = response.clone();
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      clone.text().then(text => save(url, response.status, text)).catch(() => {});
    } catch {}
    return response;
  };

  const OriginalXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function() {
    const xhr = new OriginalXHR();
    xhr.addEventListener('load', function() {
      try { save(this.responseURL || '', this.status, String(this.responseText || '')); } catch {}
    });
    return xhr;
  };
  window.XMLHttpRequest.prototype = OriginalXHR.prototype;
})();
`
  });
}

async function discoverAndStartDirectMiner(page, address, externalCaptured = []) {
  return page.evaluate(async ({ address, externalCaptured }) => {
    const captured = [...(window.__purrcatNetwork || []), ...(externalCaptured || [])];
    const candidates = [];

    function walk(v) {
      if (!v || typeof v !== 'object' || candidates.length > 50) return;
      if (v.anchorHash && v.nonceHigh && (v.targetHi !== undefined || v.targetLo !== undefined || v.target !== undefined)) {
        candidates.push(v);
      }
      if (Array.isArray(v)) for (const x of v) walk(x);
      else for (const x of Object.values(v)) walk(x);
    }

    for (const entry of captured) {
      try { walk(JSON.parse(entry.text)); } catch {}
    }

    if (!candidates.length) {
      return {
        ok: false,
        reason: 'No complete mining job found',
        captured: captured.map(x => ({url:x.url,status:x.status,bytes:x.text?.length||0}))
      };
    }

    const raw = candidates[candidates.length - 1];
    const gpuMod = await import(new URL('/miner/gpu_miner.js?cli='+Date.now(), location.origin).href);
    const keccak = await import(new URL('/miner/keccak_core.js?cli='+Date.now(), location.origin).href);

    let targetBig = null;
    if (raw.target !== undefined && raw.target !== null) {
      try { targetBig = BigInt(String(raw.target)); } catch {}
    }

    const targetHi = raw.targetHi !== undefined
      ? Number(BigInt(String(raw.targetHi)) & 0xffffffffn) >>> 0
      : targetBig !== null
        ? Number((targetBig >> 224n) & 0xffffffffn) >>> 0
        : null;

    const targetLo = raw.targetLo !== undefined
      ? Number(BigInt(String(raw.targetLo)) & 0xffffffffn) >>> 0
      : targetBig !== null
        ? Number((targetBig >> 192n) & 0xffffffffn) >>> 0
        : null;

    if (targetHi === null || targetLo === null) {
      return { ok:false, reason:'Mining job found but targetHi/targetLo could not be derived', rawKeys:Object.keys(raw) };
    }

    const job = {
      jobId: String(raw.jobId ?? raw.id ?? Date.now()),
      prep: keccak.prepare({
        domain: raw.domain,
        chainId: raw.chainId ?? 999,
        contract: raw.contract,
        anchorHash: raw.anchorHash,
        miner: raw.miner ?? address,
        nonceHigh: raw.nonceHigh
      }),
      targetHi,
      targetLo
    };

    const miner = await gpuMod.createGpuMiner({
      onProgress: count => {
        window.__purrcatProgress = (window.__purrcatProgress || 0) + Number(count || 0);
        window.__purrcatLastProgressAt = performance.now();
      },
      onFound: hit => { window.__purrcatFound = hit; },
      onError: error => { window.__purrcatMinerError = String(error?.message || error); }
    });

    miner.setJob(job);
    window.__purrcatDirectMiner = miner;
    window.__purrcatDirectJob = job;

    return {
      ok: true,
      job: {jobId:job.jobId,targetHi:job.targetHi,targetLo:job.targetLo}
    };
  }, { address, externalCaptured });
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

      await context.route(/https:\/\/purrcat\.xyz\/miner\/gpu_miner\.js(?:\?.*)?$/i, async (route) => {
        try {
          const response = await route.fetch();
          let body = await response.text();

          const exportNeedle = 'export async function createGpuMiner({';
          const originalNeedle = 'async function createGpuMinerOriginal({';

          if (body.includes(exportNeedle)) {
            body = body.replace(exportNeedle, originalNeedle);

            const wrapper = [
              '',
              '// CLI instrumentation wrapper',
              'export async function createGpuMiner(args = {}) {',
              '  const originalProgress = args.onProgress;',
              '  const originalFound = args.onFound;',
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
              '      window.__purrcatMinerError = String(error?.message || error);',
              '      if (args.onError) args.onError(error);',
              '    }',
              '  });',
              '  const originalSetJob = miner.setJob.bind(miner);',
              '  miner.setJob = (job) => {',
              '    window.__purrcatJob = {',
              '      jobId: job?.jobId ?? null,',
              '      targetHi: job?.targetHi ?? null,',
              '      targetLo: job?.targetLo ?? null',
              '    };',
              '    return originalSetJob(job);',
              '  };',
              '  window.__purrcatGpuMiner = miner;',
              '  return miner;',
              '}',
              ''
            ].join('\\n');

            body += wrapper;
          }

          await route.fulfill({response, body});
        } catch (error) {
          await route.abort('failed');
        }
      });

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
  return `
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
  `;
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

  await context.addInitScript({content:providerScript(address)});

  // Re-load after the provider has been installed.
  page.on('console',msg=>{const t=msg.text();if(/hash|mine|hunt|gpu|webgpu|nonce|difficulty|keccak|error|mint|wallet/i.test(t))console.log('[PAGE] '+t)});
  page.on('pageerror',e=>console.log('[PAGEERROR] '+e.message));


  const externalNetwork = [];
  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (!/purrcat|hunt|job|mine|anchor|api/i.test(url)) return;
      const headers = response.headers();
      const ct = headers['content-type'] || '';
      if (!/json|text|javascript/i.test(ct)) return;
      const text = await response.text();
      if (!text || text.length > 3000000) return;

      if (/anchorHash|nonceHigh|targetHi|targetLo|target|jobId|difficulty/i.test(text)) {
        externalNetwork.push({url, status:response.status(), text});
        if (externalNetwork.length > 100) externalNetwork.shift();
        console.log('[NET] candidate payload: '+url+' ('+text.length+' bytes)');
      }
    } catch {}
  });

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
    if(method==='eth_sendTransaction'){
      if(!privateKey)throw new Error('No PURRCAT_PRIVATE_KEY configured.');
      if(process.env.PURRCAT_AUTO_SUBMIT !== '1')throw new Error('Transaction blocked. Set PURRCAT_AUTO_SUBMIT=1.');

      const t={...(params?.[0]||{})};
      delete t.from;
      if(t.gas){t.gasLimit=BigInt(t.gas);delete t.gas;}

      const balance=await rpc.getBalance(address);
      const estimate=await rpc.estimateGas(t);
      const fee=await rpc.getFeeData();
      const gasPrice=fee.maxFeePerGas||fee.gasPrice||0n;
      const value=BigInt(t.value||0);
      const worst=value+estimate*gasPrice;

      console.log('[TX] value '+ethers.formatEther(value)+' HYPE | max '+ethers.formatEther(worst)+' HYPE');

      if(balance<worst)throw new Error('Insufficient HYPE for transaction plus gas.');

      const wallet=new ethers.Wallet(privateKey,rpc);
      const sent=await wallet.sendTransaction(t);
      console.log('[TX SENT] '+sent.hash);
      return sent.hash;
    }

    if(method==='personal_sign'){
      if(!privateKey)throw new Error('No PURRCAT_PRIVATE_KEY configured.');
      if(process.env.PURRCAT_AUTO_SUBMIT !== '1')throw new Error('Signing blocked. Set PURRCAT_AUTO_SUBMIT=1.');
      const wallet=new ethers.Wallet(privateKey,rpc);
      const message=params?.[0]||'0x';
      return wallet.signMessage(ethers.getBytes(message));
    }

    if(method==='eth_sign'){
      if(!privateKey)throw new Error('No PURRCAT_PRIVATE_KEY configured.');
      if(process.env.PURRCAT_AUTO_SUBMIT !== '1')throw new Error('Signing blocked. Set PURRCAT_AUTO_SUBMIT=1.');
      const wallet=new ethers.Wallet(privateKey,rpc);
      return wallet.signMessage(ethers.getBytes(params?.[1]||'0x'));
    }

    if(method==='eth_signTypedData_v4'||method==='eth_signTypedData'){
      if(!privateKey)throw new Error('No PURRCAT_PRIVATE_KEY configured.');
      if(process.env.PURRCAT_AUTO_SUBMIT !== '1')throw new Error('Signing blocked. Set PURRCAT_AUTO_SUBMIT=1.');
      const wallet=new ethers.Wallet(privateKey,rpc);
      const p=params||[];
      const typed=typeof p[p.length-1]==='string'?JSON.parse(p[p.length-1]):p[p.length-1];
      const types={...(typed?.types||{})};
      delete types.EIP712Domain;
      return wallet.signTypedData(typed?.domain||{},types,typed?.message||{});
    }

    if(method==='eth_sendRawTransaction'){
      if(!privateKey)throw new Error('No PURRCAT_PRIVATE_KEY configured.');
      if(process.env.PURRCAT_AUTO_SUBMIT !== '1')throw new Error('Transaction blocked. Set PURRCAT_AUTO_SUBMIT=1.');
      return rpc.send(method,params||[]);
    }

    if(method.startsWith('net_')||method.startsWith('web3_')||method.startsWith('eth_'))return rpc.send(method,params||[]);
    throw new Error('Unsupported RPC method: '+method);
  });

  await page.reload({waitUntil:'domcontentloaded',timeout:120000});

  if (address) {
    await page.evaluate(async () => {
      try {
        if (window.ethereum) {
          await window.ethereum.request({method:'eth_requestAccounts'});
        }
      } catch (e) {
        console.log('[WALLET] request failed: ' + e.message);
      }
    }).catch(()=>{});
  }

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
  let directStarted = false;
  let progressBase = 0;
  let progressAt = Date.now();

  async function tryDirectStart() {
    if (!address || directStarted) return;
    try {
      const direct = await discoverAndStartDirectMiner(page, address, externalNetwork);
      if (direct.ok) {
        directStarted = true;
        console.log('[DIRECT] PurrCat WebGPU miner is running.');
        console.log('[DIRECT] Job: ' + JSON.stringify(direct.job));
      } else {
        console.log('[DIRECT] job not ready yet: ' + direct.reason);
        if (direct.captured?.length) console.log('[NET] Captured: ' + JSON.stringify(direct.captured.slice(-8)));
      }
    } catch (e) {
      console.log('[DIRECT] startup error: ' + e.message);
    }
  }

  await tryDirectStart();

  console.log('[RUN] Watching PurrCat client and GPU.');

  const startedAt=Date.now();
  const timer=setInterval(async()=>{
    try{
      if (!directStarted) await tryDirectStart();
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

      const snapshot = await page.evaluate(() => ({
        total: Number(window.__purrcatHashCount || 0),
        found: window.__purrcatFound || null,
        error: window.__purrcatMinerError || null,
        job: window.__purrcatJob || null,
        miner: !!window.__purrcatGpuMiner
      })).catch(() => null);

      if (snapshot) {
        const now = Date.now();
        const delta = Math.max(0, snapshot.total - progressBase);
        const rate = Math.round(delta / Math.max(0.001, (now - progressAt) / 1000));
        progressBase = snapshot.total;
        progressAt = now;

        console.log('[HASHRATE] '+rate.toLocaleString()+' H/s | GPU miner '+(snapshot.miner ? 'ready' : 'not created'));

        if (snapshot.job) console.log('[JOB] '+JSON.stringify(snapshot.job));
        else console.log('[JOB] waiting for PurrCat client to assign mining job');

        if (snapshot.found) console.log('[FOUND] '+JSON.stringify(snapshot.found));
        if (snapshot.error) console.log('[MINER ERROR] '+snapshot.error);
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
