#!/bin/bash
# lan_race.sh -- end-to-end LAN check: two game instances on the virtual LAN
# race each other to the finish (about 8 minutes).
#
#   tests/net/lan_race.sh <outdir> [circuit|sprint|drag] [races]
#
# Instance 1 hosts with the lifted server.dll (Host LAN Server, Select Car,
# Create Game), instance 2 finds it, joins (lobby Filter for sprint/drag) and
# readies; the game's AI drives both cars (drag: the synthetic pad).  Scripts
# from tools/gen_lan_race.py, run by tests/net/vlan_run.sh (NOFOCUS=2,
# loopback-only sandbox, no real network).  PASS when both instances exit 0
# through their scripts, reach the results screen (UI_PostRaceResults.fng),
# log no fault / timeout / trap / unresolved call / "[net] BLOCKED", and
# tools/lan_trace.py finds each car where its owner had it while the two
# cars are within 150 m of each other (p95 < 1.5 m, no teleports, at least
# 500 such frames).  Farther apart the game shows a car less closely (steps
# every 0.1 s from about 150-200 m, 1-2.5 m off beyond 300 m: an AI car that
# crashes at the start leaves the other alone for the rest of the race,
# netfix/lanrace-final; tools/lan_trace.py).  The results
# tables are in <outdir>/i*/ *results*.png.
# races > 1: one session of that many races (after each, the host creates a
# new game and the joiner presses Refresh and joins it); PASS also needs the
# last race's results on both, and the guest heap after each race is printed
# (a long LAN evening); the trace check covers the first race.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:?usage: tests/net/lan_race.sh <outdir> [circuit|sprint|drag] [races]}"; MODE="${2:-circuit}"; RACES="${3:-1}"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
PY="$ROOT/.venv/bin/python"; [ -x "$PY" ] || PY=python3
# game data: NFSU2_DATA, else a gamedata folder two folders up from the checkout
if [ -z "${NFSU2_DATA:-}" ]; then
  for d in "$ROOT/../../work/gamedata" "$ROOT/../../gamedata"; do [ -f "$d/SPEED2.EXE" ] && NFSU2_DATA="$d" && break; done
fi
export NFSU2_DATA="${NFSU2_DATA:?set NFSU2_DATA to the game folder}"
G="$ROOT/tools/gen_lan_race.py"
case "$MODE" in
  circuit) H="--mode 0 --race-ms 120000"; J="--refresh --race-ms 120000" ;;
  sprint)  H="--mode 1 --race-ms 90000";  J="--filter 1 --race-ms 90000" ;;
  drag)    H="--mode 2 --drag --race-ms 40000"; J="--filter 2 --drag --race-ms 40000" ;;
  *) echo "mode: circuit|sprint|drag"; exit 2 ;;
esac
# shellcheck disable=SC2086
"$PY" "$G" host --name HOSTMAC --car 0 --races "$RACES" $H > "$OUT/host.txt" || exit 2
# shellcheck disable=SC2086
"$PY" "$G" join --name JOINER --car 1 --races "$RACES" $J > "$OUT/join.txt" || exit 2
NFSU2_TIMEOUT="${NFSU2_TIMEOUT:-$((900 * RACES))}" NET_EXTRA="${NET_EXTRA:-}" \
  NET_EXTRA_1="NFSU2_CAR_TRACE=$OUT/i1/cars.csv" NET_EXTRA_2="NFSU2_CAR_TRACE=$OUT/i2/cars.csv" \
  "$ROOT/tests/net/vlan_run.sh" "$OUT" --quit-after $((1800 * RACES)) -- "$OUT/host.txt" "$OUT/join.txt" > "$OUT/vlan_run.txt" 2>&1
rc=$?
why=""
[ $rc -eq 0 ] || why="$why exit=$rc"
for i in 1 2; do
  log="$OUT/i$i/log.txt"
  LC_ALL=C grep -aq "quit at guest frame" "$log" || why="$why i$i:no-quit"
  LC_ALL=C grep -aq "screen UI_PostRaceResults.fng" "$log" || why="$why i$i:no-results"
  LC_ALL=C grep -aq "FAULT IN GUEST\|GUEST MEMORY FAULT\|HOST SEGV" "$log" && why="$why i$i:fault"
  LC_ALL=C grep -aq "TIME LIMIT REACHED" "$log" && why="$why i$i:timeout"
  LC_ALL=C grep -aq "^\[trap\]" "$log" && why="$why i$i:trap"
  LC_ALL=C grep -aq "UNRESOLVED INDIRECT" "$log" && why="$why i$i:unresolved-icall"
  LC_ALL=C grep -aq "^\[net\] BLOCKED" "$log" && why="$why i$i:net-blocked"
  if [ "$RACES" -gt 1 ]; then
    LC_ALL=C grep -aq "LOG results_r$RACES\$" "$log" || why="$why i$i:no-results-r$RACES"
    # guest heap after each race (heap.c's [status] line at the results screen:
    # live/peak and the reserved VA), a long LAN evening
    echo "i$i: $(LC_ALL=C awk '/LOG results(_r[0-9]+)?$/{r=$NF; w=1; next} w && /^\[status\]/{match($0, /heap=[^ ]+ va=[^ ]+/); printf "%s %s; ", r, substr($0, RSTART, RLENGTH); w=0}' "$log")"
  fi
done
"$PY" "$ROOT/tools/lan_trace.py" "$OUT" > "$OUT/trace.txt" 2>&1
cat "$OUT/trace.txt"
"$PY" - "$OUT/trace.txt" <<'EOF' || why="$why trace"
import re, sys
t = open(sys.argv[1]).read()
near = re.findall(r'within \d+ m of the viewer: (\d+) samples, err median \S+ m, p95 (\S+) m; jumps (\d+)', t)
ok = len(near) == 2 and all(int(n) >= 500 and float(p) < 1.5 and int(j) == 0 for n, p, j in near)
sys.exit(0 if ok else 1)
EOF
if [ -z "$why" ]; then echo "PASS lan_race $MODE ($OUT)"; exit 0; fi
echo "FAIL lan_race $MODE:$why ($OUT)"; exit 1
