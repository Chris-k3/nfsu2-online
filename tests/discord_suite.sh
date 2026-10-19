#!/bin/bash
# Game-level Discord Rich Presence scenarios (runtime/discord.c).
#   tests/discord_suite.sh <outdir> [flow gamequit customize latekill malformed absent]
#
# Every run talks to tools/mock_discord.py through NFSU2_DISCORD_IPC=<socket in
# a private temp dir>, never to the Discord app; TMPDIR and XDG_RUNTIME_DIR
# point at that dir too.  One game instance at a time.  Scenarios:
#   flow       boot -> menus -> Circuit (pause, quit to menu) -> Drift -> menus ->
#              clean quit: presence texts in order, timers, rate limit, clear + CLOSE
#   gamequit   the game's own Quit Game (ExitProcess): clear + CLOSE at once
#   customize  main menu -> Customize -> car shop -> parts: "Customizing" + the car
#   latekill   Discord absent at start, appears mid-race (connects); then killed
#              mid-race (game unaffected) and started again (reconnects)
#   malformed  Discord answers garbage, never READY, is slow, closes at once,
#              then behaves: no hang, no crash, presence shown in the end
#   absent     Discord never there: baseline frame pacing for the same race
# Needs NFSU2_DATA (game folder) unless the default ../../work/gamedata works.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:?usage: tests/discord_suite.sh <outdir> [scenario...]}"; shift
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
SEED="${NFSU2_REGFILE_SEED:-$ROOT/tests/web/seed/registry_perf4_native.txt}"
SCEN="${*:-flow gamequit customize latekill malformed absent}"
SOCKDIR="$(mktemp -d /tmp/nfsu2-dsuite.XXXXXX)"            # short: sun_path < 104 bytes
MOCK="/usr/bin/python3 -I $ROOT/tools/mock_discord.py"
MPID=""; GPID=""
cleanup(){ [ -n "$MPID" ] && kill "$MPID" 2>/dev/null; [ -n "$GPID" ] && { pkill -P "$GPID" 2>/dev/null; kill "$GPID" 2>/dev/null; }
           rm -rf "$SOCKDIR"; }
trap cleanup EXIT

now(){ /usr/bin/python3 -c 'import time; print("%.3f" % time.time())'; }
ev(){ echo "$(now) $*" >> "$D/events.txt"; echo "  [$(date +%T)] $*"; }
mock_start(){   # mode
  $MOCK "$SOCK" --log "$D/frames.jsonl" --mode "$1" --ping 5 > /dev/null 2>&1 &
  MPID=$!
  for _ in $(seq 100); do [ -S "$SOCK" ] && break; sleep 0.05; done
  ev "mock $1 started"
}
mock_kill(){    # signal
  [ -n "$MPID" ] && kill "-$1" "$MPID" 2>/dev/null && wait "$MPID" 2>/dev/null
  MPID=""; rm -f "$SOCK"; ev "mock killed ($1)"
}
game_start(){   # script, extra VAR=val...
  local s="$1"; shift
  NFSU2_REGFILE_SEED="$SEED" TMPDIR="$SOCKDIR" XDG_RUNTIME_DIR="$SOCKDIR" \
    "$ROOT/tools/autorun.sh" "$D/game" NOFOCUS=2 NFSU2_TIMEOUT=420 NFSU2_FNG_LOG=1 NFSU2_STATUS_EVERY=1200 \
      NFSU2_DUMP_SCALE=0.3 NFSU2_INPUT_SCRIPT="$ROOT/tests/scripts/$s" \
      NFSU2_DISCORD=1 NFSU2_DISCORD_IPC="$SOCK" NFSU2_DISCORD_LOG=1 "$@" > "$D/game.run" 2>&1 < /dev/null &
  GPID=$!
  ev "game started ($s)"
}
game_wait(){ wait "$GPID"; local rc=$?; GPID=""; ev "game exited ($rc)"; return $rc; }
# wait until the mock log has a frame matching a regex (or the game ended)
wait_frames(){  # regex timeout_s
  local t=0
  while [ $t -lt $(( $2 * 10 )) ]; do
    grep -qE "$1" "$D/frames.jsonl" 2>/dev/null && return 0
    [ -n "$GPID" ] && ! kill -0 "$GPID" 2>/dev/null && return 1
    sleep 0.1; t=$((t + 1))
  done
  return 1
}
wait_count(){   # regex count timeout_s  (mock log)
  local t=0
  while [ $t -lt $(( $3 * 10 )) ]; do
    [ "$(grep -cE "$1" "$D/frames.jsonl" 2>/dev/null)" -ge "$2" ] && return 0
    [ -n "$GPID" ] && ! kill -0 "$GPID" 2>/dev/null && return 1
    sleep 0.1; t=$((t + 1))
  done
  return 1
}
wait_log(){     # regex timeout_s  (game log)
  local t=0
  while [ $t -lt $(( $2 * 10 )) ]; do
    LC_ALL=C grep -aqE "$1" "$D/game/log.txt" 2>/dev/null && return 0
    [ -n "$GPID" ] && ! kill -0 "$GPID" 2>/dev/null && return 1
    sleep 0.1; t=$((t + 1))
  done
  return 1
}
check(){        # case
  /usr/bin/python3 -I "$ROOT/tests/discord_check.py" "$1" "$D/frames.jsonl" "$D/game/log.txt" "$D/events.txt" \
    > "$D/check.txt" 2>&1
  local rc=$?
  grep -v "^INFO   t=" "$D/check.txt" | sed 's/^/  /'
  "$ROOT/.venv/bin/python" "$ROOT/tools/contact_sheet.py" "$D/game" 5 260 >/dev/null 2>&1
  return $rc
}

pass=0; fail=0
for name in $SCEN; do
  D="$OUT/$name"; rm -rf "$D"; mkdir -p "$D"; : > "$D/events.txt"; : > "$D/frames.jsonl"
  SOCK="$SOCKDIR/$name.sock"
  echo "== $name"
  ok=1
  case "$name" in
  flow)
    mock_start normal
    game_start discord_flow.txt
    game_wait || ok=0
    sleep 0.5; mock_kill TERM ;;
  gamequit)
    mock_start normal
    game_start discord_gamequit.txt
    # ExitProcess clears the presence at once; in a window the base port then
    # stays open until its timeout (not a Discord matter), so stop it here.
    wait_log "LOG MARK quitting" 120 || ok=0
    wait_frames '"op": 2' 20 || ok=0
    ev "CLOSE received"
    sleep 2; pkill -P "$GPID" 2>/dev/null; game_wait
    mock_kill TERM ;;
  latekill)
    game_start discord_race_long.txt
    wait_log "LOG MARK race" 180 || ok=0
    ev "race"
    sleep 8
    mock_start normal                                      # Discord appears mid-race
    wait_frames '"state": "Lap ' 40 || { ok=0; echo "  no race presence after Discord appeared"; }
    ev "race presence shown"
    sleep 10
    mock_kill KILL                                         # Discord dies mid-race
    sleep 15
    mock_start normal                                      # ... and comes back
    wait_count '"dir": "in", "op": 0' 2 40 || { ok=0; echo "  no reconnection"; }
    ev "reconnected"
    game_wait || ok=0
    sleep 0.5; mock_kill TERM ;;
  malformed)
    game_start discord_race_long.txt
    raced=0
    for m in garbage noready slow close error; do
      mock_start "$m"
      for _ in $(seq 25); do
        sleep 1
        [ $raced -eq 0 ] && LC_ALL=C grep -aq "LOG MARK race" "$D/game/log.txt" 2>/dev/null && { raced=1; ev "race"; }
      done
      mock_kill KILL
    done
    mock_start normal
    wait_frames '"details": "Circuit' 60 || { ok=0; echo "  no presence once Discord behaved"; }
    ev "race presence shown"
    game_wait || ok=0
    sleep 0.5; mock_kill TERM ;;
  customize)
    mock_start normal
    game_start mainmenu_item3.txt
    game_wait || ok=0
    sleep 0.5; mock_kill TERM ;;
  absent)
    game_start discord_race_long.txt
    wait_log "LOG MARK race" 180 || ok=0
    ev "race"
    game_wait || ok=0 ;;
  *) echo "unknown scenario $name"; ok=0 ;;
  esac
  check "$name" || ok=0
  if [ $ok -eq 1 ]; then pass=$((pass+1)); echo "PASS $name"; else fail=$((fail+1)); echo "FAIL $name"; fi
done
echo "discord suite: $pass passed, $fail failed  ($OUT)"
[ $fail -eq 0 ]
