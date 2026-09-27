#!/usr/bin/env node
'use strict';

/*
 * PurrCat CLI runtime
 *
 * Terminal-only controller for the live PurrCat WebGPU client.
 * Chromium runs under Xvfb so no interactive desktop is required.
 * The runtime validates NVIDIA/WebGPU, loads the live hunt client,
 * starts the hunt control and prints GPU/client telemetry.
 */

const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const SITE = process.env.PURRCAT_SITE || 'https://purrcat.xyz/#hunt';
const DISPLAY = process.env.DISPLAY || ':99';
const STATS_MS = Math.max(
  1000,
  Number(process.env.PURRCAT_STATS_INTERVAL || '5000')
);
const START_PATTERN =
  process.env.PURRCAT_START_PATTERN ||
  'start mining|start hunt|start|hunt|mine';

const args = new Set(process.argv.slice(2));
const HEADLESS = args.has('--headless');
const DRY_RUN = args.has('--dry-run');

function die(message) {
  console.error('\nERROR:', message);
  process.exit(1);
}

function exec(command, argv) {
  return spawnSync(command, argv, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gpuRows() {
  const r = exec('nvidia-smi', [
    '--query-gpu=index,name,driver_version,utilization.gpu,temperature.gpu,power.draw,memory.used,memory.total',
    '--format=csv,noheader,nounits',
  ]);

  if (r.status !== 0 || !r.stdout.trim()) return [];

  return r.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const p = line.split(',').map((x) => x.trim());
      return {
        index: p[0],
        name: p[1],
        driver: p[2],
        util: p[3],
        temp: p[4],
        power: p[5],
        used: p[6],
        total: p[7],
      };
    });
}

function printGpuStats() {
  const rows = gpuRows();

  if (!rows.length) {
    console.log('[GPU] nvidia-smi unavailable');
    return rows;
  }

  for (const g of rows) {
    console.log(
      `[GPU${g.index}] ${g.name} | util ${g.util}% | ` +
        `temp ${g.temp}C | power ${g.power}W | ` +
        `VRAM ${g.used}/${g.total} MiB | driver ${g.driver}`
    );
  }

  return rows;
}

function startXvfb() {
  if (process.env.DISPLAY) return null;

  const existing = exec('pgrep', ['-f', `Xvfb ${DISPLAY}`]);
  if (existing.status === 0) {
    process.env.DISPLAY = DISPLAY;
    return null;
  }

  const xvfb = spawn(
    'Xvfb',
    [DISPLAY, '-screen', '0', '1440x900x24', '-nolisten', 'tcp'],
    { stdio: 'ignore' }
  );

  xvfb.on('error', (err) => {
    die(`Failed to start Xvfb: ${err.message}`);
  });

  process.env.DISPLAY = DISPLAY;
  return xvfb;
}

async function getWebGPUInfo(page) {
  return page.evaluate(async () => {
    if (!navigator.gpu) {
      return { available: false, adapter: null };
    }

    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    });

    if (!adapter) {
      return { available: true, adapter: null };
    }

    return {
      available: true,
      adapter: {
        vendor: adapter.info?.vendor || null,
        architecture: adapter.info?.architecture || null,
        device: adapter.info?.device || null,
        description: adapter.info?.description || null,
      },
    };
  });
}

function isHardwareNvidia(info) {
  const text = JSON.stringify(info || {}).toLowerCase();
  return (
    /nvidia|geforce|10de/.test(text) &&
    !/swiftshader|llvmpipe|software/.test(text)
  );
}

async function clickRunButton(page) {
  const pattern = new RegExp(START_PATTERN, 'i');
  const candidates = page.locator('button').filter({ hasText: pattern });
  const count = await candidates.count();

  for (let i = 0; i < count; i += 1) {
    const button = candidates.nth(i);

    if (!(await button.isVisible().catch(() => false))) continue;
    if (await button.isDisabled().catch(() => true)) continue;

    const text = ((await button.innerText().catch(() => '')) || '').trim();
    if (!text || /connect wallet/i.test(text)) continue;

    await button
      .click({ force: true })
      .catch(async () => button.evaluate((el) => el.click()));

    return text;
  }

  return null;
}

async function main() {
  console.log('==============================================');
  console.log('          PURRCAT CLI RUNTIME');
  console.log('==============================================');

  const gpus = printGpuStats();

  if (!gpus.length) {
    die('No NVIDIA GPU detected.');
  }

  console.log(`[GPU] Detected ${gpus.length} NVIDIA GPU(s).`);

  const xvfb = HEADLESS ? null : startXvfb();

  const browser = await chromium.launch({
    headless: HEADLESS,
    executablePath: chromium.executablePath(),
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--disable-software-rasterizer',
      '--force_high_performance_gpu',
      '--use-webgpu-power-preference=high-performance',
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,UseOzonePlatform',
      '--use-angle=vulkan',
      ...(HEADLESS ? [] : ['--ozone-platform=x11']),
      '--window-size=1440,900',
    ],
    env: {
      ...process.env,
      DISPLAY: process.env.DISPLAY || DISPLAY,
    },
  });

  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });

  const loadedAssets = new Set();

  page.on('request', (request) => {
    const url = request.url();

    if (
      /\/miner\/(?:gpu_miner|keccak_core)\.js(?:\?|$)/i.test(url) ||
      /\.wasm(?:\?|$)/i.test(url)
    ) {
      loadedAssets.add(url);
      console.log(`[ASSET] ${url}`);
    }
  });

  page.on('console', (msg) => {
    const text = msg.text();

    if (
      /hash|mine|hunt|gpu|webgpu|nonce|difficulty|keccak|error|mint/i.test(
        text
      )
    ) {
      console.log(`[PAGE] ${text}`);
    }
  });

  page.on('pageerror', (error) => {
    console.log(`[PAGEERROR] ${error.message}`);
  });

  console.log(`[SITE] ${SITE}`);
  console.log('[WEBGPU] Checking adapter...');

  await page.goto(SITE, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });

  const webgpu = await getWebGPUInfo(page);
  console.log(`[WEBGPU] ${JSON.stringify(webgpu)}`);

  if (!webgpu.available || !webgpu.adapter) {
    die('WebGPU adapter unavailable.');
  }

  if (!isHardwareNvidia(webgpu.adapter)) {
    die(
      'WebGPU is not reporting an NVIDIA hardware adapter. ' +
        'Refusing to run paid GPU compute on a software adapter.'
    );
  }

  await page.waitForTimeout(8000);

  const buttons = await page.locator('button').evaluateAll((elements) =>
    elements
      .map((button) => ({
        text: (button.innerText || '').trim(),
        visible: !!(
          button.offsetWidth ||
          button.offsetHeight ||
          button.getClientRects().length
        ),
        disabled: button.disabled,
      }))
      .filter((x) => x.visible)
  );

  console.log(`[UI] Buttons: ${JSON.stringify(buttons)}`);

  if (DRY_RUN) {
    console.log('[DRY-RUN] GPU/WebGPU verification passed.');
    console.log(`[DRY-RUN] Loaded compute assets: ${loadedAssets.size}`);

    await browser.close();
    if (xvfb) xvfb.kill('SIGTERM');
    return;
  }

  const clicked = await clickRunButton(page);

  if (!clicked) {
    die(
      'Could not find the PurrCat run button. ' +
        'Set PURRCAT_START_PATTERN to the exact visible button text.'
    );
  }

  console.log(`[RUNTIME] Started via button: ${clicked}`);
  console.log(
    '[RUNTIME] Terminal-only mode; Chromium is running under Xvfb.'
  );

  const startedAt = Date.now();

  const statsTimer = setInterval(async () => {
    try {
      const body = await page.locator('body').innerText().catch(() => '');

      const relevant = body
        .split(/\n/)
        .map((x) => x.trim())
        .filter((x) =>
          /hashrate|H\/s|KH\/s|MH\/s|GH\/s|difficulty|expected|streak|found|won|mint|error/i.test(
            x
          )
        )
        .slice(0, 20);

      const uptime = Math.floor((Date.now() - startedAt) / 1000);

      console.log(`\n[STATS] uptime=${uptime}s`);

      if (relevant.length) {
        console.log(relevant.join(' | '));
      }

      printGpuStats();
    } catch (error) {
      console.log(`[STATS ERROR] ${error.message}`);
    }
  }, STATS_MS);

  const shutdown = async () => {
    clearInterval(statsTimer);
    console.log('\nStopping PurrCat runtime...');

    await browser.close().catch(() => {});

    if (xvfb) xvfb.kill('SIGTERM');

    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await new Promise(() => {});
}

main().catch((error) => die(error.stack || error.message));
