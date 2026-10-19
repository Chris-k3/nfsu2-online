#!/bin/bash
# One game instance with stand-in friends (out/roam_fakepeer), loopback only.
#   tools/roam_solo.sh <outdir> <timeout-s> <script> "<game VAR=value ...>" "<fakepeer args>" ...
# The game listens on 127.0.0.1:$ROAM_BASEPORT (default 47320) and lists
# every fake peer (47330, 47331, ...) as a peer; each fake peer gets
# "--port 4733k --peer 127.0.0.1:47320" plus its own arguments and logs to
# <outdir>/fake<k>.log.  Only processes this script started are stopped.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:?usage}"; TMO="${2:?timeout}"; SCRIPT="${3:?script}"; GVARS="$4"; shift 4
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
BASE="${ROAM_BASEPORT:-47320}"
SEED="${NFSU2_REGFILE_SEED:-$ROOT/tests/web/seed/registry_perf4_native.txt}"
if [ -z "$NFSU2_DATA" ]; then for d in "$ROOT/../../gamedata" "$ROOT/../../work/gamedata"; do [ -f "$d/SPEED2.EXE" ] && export NFSU2_DATA="$(cd "$d" && pwd)" && break; done; fi
peers=""; k=0
for f in "$@"; do peers="${peers:+$peers,}127.0.0.1:$((BASE + 10 + k))"; k=$((k + 1)); done
d="$OUT/game"; rm -rf "$d"; mkdir -p "$d"
# shellcheck disable=SC2086
env NFSU2_REGFILE_SEED="$SEED" $GVARS "$ROOT/tools/autorun.sh" "$d" NOFOCUS=2 NFSU2_TIMEOUT="$TMO" ALARM="$TMO" \
    NFSU2_FNG_LOG=1 NFSU2_STATUS_EVERY=1200 NFSU2_DUMP_SCALE=0.5 \
    NFSU2_ROAM=1 NFSU2_ROAM_PORT="$BASE" NFSU2_ROAM_PEERS="$peers" NFSU2_ROAM_NAME=Viewer ROAM_PROFILE=VIEWER \
    NFSU2_ROAM_POSELOG="$d/pose.csv" NFSU2_INPUT_SCRIPT="$([ "${SCRIPT#/}" != "$SCRIPT" ] && echo "$SCRIPT" || echo "$ROOT/tests/scripts/$SCRIPT")" $GVARS > "$d.run" 2>&1 < /dev/null &
gpid=$!
fpids=(); k=0
for f in "$@"; do
  # shellcheck disable=SC2086
  "$ROOT/out/roam_fakepeer" --port $((BASE + 10 + k)) --peer "127.0.0.1:$BASE" $f > "$OUT/fake$k.log" 2>&1 &
  fpids+=($!); echo "roam_solo: fake peer $k on 127.0.0.1:$((BASE + 10 + k)): $f (pid $!)"
  k=$((k + 1))
done
deadline=$(( $(date +%s) + TMO + 60 ))
while kill -0 "$gpid" 2>/dev/null; do
  if [ "$(date +%s)" -gt "$deadline" ]; then g=$(pgrep -P "$gpid" | head -1); [ -n "$g" ] && kill "$g"; kill "$gpid"; break; fi
  sleep 2
done
wait "$gpid"; rc=$?
for p in "${fpids[@]}"; do kill "$p" 2>/dev/null; done
wait 2>/dev/null
echo "roam_solo: game exit=$rc ($(tail -1 "$d.run"))"
if grep -l "BLOCKED" "$d/log.txt" "$OUT"/fake*.log >/dev/null 2>&1; then echo "roam_solo: BLOCKED lines found"; exit 1; fi
exit $rc
