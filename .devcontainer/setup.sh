#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "=========================================================="
echo " [NFSU2-Web] Setting up Codespace environment..."
echo "=========================================================="

# 1. System packages
echo "[1/6] Checking system tools..."
sudo apt-get update -qq || true
sudo apt-get install -y -qq build-essential curl wget unzip p7zip-full python3-venv python3-pip || true

# 2. Rust toolchain
echo "[2/6] Checking Rust toolchain..."
if ! command -v cargo >/dev/null 2>&1; then
  echo "Installing Rust via rustup..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
fi

# 3. wasi-sdk 34
echo "[3/6] Checking wasi-sdk 34..."
mkdir -p deps
if [ ! -d deps/wasi-sdk-34.0-x86_64-linux ]; then
  echo "Downloading wasi-sdk 34 (Linux x86_64)..."
  wget -q --show-progress -c https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/wasi-sdk-34.0-x86_64-linux.tar.gz
  tar -xzf wasi-sdk-34.0-x86_64-linux.tar.gz -C deps/
  rm -f wasi-sdk-34.0-x86_64-linux.tar.gz
fi

# 4. Python virtual environment
echo "[4/6] Setting up Python lifter environment..."
if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
source .venv/bin/activate
pip install -q --upgrade pip
pip install -q -r requirements.txt

# 5. Web tools
echo "[5/6] Building web client..."
(cd web && npm ci --no-audit --no-fund)
(cd web && node build.mjs)

# 6. Check game files
echo "[6/6] Checking game assets..."
if [ ! -f "game/SPEED2.EXE" ] && [ -f "game.zip" ]; then
  echo "Found game.zip! Extracting to ./game..."
  mkdir -p game
  unzip -q -o game.zip -d game
fi

if [ -f "game/SPEED2.EXE" ]; then
  echo "Game files found in ./game! Building game module..."
  if [ ! -f "out/web/nfsu2.wasm" ]; then
    ./web/gen.sh game/SPEED2.EXE
    ./web/build.sh
  fi
  echo "Building Rust server..."
  ./web/server-rs/build.sh
  echo "Setup COMPLETE! You can run ./start-server.sh now."
else
  echo "----------------------------------------------------------"
  echo " NOTE: Game files not found yet in ./game/SPEED2.EXE"
  echo " To finish setup:"
  echo " 1. Drag and drop your 'game.zip' directly into this workspace"
  echo " 2. Run: ./start-server.sh"
  echo "----------------------------------------------------------"
fi
