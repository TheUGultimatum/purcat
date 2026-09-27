# PurrCat Runtime

Terminal runtime for the PurrCat hunt client on HyperEVM.

## Network

- Chain ID: 999
- Native gas token: HYPE
- Default RPC: https://rpc.hyperliquid.xyz/evm

## Fresh VPS

```bash
git clone https://github.com/TheUGultimatum/purcat.git
cd purcat
chmod +x install.sh
./install.sh
node --check runner.js
```

## Run

Keep the key only in the current shell:

```bash
read -rsp "Enter private key: " PURRCAT_PRIVATE_KEY
echo
export PURRCAT_PRIVATE_KEY
```

Check the wallet balance and run:

```node runner.js```

For automatic transaction signing by the client:

```bash
export PURRCAT_AUTO_SUBMIT=1
node runner.js
```

No private keys belong in this repository.
