#!/bin/bash
# Free-roam multiplayer on loopback: 2-4 game instances, a full mesh.
#   tools/roam_multi.sh <outdir> <timeout-s> "<name>|<script>|VAR=value VAR=value" ...
# Instance i (0-based) runs in <outdir>/<name> through tools/autorun.sh with
# NOFOCUS=2 (invisible window), NFSU2_TIMEOUT, the performance-level-4
# registry seed, NFSU2_ROAM=1, its own port ($ROAM_BASEPORT + i, default
# 47300 + i), every other instance as a peer (127.0.0.1 only), its name, a
# pose log (pose.csv) and the given script (tests/scripts/<script>, or an absolute path).  The
# runtime is in test-harness mode (loopback only, no LAN discovery) and
# autorun.sh wraps it in the loopback-only sandbox.  Only the processes this
# script started are ever stopped.  ROAM_KILL="<name>:<seconds>" kills that
# instance abruptly (SIGKILL) after <seconds>, as a crashed peer would go.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:?usage: tools/roam_multi.sh <outdir> <timeout-s> 'name|script|VARS' ...}"; shift
TMO="${1:?timeout}"; shift
[ $# -ge 2 ] && [ $# -le 4 ] || { echo "roam_multi: 2..4 instances" >&2; exit 2; }
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
BASE="${ROAM_BASEPORT:-47300}"
SEED="${NFSU2_REGFILE_SEED:-$ROOT/tests/web/seed/registry_perf4_native.txt}"
if [ -z "$NFSU2_DATA" ]; then for d in "$ROOT/../../gamedata" "$ROOT/../../work/gamedata"; do [ -f "$d/SPEED2.EXE" ] && export NFSU2_DATA="$(cd "$d" && pwd)" && break; done; fi
N=$#; i=0; names=(); pids=()
for spec in "$@"; do
  IFS='|' read -r name script vars <<< "$spec"
  names+=("$name")
  peers=""
  for j in $(seq 0 $((N - 1))); do [ "$j" = "$i" ] || peers="${peers:+$peers,}127.0.0.1:$((BASE + j))"; done
  d="$OUT/$name"; rm -rf "$d"; mkdir -p "$d"
  # shellcheck disable=SC2086
  # the instance's variables go into autorun.sh's environment too (it copies
  # NFSU2_SAVE_SEED before it exports its arguments)
  env NFSU2_REGFILE_SEED="$SEED" $vars "$ROOT/tools/autorun.sh" "$d" NOFOCUS=2 NFSU2_TIMEOUT="$TMO" ALARM="$TMO" \
      NFSU2_FNG_LOG=1 NFSU2_STATUS_EVERY=1200 NFSU2_DUMP_SCALE=0.5 \
      NFSU2_ROAM=1 NFSU2_ROAM_PORT=$((BASE + i)) NFSU2_ROAM_PEERS="$peers" NFSU2_ROAM_NAME="$name" ROAM_PROFILE="$name" \
      NFSU2_ROAM_POSELOG="$d/pose.csv" NFSU2_INPUT_SCRIPT="$([ "${script#/}" != "$script" ] && echo "$script" || echo "$ROOT/tests/scripts/$script")" $vars \
      > "$d.run" 2>&1 < /dev/null &
  pids+=($!)
  echo "roam_multi: $name on 127.0.0.1:$((BASE + i)), peers $peers, script $script (autorun pid $!)"
  i=$((i + 1))
  sleep "${ROAM_STAGGER:-2}"
done
game_pid(){ pgrep -P "$1" 2>/dev/null | head -1; }
if [ -n "$ROAM_KILL" ]; then
  kn="${ROAM_KILL%%:*}"; ks="${ROAM_KILL##*:}"
  ( sleep "$ks"
    for k in "${!names[@]}"; do
      if [ "${names[$k]}" = "$kn" ]; then
        # autorun.sh's child is the game (sandbox-exec execs it in place)
        g=$(game_pid "${pids[$k]}")
        [ -n "$g" ] && kill -9 "$g" && echo "roam_multi: killed $kn (pid $g) after ${ks}s"
      fi
    done ) &
  killer=$!
fi
deadline=$(( $(date +%s) + TMO + 60 ))
for k in "${!pids[@]}"; do
  while kill -0 "${pids[$k]}" 2>/dev/null; do
    if [ "$(date +%s)" -gt "$deadline" ]; then
      g=$(game_pid "${pids[$k]}"); [ -n "$g" ] && kill "$g" 2>/dev/null; kill "${pids[$k]}" 2>/dev/null
      echo "roam_multi: ${names[$k]} stopped (over time)"; break
    fi
    sleep 2
  done
  wait "${pids[$k]}" 2>/dev/null; rc=$?
  echo "roam_multi: ${names[$k]} exit=$rc ($(tail -1 "$OUT/${names[$k]}.run" 2>/dev/null))"
done
[ -n "$killer" ] && kill "$killer" 2>/dev/null
# no packet left the Mac: any BLOCKED line is a failure
if grep -l "BLOCKED" "$OUT"/*/log.txt >/dev/null 2>&1; then echo "roam_multi: BLOCKED lines found:"; grep -h "BLOCKED" "$OUT"/*/log.txt | head; exit 1; fi
exit 0
