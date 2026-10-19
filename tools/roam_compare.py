#!/usr/bin/env python3
"""Free-roam multiplayer: where B shows A's car against where A's car is.

  tools/roam_compare.py <A/pose.csv> <B/pose.csv> [--csv out.csv]

Both files come from NFSU2_ROAM_POSELOG.  "L" rows are an instance's own car
per frame, "R" rows a remote car as shown per frame, all stamped with the host
monotonic clock (shared by every process on one Mac).  For every frame of B
that shows A's car (R rows whose id is A's), A's true position at a host time
t - L is interpolated from A's L rows.  Reported:
  - the latency L* that fits best (B shows A's car L* behind real time),
  - the error at L* (the shape error: smoothing, interpolation, extrapolation),
  - the error at the nominal 100 ms and at L = 0 (what a viewer sees: the gap
    to where A really is now, about speed x latency),
  - frame-to-frame smoothness of B's shown car (step and step-change);
  - when the logs have the drawn position (columns rx, ry, rz: car +0x50, where
    the renderer draws the car, the position minus the rotated centre-of-mass
    offset), the same error for what is drawn: B's drawn car against A's own
    drawn car at the best-fit latency.
"""
import sys, bisect, math

def load(path):
    L, R = [], {}
    own = None
    with open(path) as f:
        next(f, None)
        for line in f:
            p = line.rstrip('\n').split(',')
            if len(p) < 10: continue
            kind, host, sync, pid = p[0], int(p[1]), float(p[2]), p[3]
            x, y, z, sp, mode, err = float(p[4]), float(p[5]), float(p[6]), float(p[7]), int(p[8]), float(p[9])
            d = (float(p[14]), float(p[15]), float(p[16])) if len(p) >= 17 else None
            if kind == 'L':
                own = pid; L.append((host, x, y, z, sp, d))
            elif kind == 'R':
                R.setdefault(pid, []).append((host, x, y, z, sp, mode, err, d))
    return own, L, R

def interp(L, ts, t):
    i = bisect.bisect_left(ts, t)
    if i <= 0 or i >= len(L): return None
    a, b = L[i - 1], L[i]
    if b[0] - a[0] > 200000: return None          # a gap in A's log (pause, load)
    u = (t - a[0]) / (b[0] - a[0])
    return (a[1] + u * (b[1] - a[1]), a[2] + u * (b[2] - a[2]), a[3] + u * (b[3] - a[3]), a[4] + u * (b[4] - a[4]))

def stats(v):
    if not v: return (0, 0, 0, 0, 0)
    s = sorted(v)
    q = lambda f: s[min(len(s) - 1, int(f * len(s)))]
    return (sum(s) / len(s), q(0.5), q(0.95), q(0.99), s[-1])

def main():
    a_id, AL, _ = load(sys.argv[1])
    b_id, BL, BR = load(sys.argv[2])
    out = sys.argv[sys.argv.index('--csv') + 1] if '--csv' in sys.argv else None
    rows = BR.get(a_id, [])
    if not rows or not AL:
        print("no frames of A's car in B's log (A id %s, B shows %s)" % (a_id, list(BR.keys()))); return 1
    ts = [r[0] for r in AL]
    # only frames where A moves (> 1 m/s) count for latency fitting
    moving = [r for r in rows if r[4] > 1.0]
    best = None
    for lat_ms in range(0, 400, 2):
        e = []
        for r in moving[::3]:
            p = interp(AL, ts, r[0] - lat_ms * 1000)
            if p: e.append(math.dist(r[1:4], p[:3]))
        if e:
            m = sum(e) / len(e)
            if best is None or m < best[1]: best = (lat_ms, m)
    if best is None:
        # A never moved faster than 1 m/s while B showed it (a parked or
        # waiting player): nothing to fit a latency to
        print("A never moves faster than 1 m/s in the %d frames B shows it: no latency fit, the errors below use 100 ms" % len(rows))
        best = (100, float('inf'))
    lat = best[0]
    # refine to 0.25 ms
    for l4 in (range(max(0, lat * 4 - 8), lat * 4 + 9) if moving else ()):
        e = []
        for r in moving[::2]:
            p = interp(AL, ts, r[0] - l4 * 250)
            if p: e.append(math.dist(r[1:4], p[:3]))
        if e:
            m = sum(e) / len(e)
            if m < best[1]: best = (l4 / 4.0, m)
    lat = best[0]
    res = {}
    for name, L_ms in (('best', lat), ('100ms', 100.0), ('now', 0.0)):
        e, eh = [], []
        for r in rows:
            p = interp(AL, ts, r[0] - L_ms * 1000)
            if p:
                e.append(math.dist(r[1:4], p[:3])); eh.append(math.hypot(r[1] - p[0], r[2] - p[1]))
        res[name] = (stats(e), stats(eh), len(e))
    # smoothness of the shown car: per-frame step against speed x frame time
    steps, jerks = [], []
    prev = None
    for r in rows:
        if prev and 0 < r[0] - prev[0] < 100000:
            d = math.dist(r[1:4], prev[1:4]); dt = (r[0] - prev[0]) / 1e6
            steps.append(abs(d - 0.5 * (r[4] + prev[4]) * dt))
        prev = r
    speeds = [r[4] for r in rows]
    modes = {}
    for r in rows: modes[r[5]] = modes.get(r[5], 0) + 1
    span = (rows[-1][0] - rows[0][0]) / 1e6
    print("A = %s (%d own frames), B = %s shows A in %d frames over %.1f s; A's speed mean %.1f m/s, max %.1f m/s" %
          (a_id, len(AL), b_id, len(rows), span, sum(speeds) / len(speeds), max(speeds)))
    print("modes: %s (1 interpolating, 2 extrapolating, 3 holding)" % (', '.join('%d: %d' % kv for kv in sorted(modes.items()))))
    print("best-fit latency: %.2f ms (B shows A's car that far behind real time)" % lat)
    for name in ('best', 'now', '100ms'):
        (m, p50, p95, p99, mx), (hm, _, _, hp99, hmx), n = res[name]
        label = {'best': 'at the best-fit latency (shape error)', 'now': 'against where A is at the same instant',
                 '100ms': 'at the nominal 100 ms delay'}[name]
        print("error %-42s 3D mean %.3f m, p50 %.3f, p95 %.3f, p99 %.3f, max %.3f m (horizontal mean %.3f, p99 %.3f, max %.3f; %d frames)" %
              (label, m, p50, p95, p99, mx, hm, hp99, hmx, n))
    # along-track (timing) and cross-track (off A's path) parts at the best-fit
    # latency, and a latency fitted per 2 s window (slow timing drift removed)
    along, cross = [], []
    for r in rows:
        p = interp(AL, ts, r[0] - lat * 1000)
        q = interp(AL, ts, r[0] - lat * 1000 + 20000)
        if not p or not q: continue
        dx, dy = q[0] - p[0], q[1] - p[1]; n = math.hypot(dx, dy)
        if n < 0.02: continue
        ex, ey = r[1] - p[0], r[2] - p[1]
        along.append(abs((ex * dx + ey * dy) / n)); cross.append(abs((-ex * dy + ey * dx) / n))
    sa, sc = stats(along), stats(cross)
    print("error split at the best-fit latency: along the path mean %.3f m, p99 %.3f, max %.3f; across the path mean %.3f m, p99 %.3f, max %.3f" %
          (sa[0], sa[3], sa[4], sc[0], sc[3], sc[4]))
    win, lats = [], []
    t0 = rows[0][0]
    for r in rows:
        if r[0] - t0 > 2000000 or r is rows[-1]:
            mv = [x for x in win if x[4] > 1.0]
            if len(mv) > 30:
                bl = None
                for l in range(0, 600, 2):
                    e = [math.dist(x[1:4], p[:3]) for x in mv[::2] for p in [interp(AL, ts, x[0] - l * 1000)] if p]
                    if e:
                        m = sum(e) / len(e)
                        if bl is None or m < bl[1]: bl = (l, m, e)
                if bl: lats.append(bl[0]); win_err = bl[2]; along_w = 0
            win, t0 = [], r[0]
        win.append(r)
    if lats:
        print("latency per 2 s window: min %d ms, median %d ms, max %d ms (%d windows)" % (min(lats), sorted(lats)[len(lats) // 2], max(lats), len(lats)))
    sm = stats(steps)
    print("smoothness: |step - v*dt| per frame mean %.4f m, p99 %.4f m, max %.4f m (%d frames)" % (sm[0], sm[3], sm[4], len(steps)))
    # what is drawn: B's car at +0x50 against A's own car at +0x50
    if rows[0][7] is not None and AL[0][5] is not None:
        def interp_d(t):
            i = bisect.bisect_left(ts, t)
            if i <= 0 or i >= len(AL): return None
            a, b = AL[i - 1], AL[i]
            if b[0] - a[0] > 200000: return None
            u = (t - a[0]) / (b[0] - a[0])
            return tuple(a[5][k] + u * (b[5][k] - a[5][k]) for k in range(3))
        ed, dc, off = [], [], []
        for r in rows:
            q = interp_d(r[0] - lat * 1000); p = interp(AL, ts, r[0] - lat * 1000); p2 = interp(AL, ts, r[0] - lat * 1000 + 20000)
            if not q or not p: continue
            ed.append(math.dist(r[7], q))
            off.append(math.dist(r[1:4], r[7]))
            if p2:
                dx, dy = p2[0] - p[0], p2[1] - p[1]; n = math.hypot(dx, dy)
                if n >= 0.02:
                    ex, ey = r[7][0] - q[0], r[7][1] - q[1]
                    dc.append(abs((-ex * dy + ey * dx) / n))
        if ed:
            sd, sx, so = stats(ed), stats(dc), stats(off)
            print("drawn position (+0x50) at the best-fit latency: B's drawn car against A's own drawn car mean %.3f m, p50 %.3f, p99 %.3f, max %.3f m; "
                  "across the path mean %.3f m, p99 %.3f m (%d frames); B's drawn-to-body offset mean %.3f m" % (sd[0], sd[1], sd[3], sd[4], sx[0], sx[3], len(ed), so[0]))
    if out:
        with open(out, 'w') as f:
            f.write('host_us,shown_x,shown_y,shown_z,true_x,true_y,true_z,err_best,err_now,speed,mode\n')
            for r in rows:
                p = interp(AL, ts, r[0] - lat * 1000); q = interp(AL, ts, r[0])
                if p and q:
                    f.write('%d,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.4f,%.4f,%.2f,%d\n' % (r[0], r[1], r[2], r[3], p[0], p[1], p[2],
                            math.dist(r[1:4], p[:3]), math.dist(r[1:4], q[:3]), r[4], r[5]))
    return 0

if __name__ == '__main__':
    sys.exit(main())
