#!/bin/bash
# One game instance and stand-in friends (out/roam_fakepeer) that join and
# leave on a timed plan, loopback only.
#   tools/roam_plan.sh <outdir> <timeout-s> <script> <baseport> <nfake> <plan.sh|-> [VAR=value ...]
# The game runs through tools/autorun.sh (NOFOCUS=2, NFSU2_TIMEOUT, ALARM,
# the loopback-only sandbox, NFSU2_ROAM_HARNESS=1) on 127.0.0.1:<baseport>
# with the <nfake> stand-in ports <baseport>+10, +11, ... as configured
# peers; <script> is tests/scripts/<script> or an absolute path and must log
# ROAM_INROAM once it is in free roam.  Then <plan.sh> is sourced in a
# background shell (bash); it starts stand-ins with
#   fp <k> <roam_fakepeer arguments...>     on port <baseport>+10+k, logging to <outdir>/fake<k>.log
# (each call runs in the foreground: put "( sleep S; fp ... ) &" in the
# plan).  $OUT is the outdir.  ROAM_FAKEPEER=<binary> replaces
# out/roam_fakepeer.  Only processes started here are ever stopped, by PID.
# From the free-roam round-3a review.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:?usage: tools/roam_plan.sh <outdir> <timeout-s> <script> <baseport> <nfake> <plan.sh|-> [VAR=value ...]}"
TMO="${2:?timeout}"; SCRIPT="${3:?script}"; BASE="${4:?baseport}"; NF="${5:?nfake}"; PLAN="${6:?plan}"; shift 6
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"; d="$OUT/game"; rm -rf "$d"; mkdir -p "$d"
SEED="${NFSU2_REGFILE_SEED:-$ROOT/tests/web/seed/registry_perf4_native.txt}"
if [ -z "$NFSU2_DATA" ]; then for g in "$ROOT/../../gamedata" "$ROOT/../../work/gamedata"; do [ -f "$g/SPEED2.EXE" ] && export NFSU2_DATA="$(cd "$g" && pwd)" && break; done; fi
FP="${ROAM_FAKEPEER:-$ROOT/out/roam_fakepeer}"
[ "$PLAN" = "-" ] || [ "${PLAN#/}" != "$PLAN" ] || PLAN="$(pwd)/$PLAN"
[ "${SCRIPT#/}" != "$SCRIPT" ] || SCRIPT="$ROOT/tests/scripts/$SCRIPT"
peers=""; k=0; while [ "$k" -lt "$NF" ]; do peers="${peers:+$peers,}127.0.0.1:$((BASE + 10 + k))"; k=$((k + 1)); done
env NFSU2_REGFILE_SEED="$SEED" "$@" "$ROOT/tools/autorun.sh" "$d" NOFOCUS=2 NFSU2_TIMEOUT="$TMO" ALARM="$TMO" \
    NFSU2_FNG_LOG=1 NFSU2_STATUS_EVERY=1200 NFSU2_DUMP_SCALE=0.5 \
    NFSU2_ROAM=1 NFSU2_ROAM_PORT="$BASE" NFSU2_ROAM_PEERS="$peers" NFSU2_ROAM_NAME="${ROAM_NAME:-Viewer}" ROAM_PROFILE="${ROAM_PROFILE:-VIEWER}" \
    NFSU2_ROAM_POSELOG="$d/pose.csv" NFSU2_INPUT_SCRIPT="$SCRIPT" "$@" \
    > "$d.run" 2>&1 < /dev/null &
gpid=$!
echo "roam_plan: game (autorun pid $gpid) on 127.0.0.1:$BASE, peers $peers, script $SCRIPT"
fp(){ local i="$1"; shift
      echo "== $(date +%T) fp$i $*" >> "$OUT/fake$i.log"
      "$FP" --port $((BASE + 10 + i)) --peer "127.0.0.1:$BASE" "$@" >> "$OUT/fake$i.log" 2>&1; }
ppid_plan=""
if [ "$PLAN" != "-" ]; then
  ( while kill -0 "$gpid" 2>/dev/null && ! grep -q 'ROAM_INROAM' "$d/log.txt" 2>/dev/null; do sleep 1; done
    echo "roam_plan: game in free roam at $(date +%T)" >> "$OUT/plan.log"
    # shellcheck disable=SC1090
    kill -0 "$gpid" 2>/dev/null && . "$PLAN"
    wait
    echo "roam_plan: plan done at $(date +%T)" >> "$OUT/plan.log" ) &
  ppid_plan=$!
fi
deadline=$(( $(date +%s) + TMO + 60 ))
while kill -0 "$gpid" 2>/dev/null; do
  if [ "$(date +%s)" -gt "$deadline" ]; then g=$(pgrep -P "$gpid" | head -1); [ -n "$g" ] && kill "$g"; kill "$gpid"; break; fi
  sleep 2
done
wait "$gpid"; rc=$?
# the plan and the stand-ins it started (only our own PIDs)
killtree(){ local c; for c in $(pgrep -P "$1" 2>/dev/null); do killtree "$c"; done; kill "$1" 2>/dev/null; }
[ -n "$ppid_plan" ] && killtree "$ppid_plan"
wait 2>/dev/null
echo "roam_plan: game exit=$rc ($(tail -1 "$d.run"))"
# no packet left the Mac: any BLOCKED line is a failure
if grep -l "BLOCKED" "$d/log.txt" "$OUT"/fake*.log >/dev/null 2>&1; then echo "roam_plan: BLOCKED lines found"; exit 1; fi
exit $rc
