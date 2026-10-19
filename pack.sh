#!/bin/bash
# Build out/NFSU2.app from the linked binary.
#
#   ./pack.sh [--exe <SPEED2.EXE>] [--install [<dir>]]
#
# The separate "NFSU2 HD.app" is retired: its features that held up in the
# measurements (MSAA, the larger mirror, anisotropic filtering) are options
# of NFSU2.app, off by default (settings.ini "graphics = enhanced" or the
# single keys).  Its larger road reflection, ray-traced reflections and SSR
# stay in the unshipped research build (./link.sh hd -> out/nfsu2_hd_boot).
#
# The app holds only the port.  It runs against the user's own game folder,
# which it asks for on first launch and never writes to; registry, saves and
# settings live in ~/Library/Application Support/NFSU2, logs in
# ~/Library/Logs/NFSU2.
#
# The icon is made at build time from SPEED2.EXE's own icon resource, so the
# exe is needed here: --exe, else $NFSU2_DATA, else game_folder from the
# user's settings.ini, else the work/gamedata clone next to the checkout.
# --install copies the finished app to <dir> (default ~/Applications).
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"; cd "$ROOT"

EXE=""; INSTALL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --hd)      echo "pack.sh --hd: the HD app is retired; NFSU2.app has the graphics options"
               echo "  (settings.ini: graphics = enhanced)."
               echo "  The research build out/nfsu2_hd_boot (./link.sh hd) is not packaged."
               exit 1 ;;
    --exe)     EXE="$2"; shift ;;
    --install) INSTALL="$HOME/Applications"
               case "$2" in ""|--*) ;; *) INSTALL="$2"; shift ;; esac ;;
    *) echo "unknown option: $1"; exit 1 ;;
  esac
  shift
done

BIN="$ROOT/out/nfsu2_boot"; NAME="NFSU2"; DISP="Need for Speed Underground 2"
BID="org.nfsu2.nativeport"
[ -x "$BIN" ] || { echo "build first: ./build.sh && ./link.sh  ($BIN missing)"; exit 1; }

# arm64 only: the lifted code is AArch64 C, there is no x86 slice to fall
# back to (and Rosetta is not involved anywhere).
# LAN hosting needs server.dll lifted into the binary (gen.sh did that if the
# game folder it was given had server.dll; the app never contains the DLL
# itself and loads the user's own copy, checked by SHA-256, at run time).
ls "$ROOT"/gen/server/shard_*.c >/dev/null 2>&1 \
  || echo "warning: gen/server has no lifted server.dll: hosting a LAN game will not be available in this app"
ARCHS="$(lipo -archs "$BIN")"
[ "$ARCHS" = "arm64" ] || { echo "expected an arm64-only binary, got: $ARCHS"; exit 1; }
# LSMinimumSystemVersion = the deployment target the binary was linked with
# (build.sh / link.sh MINOS), read back from its LC_BUILD_VERSION.
MINOS="$(otool -l "$BIN" | awk '/LC_BUILD_VERSION/{f=1} f&&$1=="minos"{print $2; exit}')"
[ -n "$MINOS" ] || { echo "cannot read the deployment target of $BIN"; exit 1; }

# SPEED2.EXE for the icon
if [ -z "$EXE" ]; then
  if [ -n "$NFSU2_DATA" ]; then
    if [ -d "$NFSU2_DATA" ]; then EXE="$NFSU2_DATA/SPEED2.EXE"; else EXE="$NFSU2_DATA"; fi
  else
    INI="${NFSU2_APPSUPPORT:-$HOME/Library/Application Support/NFSU2}/settings.ini"
    # "|| true": without a settings.ini (before the first launch) the test
    # fails, and under set -e a failing $(...) in an assignment ends the script.
    GF="$( [ -f "$INI" ] && sed -n 's/^[[:space:]]*game_folder[[:space:]]*=[[:space:]]*//p' "$INI" | tail -1 || true)"
    for d in "$GF" "$ROOT/../../gamedata" "$ROOT/../../work/gamedata"; do
      [ -n "$d" ] && [ -f "$d/SPEED2.EXE" ] && { EXE="$d/SPEED2.EXE"; break; }
    done
  fi
fi

OUTDIR="$ROOT/out"
APP="$OUTDIR/$NAME.app"
rm -rf "$APP"
# An "NFSU2 HD.app" left in out/ by an earlier pack.sh --hd is build output
# of the retired HD app (its research binary would still run SSR and ray
# tracing by default): remove it, so out/ holds only the app this builds.
if [ -d "$OUTDIR/NFSU2 HD.app" ]; then
  rm -rf "$OUTDIR/NFSU2 HD.app"
  echo "removed the retired out/NFSU2 HD.app (build output of pack.sh --hd before the HD app was retired)"
fi
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/NFSU2"
chmod +x "$APP/Contents/MacOS/NFSU2"
printf 'APPL????' > "$APP/Contents/PkgInfo"
# First-launch registry (the game's highest graphics settings, native-resolution row), see
# app_seed_registry in runtime/bundle.m.
cp "$ROOT/app/registry-defaults.txt" "$APP/Contents/Resources/"

ICON_KEY=""
if [ -f "$EXE" ] && [ -x "$ROOT/.venv/bin/python" ]; then
  "$ROOT/.venv/bin/python" "$ROOT/tools/exeicon.py" "$EXE" "$APP/Contents/Resources/AppIcon.icns"
  ICON_KEY="<key>CFBundleIconFile</key>               <string>AppIcon</string>"
else
  echo "warning: no SPEED2.EXE (--exe) or no .venv: the app gets no icon"
fi

VER="$(date +%Y.%m.%d)"
# this tree's own commit only: a copy without .git inside another repository
# (a review copy) must not get that repository's revision
REV=unknown
if [ "$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null)" = "$(pwd -P)" ]; then
  REV="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
fi
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>                   <string>${NAME}</string>
  <key>CFBundleDisplayName</key>            <string>${DISP}</string>
  <key>CFBundleExecutable</key>             <string>NFSU2</string>
  <key>CFBundleIdentifier</key>             <string>${BID}</string>
  ${ICON_KEY}
  <key>CFBundlePackageType</key>            <string>APPL</string>
  <key>CFBundleShortVersionString</key>     <string>${VER}</string>
  <key>CFBundleVersion</key>                <string>${VER}</string>
  <key>CFBundleInfoDictionaryVersion</key>  <string>6.0</string>
  <key>NFSU2SourceRevision</key>            <string>${REV}</string>
  <key>LSMinimumSystemVersion</key>         <string>${MINOS}</string>
  <!-- A game: macOS turns Game Mode on for it in full screen. -->
  <key>LSApplicationCategoryType</key>      <string>public.app-category.racing-games</string>
  <key>GCSupportsGameMode</key>             <true/>
  <!-- Controllers drive the game (no "press a key" focus hand-off). -->
  <key>GCSupportsControllerUserInteraction</key> <true/>
  <!-- arm64 only, never under Rosetta. -->
  <key>LSArchitecturePriority</key>         <array><string>arm64</string></array>
  <key>LSRequiresNativeExecution</key>      <true/>
  <!-- Retina: without it the window is drawn at 1x and scaled up. -->
  <key>NSHighResolutionCapable</key>        <true/>
  <key>NSQuitAlwaysKeepsWindows</key>       <false/>
  <!-- The game folder may live in one of these. -->
  <key>NSDesktopFolderUsageDescription</key>
    <string>To read the game files (SPEED2.EXE and its data folders). Nothing is written there.</string>
  <key>NSDocumentsFolderUsageDescription</key>
    <string>To read the game files (SPEED2.EXE and its data folders). Nothing is written there.</string>
  <key>NSDownloadsFolderUsageDescription</key>
    <string>To read the game files (SPEED2.EXE and its data folders). Nothing is written there.</string>
  <key>NSRemovableVolumesUsageDescription</key>
    <string>To read the game files (SPEED2.EXE and its data folders). Nothing is written there.</string>
  <key>NSNetworkVolumesUsageDescription</key>
    <string>To read the game files (SPEED2.EXE and its data folders). Nothing is written there.</string>
  <!-- LAN races and free-roam multiplayer: finding other players (UDP
       broadcast) and playing with them needs macOS Local Network access;
       without this text macOS denies it silently.  One text for both
       features.  No Bonjour. -->
  <key>NSLocalNetworkUsageDescription</key>
    <string>To find and play with other Need for Speed Underground 2 players on your network: LAN races and free-roam driving together.</string>
  <key>NSHumanReadableCopyright</key>
    <string>Native arm64 port (static x86 recompilation) for personal use. The game itself is not included.</string>
</dict>
</plist>
PLIST
plutil -lint -s "$APP/Contents/Info.plist"

# Extended attributes (quarantine etc. from the source tree) would end up in
# the signature; drop them first.  Ad-hoc signature: enough to run locally.
xattr -cr "$APP" 2>/dev/null || true
codesign --force --sign - --timestamp=none "$APP"
codesign --verify --strict "$APP"

echo "built: $APP  ($(du -sh "$APP" | cut -f1), $(lipo -archs "$APP/Contents/MacOS/NFSU2"), macOS $MINOS+, ad-hoc signed)"

if [ -n "$INSTALL" ]; then
  mkdir -p "$INSTALL"
  rm -rf "$INSTALL/$NAME.app"
  ditto "$APP" "$INSTALL/$NAME.app"
  echo "installed: $INSTALL/$NAME.app"
fi
