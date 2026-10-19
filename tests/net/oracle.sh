#!/bin/bash
# Build and run tests/net_oracle.c: the original x86 network encode/decode
# functions under Unicorn vs the lifted C (see the file's header).
#   tests/net/oracle.sh [iterations]        (after ./build.sh and ./link.sh orig)
# Needs a native arm64 Unicorn 2.1.x: by default the project's
# work/deps/unicorn-2.1.4 (as link.sh's ORACLE=1 / ASIPEER=1 builds), or
# UNICORN_INC=<src>/include UNICORN_LIB=<build>/libunicorn.a.  Test tool only:
# Unicorn is GPLv2 and never linked into the game or the app.  The lifted
# code is gen.sh's (X87PC=1 by default): each case runs both sides with the
# case's x87 control word (PC=53, then PC=24).
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
UDEP=""
for d in "$ROOT/../../work/deps/unicorn-2.1.4" "$ROOT/../../deps/unicorn-2.1.4"; do
  [ -d "$d" ] && { UDEP="$(cd "$d" && pwd)"; break; }
done
UNICORN_INC="${UNICORN_INC:-${UDEP:+$UDEP/include}}"; UNICORN_LIB="${UNICORN_LIB:-${UDEP:+$UDEP/lib/libunicorn.a}}"
[ -d "$UNICORN_INC" ] && [ -f "$UNICORN_LIB" ] || { echo "needs Unicorn: work/deps/unicorn-2.1.4, or UNICORN_INC and UNICORN_LIB"; exit 1; }
DATA="${NFSU2_DATA:-$ROOT/../../work/gamedata}"
CSRC=$(sed -n 's/^CSRC="\(.*\)"/\1/p' link.sh); MSRC=$(sed -n 's/^MSRC="\(.*\)"/\1/p' link.sh)
RT=""; for f in $CSRC $MSRC impargs srv_impargs srv_modinfo; do [ -f "out/obj/$f.o" ] && RT="$RT out/obj/$f.o"; done
SHARDS="$(ls gen/all/shard_*.c | sed -E "s|gen/all/(.*)\.c|out/obj/\1.o|" | tr "\n" " ") out/obj/fntab.o $([ -f gen/all/stubs.c ] && echo out/obj/stubs.o || true)"
# the second guest module (server.dll, feat/netsrv): runtime/module.c refers to its tables
SHARDS="$SHARDS $(ls gen/server/shard_*.c 2>/dev/null | sed -E "s|gen/server/(.*)\.c|out/obj/srv/\1.o|" | tr "\n" " ") out/obj/srv/fntab.o $([ -f gen/server/stubs.c ] && echo out/obj/srv/stubs.o || true)"
FW="-lm -lpthread -framework Cocoa -framework Metal -framework QuartzCore -framework ImageIO -framework CoreGraphics -framework CoreServices -framework AudioToolbox -framework CoreAudio -framework GameController -framework Carbon"
clang -O1 -g -Iruntime -Igen/all -I"$UNICORN_INC" -c -o out/obj/net_oracle.o tests/net_oracle.c
clang -o out/net_oracle out/obj/net_oracle.o $SHARDS $RT "$UNICORN_LIB" $FW
NFSU2_NET=off ALARM=0 NFSU2_NET_HARNESS=1 out/net_oracle "$DATA/SPEED2.EXE" "${1:-300}"
