#!/bin/bash
# Every check of the Windows companion that runs without Windows.
#   tools/roam_asi_test.sh [<snapshot dir>] [<outdir>]
# <snapshot dir> holds snap.bin and cfg_player.bin from a port run of
# tests/scripts/roam_asi_snapshot.txt (default: ../../runs/roam-71); outdir
# default: ../../runs/roam-asitest.  Needs mingw-w64 and Unicorn
# (ASIPEER=1 ./link.sh orig builds the test programs).
#  1. two clean builds of NFSU2FreeRoam.asi are byte-identical;
#  2. tools/asi_check.py: PE structure, imports, exports, hook site and the
#     other mods' patch sites, the exe fingerprint, the thunks;
#  3. out/roam_pe_selftest: the core built by mingw (the plugin's own object
#     file) gives the same bytes as the arm64 build, under Unicorn;
#  4. out/asi_harness in every mode: the plugin and the Mac build side by
#     side on a free-roam snapshot (identical datagrams, game calls, guest
#     memory), the fault guard (a fault in a game function, in the plugin,
#     and inside a game function's SEH frame: FS:[0] must come back), a wrong
#     exe, a chained hook, an Unlimiter-style replaced function.
# Nothing here opens a network socket.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
SNAP="${1:-$ROOT/../../runs/roam-71}"; OUT="${2:-$ROOT/../../runs/roam-asitest}"
EXE="${NFSU2_DATA:-$ROOT/../../gamedata}/SPEED2.EXE"
mkdir -p "$OUT"
fail=0
echo "== 1. reproducible build"
tools/build_roam_asi.sh > "$OUT/build1.txt" 2>&1; cp out/win/NFSU2FreeRoam.asi "$OUT/first.asi"
tools/build_roam_asi.sh > "$OUT/build2.txt" 2>&1
if cmp -s "$OUT/first.asi" out/win/NFSU2FreeRoam.asi; then echo "  ok    two builds are byte-identical ($(shasum -a 256 out/win/NFSU2FreeRoam.asi | cut -c1-16)...)"; else echo "  FAIL  two builds differ"; fail=1; fi
echo "== 2. the file"
.venv/bin/python -I tools/asi_check.py out/win/NFSU2FreeRoam.asi "$EXE" > "$OUT/asi_check.txt" 2>&1 || fail=1
grep -E 'FAIL|PASS' "$OUT/asi_check.txt" | sed 's/^/  /'
echo "== 3. the core's bytes, 32-bit Windows build vs arm64"
out/roam_pe_selftest out/win/roam_selftest.dll | sed 's/^/  /' || fail=1
echo "== 4. the plugin vs the Mac build on a free-roam snapshot ($SNAP)"
for m in none fault faultself faultseh badexe chain unlimiter; do
  d="$OUT/harness-$m"; rm -rf "$d"; mkdir -p "$d"
  if ROAM_EXE="$EXE" ROAM_ROOT="$ROOT" out/asi_harness $([ $m != none ] && echo --$m) "$SNAP/snap.bin" "$SNAP/cfg_player.bin" "$d" > "$d/result.txt" 2>&1; then r=PASS; else r=FAIL; fail=1; fi
  printf "  %-5s %-10s %s\n" "$r" "$m" "$(grep -cE '^  ok' "$d/result.txt") checks ok, $(grep -cE '^  FAIL' "$d/result.txt") failed"
done
[ $fail = 0 ] && echo "roam_asi_test: PASS" || { echo "roam_asi_test: FAIL"; exit 1; }
