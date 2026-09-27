# PurrCat Runtime

A lightweight CLI runtime for the PurrCat hunt client on HyperEVM.

## Network

- Chain ID: 999
- Native gas token: HYPE
- Default RPC: https://rpc.hyperliquid.xyz/evm

## Layout

The project is designed around a small terminal runner with the browser/WebGPU components kept separate from the command-line control layer.

## Setup

```bash
chmod +x install.sh
./install.sh
```

Run the local client with:

```bash
node runner.js
```

No private keys belong in this repository.

## Runtime

Use `runner.js` for the terminal GPU runtime.
