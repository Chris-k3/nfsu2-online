#!/bin/bash
# Unit tests for runtime/discord.c (no game, no real Discord): builds
# out/discord_unit and runs every case; the IPC cases talk to
# tools/mock_discord.py on a socket in a private temp dir, never to the
# Discord app.  Takes about 40 s.
#   tests/discord_unit.sh [case ...]
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
mkdir -p out
clang -O1 -g -Wall -Wextra -Wno-unused-parameter -Wno-unused-function -Iruntime \
      -o out/discord_unit tests/discord_unit.c runtime/mem.c -lm || exit 1
# Unix socket paths must stay under 104 bytes: a short private dir.
TMP="$(mktemp -d /tmp/nfsu2-discord.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
CASES="${*:-text state guard bench ipc absent late restart park noready close garbage slow error badid noread}"
fail=0
for c in $CASES; do
  echo "== $c"
  env -u NFSU2_DISCORD_IPC -u NFSU2_INPUT_SCRIPT TMPDIR="$TMP" XDG_RUNTIME_DIR="$TMP" \
      ./out/discord_unit "$c" "$ROOT/tools/mock_discord.py" "$TMP" > "$TMP/$c.out" 2>&1
  rc=$?
  grep -E "^(PASS|FAIL|INFO)" "$TMP/$c.out"
  [ $rc -eq 0 ] || { fail=1; echo "FAIL $c: exit $rc"; tail -5 "$TMP/$c.out"; }
  if [ -f "$TMP/$c.jsonl" ]; then
    /usr/bin/python3 -I "$ROOT/tests/discord_check.py" "$c" "$TMP/$c.jsonl" > "$TMP/$c.check"; rc=$?
    grep -v "^INFO   t=" "$TMP/$c.check"
    [ $rc -eq 0 ] || fail=1
  fi
  # the client never logs the READY payload (it holds the user's Discord name)
  if grep -q "mock-user-secret" "$TMP/$c.out"; then echo "FAIL $c: READY payload leaked into the log"; fail=1; fi
done
[ $fail -eq 0 ] && echo "discord unit tests: all passed" || echo "discord unit tests: FAILED"
exit $fail
