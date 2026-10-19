#!/usr/bin/env python3
"""Checks a tools/mock_discord.py frame log (and, for game runs, the game log).

    tests/discord_check.py <case> <frames.jsonl> [game log.txt [events.txt]]

Prints "PASS ..."/"FAIL ..." lines and exits 1 on any failure.  Cases are the
ones of tests/discord_unit.c (ipc late restart park noready close garbage slow
error badid noread) and of tests/discord_suite.sh (flow gamequit customize latekill malformed absent);
for those also the game log and the suite's events file (epoch seconds + what).
"""
import json, re, sys

DEFAULT_ID = '1442720706248052796'
fails = 0


def check(ok, msg):
    global fails
    print(('PASS ' if ok else 'FAIL ') + msg)
    if not ok: fails += 1


def load(path):
    rows = [json.loads(l) for l in open(path, encoding='utf-8') if l.strip()]
    # split into mock instances (a restarted mock appends to the same log)
    sessions, cur = [], None
    for r in rows:
        if r.get('dir') == 'event' and r.get('what') == 'listening':
            cur = []; sessions.append(cur)
        if cur is not None: cur.append(r)
    return rows, sessions


def activities(rows):
    """[(t, conn, activity-or-None)] for every SET_ACTIVITY the client sent."""
    out = []
    for r in rows:
        if r.get('dir') == 'in' and r.get('op') == 1 and isinstance(r.get('json'), dict) \
                and r['json'].get('cmd') == 'SET_ACTIVITY':
            out.append((r['t'], r.get('conn'), r['json'].get('args', {}).get('activity')))
    return out


def text(a):
    return None if a is None else (a.get('details', '') + ' | ' + a.get('state', ''))


def common(rows, app_id=DEFAULT_ID):
    bad = [r for r in rows if r.get('dir') == 'in' and isinstance(r.get('json'), dict) and '_raw' in r['json']]
    check(not bad, f'every client frame is valid UTF-8 JSON ({len(bad)} bad)')
    viol = [r['why'] for r in rows if r.get('what') == 'violation']
    check(not viol, 'no protocol/limit violations' + (f': {viol[:3]}' if viol else ''))
    hs = [r['json'] for r in rows if r.get('dir') == 'in' and r.get('op') == 0]
    check(all(h == {'v': 1, 'client_id': app_id} for h in hs),
          f'handshakes are {{"v":1,"client_id":"{app_id}"}} ({len(hs)} seen)')
    for s in split_conns(rows):
        n = [r['json'].get('nonce') for r in s if r.get('dir') == 'in' and r.get('op') == 1 and isinstance(r.get('json'), dict)]
        if len(n) != len(set(n)):
            check(False, f'nonces are unique per connection ({len(n)} commands, {len(set(n))} distinct)')
    return hs


def split_conns(rows):
    out, cur = [], {}
    for r in rows:
        if r.get('dir') == 'event' and r.get('what') == 'listening':
            for v in cur.values(): out.append(v)
            cur = {}
        if r.get('conn') is not None: cur.setdefault(r['conn'], []).append(r)
    out += list(cur.values())
    return out


def clean_end(rows):
    """The last connection ends with a clear (SET_ACTIVITY without activity) then CLOSE."""
    ins = [r for r in rows if r.get('dir') == 'in']
    if len(ins) < 2:
        check(False, 'clear + CLOSE at quit (too few frames)'); return
    last, before = ins[-1], ins[-2]
    ok = last.get('op') == 2 and before.get('op') == 1 and before['json'].get('cmd') == 'SET_ACTIVITY' \
        and 'activity' not in before['json'].get('args', {})
    check(ok, 'quit: activity cleared, then CLOSE')


def has_seq(acts, want):
    """want: list of (details-substring, state-substring) that must appear in this order."""
    i = 0
    for _, _, a in acts:
        if i < len(want) and a is not None and want[i][0] in a.get('details', '') and want[i][1] in a.get('state', ''):
            i += 1
    return i == len(want), i


def main():
    case, path = sys.argv[1], sys.argv[2]
    game = sys.argv[3] if len(sys.argv) > 3 else None
    rows, sessions = load(path)
    acts = activities(rows)
    print(f'INFO {case}: {len(rows)} log rows, {len(sessions)} mock instance(s), {len(acts)} SET_ACTIVITY')
    for t, c, a in acts:
        print(f'INFO   t={t:7.2f} conn={c} {text(a) if a is not None else "(clear)"}'
              + (f' start={a.get("timestamps", {}).get("start")}' if a else ''))
    hs = common(rows)

    if case == 'ipc':
        ok, n = has_seq(acts, [('In the menus', ''), ('Customizing', 'Nissan 350Z'), ('Loading', 'Circuit'),
                               ('Circuit', 'Lap'), ('Career', 'Free roaming as A"B\\ é'), ('In the menus', '')])
        check(ok, f'presence sequence menus -> customize -> loading -> race -> career (odd name) -> menus ({n}/6)')
        last = [a for _, _, a in acts if a is not None][-1]
        check(last.get('details') == 'In the menus', f'coalescing: the last state shown is the latest one ({text(last)})')
        pongs = sum(1 for r in rows if r.get('dir') == 'in' and r.get('op') == 4)
        pings = sum(1 for r in rows if r.get('dir') == 'out' and r.get('op') == 3)
        check(pings > 0 and pongs >= pings - 1, f'PING answered with PONG ({pongs}/{pings})')
        clean_end(rows)
    elif case == 'late':
        check(len(hs) >= 1 and len(acts) >= 1, 'connected and showed a presence after Discord appeared')
        clean_end(rows)
    elif case == 'restart':
        check(len(sessions) == 2, 'two Discord instances (killed and started again)')
        for k, s in enumerate(sessions):
            a = [x for x in activities(s) if x[2] is not None]
            check(len(a) >= 1 and 'Circuit' in a[0][2].get('details', ''),
                  f'instance {k + 1}: race presence shown ({text(a[0][2]) if a else "none"})')
        clean_end(sessions[-1])
    elif case == 'park':
        ok, n = has_seq(acts, [('Circuit', 'Lap 2/3'), ('Circuit', 'Paused'), ('Circuit', 'Lap 2/3'),
                               ('Circuit', 'Paused'), ('Circuit', 'Lap 2/3'), ('In the menus', '')])
        check(ok, f'park: race -> paused while parked -> race -> paused -> race -> menus ({n}/6 steps in order)')
        race = [(t, a) for t, _, a in acts if a is not None and a.get('details', '').startswith('Circuit')]
        st = [(a.get('state', ''), a.get('timestamps', {}).get('start')) for _, a in race]
        laps = [s0 for x, s0 in st if x.startswith('Lap')]
        print(f'INFO park: race presences {st}')
        check(len(laps) >= 3 and laps[1] >= laps[0] + 3 and laps[2] == laps[1],
              f'park: after a 4 s park the race timer comes back re-anchored (later), after a 1 s park unchanged ({laps})')
        first_pause = next((i for i, (x, _) in enumerate(st) if x == 'Paused'), None)
        stale = [s0 for x, s0 in st[first_pause or 0:] if x.startswith('Lap') and laps and s0 == laps[0]]
        check(first_pause is not None and not stale,
              'park: the race with its pre-park timer is not shown again after the resume (waits for a fresh sample)')
        clean_end(rows)
    elif case in ('noready', 'close', 'garbage', 'slow'):
        check(len(hs) >= (1 if case == 'slow' else 2), f'{case}: handshake retried with backoff ({len(hs)} handshakes)')
        check(not [a for a in acts if a[2] is not None] or case == 'slow',
              f'{case}: no presence sent to a Discord that never became ready')
    elif case == 'error':
        check(len(acts) >= 1, 'error: presence sent and refused by Discord (ERROR reply)')
    elif case == 'noread':
        stopped = sum(1 for r in rows if r.get('what') == 'stopped reading')
        ended = sum(1 for r in rows if r.get('what') == 'flood ended')
        check(stopped >= 1 and ended >= 1 and len(hs) >= 2,
              f'noread: a Discord that stops reading is dropped and reconnected ({stopped} stopped reading, '
              f'{ended} dropped by the client, {len(hs)} handshakes)')
    elif case == 'badid':
        check(2 <= len(hs) <= 8, f'badid: refused client id retried slowly ({len(hs)} handshakes in ~4 s)')
    elif case == 'flow':
        # "Loading..." is shown only when a load lasts longer than the settle time (1 s), so it is optional here
        ok, n = has_seq(acts, [('In the menus', ''), ('Circuit — ', 'On the starting line'),
                               ('Circuit — ', 'Lap 1/3'), ('Circuit — ', 'Paused'), ('In the menus', ''),
                               ('Drift — ', 'On the starting line'), ('Drift — ', 'pts'), ('Drift — ', 'Paused'),
                               ('In the menus', '')])
        check(ok, f'flow presence sequence menus -> circuit (grid, lap, paused) -> menus -> drift (grid, points, '
                  f'paused) -> menus ({n}/9 steps seen in order)')
        loads = [text(a) for _, _, a in acts if a and a.get('details', '').startswith('Loading')]
        print(f'INFO loading screens long enough to be shown: {loads}')
        starts = [a.get('timestamps', {}).get('start') for _, _, a in acts if a]
        menus = [a.get('timestamps', {}).get('start') for _, _, a in acts if a and a.get('details') == 'In the menus']
        check(len(set(menus)) == 1, f'menus keep the session timer ({sorted(set(menus))})')
        race = [a.get('timestamps', {}).get('start') for _, _, a in acts if a and a.get('details', '').startswith('Circuit')]
        check(bool(race) and bool(menus) and min(race) > menus[0], 'the race has its own (later) timer')
        # both quick races have 4 racers (the HUD shows "/4"); the race status
        # keeps 6 entries, of which only the first [+0x24] are in use
        counts = sorted({int(m.group(1)) for _, _, a in acts if a
                         for m in [re.search(r' of (\d+)', a.get('state', ''))] if m})
        check(counts == [4], f'racer count is the 4 of the race ("of N" seen: {counts})')
        clean_end(rows)
    elif case == 'gamequit':
        ok, n = has_seq(acts, [('In the menus', '')])
        check(ok, 'menus shown before quitting')
        clean_end(rows)
    elif case == 'customize':
        ok, n = has_seq(acts, [('In the menus', ''), ('Customizing', 'Peugeot 206')])
        check(ok, 'customize shows the car on screen (Peugeot 206, the default first car)')
        clean_end(rows)
    elif case == 'latekill':
        check(len(sessions) == 2, 'Discord appeared mid-race, was killed and started again (2 instances)')
        for k, s in enumerate(sessions):
            a = [x for x in activities(s) if x[2] is not None]
            check(len(a) >= 1 and 'Circuit' in a[0][2].get('details', ''),
                  f'instance {k + 1}: the current race was shown ({text(a[0][2]) if a else "none"})')
        clean_end(sessions[-1] if sessions else rows)
    elif case == 'malformed':
        modes = [next((r.get('mode') for r in s if r.get('what') == 'listening'), '?') for s in sessions]
        print(f'INFO mock instances: {modes}')
        for m, s in zip(modes, sessions):
            h = [r for r in s if r.get('dir') == 'in' and r.get('op') == 0]
            print(f'INFO   {m}: {len(h)} handshake(s), {len([x for x in activities(s)])} SET_ACTIVITY')
        last = sessions[-1] if sessions else []
        a = [x for x in activities(last) if x[2] is not None]
        check(modes[-1:] == ['normal'] and len(a) >= 1, 'once Discord behaved, the presence was shown')
        check(sum(1 for m, s in zip(modes, sessions) if m != 'normal' and any(r.get('op') == 0 for r in s)) >= 3,
              'the client met at least 3 misbehaving Discords')
        clean_end(last)
    elif case == 'absent':
        check(len(rows) == 0 or not hs, 'no Discord, no connection')

    if game:
        log = open(game, encoding='latin-1').read()
        if case == 'gamequit':
            check('guest ExitProcess' in log, 'game: quit through its own menu (ExitProcess)')
            check('[discord] presence -> (cleared)' in log, 'game: cleared the presence at ExitProcess')
        else:
            check('quit at guest frame' in log, 'game: reached the end of its script')
            check(not re.search(r'FAULT IN GUEST|GUEST MEMORY FAULT|HOST SEGV|TIME LIMIT REACHED', log), 'game: no fault or timeout')
        check('[discord] on:' in log, 'game: Discord presence was on (mock socket only)')
        check('mock-user-secret' not in log, "game: the READY payload (user's Discord name) is never logged")
        frames = [(float(m.group(1)), int(m.group(2)), float(m.group(3)), float(m.group(4)))
                  for m in re.finditer(r'\[discord\] frames: wall=([\d.]+) n=(\d+) avg=([\d.]+)ms max=([\d.]+)ms', log)]
        events = []
        if len(sys.argv) > 4:
            for l in open(sys.argv[4]):
                t, _, what = l.strip().partition(' ')
                events.append((float(t), what))
        race = [t for t, w in events if w == 'race']
        end = [t for t, w in events if w.startswith('game exited')]
        if frames and race and end:
            # the steady part of the race: from 10 s after it started to 8 s before the game quit
            win = [f for f in frames if race[0] + 10 <= f[0] - 5 and f[0] <= end[-1] - 8]
            if win:
                worst = max(f[3] for f in win)
                avg = sum(f[2] * f[1] for f in win) / sum(f[1] for f in win)
                print(f'INFO race frame pacing: {len(win)} windows of 5 s, avg {avg:.2f} ms/frame, worst frame {worst:.1f} ms')
                for t, w in events:
                    if w.startswith('mock') or w.startswith('race presence') or w == 'reconnected':
                        near = [f for f in win if f[0] - 5 <= t <= f[0]]
                        if near:
                            print(f'INFO   window with "{w}": avg {near[0][2]:.2f} ms, max {near[0][3]:.1f} ms')
                if case in ('latekill', 'malformed', 'absent'):
                    check(worst < 250, f'game: no stalled frame during the race (worst {worst:.1f} ms; a blocking '
                          f'socket call would stall >= 1000 ms)')
                with open(game + '.pacing.json', 'w') as f:
                    json.dump({'avg_ms': avg, 'worst_ms': worst, 'windows': len(win)}, f)
        m = re.search(r'\[discord\] sampler: (\d+) samples, avg ([\d.]+) us, max ([\d.]+) us', log)
        if m: print(f'INFO game sampler cost: {m.group(1)} samples, avg {m.group(2)} us, max {m.group(3)} us')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
