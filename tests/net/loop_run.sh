#!/bin/bash
# loop_run.sh -- run two game instances that talk over REAL BSD sockets on
# 127.0.0.1 (NFSU2_NET=loopback), the code path of the "lan" mode except for
# the address policy.  No hub: each instance sees itself and one peer.
#
#   tests/net/loop_run.sh <outdir> <script1> <script2>
#
# Instance 1 is 10.77.0.2 (host name LOOP-2), instance 2 is 10.77.0.3
# (LOOP-3); each is the other's NFSU2_NET_LOOPPEER.  Their game ports are
# moved apart on 127.0.0.1 (NFSU2_NET_LOOPOFFSET / NFSU2_NET_LOOPPEEROFFSET,
# defaults 23000 and 24000: 9999 -> 32999 / 33999, 9900 -> 32900 / 33900,
# 3658 -> 26658 / 27658), so a broadcast reaches the own port and the peer's,
# and a datagram or connection from a port that is not one of an instance's
# own sockets is reported as coming from the peer.  Both run under the
# loopback-only sandbox (tools/autorun.sh), NOFOCUS=2, a timeout, a quarter
# render scale and 60 fps.  LOOP_OFF1/LOOP_OFF2 change the offsets;
# NET_EXTRA, NET_EXTRA_1, NET_EXTRA_2 add instance variables; NFSU2_TIMEOUT
# (default 300).  Exit status: 0 when both instances exited 0.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:?usage: tests/net/loop_run.sh <outdir> script1 script2}"; shift
[ $# -eq 2 ] || { echo "two instance scripts"; exit 2; }
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
PY="${PY:-$ROOT/.venv/bin/python}"
[ -x "$PY" ] || PY=python3
SEED="${NFSU2_REGFILE_SEED:-$ROOT/tests/web/seed/registry_perf4_native.txt}"
O1="${LOOP_OFF1:-23000}" O2="${LOOP_OFF2:-24000}"
PIDS=(); n=0
for s in "$@"; do
  n=$((n+1))
  if [ $n = 1 ]; then me=2 peer=3 off=$O1 poff=$O2; else me=3 peer=2 off=$O2 poff=$O1; fi
  ex="NET_EXTRA_$n"
  # shellcheck disable=SC2086
  NFSU2_REGFILE_SEED="$SEED" "$ROOT/tools/autorun.sh" "$OUT/i$n" NOFOCUS=2 NFSU2_NET=loopback \
     NFSU2_NET_ADDR="10.77.0.$me" NFSU2_NET_LOOPPEER="10.77.0.$peer" NFSU2_NET_NAME="LOOP-$me" \
     NFSU2_NET_LOOPOFFSET="$off" NFSU2_NET_LOOPPEEROFFSET="$poff" \
     NFSU2_TIMEOUT="${NFSU2_TIMEOUT:-300}" NFSU2_FNG_LOG=1 \
     NFSU2_DUMP_SCALE=0.5 NFSU2_RENDER=scale:0.25 NFSU2_FPS=60 NFSU2_STATUS_EVERY=600 \
     NFSU2_INPUT_SCRIPT="$s" ${NET_EXTRA:-} ${!ex:-} > "$OUT/i$n.run" 2>&1 < /dev/null &
  PIDS+=($!)
  sleep 3
done
rc=0
for p in "${PIDS[@]}"; do wait "$p" || rc=1; done
for i in 1 2; do
  printf 'i%d: %s  ' "$i" "$(cat "$OUT/i$i.run")"
  LC_ALL=C grep -a "^\[net\] mode\|^\[net\] loopback peer\|BLOCKED" "$OUT/i$i/log.txt" | head -3 | tr '\n' ' '; echo
  "$PY" "$ROOT/tools/contact_sheet.py" "$OUT/i$i" 5 300 >/dev/null 2>&1
done
exit $rc
