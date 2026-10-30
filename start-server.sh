#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo "=========================================================="
echo " Need for Speed: Underground 2 Web Server"
echo " 4-Player Multiplayer · Solid Collisions · Free Roam Hub"
echo "=========================================================="

# Check for game directory or zip
if [ ! -f "game/SPEED2.EXE" ]; then
  if [ -f "game.zip" ]; then
    echo "Found game.zip, extracting to ./game..."
    mkdir -p game
    unzip -q -o game.zip -d game
  else
    echo "No game found in ./game and no game.zip found."
    echo "Attempting automatic download from verified archive..."
    mkdir -p /tmp/nfsu2-iso game
    if [ ! -f "/tmp/nfsu2-iso/disk1.iso" ]; then
      echo "Downloading Disk 1..."
      curl -L -C - --progress-bar "https://archive.org/download/nfsug-2-disk-1_20251007/NFSUG2_DISK1.iso" -o /tmp/nfsu2-iso/disk1.iso
    fi
    if [ ! -f "/tmp/nfsu2-iso/disk2.iso" ]; then
      echo "Downloading Disk 2..."
      curl -L -C - --progress-bar "https://archive.org/download/nfsug-2-disk-1_20251007/NFSUG2_DISK2.iso" -o /tmp/nfsu2-iso/disk2.iso
    fi
    echo "Extracting ISO files..."
    7z x -y -o/tmp/nfsu2-iso/d1 /tmp/nfsu2-iso/disk1.iso >/dev/null
    7z x -y -o/tmp/nfsu2-iso/d2 /tmp/nfsu2-iso/disk2.iso >/dev/null
    echo "Copying game assets..."
    cp -r /tmp/nfsu2-iso/d1/* game/ 2>/dev/null || true
    cp -r /tmp/nfsu2-iso/d2/* game/ 2>/dev/null || true
    rm -rf /tmp/nfsu2-iso
  fi
fi

if [ ! -f "game/SPEED2.EXE" ]; then
  echo "ERROR: game/SPEED2.EXE not found!"
  echo "Please place the NFSU2 game files inside ./game or provide game.zip in root."
  exit 1
fi

# Ensure python venv
if [ -d ".venv" ]; then
  source .venv/bin/activate
fi

# Build WASM if missing
if [ ! -f "out/web/nfsu2.wasm" ]; then
  echo "Compiling WebAssembly module (first time only)..."
  ./web/gen.sh game/SPEED2.EXE
  ./web/build.sh
fi

# Build web frontend if needed
if [ ! -f "web/dist/main.js" ]; then
  echo "Building web client..."
  (cd web && node build.mjs)
fi

# Build server if needed
if [ ! -x "out/web/server-rs/nfsu2-server" ]; then
  echo "Building Rust server..."
  ./web/server-rs/build.sh
fi

echo "----------------------------------------------------------"
echo " SERVER READY!"
echo " In GitHub Codespaces, check the 'Ports' tab and make sure"
echo " Port 8080 visibility is set to 'Public'."
echo " Share that HTTPS link with your friends to play together!"
echo "----------------------------------------------------------"

exec ./web/start.sh --data "$ROOT/game" --http-port 8080
