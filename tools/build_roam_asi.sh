#!/bin/bash
# Builds the Windows companion of the free-roam multiplayer: NFSU2FreeRoam.asi
# (Ultimate ASI Loader plugin for the original PC game, SPEED2.EXE v1.2 NA).
#   tools/build_roam_asi.sh            -> out/win/
# Needs the mingw-w64 cross compiler (Homebrew: brew install mingw-w64).
#
# The protocol core and the game side are the Mac port's own sources
# (runtime/roam_core.c, runtime/roam_game.c), built for 32-bit x86 with the
# flags that make their floats bit-identical to the arm64 build: SSE2 math,
# no fused multiply-add.  Freestanding: no C runtime, no libgcc DLL, no
# pthreads; the plugin imports KERNEL32 and WS2_32 only (tools/asi_check.py
# verifies that).  Reproducible: no time stamp, the same bytes every build.
#
# Output (out/win/):
#   NFSU2FreeRoam.asi        the plugin (stripped)
#   dbg/NFSU2FreeRoam.asi    the same with symbols (the Unicorn tests use it)
#   NFSU2FreeRoam.map        linker map
#   roam_selftest.dll        tests/roam_selftest.c on the plugin's own core
#                            object (tools/roam_x86check.sh runs it)
#   dist/                    what a Windows friend copies into the game folder
#                            (scripts/NFSU2FreeRoam.asi + .ini, README.txt)
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
CC="${MINGW_CC:-i686-w64-mingw32-gcc}"
command -v "$CC" >/dev/null || { echo "build_roam_asi: $CC not found (brew install mingw-w64)"; exit 1; }
O=out/win; mkdir -p "$O/obj" "$O/dbg" "$O/dist/scripts"
VER="${ROAM_ASI_VERSION:-1.0}"
# -msse2 -mfpmath=sse: float math in SSE (IEEE single/double, as on arm64),
#   never the x87 (whose precision the game's D3D device sets to 24 bits);
# -ffp-contract=off: no fused multiply-add (arm64 would fuse otherwise);
# -mstackrealign: the game and Windows call us with 4-byte aligned stacks;
# -fno-strict-aliasing: guest memory is read through casts;
# -ffreestanding, no stack protector, no unwind tables: no C runtime at all.
CFLAGS="-std=c11 -O2 -march=i686 -msse2 -mfpmath=sse -mstackrealign -ffp-contract=off -fno-strict-aliasing \
 -ffreestanding -fno-stack-protector -fno-asynchronous-unwind-tables -fno-ident -fno-pic \
 -Wall -Wextra -Wno-unused-parameter -DROAM_HOST_WIN -DROAM_ASI_VERSION=\"$VER\" -Iwin/roam_asi -Iruntime"
LDFLAGS="-shared -nostdlib -Wl,--subsystem,windows:5.1 -Wl,--no-insert-timestamp -Wl,--dynamicbase -Wl,--nxcompat -Wl,--image-base,0x10000000 \
 -Wl,--enable-reloc-section -Wl,--disable-auto-import -Wl,--major-os-version,5 -Wl,--minor-os-version,1 \
 -Wl,--major-subsystem-version,5 -Wl,--minor-subsystem-version,1"
LIBS="-lkernel32 -lws2_32 -lgcc"
# the exe check's table, from the game's exe when it is here (it is
# committed: the build also works without the exe)
EXE="${NFSU2_DATA:-$ROOT/../../gamedata}/SPEED2.EXE"
if [ -f "$EXE" ]; then
  "$ROOT/.venv/bin/python" -I tools/roam_fingerprint.py "$EXE" > "$O/roam_fp.h.new" 2>/dev/null
  cmp -s "$O/roam_fp.h.new" win/roam_asi/roam_fp.h || { echo "build_roam_asi: win/roam_asi/roam_fp.h is out of date (tools/roam_fingerprint.py)"; exit 1; }
  rm -f "$O/roam_fp.h.new"
fi
$CC $CFLAGS -c -o "$O/obj/roam_core.o" runtime/roam_core.c
$CC $CFLAGS -c -o "$O/obj/roam_game.o" runtime/roam_game.c
$CC $CFLAGS -c -o "$O/obj/roam_win.o"  win/roam_asi/roam_win.c
$CC $CFLAGS -c -o "$O/obj/roam_asi.o"  win/roam_asi/roam_asi.c
$CC $CFLAGS -fno-builtin -fno-tree-loop-distribute-patterns -c -o "$O/obj/roam_libc.o" win/roam_asi/roam_libc.c
OBJS="$O/obj/roam_asi.o $O/obj/roam_game.o $O/obj/roam_win.o $O/obj/roam_core.o $O/obj/roam_libc.o"
$CC $LDFLAGS -e _DllMain@12 -Wl,-Map,"$O/NFSU2FreeRoam.map" -o "$O/dbg/NFSU2FreeRoam.asi" $OBJS $LIBS
# the shipped file: the same link without the symbol table (strip(1) would
# stamp the time into the header; tools/asi_check.py compares the sections)
$CC $LDFLAGS -e _DllMain@12 -s -o "$O/NFSU2FreeRoam.asi" $OBJS $LIBS
# the core's cross-platform self-test on the plugin's own objects
$CC $CFLAGS -DROAM_SELFTEST_EXTERN_CORE -c -o "$O/obj/roam_selftest.o" tests/roam_selftest.c
$CC $CFLAGS -c -o "$O/obj/selftest_dll.o" win/roam_asi/selftest_dll.c
$CC $LDFLAGS -e _roam_selftest_dllmain@12 -o "$O/roam_selftest.dll" "$O/obj/roam_selftest.o" "$O/obj/roam_core.o" "$O/obj/roam_libc.o" \
    "$O/obj/selftest_dll.o" -lgcc
# what a Windows friend gets
cp "$O/NFSU2FreeRoam.asi" win/roam_asi/NFSU2FreeRoam.ini "$O/dist/scripts/"
cp win/roam_asi/README.txt "$O/dist/README.txt"
sz=$(stat -f %z "$O/NFSU2FreeRoam.asi")
echo "build_roam_asi: $O/NFSU2FreeRoam.asi ($sz bytes, version $VER), $O/roam_selftest.dll, $O/dist/"
