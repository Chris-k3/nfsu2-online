#!/bin/bash
# Run the NFSU2 native ARM64 port
ROOT="$(cd "$(dirname "$0")" && pwd)"
# NFSU2_DATA: the game folder (with SPEED2.EXE in it) or the path to SPEED2.EXE.
# If unset, the default folder in the repo root is used.
EXE="$ROOT/Need for Speed Underground 2 - Clean Edition/Need for Speed Underground 2/SPEED2.EXE"
if [ -n "$NFSU2_DATA" ]; then
  if [ -d "$NFSU2_DATA" ]; then EXE="$NFSU2_DATA/SPEED2.EXE"; else EXE="$NFSU2_DATA"; fi
fi
[ -f "$EXE" ] || { echo "SPEED2.EXE not found: $EXE"; exit 1; }
# TWO BUILDS (see link.sh):
#   ./run.sh [mode]          original  (out/nfsu2_boot)
#   NFSHD=1 ./run.sh [mode]  HD        (out/nfsu2_hd_boot) -- graphics enhancements
#   ./run.sh hd | hd1080p    shortcuts for HD
# HD settings (read by the HD build only): HDREFL=0 (reflection enhancement off),
#   HD_ROAD=1.0, HD_BLUR=0.5, HD_MIRROR=1024, HD_CUBE=512, HD_MSAA=4 (0 off),
#   HD_SSR=1 (0 off), HD_SSR_CAR=1 (car paint), HD_SSR_DEBUG=1|2|3.
#   Details: runtime/enhance.c
MODE="${1:-window}"
case "$MODE" in
  hd)      NFSHD=1; MODE=window ;;
  hd1080p) NFSHD=1; MODE=1080p ;;
esac
BIN="$ROOT/out/nfsu2_boot"
[ "${NFSHD:-0}" = 1 ] && BIN="$ROOT/out/nfsu2_hd_boot"
[ -x "$BIN" ] || { echo "build first: ./build.sh && ./link.sh  ($BIN missing)"; exit 1; }
[ "${NFSHD:-0}" = 1 ] && echo "build: HD (graphics enhancements on)" || echo "build: original"

# --- temporarily required settings (root causes still open) ---
# FIXMAT   : the game's front-end WorldViewProj matrix arrives broken (only
#            rows 2 and 3 written, 0-1 zero) -> every vertex collapses to
#            (1,1).  MODE=3 injects the identity matrix, which is correct:
#            the raw positions are already in clip space.
# NOMOVIES : there is no VP6 video decoder; unless the video files are
#            ignored, the game waits forever on the first video.
# Synthetic input/forcing variables for diagnosis must not leak in from the
# shell: a stale "export AUTOKEY=..." made the game seem to click by itself.
unset AUTOKEY AUTOCLICK FORCESWITCH FETICK GAMELOG DUMPFRAME BOOTFLOW \
      DATADIFF VSKDUMP OWNERSCAN PARAMNAME PDLIST WATCHVSK WATCHADDR \
      MPROT_HARD MPROT_ANY MPROT_PERSIST PRESENTBT VSKBT GLYPHDUMP DRAWDUMP \
      AUTOSEQ GILLOG SNDSTAT SNDGAP SNDLOG \
      READLOG GPUVSLOG GPUVSDUMP GPUVSMASK NOVS NOPACE PACE60 TESTFILL \
      SKIPDRAW CLEARCOL MIPOFF DRAWV SLIVER PSDUMP DUMPMIP DUMPTEX SMPLOG LOCKLOG RTLOG \
      DRAWSUM PSISO SKIPPS PSINFO BLITLOG SNDCSV SNDDUMP SNDBACKEND \
      FPSCSV AUTOKEYSTOP VCLOCK VCLOCK_MAXD DECLLOG CULLWIND RSLOG NOFOG BLITQUAD RESSCAN ASPFIX ASPLOG PSHIST MIPLIN NOANISO LODMAX \
      RTIDLOG DRAWVPS ZSHARELOG XFORMAT CAMLOG HD_SSR_DEBUG VIEWLOG HD_RTPROBE HD_RTPROBE2 HD_RT_STAGE HD_RT_NOTEX HD_RT_PLAIN HD_RT_ONLYCX HD_RT_SLOWBUILD HD_RT_LOG HD_RT_DUMPTAB HD_RT_STRESS HD_COMP HD_MSLAZY HD_REORDER HD_RT_AB HD_RT_FIX HD_RT_POISON FORCERAIN FORCETOD FORCETOD_STATE GPUWIN PASSPROF PASSPROF_MODE GPUVSDUMP

# v12na (heap track): FIXMAT is off by default.  The "broken WVP" draws are
# invisible either way (rows 0-1 zero): FIXMAT=0 and FIXMAT=1 frames match in
# the title, main menu garage, customize, race and career free roam, and the
# pattern count does not change when IsProcessorFeaturePresent stops
# reporting 3DNow!, so it was not D3DX's PSGP path.  FIXMAT=1 still works.
export FIXMAT="${FIXMAT:-0}"
export NOMOVIES="${NOMOVIES:-0}"   # v12na: VP6 movies play (RealCore ~MHz fix)
export FIXMAT_MODE="${FIXMAT_MODE:-3}"
# SNDSYNC : the game produces audio in its own VIRTUAL time (16.67 ms per frame).
#           Below 60 fps the emulator produces only ~75% of real time and
#           every buffer cycle leaves an unwritten region -> the audio drops out.
#           1 = tie playback to the game's speed (no dropouts, pitch slightly lower)
#           0 = play in real time (correct pitch, occasional dropouts)
export SNDSYNC="${SNDSYNC:-1}"
# GPUVS : run vertex shaders on the GPU (the game's own bytecode is
#         translated to MSL).  Measured: draw path 34.6 s -> 2.2 s,
#         vertex throughput 2.4 -> 90 M/s.  A shader that cannot be
#         translated falls back to the CPU interpreter automatically.
#         GPUVS=0 goes back to the old (CPU) path.
export GPUVS="${GPUVS:-1}"

# NOTE: this used to say "the front end hangs at UG_LS_Splash.fng, FORCESWITCH=3
# is needed".  That NO LONGER HOLDS: since the FPUSH fix the game reaches the
# title screen by itself and waits at "Press Enter Key" -- exactly the
# original behaviour.  FORCESWITCH=3 stays only to skip to the menu without
# Enter (measurement/diagnosis).
# NFSRES: the game's own resolution table has 6 rows, all of them 4:3 -- 1080p
# cannot be picked in the menu.  This variable opens the device at the given
# size, corrects the geometry to Hor+ widescreen and keeps the UI's circles
# round (HUDFIX=0 turns that off).
#   NFSRES=1920x1080 ./run.sh      or     ./run.sh 1080p
export NFSRES="${NFSRES:-}"
# NFSNATIVE: on a Retina display, raises the resolution the game picked (at
#   most 1280x960 in the menu) to the screen's real pixel count, KEEPING THE
#   ASPECT RATIO (2448x1836 on a 14" MacBook Pro).  The 1280x960 surface used
#   to be scaled up ~2x into the window and came out blurry.  ON by default.
#   NFSNATIVE=0 turns it off: the image is still 1:1 pixels, but the window
#   opens at half size.  If NFSRES is given, it wins.
# NFSMAXPIX: upper bound of the native scale, in pixels (default 6000000;
#   keeps the frame budget on 5K/6K displays).

# For a double-clickable .app:  ./pack.sh  (see out/NFSU2.app)

if [ "$MODE" = "1080p" ]; then MODE=window; export NFSRES="${NFSRES:-1920x1080}"; fi
[ -n "$NFSRES" ] && echo "resolution: $NFSRES (widescreen fix on)"
case "$MODE" in
  window)   echo "windowed mode (close the window or press Ctrl-C to quit)"
            WINDOW=1 ALARM="${ALARM:-0}" exec "$BIN" "$EXE" ;;
  headless) echo "headless mode, ${ALARM:-60} s"
            ALARM="${ALARM:-60}" exec "$BIN" "$EXE" ;;
  profile)  echo "sampling profile"
            SAMPLE=1 ALARM="${ALARM:-30}" exec "$BIN" "$EXE" ;;
  trace)    echo "D3D9 call trace"
            COMTRACE=1 ALARM="${ALARM:-20}" exec "$BIN" "$EXE" ;;
  test)     "$ROOT/out/isatest" && "$ROOT/out/nfsu2_all" "$EXE" && "$ROOT/out/roam_unit" || exit 1
            # Winsock HLE: loopback (in the loopback-only sandbox) and the virtual LAN hub
            if [ -x "$ROOT/out/net_harness" ]; then
              SB=""; [ -x /usr/bin/sandbox-exec ] && SB="/usr/bin/sandbox-exec -f $ROOT/tests/net/loopback-only.sb"
              PY="$ROOT/.venv/bin/python"; HUB=""; [ -x "$PY" ] && HUB="--vlan-hub $PY $ROOT/tools/vlanhub.py"
              $SB "$ROOT/out/net_harness" $HUB > "$ROOT/out/net_harness.txt" 2>&1
              rc=$?; tail -1 "$ROOT/out/net_harness.txt"; [ $rc -eq 0 ] || { grep -a "FAIL" "$ROOT/out/net_harness.txt" | head -20; exit 1; }
            fi ;;
  *)        echo "usage: [NFSHD=1] ./run.sh [window|1080p|hd|hd1080p|headless|profile|trace|test]"; exit 1 ;;
esac
