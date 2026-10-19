#!/bin/bash
# vlan_run.sh -- run 2-4 game instances on one virtual LAN (tools/vlanhub.py).
#
#   tests/net/vlan_run.sh <outdir> [hub options --] <script1> <script2> [<script3> <script4>]
#
# Starts the hub (<outdir>/hub.sock, hub.log, hub.pcap) under the loopback-only
# sandbox, then one instance per input script (<outdir>/i1, i2, ...), each via
# tools/autorun.sh with NFSU2_NET=vlan:<hub>, NOFOCUS=2, a timeout, a quarter
# render scale and 60 fps (LAN races run at 30 anyway), started 3 s apart.  The
# hub is stopped when the last instance exits.  Instance N asks the hub for
# 10.77.0.(N+1) (so i1 is 10.77.0.2), with the host name VLAN-<N+1>.
# Hub options before "--", e.g.:  --delay 20 --jitter 5 --loss 1 --fake-server MACHOST@10.77.0.50
# Extra instance variables: NET_EXTRA="VAR=value ..." (all instances),
# NET_EXTRA_1 .. NET_EXTRA_4 (one instance).  NFSU2_TIMEOUT (default 300).
# NET_APP_<n>=1 runs instance n as the packaged app (tools/apptest.sh,
# out/NFSU2.app, under the same sandbox; its log is support/Logs/nfsu2.log).
# Exit status: 0 when every instance exited 0.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:?usage: tests/net/vlan_run.sh <outdir> [hub options --] script1 script2 ...}"; shift
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
HUBOPT=()
if printf '%s\n' "$@" | grep -qx -- '--'; then
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do HUBOPT+=("$1"); shift; done
  shift
fi
[ $# -ge 1 ] && [ $# -le 4 ] || { echo "1 to 4 instance scripts"; exit 2; }
PY="${PY:-$ROOT/.venv/bin/python}"
[ -x "$PY" ] || PY=python3
SB=(/usr/bin/sandbox-exec -f "$ROOT/tests/net/loopback-only.sb")
HUB="$OUT/hub.sock"
rm -f "$HUB"
# the hub outlives the instances' timeout (they are started 3 s apart), at
# least 30 min; a "--quit-after" among the hub options wins
QA=$(( ${NFSU2_TIMEOUT:-300} + 60 )); [ "$QA" -lt 1800 ] && QA=1800
"${SB[@]}" "$PY" -I "$ROOT/tools/vlanhub.py" --sock "$HUB" --pcap "$OUT/hub.pcap" --log "$OUT/hub.log" \
  --quit-after "$QA" ${HUBOPT[@]+"${HUBOPT[@]}"} &
HUBPID=$!
for i in $(seq 1 50); do [ -S "$HUB" ] && break; sleep 0.1; done
[ -S "$HUB" ] || { echo "hub did not start"; kill "$HUBPID" 2>/dev/null; exit 3; }
SEED="${NFSU2_REGFILE_SEED:-$ROOT/tests/web/seed/registry_perf4_native.txt}"
PIDS=(); n=0
for s in "$@"; do
  n=$((n+1))
  ex="NET_EXTRA_$n"
  ap="NET_APP_$n"; RUN=("$ROOT/tools/autorun.sh")
  [ "${!ap:-0}" = 1 ] && RUN=("${SB[@]}" env NFSU2_SANDBOXED=1 "$ROOT/tools/apptest.sh")
  # shellcheck disable=SC2086
  NFSU2_REGFILE_SEED="$SEED" "${RUN[@]}" "$OUT/i$n" NOFOCUS=2 NFSU2_NET="vlan:$HUB" \
     NFSU2_NET_ADDR="10.77.0.$((n+1))" NFSU2_TIMEOUT="${NFSU2_TIMEOUT:-300}" NFSU2_FNG_LOG=1 \
     NFSU2_DUMP_SCALE=0.5 NFSU2_RENDER=scale:0.25 NFSU2_FPS=60 NFSU2_STATUS_EVERY=600 \
     NFSU2_INPUT_SCRIPT="$s" ${NET_EXTRA:-} ${!ex:-} > "$OUT/i$n.run" 2>&1 < /dev/null &
  PIDS+=($!)
  sleep 3
done
rc=0
for p in "${PIDS[@]}"; do wait "$p" || rc=1; done
kill "$HUBPID" 2>/dev/null; wait "$HUBPID" 2>/dev/null
for i in $(seq 1 $n); do
  printf 'i%d: %s  ' "$i" "$(cat "$OUT/i$i.run")"
  lg="$OUT/i$i/log.txt"; [ -f "$lg" ] || lg="$OUT/i$i/support/Logs/nfsu2.log"
  LC_ALL=C grep -a "^\[net\] mode\|BLOCKED" "$lg" | head -3 | tr '\n' ' '; echo
  "$PY" "$ROOT/tools/contact_sheet.py" "$OUT/i$i" 5 300 >/dev/null 2>&1
done
LC_ALL=C grep -a "stats:" "$OUT/hub.log" | tail -1
exit $rc
