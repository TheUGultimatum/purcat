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

echo "[1/6] Updating package lists..."
$SUDO apt-get update -y

echo "[2/6] Installing system requirements..."
$SUDO apt-get install -y   ca-certificates curl git wget jq unzip   dbus dbus-x11 pciutils procps psmisc xvfb   fontconfig   libnss3 libnspr4   libatk1.0-0t64 libatk-bridge2.0-0t64   libcups2t64 libdrm2 libgbm1 libgtk-3-0t64   libx11-6 libx11-xcb1 libxcb1 libxcomposite1   libxdamage1 libxext6 libxfixes3 libxkbcommon0   libxrandr2 libxshmfence1 libxss1 libxtst6   libasound2t64   libvulkan1 libvulkan-dev vulkan-tools

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"

echo "[3/6] Installing Node.js..."
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi

echo "[4/6] Installing npm dependencies..."
npm install

echo "[5/6] Installing Chromium..."
npx playwright install chromium
npx playwright install-deps chromium || true

echo "[6/6] Checking runtime..."
chmod +x runner.js
node --check runner.js

echo
echo "PurrCat runtime installed successfully."
echo "Run: node runner.js"
echo "Auto-submit: PURRCAT_AUTO_SUBMIT=1 node runner.js"
