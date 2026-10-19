#!/bin/bash
# Builds the bundle that runs the server on a VPS (docs/web/VPS.md):
#
#   web/deploy/pack.sh [--out <dir>] [--no-build] [--data "<game folder>"]
#
# out/web/deploy/nfsu2-web-<rev>.tar.gz holds nfsu2-web/ with
#   web/server/       the server (server.mjs, headers.mjs, lan.mjs, cloudflare-ips.txt, online/*.mjs: the
#                     game's Online mode)
#   web/node_modules/ its one dependency (ws), copied from this checkout; web/package.json
#   web/dist/         the page (the test pages and source maps are in web/dist-dev, never copied)
#   out/web/          the game module (nfsu2.wasm, nfsu2.json), built here with web/build.sh
#   deploy/           nfsu2-web.service (systemd), Caddyfile (an example), cloudflared.yml (an example)
#   README.md         the short version of docs/web/VPS.md
# and NEVER the game folder or anything from it: the files are copied from a
# fixed list, and the bundle is refused if any file in it has the name and size
# of a file in the game folder (--data, else $NFSU2_DATA, when it is there),
# carries the game's file names, or names this machine (host name, home folder).
# The archive's owner is root, its modes 644/755, without macOS metadata.
# --no-build: use web/dist as it is (default: rebuild it with node build.mjs).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/out/web/deploy" BUILD=1 DATA="${NFSU2_DATA:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    --data) DATA="$2"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "pack.sh: unknown option $1"; exit 2 ;;
  esac
done
[ -z "$DATA" ] && [ -d "$HOME/projects/nsfu2/Need for Speed - Underground 2" ] && DATA="$HOME/projects/nsfu2/Need for Speed - Underground 2"
cd "$ROOT"
REV="$(git rev-parse --short HEAD)$(git diff --quiet HEAD -- web/server web/src web/index.html 2>/dev/null || echo +)"
[ -f out/web/nfsu2.wasm ] && [ -f out/web/nfsu2.json ] || { echo "no game module: build it first (web/build.sh)"; exit 1; }
[ -f web/node_modules/ws/package.json ] || { echo "no web/node_modules/ws: cd web && npm ci"; exit 1; }
if [ "$BUILD" = 1 ]; then (cd web && node build.mjs >/dev/null 2>&1) || { echo "the page did not build (cd web && node build.mjs)"; exit 1; }; fi

STAGE="$OUT/stage"
rm -rf "$STAGE"; mkdir -p "$STAGE/nfsu2-web"
B="$STAGE/nfsu2-web"
mkdir -p "$B/web/server/online" "$B/web/node_modules" "$B/out/web" "$B/deploy"
# ---- the fixed list ----
cp web/server/server.mjs web/server/headers.mjs web/server/lan.mjs web/server/cloudflare-ips.txt "$B/web/server/"
cp web/server/online/*.mjs "$B/web/server/online/"
cp -R web/node_modules/ws "$B/web/node_modules/ws"
WS_VERSION="$(node -p "require('./web/node_modules/ws/package.json').version")"
cat > "$B/web/package.json" <<JSON
{ "name": "nfsu2-web-server", "private": true, "type": "module", "dependencies": { "ws": "$WS_VERSION" } }
JSON
# the page: everything web/dist has (node build.mjs puts the test pages and source maps in web/dist-dev;
# they are left out here too, should an older build have left them in web/dist)
(cd web/dist && find . -type f ! -path './test/*' ! -name '*.map' -print) | while read -r f; do
  mkdir -p "$B/web/dist/$(dirname "$f")"; cp "web/dist/$f" "$B/web/dist/$f"
done
cp out/web/nfsu2.wasm out/web/nfsu2.json "$B/out/web/"
cp web/deploy/nfsu2-web.service web/deploy/Caddyfile web/deploy/cloudflared.yml "$B/deploy/"
cp web/deploy/README.md "$B/README.md"

# ---- refusals ----
fail() { echo "pack.sh: REFUSED: $*"; rm -rf "$STAGE"; exit 1; }
[ -z "$(find "$B" -type l -print -quit)" ] || fail "a symbolic link in the bundle"
GAME_NAMES='(^|/)SPEED2\.EXE$|\.(BUN|BIN|LZC|VIV|MUS|ASF|VP6|ABK|GIN|CSI|MPF|AUD|LZW|DLL|EXE)$'
bad="$(cd "$B" && find . -type f | grep -iE "$GAME_NAMES" || true)"
[ -z "$bad" ] || fail "game file names: $bad"
if [ -n "$DATA" ] && [ -d "$DATA" ]; then
  # name + size of every game file against every bundle file
  node -e '
    const fs = require("fs"), path = require("path");
    const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, out); else if (e.isFile()) out.push(p); } return out; };
    const game = new Set(walk(process.argv[1]).map(p => path.basename(p).toLowerCase() + ":" + fs.statSync(p).size));
    const hit = walk(process.argv[2]).filter(p => game.has(path.basename(p).toLowerCase() + ":" + fs.statSync(p).size));
    if (hit.length) { console.log(hit.join("\n")); process.exit(1); }' "$DATA" "$B" || fail "files that match the game folder"
  echo "checked against the game folder: no file of it is in the bundle"
  # what the server leaves out of the game folder (server.mjs GAME_ENTRIES): copy only the rest to the VPS
  others="$(node -e '
    const fs = require("fs");
    const m = /const GAME_ENTRIES = \[([^\]]*)\]/.exec(fs.readFileSync(process.argv[2], "utf8"));
    if (!m) process.exit(0);
    const keep = new Set([...m[1].matchAll(/'"'"'([^'"'"']+)'"'"'/g)].map(x => x[1]));
    console.log(fs.readdirSync(process.argv[1]).filter(n => !n.startsWith(".") && !keep.has(n.toLowerCase())).join(", "));' "$DATA" web/server/server.mjs)"
  [ -z "$others" ] || echo "NOTE: the server serves only the game's own files; these of your game folder it never serves (leave them off the VPS): $others"
fi
HOSTNAME_SHORT="$(hostname | sed 's/\.local$//')"
for needle in "$HOME" "$HOSTNAME_SHORT"; do
  hit="$(grep -rlaF "$needle" "$B" || true)"
  [ -z "$hit" ] || fail "names this machine ($needle) in: $hit"
done
SIZE_MB=$(( $(du -sk "$B" | cut -f1) / 1024 ))
[ "$SIZE_MB" -lt 200 ] || fail "$SIZE_MB MB: more than the server, the page and the module"

# ---- the archive ----
find "$B" -type d -exec chmod 755 {} +; find "$B" -type f -exec chmod 644 {} +
mkdir -p "$OUT"
TGZ="$OUT/nfsu2-web-$REV.tar.gz"
COPYFILE_DISABLE=1 tar -C "$STAGE" --no-mac-metadata --no-xattrs --uid 0 --gid 0 --uname root --gname root -czf "$TGZ" nfsu2-web
rm -rf "$STAGE"
echo "$TGZ"
echo "  $(du -h "$TGZ" | cut -f1), $(tar -tzf "$TGZ" | grep -vc '/$') files, sha256 $(shasum -a 256 "$TGZ" | cut -d' ' -f1)"
