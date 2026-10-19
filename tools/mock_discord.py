#!/usr/bin/env python3
"""Mock Discord desktop IPC server for testing runtime/discord.c (never the real client).

    tools/mock_discord.py <socket path> [--log frames.jsonl] [--mode MODE] [--duration S]
                          [--ping S] [--reply-delay S]

Listens on a Unix socket like the Discord app's discord-ipc-N and speaks its
framing: 8-byte little-endian header {opcode, length} + UTF-8 JSON.  Every
frame in both directions goes to the log as one JSON object per line:
    {"t": <seconds since start>, "conn": N, "dir": "in"|"out"|"event", "op": OP, "json": <payload>}
"json" is the decoded payload, or {"_raw": "..."} when it was not valid JSON
(a test treats that as a failure).  Checks Discord's own limits as it goes and
logs "event" lines for violations (rate limit, field lengths, forbidden fields).

Modes (how the server misbehaves):
    normal     handshake -> READY, SET_ACTIVITY -> reply (default)
    noready    accept the handshake, never answer (client must time out)
    close      close the socket right after the handshake
    garbage    answer the handshake with random bytes and an absurd header
    slow       answer nothing for --reply-delay seconds, and do not read meanwhile
    error      READY, then an ERROR reply to every SET_ACTIVITY
    badid      CLOSE {code 4000, "Invalid Client ID"} after the handshake
    noread     READY, then never read again while sending a 1.5 KB PING every
               10 ms: the client's PONGs fill the socket buffer (its writes
               block); it must drop the connection without stalling the game
--ping S: also send a PING every S seconds (the client must answer PONG).
--rate-n/--rate-window: the rate limit to check (Discord: 5 per 20 s).
SIGTERM/SIGINT: stop, writing a final {"dir":"event","what":"exit"} line.
"""
import argparse, json, os, random, selectors, signal, socket, struct, sys, time

OPS = {0: 'HANDSHAKE', 1: 'FRAME', 2: 'CLOSE', 3: 'PING', 4: 'PONG'}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('path')
    ap.add_argument('--log')
    ap.add_argument('--mode', default='normal',
                    choices=['normal', 'noready', 'close', 'garbage', 'slow', 'error', 'badid', 'noread'])
    ap.add_argument('--duration', type=float, default=0)
    ap.add_argument('--ping', type=float, default=0)
    ap.add_argument('--reply-delay', type=float, default=8.0)
    ap.add_argument('--rate-n', type=int, default=5, help="Discord's limit: N SET_ACTIVITY ...")
    ap.add_argument('--rate-window', type=float, default=20.0, help='... per this many seconds')
    a = ap.parse_args()

    t0 = time.monotonic()
    logf = open(a.log, 'a', buffering=1) if a.log else None

    def log(**kw):
        kw['t'] = round(time.monotonic() - t0, 3)
        line = json.dumps(kw, ensure_ascii=False)
        if logf: logf.write(line + '\n')
        else: print(line, flush=True)

    try: os.unlink(a.path)
    except FileNotFoundError: pass
    ls = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    ls.bind(a.path); ls.listen(4); ls.setblocking(False)
    sel = selectors.DefaultSelector()
    sel.register(ls, selectors.EVENT_READ, None)
    log(dir='event', what='listening', path=a.path, mode=a.mode)

    stop = [False]
    def on_sig(*_): stop[0] = True
    signal.signal(signal.SIGTERM, on_sig); signal.signal(signal.SIGINT, on_sig)

    conns = {}           # sock -> state
    nconn = [0]
    sets = []            # times of SET_ACTIVITY (for the rate check, across connections like Discord)

    def send(s, st, op, obj=None, raw=None):
        body = raw if raw is not None else json.dumps(obj, separators=(',', ':')).encode()
        try: s.sendall(struct.pack('<II', op, len(body)) + body)
        except OSError: return
        log(conn=st['id'], dir='out', op=op, json=obj if raw is None else {'_raw': body[:64].hex()})

    def drop(s, why):
        st = conns.pop(s, None)
        try: sel.unregister(s)
        except Exception: pass
        s.close()
        if st: log(conn=st['id'], dir='event', what='closed', why=why)

    def check_activity(st, j):
        args = j.get('args') if isinstance(j, dict) else None
        if not isinstance(args, dict) or not isinstance(args.get('pid'), int):
            log(conn=st['id'], dir='event', what='violation', why='args.pid missing or not an int')
        if not isinstance(j.get('nonce'), str) or not j.get('nonce'):
            log(conn=st['id'], dir='event', what='violation', why='nonce missing')
        act = (args or {}).get('activity')
        if act is None: return
        for k in ('details', 'state'):
            if k in act:
                v = act[k]
                if not isinstance(v, str) or not (2 <= len(v) <= 128):
                    log(conn=st['id'], dir='event', what='violation', why=f'{k} length {len(v) if isinstance(v, str) else v!r}')
        for k in ('buttons', 'party', 'secrets', 'match', 'join', 'spectate'):
            if k in act:
                log(conn=st['id'], dir='event', what='violation', why=f'forbidden field {k}')
        ts = act.get('timestamps', {}).get('start')
        if ts is not None and not (1.5e9 < ts < 4e9):
            log(conn=st['id'], dir='event', what='violation', why=f'timestamps.start {ts} not Unix seconds')

    def handle(s, st, op, body):
        try:
            j = json.loads(body.decode('utf-8'))
        except Exception:
            log(conn=st['id'], dir='in', op=op, json={'_raw': body[:200].hex()})
            log(conn=st['id'], dir='event', what='violation', why='payload is not valid UTF-8 JSON')
            return
        log(conn=st['id'], dir='in', op=op, json=j)
        if op == 0:
            st['hs'] = True
            if a.mode == 'noready': return
            if a.mode == 'close': drop(s, 'mode close'); return
            if a.mode == 'badid':
                send(s, st, 2, {'code': 4000, 'message': 'Invalid Client ID'}); drop(s, 'mode badid'); return
            if a.mode == 'garbage':
                send(s, st, 1, raw=bytes(random.getrandbits(8) for _ in range(40)))
                try: s.sendall(struct.pack('<II', 77, 0x7fffffff) + b'\xff' * 32)
                except OSError: pass
                log(conn=st['id'], dir='event', what='sent garbage')
                return
            if a.mode == 'slow':
                st['mute_until'] = time.monotonic() + a.reply_delay
                st['pending'].append((1, ready_payload()))
                return
            send(s, st, 1, ready_payload())
            if a.mode == 'noread':
                st['noread'] = True
                try: sel.unregister(s)                      # never read from it again
                except Exception: pass
                log(conn=st['id'], dir='event', what='stopped reading')
        elif op == 1:
            if j.get('cmd') == 'SET_ACTIVITY':
                now = time.monotonic()
                sets.append(now)
                recent = [x for x in sets if now - x < a.rate_window]
                if len(recent) > a.rate_n:
                    log(conn=st['id'], dir='event', what='violation',
                        why=f'rate: {len(recent)} SET_ACTIVITY in {a.rate_window:g} s')
                check_activity(st, j)
                if a.mode == 'error':
                    send(s, st, 1, {'cmd': 'SET_ACTIVITY', 'evt': 'ERROR', 'nonce': j.get('nonce'),
                                    'data': {'code': 4002, 'message': 'child "activity" fails because [mock]'}})
                else:
                    send(s, st, 1, {'cmd': 'SET_ACTIVITY', 'evt': None, 'nonce': j.get('nonce'),
                                    'data': (j.get('args') or {}).get('activity')})
        elif op == 2:
            drop(s, 'client CLOSE')
        elif op == 3:
            send(s, st, 4, j)
        elif op == 4:
            st['pongs'] += 1

    def ready_payload():
        return {'cmd': 'DISPATCH', 'evt': 'READY', 'nonce': None,
                'data': {'v': 1, 'config': {'cdn_host': 'cdn.discordapp.com', 'api_endpoint': '//discord.com/api',
                                            'environment': 'production'},
                         'user': {'id': '1', 'username': 'mock-user-secret', 'discriminator': '0', 'avatar': None}}}

    last_ping = time.monotonic()
    while not stop[0]:
        if a.duration and time.monotonic() - t0 > a.duration: break
        for key, _ in sel.select(timeout=0.1):
            if key.data is None:
                try: c, _ = ls.accept()
                except BlockingIOError: continue
                c.setblocking(False)
                nconn[0] += 1
                conns[c] = {'id': nconn[0], 'buf': b'', 'hs': False, 'pongs': 0, 'mute_until': 0, 'pending': []}
                sel.register(c, selectors.EVENT_READ, 'c')
                log(conn=nconn[0], dir='event', what='accepted')
                continue
            s = key.fileobj; st = conns.get(s)
            if not st: continue
            if time.monotonic() < st['mute_until']: continue      # "slow": do not read
            try: d = s.recv(65536)
            except BlockingIOError: continue
            except OSError: d = b''
            if not d: drop(s, 'client closed'); continue
            st['buf'] += d
            while len(st['buf']) >= 8 and s in conns:
                op, ln = struct.unpack_from('<II', st['buf'])
                if ln > 1 << 20:
                    log(conn=st['id'], dir='event', what='violation', why=f'absurd length {ln}'); drop(s, 'bad frame'); break
                if len(st['buf']) < 8 + ln: break
                body = st['buf'][8:8 + ln]; st['buf'] = st['buf'][8 + ln:]
                handle(s, st, op, body)
        now = time.monotonic()
        for s, st in list(conns.items()):
            if st['pending'] and now >= st['mute_until']:
                for op, obj in st['pending']: send(s, st, op, obj)
                st['pending'] = []
        for s, st in list(conns.items()):
            if st.get('noread') and now - st.get('last_flood', 0) >= 0.01:
                st['last_flood'] = now
                body = json.dumps({'flood': 'x' * 1500}).encode()
                try: s.send(struct.pack('<II', 3, len(body)) + body); st['flood'] = st.get('flood', 0) + 1
                except BlockingIOError: pass
                except OSError:
                    log(conn=st['id'], dir='event', what='flood ended', pings=st.get('flood', 0)); drop(s, 'peer gone')
        if a.ping and now - last_ping >= a.ping:
            last_ping = now
            for s, st in list(conns.items()):
                if st['hs'] and a.mode in ('normal', 'error'): send(s, st, 3, {'ping': int(now * 1000)})
    for s in list(conns): drop(s, 'server exit')
    try: os.unlink(a.path)
    except FileNotFoundError: pass
    log(dir='event', what='exit')


if __name__ == '__main__':
    main()
