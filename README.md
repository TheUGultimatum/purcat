# PurrCat CLI Hunter

A single-GPU CLI automation project for the PurrCat hunt on HyperEVM.

> Status: research scaffold only. Contract and browser mining protocol still need to be verified from the live site before enabling any paid GPU mining or transaction submission.

## Network

HyperEVM mainnet:
- Chain ID: 999
- Native gas token: HYPE
- Default RPC: https://rpc.hyperliquid.xyz/evm

## Repository

https://github.com/TheUGultimatum/purcat

## Planned architecture

1. Inspect the PurrCat hunt frontend and reproduce its exact candidate-search algorithm.
2. Verify whether the work is CPU, WebGPU, WASM, or another browser workload.
3. Build a single-GPU worker first.
4. Measure correctness and hashrate on a cheap test instance.
5. Add local wallet signing/submission only after the winning flow is verified.
6. Add multi-GPU partitioning after single-GPU correctness is proven.

No private keys belong in this repository.
