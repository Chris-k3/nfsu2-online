//! A frame from a browser to the browsers it reaches, the free-roam hub or the Online host (lan.mjs `route`,
//! `deliver`, `sendFrame`, `post`, the stream rules, `pump`, `stalled`, `cutGroup`).  It runs on the sender's reader,
//! on whatever core that is.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{
    AtomicBool,
    Ordering::{Relaxed, SeqCst},
};

use bytes::{BufMut, Bytes, BytesMut};
use nfsu2_util::{FrameCtx, mono_ms};
use smallvec::SmallVec;

use crate::conn::{Conn, Out};
use crate::{BROADCAST, Cause, Cut, KIND_LAN_ICMP, KIND_LAN_UDP, KIND_STREAM, KIND_UDP, LanSwitch, Peer, STREAM_LOW, slot};

/// The stream segments (kind 4) waiting at each receiver (by connection), behind the switch's one lock for them.
#[derive(Default)]
pub(crate) struct Streams {
    by_conn: HashMap<u64, StreamQueue>,
    /// tells one sending client's queued segments from those of the same client after it was cut (lan.mjs compared
    /// the objects)
    era: u64,
}

impl Streams {
    pub(crate) fn remove(&mut self, conn: u64) {
        self.by_conn.remove(&conn);
    }
}

/// lan.mjs's `sq`, `streamQueued`, `streamTotal`, `streamSince`, `streamOut` of one receiver.
#[derive(Default)]
struct StreamQueue {
    sq: VecDeque<Segment>,
    /// bytes queued by sending client, in the order they first queued (lan.mjs's Map: the first of equals is cut)
    queued: Vec<Queued>,
    total: usize,
    /// since when the queue is not empty, and when a segment last went out
    since: f64,
    out: f64,
}

struct Queued {
    group: Arc<str>,
    era: u64,
    n: usize,
}

struct Segment {
    data: Bytes,
    src: u32,
    dst: u32,
    group: Arc<str>,
    era: u64,
}

impl StreamQueue {
    fn mine(&self, g: &str) -> Option<usize> {
        self.queued.iter().position(|q| &*q.group == g)
    }
}

impl LanSwitch {
    /// lan.mjs `route(peer, data, dst)` for each of `dsts` in turn (the frame's own destination, or a bundle entry's
    /// list): from peer to the browsers each reaches, the free-roam hub or the Online host, within peer's budgets.
    /// False: over them (what follows in a bundle goes too).
    ///
    /// lan.mjs charged each destination on its own (k frames of n bytes: k the players a broadcast reaches, 1 for any
    /// other) and stopped at the first its buckets could not pay for.  Here the buckets are locked once for all of
    /// them (32 friends were 32 times three locks and a clock read): the destinations go up to the first whose running
    /// total one of the buckets cannot pay for, which is where lan.mjs's checks one after the other stopped.
    pub(crate) fn route(&self, peer: &Arc<Peer>, data: &Bytes, dsts: impl Iterator<Item = u32> + Clone) -> bool {
        let n = data.len();
        let lan_only = (KIND_LAN_UDP..=KIND_LAN_ICMP).contains(&data[0]);
        let reaches = |p: &Arc<Peer>| !Arc::ptr_eq(p, peer) && p.open() && (!lan_only || p.lan() != Some(false));
        // what the switch sends for each: a broadcast costs its size for every player it reaches
        let all = dsts.clone().any(|d| d == BROADCAST).then(|| self.all.load());
        let reached: SmallVec<[usize; 2]> = match &all {
            Some(all) => dsts.clone().filter(|&d| d == BROADCAST).map(|_| all.iter().filter(|p| reaches(p)).count()).collect(),
            None => SmallVec::new(),
        };
        let mut reached_each = reached.iter();
        let costs = dsts.clone().map(|d| if d == BROADCAST { reached_each.next().map_or(1, |&c| c.max(1)) } else { 1 });
        let (paid, all_paid) = self.charge(peer, mono_ms(), n as f64, costs);
        if paid > 0 {
            self.stats.frames.add(paid as u64);
            self.stats.bytes.add((n * paid) as u64);
            peer.frames_in.fetch_add(paid as u64, Relaxed);
        }
        let mut reached_each = reached.iter();
        for dst in dsts.take(paid) {
            let count = if dst == BROADCAST { reached_each.next().copied().unwrap_or(0) } else { 0 };
            self.route_one(peer, data, dst, all.as_deref().map(|a| &a[..]), count, &reaches);
        }
        if !all_paid {
            self.stats.limited.inc();
        }
        all_paid
    }

    /// one destination that was paid for (lan.mjs `route` past its checks): the trace, a host, or the browsers
    fn route_one(
        &self,
        peer: &Arc<Peer>,
        data: &Bytes,
        dst: u32,
        all: Option<&[Arc<Peer>]>,
        count: usize,
        reaches: &impl Fn(&Arc<Peer>) -> bool,
    ) {
        let vip = peer.vip;
        // the hub, the online host and the trace see the frame as sent to them
        if let Some(tap) = &self.tap {
            tap(&own(data, vip, dst));
        }
        if self.roam_vip == Some(dst) {
            if let Some(roam) = &self.roam {
                roam.frame(vip, own(data, vip, dst), self.frame_ctx(peer, None));
            }
            return;
        }
        if self.online_vip == Some(dst) {
            if let Some(online) = &self.online {
                // what the host sends while it handles the frame is charged to the sender's budgets
                let cause = Arc::new(Cause {
                    peer: peer.clone(),
                    stats: self.stats.clone(),
                    over: AtomicBool::new(false),
                    counted: AtomicBool::new(false),
                });
                let mut ctx = self.frame_ctx(peer, Some(cause));
                ctx.slot = Some(self.online_backlog.enter());
                peer.fed_online.store(true, Relaxed);
                online.frame(vip, own(data, vip, dst), ctx);
            }
            return;
        }
        if dst == BROADCAST {
            match all {
                Some(all) if count > 0 => {
                    for p in all.iter().filter(|p| reaches(p)) {
                        self.deliver(peer, p, data, dst);
                    }
                }
                _ => self.stats.dropped.inc(),
            }
            return;
        }
        let one = slot(dst).map(|i| self.table[i].load());
        match one.as_deref().and_then(|p| p.as_ref()).filter(|p| p.open()) {
            Some(p) => self.deliver(peer, p, data, dst),
            None => self.stats.dropped.inc(),
        }
    }

    /// the sender's buckets (connection, client, site, locked in that order everywhere) refilled to `now`: how many
    /// of the destinations (each `costs` frames of n bytes, in order) they pay for, and whether that was all of them;
    /// what those cost is taken
    fn charge(&self, peer: &Peer, now: f64, n: f64, costs: impl Iterator<Item = usize>) -> (usize, bool) {
        let mut a = peer.buckets.lock();
        let mut b = peer.group.buckets.lock();
        let mut c = peer.site.as_ref().map(|s| s.buckets.lock());
        // what the poorest bucket has (lan.mjs's checks one destination after the other subtracted whole frames and
        // bytes from what each had, exactly: a running total compared with what each had is the same check)
        let (mut frames, mut bytes) = a.refill(now);
        for (f, b) in [Some(b.refill(now)), c.as_mut().map(|c| c.refill(now))].into_iter().flatten() {
            frames = frames.min(f);
            bytes = bytes.min(b);
        }
        let (mut total, mut paid, mut all) = (0.0, 0, true);
        for k in costs {
            let t = total + k as f64;
            if t > frames || t * n > bytes {
                all = false;
                break;
            }
            total = t;
            paid += 1;
        }
        if paid > 0 {
            a.spend_paid(total, total * n);
            b.spend_paid(total, total * n);
            if let Some(c) = c.as_mut() {
                c.spend_paid(total, total * n);
            }
        }
        (paid, all)
    }

    fn frame_ctx(&self, peer: &Peer, cause: Option<Arc<Cause>>) -> FrameCtx {
        FrameCtx {
            group: peer.group.id.clone(),
            site: peer.site.as_ref().map(|s| s.id.clone()),
            cause: cause.map(|c| c as Arc<dyn nfsu2_util::Charge>),
            slot: None,
        }
    }

    /// lan.mjs `deliver(from, p, data, dst)`: one frame to one peer, through the impairment when it is on, always
    /// through `send_frame` (the queue rules)
    pub(crate) fn deliver(&self, from: &Arc<Peer>, p: &Arc<Peer>, data: &Bytes, dst: u32) {
        match &self.impair {
            Some(im) if (KIND_LAN_UDP..=KIND_LAN_ICMP).contains(&data[0]) => im.deliver(&self.stats, from, p, data, dst),
            _ => self.deliver_now(from, p, data, dst),
        }
    }

    pub(crate) fn deliver_now(&self, from: &Arc<Peer>, p: &Arc<Peer>, data: &Bytes, dst: u32) {
        if p.open() && self.send_frame(from, p, data, dst) {
            p.frames_out.fetch_add(1, Relaxed);
        }
    }

    /// lan.mjs `sendFrame(from, p, data, dst)`: a datagram is dropped while the receiver's queue is long, a stream
    /// segment never is (see streamQueue: the receiver or the client flooding it goes instead)
    fn send_frame(&self, from: &Arc<Peer>, p: &Arc<Peer>, data: &Bytes, dst: u32) -> bool {
        if data[0] == KIND_STREAM {
            return self.send_stream(from, p, data, dst);
        }
        let q = &p.conn.out;
        let limit = if data[0] == KIND_UDP { self.o.roam_queue } else { self.o.shed_queue };
        if q.buffered() + q.dgram() > limit {
            self.stats.shed.inc();
            return false;
        }
        self.post(p, data, from.vip, dst)
    }

    /// lan.mjs `post(p, data, dst)`: a datagram to p, into its bundle when it takes them (out at the bundle clock's
    /// next tick), else as it is
    fn post(&self, p: &Arc<Peer>, data: &Bytes, src: u32, dst: u32) -> bool {
        if !p.takes_bundles() {
            return self.send(p, Out::Frame { data: data.clone(), src, dst });
        }
        if !self.room(p, Cut::Slow) {
            self.stats.dropped.inc();
            return false;
        }
        p.conn.push_dgram(data.clone(), src, dst, self.clock.as_deref());
        true
    }

    /// a stream segment to p (lan.mjs `sendFrame`'s kind 4): past the receiver's share for one client (or its whole
    /// queue), whose fault it is decides who goes: a receiver that stopped reading, or the client with the most
    /// queued there (all of its connections)
    fn send_stream(&self, from: &Arc<Peer>, p: &Arc<Peer>, data: &Bytes, dst: u32) -> bool {
        let g = &from.group.id;
        let len = data.len();
        let now = mono_ms();
        let mut guard = self.streams.lock();
        // a receiver that left after deliver_now looked: its close logic let go of its queue here (under this lock,
        // after the connection ended), and it must not come back, for good
        if !p.open() {
            return false;
        }
        let st: &mut Streams = &mut guard;
        let s = st.by_conn.entry(p.conn.id).or_default();
        let mine = s.mine(g).map_or(0, |i| s.queued[i].n);
        if mine + len > self.o.stream_share || s.total + len > self.o.stream_queue {
            if self.stalled(s, now) {
                self.cut(p, Cut::Stall);
                return false;
            }
            // the receiver reads, and more comes than it takes: the client with the most queued there goes
            let mut top = g.clone();
            let mut most = mine;
            for q in &s.queued {
                if q.n > most {
                    most = q.n;
                    top = q.group.clone();
                }
            }
            self.cut_group(st, &top, Cut::Hog);
            if top == *g {
                return false;
            }
        }
        if !self.room(p, Cut::Slow) {
            self.stats.dropped.inc();
            return false;
        }
        let s = st.by_conn.entry(p.conn.id).or_default();
        // straight to the connection while it has little queued; behind the switch's own queue otherwise, so that
        // what the receiver takes is seen segment by segment
        if s.sq.is_empty() && p.conn.out.buffered() <= STREAM_LOW {
            p.conn.push(Out::Frame { data: data.clone(), src: from.vip, dst });
            return true;
        }
        if s.sq.is_empty() {
            s.since = now;
            s.out = now;
        }
        let era = match s.mine(g) {
            Some(i) => {
                s.queued[i].n += len;
                s.queued[i].era
            }
            None => {
                st.era += 1;
                s.queued.push(Queued { group: g.clone(), era: st.era, n: len });
                st.era
            }
        };
        s.total += len;
        s.sq.push_back(Segment { data: data.clone(), src: from.vip, dst, group: g.clone(), era });
        // (SeqCst: see OutQueue::buffered_synced)
        p.conn.streaming.store(true, SeqCst);
        Self::pump_one(&p.conn, s);
        true
    }

    /// lan.mjs `stalled(p)`: p has stream segments waiting and none of them got out for stallMs: it stopped reading
    fn stalled(&self, s: &StreamQueue, now: f64) -> bool {
        let ms = self.o.stall_ms;
        !s.sq.is_empty() && now - s.since > ms && now - s.out > ms
    }

    /// lan.mjs `cutGroup(id, why)`: every connection of one client goes, and the stream segments of it still waiting
    /// at the others
    fn cut_group(&self, st: &mut Streams, id: &Arc<str>, why: Cut) {
        for q in self.all.load().iter() {
            if q.group.id == *id && q.open() {
                self.cut(q, why);
            }
            let Some(s) = st.by_conn.get_mut(&q.conn.id) else { continue };
            let Some(i) = s.mine(id) else { continue };
            let e = s.queued.remove(i);
            s.total -= e.n;
            s.sq.retain(|x| !(x.era == e.era && x.group == e.group));
        }
    }

    /// lan.mjs `pump(p)`: p's queued stream segments into its connection, as far as it has taken the ones before
    /// (after each write of its writer)
    pub(crate) fn pump(&self, conn: &Arc<Conn>) {
        let mut st = self.streams.lock();
        match st.by_conn.get_mut(&conn.id) {
            Some(s) => Self::pump_one(conn, s),
            None => conn.streaming.store(false, Relaxed),
        }
    }

    fn pump_one(conn: &Arc<Conn>, s: &mut StreamQueue) {
        if !conn.open() {
            s.sq.clear();
        }
        while !s.sq.is_empty() && conn.out.buffered_synced() <= STREAM_LOW {
            let x = s.sq.pop_front().expect("not empty");
            let len = x.data.len();
            if let Some(i) = s.queued.iter().position(|q| q.era == x.era && q.group == x.group) {
                s.queued[i].n -= len.min(s.queued[i].n);
                if s.queued[i].n == 0 {
                    s.queued.remove(i);
                }
            }
            s.total -= len.min(s.total);
            s.out = mono_ms();
            conn.push(Out::Frame { data: x.data, src: x.src, dst: x.dst });
        }
        conn.streaming.store(!s.sq.is_empty(), SeqCst);
    }
}

/// the frame as sent to a host (or the trace): its own copy, with its source and destination written in
fn own(data: &Bytes, src: u32, dst: u32) -> Bytes {
    let mut b = BytesMut::with_capacity(data.len());
    b.put_slice(&data[..4]);
    b.put_u32(src);
    b.put_u32(dst);
    b.put_slice(&data[12..]);
    b.freeze()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{AttachCtx, LanOptions};

    /// a peer on the switch without a socket: its connection's queue only fills
    pub(crate) fn peer(sw: &Arc<LanSwitch>, group: &str) -> (Arc<Conn>, AttachCtx, Arc<Peer>) {
        let conn = Arc::new(Conn::new(sw.conn_ids.fetch_add(1, Relaxed)));
        let ctx = AttachCtx { resume: false, group: sw.join_group(false, Some(group)), site: None, on_join: None, on_leave: None };
        let p = sw.admit(&conn, &ctx, None).expect("admitted");
        (conn, ctx, p)
    }

    pub(crate) fn frame(kind: u8, dst: u32) -> Bytes {
        let mut f = vec![0u8; 40];
        f[0] = kind;
        f[8..12].copy_from_slice(&dst.to_be_bytes());
        Bytes::from(f)
    }

    /// The buckets charged once for a bundle entry's destinations come to what lan.mjs's charges one destination
    /// after the other came to: the same destinations paid for (the first that does not fit ends the bundle) and the
    /// same frames and bytes left in each bucket, to the bit.
    #[tokio::test]
    async fn charging_a_list_at_once_is_charging_it_one_by_one() {
        let sw = LanSwitch::new(LanOptions::default(), "", None, None, None, None);
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut rnd = move |m: u64| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x % m
        };
        let peers: Vec<_> = (0..50).map(|i| peer(&sw, &format!("g{i}"))).collect();
        let (mut cut_short, mut whole) = (0, 0);
        for case in 0..20_000 {
            let p = &peers[case % peers.len()].2;
            // mostly free roam's snapshots, now and then up to maxFrame
            let n = (12 + if rnd(4) == 0 { rnd(8180) } else { rnd(200) }) as f64;
            // levels anywhere from empty to full, with fractions (a refill leaves them), and a debt (the Online host's)
            let mut set = |pair: &mut crate::Pair| {
                for b in [&mut pair.frames, &mut pair.bytes] {
                    b.v = (rnd(1_000_000) as f64 / 1_000_000.0) * b.cap * 1.1 - b.cap * 0.1;
                    b.t = 1e12;
                }
            };
            set(&mut p.buckets.lock());
            set(&mut p.group.buckets.lock());
            // 1 to 255 destinations, now and then a broadcast's count among them
            let costs: Vec<usize> = (0..1 + rnd(255)).map(|_| if rnd(20) == 0 { 1 + rnd(3000) as usize } else { 1 }).collect();
            let mut want = (p.buckets.lock().clone(), p.group.buckets.lock().clone());
            let mut paid_want = 0;
            for &k in &costs {
                let k = k as f64;
                let ok = [&mut want.0, &mut want.1].iter_mut().all(|q| q.frames.has_at(1e12, k) && q.bytes.has_at(1e12, n * k));
                if !ok {
                    break;
                }
                for q in [&mut want.0, &mut want.1] {
                    q.frames.take_at(1e12, k);
                    q.bytes.take_at(1e12, n * k);
                }
                paid_want += 1;
            }
            let (paid, all) = sw.charge(p, 1e12, n, costs.iter().copied());
            assert_eq!((paid, all), (paid_want, paid_want == costs.len()), "case {case}");
            let (a, b) = (p.buckets.lock().clone(), p.group.buckets.lock().clone());
            for (got, want) in [(&a, &want.0), (&b, &want.1)] {
                assert_eq!(got.frames.v.to_bits(), want.frames.v.to_bits(), "case {case}: frames left");
                assert_eq!(got.bytes.v.to_bits(), want.bytes.v.to_bits(), "case {case}: bytes left");
            }
            if all { whole += 1 } else { cut_short += 1 }
        }
        assert!(cut_short > 1000 && whole > 1000, "both cases came up ({cut_short} cut short, {whole} whole)");
        sw.stop();
    }

    /// A stream segment whose receiver closed between the sender's look at it and the streams' lock: nothing of it
    /// stays at the switch (the receiver's queue was let go with its connection, and must not come back).
    #[tokio::test]
    async fn a_segment_to_a_receiver_that_just_left_leaves_nothing_behind() {
        let sw = LanSwitch::new(LanOptions::default(), "", None, None, None, None);
        let (_ac, _actx, a) = peer(&sw, "a");
        let (bc, bctx, b) = peer(&sw, "b");
        // the sender saw b open (deliver_now); b's connection ends and its close logic runs; then the segment
        bc.terminate();
        sw.closed(&bc, &bctx);
        assert!(!sw.send_stream(&a, &b, &frame(KIND_STREAM, b.vip), b.vip));
        assert!(sw.streams.lock().by_conn.is_empty(), "no stream queue for a connection that is gone");
        sw.stop();
    }
}
