#!/bin/bash
# Free-roam multiplayer core: does a 32-bit x86 build produce the same bytes?
#   tools/roam_x86check.sh
# 1. compiles runtime/roam_core.c for i686 Windows (freestanding, the flags a
#    Windows ASI build would use) and checks it needs nothing but
#    memcpy/memset/memmove/memcmp/strlen (no libm, no 64-bit division helpers);
# 2. runs tests/roam_selftest.c as an i686 ELF object under Unicorn and
#    natively, and compares the two byte streams (tests/roam_x86_oracle.c).
# Unicorn 2.1.4: the project's work/deps/unicorn-2.1.4 (as link.sh's ORACLE=1
# and ASIPEER=1); UNICORN_INC=<src>/include UNICORN_LIB=<build>/libunicorn.a
# override it.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
UDEP=""
for d in "$ROOT/../../work/deps/unicorn-2.1.4" "$ROOT/../../deps/unicorn-2.1.4"; do
  [ -d "$d" ] && { UDEP="$(cd "$d" && pwd)"; break; }
done
UNICORN_INC="${UNICORN_INC:-${UDEP:+$UDEP/include}}"
UNICORN_LIB="${UNICORN_LIB:-${UDEP:+$UDEP/lib/libunicorn.a}}"
mkdir -p out
X86="-std=c99 -ffreestanding -O2 -msse2 -mfpmath=sse -ffp-contract=off -fno-pic -fno-stack-protector -fno-asynchronous-unwind-tables -Wall -Wextra"
clang -target i686-pc-windows-gnu $X86 -c -o out/roam_core_win32.o runtime/roam_core.c
undef=$(nm out/roam_core_win32.o | awk '$1=="U"{print $2}' | sort | tr '\n' ' ')
echo "roam_core for i686 Windows: undefined symbols: $undef"
for s in $undef; do case "$s" in _memcpy|_memset|_memmove|_memcmp|_strlen) ;; *) echo "FAIL: $s (only the C memory functions may be needed)"; exit 1 ;; esac; done
clang -target i686-unknown-linux-gnu $X86 -fno-builtin -DROAM_SELFTEST_FREESTANDING -c -o out/roam_selftest_x86.o tests/roam_selftest.c
[ -f "$UNICORN_LIB" ] && [ -d "$UNICORN_INC" ] || { echo "no Unicorn (UNICORN_INC / UNICORN_LIB): x86 run skipped"; exit 0; }
clang -O2 -ffp-contract=off -I"$UNICORN_INC" -o out/roam_x86_oracle tests/roam_x86_oracle.c tests/roam_selftest.c "$UNICORN_LIB" -lpthread -lm
out/roam_x86_oracle out/roam_selftest_x86.o
