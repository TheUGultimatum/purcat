#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [[ $EUID -eq 0 ]]; then
  SUDO=""
else
  SUDO="sudo"
fi

export DEBIAN_FRONTEND=noninteractive

$SUDO apt-get update
$SUDO apt-get install -y   ca-certificates curl git wget jq unzip   dbus dbus-x11 pciutils procps psmisc xvfb   fontconfig   libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0   libcups2 libdrm2 libgbm1 libgtk-3-0   libx11-6 libx11-xcb1 libxcb1 libxcomposite1   libxdamage1 libxext6 libxfixes3 libxkbcommon0   libxrandr2 libxshmfence1 libxss1 libxtst6   libasound2 libvulkan1 libvulkan-dev vulkan-tools

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"

if [[ "$NODE_MAJOR" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi

npm install
npx playwright install chromium
npx playwright install-deps chromium || true

chmod +x runner.js

echo
echo "PurrCat runtime installed."
echo "Syntax:  node --check runner.js"
echo "Run:     node runner.js"
echo "Submit:  PURRCAT_AUTO_SUBMIT=1 node runner.js"
