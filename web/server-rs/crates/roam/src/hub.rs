//! The hub's logic, without its timer (`RoamHub` gives it one): the players, the links, the cap.
//!
//! The order of the players, and of each player's links, is the order they came in: it decides between pairs at one
//! distance, and so the links.  The players live in slots (a link names the slot of the player it is to: a player
//! that goes is taken out of every link before its slot is used again, at the next tick or once many have gone, and
//! until then links to it count for nothing) and `order` lists the slots in the order the players came.

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use bytes::{Bytes, BytesMut};
use nfsu2_util::js;
use nfsu2_util::json::num;
use serde_json::{Value, json};

use crate::links::{Cand, Found, Grid, Heap, Near, before, distance, order_key, sort_stable};
use crate::wire::{self, F_DATA, KIND_UDP, Msg};
use crate::{PeerEntry, ROAM_HUB_VIP, RoamOptions};

/// roam_core.h RC_PEERS_V1: what a core of version 1 reads (its group was 8, and it drops a longer list)
const DEGREE_V1: usize = 7;
/// no slot, no place in a room
const NONE: u32 = u32::MAX;

/// a link: the player it is to, and since when
#[derive(Clone, Copy, Debug)]
struct Link {
    slot: u32,
    since: f64,
}

struct Player {
    vip: u32,
    port: u16,
    /// the hub's port it last wrote to (the source port of its list)
    hub_port: u16,
    id: u32,
    room: u32,
    /// kept as the player last sent them; nothing reads them yet
    #[allow(dead_code)]
    status: u8,
    #[allow(dead_code)]
    name: String,
    degree: usize,
    p: Option<[f64; 3]>,
    /// its velocity and heading (256 a turn) as of the position
    v: [f64; 3],
    heading: u8,
    pos_at: f64,
    seen: f64,
    /// its links after the last tick (a HELLO of another start of the game empties them)
    links: Vec<Link>,
    /// its place in `order`
    at: u32,
}

impl Player {
    fn key(&self) -> u64 {
        key(self.vip, self.port)
    }
}

/// a player's endpoint, its virtual address and port, in one number
fn key(vip: u32, port: u16) -> u64 {
    (vip as u64) << 16 | port as u64
}

/// the nearest integer, a half up (to +infinity, where `f64::round` takes it away from 0)
fn js_round(x: f64) -> f64 {
    let c = x.ceil();
    if c - 0.5 <= x { c } else { c - 1.0 }
}

/// the options: a value that is not a positive number keeps its default
fn sanitize(o: RoamOptions) -> RoamOptions {
    let d = RoamOptions::default();
    let n = |v: usize, d: usize| if v > 0 { v } else { d };
    let f = |v: f64, d: f64| if v.is_finite() && v > 0.0 { v } else { d };
    RoamOptions {
        degree: n(o.degree, d.degree),
        tick_ms: if o.tick_ms > 0 { o.tick_ms } else { d.tick_ms },
        stale_ms: f(o.stale_ms, d.stale_ms),
        gone_ms: f(o.gone_ms, d.gone_ms),
        keep: f(o.keep, d.keep),
        hold_ms: f(o.hold_ms, d.hold_ms),
        max_per_vip: n(o.max_per_vip, d.max_per_vip),
        max_players: n(o.max_players, d.max_players),
        exact_room: n(o.exact_room, d.exact_room),
        min_degree: n(o.min_degree, d.min_degree),
        busy_high: f(o.busy_high, d.busy_high),
        busy_low: f(o.busy_low, d.busy_low),
        cap_down_ms: f(o.cap_down_ms, d.cap_down_ms),
        cap_up_ms: f(o.cap_up_ms, d.cap_up_ms),
        ask_cap: n(o.ask_cap, d.ask_cap),
        look_ms: f(o.look_ms, d.look_ms),
        // (one answer is three datagrams at most)
        map_max: n(o.map_max, d.map_max).min(wire::MAP_PER * 3),
        map_gap_ms: f(o.map_gap_ms, d.map_gap_ms),
        map_fresh_ms: f(o.map_fresh_ms, d.map_fresh_ms),
    }
}

#[derive(Default)]
struct Stats {
    frames: u64,
    bad: u64,
    refused: u64,
    lists: u64,
    ticks: u64,
    tick_ms_max: f64,
    busy: f64,
    cap_cuts: u64,
}

/// one pair of a room weighed (every pair of a room of at most `exact_room` players): since when it is linked; a and b
/// are places in the room's list, a < b (its place in the order is in `Scratch::order`)
struct Pair {
    since: f64,
    a: u32,
    b: u32,
}

/// What one tick needs, kept from tick to tick so that a tick allocates (almost) nothing.
#[derive(Default)]
struct Scratch {
    room_of: HashMap<u32, usize>,
    rooms: Vec<Vec<u32>>,
    /// each slot's new links
    fresh: Vec<Vec<Link>>,
    /// each slot's place in the room being linked (NONE: not in it)
    local: Vec<u32>,
    // by the place in the room's list: where each one is, and where it will be look_ms on
    pos: Vec<[f64; 3]>,
    ahead: Vec<[f64; 3]>,
    deg: Vec<usize>,
    mark: Vec<u32>,
    since: Vec<f64>,
    pairs: Vec<Pair>,
    /// each pair's place in the order (`order_key` of its d) and its index in `pairs`, and room to sort them
    order: Vec<(u64, u32)>,
    sorting: Vec<(u64, u32)>,
    grid: Grid,
    heap: Heap,
    near: Vec<Near>,
    /// the same over the places ahead
    grid_a: Grid,
    near_a: Vec<Near>,
    /// each Near's vectors of what it found, kept for the next tick
    found: Vec<Found>,
    /// a large room's links of the last tick, sorted (`link_many`)
    olds: Vec<Cand>,
    /// each place's links of the last tick as places in the room: `olinks[ostart[i]..ostart[i + 1]]`
    olinks: Vec<u32>,
    ostart: Vec<u32>,
    /// each place's new links as places (`flinks[i * stride..][..fcount[i]]`)
    fcount: Vec<u32>,
    flinks: Vec<u32>,
    /// the block the lists are cut from (`lists`)
    buf: BytesMut,
}

/// The bytes of a block of lists: what a list waiting in a slow player's queue keeps at most
const LIST_BLOCK: usize = 4096;

/// what the links of a room are weighed by
struct Weigh {
    now: f64,
    hold_ms: f64,
    keep: f64,
}

/// how far apart places i and j of a room count: the nearer of now and look_ms ahead
#[inline]
fn apart(pos: &[[f64; 3]], ahead: &[[f64; 3]], i: usize, j: usize) -> f64 {
    distance(&pos[i], &pos[j]).min(distance(&ahead[i], &ahead[j]))
}

/// The hub's logic, without its timer (`RoamHub` gives it one).
pub struct Hub {
    o: RoamOptions,
    now: Box<dyn Fn() -> f64 + Send>,
    busy: Box<dyn FnMut() -> f64 + Send>,
    log: Box<dyn Fn(&str) + Send>,
    send: Box<dyn Fn(u32, Bytes) -> bool + Send>,
    id: u32,
    seq: u16,
    /// the cap on every player's links (its degree at most), and when it last changed
    cap: usize,
    cap_at: f64,
    st: Stats,
    slots: Vec<Option<Player>>,
    free: Vec<u32>,
    /// the slots of players gone that others' links may still name (`drop_slots`), and by slot whether it is one
    dead: Vec<u32>,
    dead_at: Vec<bool>,
    /// the slots in the order the players came (NONE where one went)
    order: Vec<u32>,
    holes: usize,
    by_key: HashMap<u64, u32>,
    /// the endpoints of each virtual address (`max_per_vip`)
    per_vip: HashMap<u32, u32>,
    /// each virtual address's last world map answered (map_gap_ms), kept past its players: a BYE and a HELLO (or
    /// another port) make a new player, and when a player's own time was the limit, a new player's first answer came
    /// at once (the second security audit, 2026-10-22: a map walks every player on the hub's one thread, and a few
    /// clients asking that way kept it busy); dropped at each tick once older than map_gap_ms
    map_at: HashMap<u32, f64>,
    s: Scratch,
}

impl Hub {
    /// `now`: the clock in ms (nfsu2_util::now_ms() in the server); `busy`: 0 to 1, how busy the server was since
    /// the last tick; `log`: a console line; `send(vip, frame)`: through the switch (true: it went); `id`: the hub's
    /// own sender id (random in the server)
    pub fn new(
        o: RoamOptions,
        now: Box<dyn Fn() -> f64 + Send>,
        busy: Box<dyn FnMut() -> f64 + Send>,
        log: Box<dyn Fn(&str) + Send>,
        send: Box<dyn Fn(u32, Bytes) -> bool + Send>,
        id: u32,
    ) -> Self {
        let o = sanitize(o);
        Hub {
            cap: o.degree,
            cap_at: f64::NEG_INFINITY,
            o,
            now,
            busy,
            log,
            send,
            id,
            seq: 0,
            st: Stats::default(),
            slots: Vec::new(),
            free: Vec::new(),
            dead: Vec::new(),
            dead_at: Vec::new(),
            order: Vec::new(),
            holes: 0,
            by_key: HashMap::new(),
            per_vip: HashMap::new(),
            map_at: HashMap::new(),
            s: Scratch::default(),
        }
    }

    /// the switch's way to its browsers
    pub fn attach_switch(&mut self, send: Box<dyn Fn(u32, Bytes) -> bool + Send>) {
        self.send = send;
    }

    /// its options, each one that was not a positive number at its default
    pub fn options(&self) -> &RoamOptions {
        &self.o
    }

    fn player(&self, slot: u32) -> Option<&Player> {
        self.slots.get(slot as usize)?.as_ref()
    }

    /// the players in the order they came
    fn players(&self) -> impl Iterator<Item = &Player> + '_ {
        self.order.iter().filter_map(|&s| self.slots.get(s as usize)?.as_ref())
    }

    fn insert(&mut self, p: Player) -> u32 {
        let k = p.key();
        let slot = match self.free.pop() {
            Some(s) => s,
            None => {
                self.slots.push(None);
                (self.slots.len() - 1) as u32
            }
        };
        *self.per_vip.entry(p.vip).or_insert(0) += 1;
        self.order.push(slot);
        self.slots[slot as usize] = Some(Player { at: (self.order.len() - 1) as u32, ..p });
        self.by_key.insert(k, slot);
        slot
    }

    /// out of the slots and the order (not out of the links: `drop_slots` does that); false if it was empty
    fn remove(&mut self, slot: u32) -> bool {
        let Some(p) = self.slots.get_mut(slot as usize).and_then(Option::take) else { return false };
        self.by_key.remove(&p.key());
        if let Some(n) = self.per_vip.get_mut(&p.vip) {
            *n -= 1;
            if *n == 0 {
                self.per_vip.remove(&p.vip);
            }
        }
        if let Some(o) = self.order.get_mut(p.at as usize) {
            *o = NONE;
        }
        self.holes += 1;
        if self.holes > 64 && self.holes * 2 > self.order.len() {
            self.order.retain(|&s| s != NONE);
            self.holes = 0;
            for (at, &s) in self.order.iter().enumerate() {
                if let Some(Some(q)) = self.slots.get_mut(s as usize) {
                    q.at = at as u32;
                }
            }
        }
        true
    }

    /// a player gone: out of the players and out of every link
    fn drop_key(&mut self, k: u64) {
        let Some(&slot) = self.by_key.get(&k) else { return };
        self.drop_slots(&[slot]);
    }

    /// Players gone at once: the same as one after another (each goes out of the order and every link alike).
    ///
    /// Out of the others' links they go later, many at once (`purge`): taking one out walks every player's links
    /// (64,000 of 2000 players), and a client may send a HELLO and a BYE thousands of times a second.  Until then its
    /// slot is `dead`, links to it count for nothing (`live`), and it is not used again, so that no link can name a
    /// newcomer in its place.
    fn drop_slots(&mut self, slots: &[u32]) {
        self.dead_at.resize(self.slots.len(), false);
        for &s in slots {
            if self.remove(s) {
                self.dead_at[s as usize] = true;
                self.dead.push(s);
            }
        }
        // a purge walks every link: once for many players gone, at least an eighth of the players
        if self.dead.len() >= 64.max(self.by_key.len() / 8) {
            self.purge();
        }
    }

    /// the players gone out of the others' links, and their slots free again
    fn purge(&mut self) {
        if self.dead.is_empty() {
            return;
        }
        let dead = &self.dead_at;
        for q in self.slots.iter_mut().flatten() {
            q.links.retain(|l| !dead.get(l.slot as usize).copied().unwrap_or(false));
        }
        for s in self.dead.drain(..) {
            self.dead_at[s as usize] = false;
            self.free.push(s);
        }
    }

    /// a link to a player that is still there (not one gone and not purged yet)
    fn live(&self, l: &Link) -> bool {
        !self.dead_at.get(l.slot as usize).copied().unwrap_or(false)
    }

    /// a frame from browser `from` to the hub's address (the switch has written the true source vip)
    pub fn frame(&mut self, from: u32, data: &[u8]) {
        self.st.frames += 1;
        if data.len() < F_DATA + wire::HDR + wire::CRC || data[0] != KIND_UDP {
            self.st.bad += 1;
            return;
        }
        let (sport, dport) = (u16::from_be_bytes([data[12], data[13]]), u16::from_be_bytes([data[14], data[15]]));
        let Some((_, sender, m)) = wire::decode(&data[F_DATA..]).filter(|_| sport != 0) else {
            self.st.bad += 1;
            return;
        };
        let k = key(from, sport);
        let found = self.by_key.get(&k).copied();
        if let Msg::Bye = m {
            if found.is_some() {
                self.drop_key(k);
            }
            return;
        }
        let slot = match found {
            Some(s) => s,
            None => {
                // a player starts with its HELLO (the room)
                let Msg::Hello { status, room, name, .. } = m else { return };
                let mine = self.per_vip.get(&from).copied().unwrap_or(0) as usize;
                if mine >= self.o.max_per_vip || self.by_key.len() >= self.o.max_players {
                    self.st.refused += 1;
                    return;
                }
                self.insert(Player {
                    vip: from,
                    port: sport,
                    hub_port: dport,
                    id: sender,
                    room,
                    status,
                    name: String::from_utf8_lossy(name).into_owned(),
                    degree: 0,
                    p: None,
                    v: [0.0; 3],
                    heading: 0,
                    pos_at: 0.0,
                    seen: 0.0,
                    links: Vec::new(),
                    at: 0,
                })
            }
        };
        let now = (self.now)();
        let degree = self.o.degree;
        let Some(Some(p)) = self.slots.get_mut(slot as usize) else { return };
        p.seen = now;
        p.hub_port = dport;
        let mut ask = None;
        match m {
            Msg::Hello { sender, core, status, room, name } => {
                // another start of the game on the same endpoint
                if p.id != sender {
                    p.links.clear();
                }
                p.id = sender;
                p.room = room;
                p.status = status;
                if p.name.as_bytes() != name {
                    p.name.clear();
                    p.name.extend(name.iter().map(|&c| c as char));
                }
                p.degree = if core >= 2 { degree } else { degree.min(DEGREE_V1) };
            }
            Msg::Snap { sender, status, p: pos, v, heading } if sender == p.id => {
                p.p = Some(pos);
                p.v = v;
                p.heading = heading;
                p.pos_at = p.seen;
                p.status = status;
            }
            Msg::MapReq { req } if sender == p.id => ask = Some(req),
            _ => {}
        }
        if let Some(req) = ask {
            self.map(slot, req, now);
        }
    }

    /// The world map's answer to the player in `slot` (roam_core.h RC_MSG_MAP): the players of its room in free roam
    /// (or paused there) with a position younger than map_fresh_ms, past itself and its links, nearest first (at one
    /// distance in the order they came), map_max of them at most, in datagrams of MAP_PER; one answer to a browser (its
    /// virtual address, whatever its endpoints) every map_gap_ms at most (a page asks again when an answer does not
    /// come).
    fn map(&mut self, slot: u32, req: u16, now: f64) {
        let (gap, fresh, max) = (self.o.map_gap_ms, self.o.map_fresh_ms, self.o.map_max);
        let Some(p) = self.player(slot) else { return };
        if self.map_at.get(&p.vip).is_some_and(|&t| now - t < gap) {
            return;
        }
        let (room, at) = (p.room, p.p.unwrap_or_default());
        let mut near: Vec<(u64, (i16, i16, u8))> = Vec::new();
        for &q in &self.order {
            let Some(o) = self.player(q) else { continue };
            let Some(pos) = o.p else { continue };
            if q == slot || o.room != room || now - o.pos_at > fresh || !matches!(o.status, 2 | 5) || p.links.iter().any(|l| l.slot == q) {
                continue;
            }
            let c = |x: f64| (x + 0.5).floor().clamp(-32767.0, 32767.0) as i16;
            near.push((order_key(distance(&at, &pos)), (c(pos[0]), c(pos[1]), o.heading)));
        }
        let (vip, port, hub_port) = (p.vip, p.port, p.hub_port);
        // (a stable sort: at one distance the order they came)
        near.sort_by_key(|e| e.0);
        let total = near.len().min(u16::MAX as usize) as u16;
        near.truncate(max);
        let list: Vec<(i16, i16, u8)> = near.into_iter().map(|e| e.1).collect();
        let parts = list.len().div_ceil(wire::MAP_PER).max(1);
        for (k, part) in list.chunks(wire::MAP_PER).chain(list.is_empty().then_some(&[][..])).enumerate() {
            let mut f = vec![0u8; F_DATA + wire::map_len(part.len())];
            f[0] = KIND_UDP;
            f[4..8].copy_from_slice(&ROAM_HUB_VIP.to_be_bytes());
            f[8..12].copy_from_slice(&vip.to_be_bytes());
            f[12..14].copy_from_slice(&hub_port.to_be_bytes());
            f[14..16].copy_from_slice(&port.to_be_bytes());
            wire::write_map(&mut f[F_DATA..], self.id, self.seq, req, k as u8, parts as u8, total, part);
            self.seq = self.seq.wrapping_add(1);
            (self.send)(vip, Bytes::from(f));
        }
        self.map_at.insert(vip, now);
    }

    /// browser `vip` left the switch
    pub fn peer_gone(&mut self, vip: u32) {
        if !self.per_vip.contains_key(&vip) {
            return;
        }
        let mine: Vec<u32> = self.order.iter().copied().filter(|&s| self.player(s).is_some_and(|p| p.vip == vip)).collect();
        self.drop_slots(&mine);
    }

    /// every `tick_ms`: who is linked to whom, and every player's list
    pub fn tick(&mut self) {
        let t0 = Instant::now();
        let now = (self.now)();
        self.adjust(now);
        let gone_ms = self.o.gone_ms;
        let gone: Vec<u32> = self.order.iter().copied().filter(|&s| self.player(s).is_some_and(|p| now - p.seen > gone_ms)).collect();
        self.drop_slots(&gone);
        // every player gone since the last tick out of the links the tick weighs
        self.purge();
        let gap = self.o.map_gap_ms;
        self.map_at.retain(|_, t| now - *t < gap);

        // the rooms: the players with a position younger than `stale_ms`, in the order they came
        let s = &mut self.s;
        s.room_of.clear();
        let mut rooms = 0;
        for &slot in &self.order {
            let Some(Some(p)) = self.slots.get(slot as usize) else { continue };
            if p.p.is_none() || now - p.pos_at > self.o.stale_ms {
                continue;
            }
            let r = *s.room_of.entry(p.room).or_insert_with(|| {
                if rooms == s.rooms.len() {
                    s.rooms.push(Vec::new());
                }
                s.rooms[rooms].clear();
                rooms += 1;
                rooms - 1
            });
            s.rooms[r].push(slot);
        }
        // (empty already, unless a tick before broke off)
        s.fresh.iter_mut().for_each(Vec::clear);
        s.fresh.resize_with(self.slots.len(), Vec::new);
        s.local.clear();
        s.local.resize(self.slots.len(), NONE);
        let w = Weigh { now, hold_ms: self.o.hold_ms, keep: self.o.keep };
        for r in 0..rooms {
            let list = std::mem::take(&mut s.rooms[r]);
            prepare(&self.slots, &list, self.cap, self.o.look_ms / 1000.0, s);
            if list.len() > self.o.exact_room {
                link_many(&self.slots, &list, &w, s);
            } else {
                link_every_pair(&self.slots, &list, &w, s);
            }
            for &slot in &list {
                s.local[slot as usize] = NONE;
            }
            s.rooms[r] = list;
        }
        self.lists();
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        self.st.ticks += 1;
        if ms > self.st.tick_ms_max {
            self.st.tick_ms_max = ms;
        }
    }

    /// every player's new links in place, and its PEERS list sent.  The lists are cut from blocks of LIST_BLOCK
    /// bytes, about 11 lists each: the switch queues a list as it is until the player's writer takes it, and one
    /// buffer for all of them (700 KB for 2000 players) was kept whole for as long as any list of its tick waited in
    /// a slow player's queue, one such buffer a second; a list of its own each was 2000 allocations a tick.
    fn lists(&mut self) {
        let s = &mut self.s;
        for &slot in &self.order {
            let Some(Some(p)) = self.slots.get(slot as usize) else { continue };
            let links = &s.fresh[slot as usize];
            let n = F_DATA + wire::peers_len(links.len());
            if s.buf.capacity() < n {
                s.buf = BytesMut::with_capacity(LIST_BLOCK.max(n));
            }
            let buf = &mut s.buf;
            buf.resize(n, 0);
            buf[0] = KIND_UDP;
            buf[4..8].copy_from_slice(&ROAM_HUB_VIP.to_be_bytes());
            buf[8..12].copy_from_slice(&p.vip.to_be_bytes());
            buf[12..14].copy_from_slice(&p.hub_port.to_be_bytes());
            buf[14..16].copy_from_slice(&p.port.to_be_bytes());
            let slots = &self.slots;
            let list = links.iter().map(|l| match slots.get(l.slot as usize) {
                Some(Some(q)) => PeerEntry { vip: q.vip, port: q.port, id: q.id },
                _ => PeerEntry { vip: 0, port: 0, id: 0 },
            });
            wire::write_peers(&mut buf[F_DATA..], self.id, self.seq, list);
            self.seq = self.seq.wrapping_add(1);
            if (self.send)(p.vip, buf.split().freeze()) {
                self.st.lists += 1;
            }
        }
        for &slot in &self.order {
            if let Some(Some(p)) = self.slots.get_mut(slot as usize) {
                std::mem::swap(&mut p.links, &mut s.fresh[slot as usize]);
                s.fresh[slot as usize].clear();
            }
        }
    }

    /// the cap on the links: a quarter down while the server is busy, 2 up once it has room again
    fn adjust(&mut self, now: f64) {
        let busy = (self.busy)();
        let was = self.cap;
        self.st.busy = js_round(busy * 100.0);
        let o = &self.o;
        if busy > o.busy_high && now - self.cap_at >= o.cap_down_ms {
            self.cap = o.min_degree.min(o.degree).max(self.cap * 3 / 4);
        } else if busy < o.busy_low && now - self.cap_at >= o.cap_up_ms {
            self.cap = o.degree.min(self.cap + 2);
        }
        if self.cap == was {
            return;
        }
        self.cap_at = now;
        if self.cap < was {
            self.st.cap_cuts += 1;
        }
        (self.log)(&format!(
            "[roam] the server's thread was {} % busy: at most {} links a player (was {was})",
            js::number_to_string(self.st.busy),
            self.cap
        ));
    }

    /// free roam is busy: the cap is under `ask_cap` (the start page does not ask new players then)
    pub fn crowded(&self) -> bool {
        self.cap < self.o.ask_cap
    }

    /// the browsers in free roam now (a HELLO within `gone_ms`)
    pub fn vips(&self) -> HashSet<u32> {
        self.players().map(|p| p.vip).collect()
    }

    /// for the tests and the switch's `info()` (the server's console): counts only, never a position
    pub fn info(&self) -> Value {
        let (mut linked, mut links) = (0u64, 0u64);
        for p in self.players() {
            let n = if self.dead.is_empty() { p.links.len() } else { p.links.iter().filter(|l| self.live(l)).count() };
            if n > 0 {
                linked += 1;
            }
            links += n as u64;
        }
        let st = &self.st;
        json!({
            "players": self.by_key.len(),
            "linked": linked,
            "links": num(links as f64 / 2.0),
            "cap": self.cap,
            "frames": st.frames,
            "bad": st.bad,
            "refused": st.refused,
            "lists": st.lists,
            "ticks": st.ticks,
            "tickMsMax": num(st.tick_ms_max),
            "busy": num(st.busy),
            "capCuts": st.cap_cuts,
        })
    }

    /// each player's links now, by `vip:port`, for the tests
    pub fn links(&self) -> Vec<(String, Vec<String>)> {
        let name = |p: &Player| format!("{}:{}", p.vip, p.port);
        let to = |l: &Link| self.live(l).then(|| self.player(l.slot)).flatten();
        self.players().map(|p| (name(p), p.links.iter().filter_map(to).map(name).collect())).collect()
    }
}

/// a room's players by their place in its list: positions, degrees (under the cap), and each one's place
fn prepare(slots: &[Option<Player>], list: &[u32], cap: usize, look: f64, s: &mut Scratch) {
    s.pos.clear();
    s.ahead.clear();
    s.deg.clear();
    for (i, &slot) in list.iter().enumerate() {
        let p = player(slots, slot);
        let (at, v) = p.map_or(([0.0; 3], [0.0; 3]), |p| (p.p.unwrap_or_default(), p.v));
        s.pos.push(at);
        s.ahead.push([at[0] + v[0] * look, at[1] + v[1] * look, at[2] + v[2] * look]);
        // a player's links at most: its degree, under the cap
        s.deg.push(p.map_or(0, |p| p.degree.min(cap)));
        s.local[slot as usize] = i as u32;
    }
}

fn player(slots: &[Option<Player>], slot: u32) -> Option<&Player> {
    slots.get(slot as usize)?.as_ref()
}

/// the place in the room of the player in `slot` (None: not in this room)
fn local(s: &[u32], slot: u32) -> Option<usize> {
    s.get(slot as usize).copied().filter(|&j| j != NONE).map(|j| j as usize)
}

/// a link made: both ends list each other
fn join(fresh: &mut [Vec<Link>], a: u32, b: u32, since: f64) {
    fresh[a as usize].push(Link { slot: b, since });
    fresh[b as usize].push(Link { slot: a, since });
}

/// The links of a room of at most `exact_room` players: every pair of them, nearest first (a link younger than
/// `hold_ms` before them all, an older one at `keep` its distance), into the links while both ends have room.
fn link_every_pair(slots: &[Option<Player>], list: &[u32], w: &Weigh, s: &mut Scratch) {
    let m = list.len();
    let Scratch { pos, ahead, deg, mark, since, pairs, order, sorting, local: at, fresh, .. } = s;
    pairs.clear();
    order.clear();
    mark.clear();
    mark.resize(m, 0);
    since.resize(m, 0.0);
    for (i, &slot) in list.iter().enumerate() {
        let Some(a) = player(slots, slot) else { continue };
        // a's links of the last tick, by place
        let stamp = i as u32 + 1;
        for l in &a.links {
            if let Some(j) = local(at, l.slot) {
                mark[j] = stamp;
                since[j] = l.since;
            }
        }
        for j in i + 1..m {
            let linked = mark[j] == stamp;
            let d = if !linked {
                apart(pos, ahead, i, j)
            } else if w.now - since[j] < w.hold_ms {
                -1.0
            } else {
                apart(pos, ahead, i, j) * w.keep
            };
            order.push((order_key(d), pairs.len() as u32));
            pairs.push(Pair { since: if linked { since[j] } else { w.now }, a: i as u32, b: j as u32 });
        }
    }
    // a stable sort by d: at one d, the pairs in the order they were weighed
    sort_stable(order, sorting);
    // a link takes two with room: once fewer than two have it, the rest of the pairs make none
    let mut open = deg.iter().filter(|&&d| d > 0).count();
    for &(_, k) in order.iter() {
        if open < 2 {
            break;
        }
        let p = &pairs[k as usize];
        let (a, b) = (p.a as usize, p.b as usize);
        let (sa, sb) = (list[a], list[b]);
        if fresh[sa as usize].len() < deg[a] && fresh[sb as usize].len() < deg[b] {
            join(fresh, sa, sb, p.since);
            open -= (fresh[sa as usize].len() == deg[a]) as usize + (fresh[sb as usize].len() == deg[b]) as usize;
        }
    }
}

/// whether `places` has `j` (every one compared, without a branch: there are at most a degree of them, and this
/// vectorizes)
fn has_place(places: &[u32], j: u32) -> bool {
    places.iter().fold(false, |found, &x| found | (x == j))
}

/// The links of a room larger than `exact_room`, as `link_every_pair` makes them from every pair sorted (at one
/// place in the order the pair of the lower index first), without sorting them all: the last tick's links at their own place,
/// and each player's nearest one after another (Near) while it has room, merged in that order.  A player walks twice,
/// by the places now and by the places ahead (`apart` is the nearer of the two): a pair comes first at the nearer of
/// its two distances, as the order has it, and when it comes again, from the other walk, it is linked already or
/// cannot be (the same as an entry of one pair coming twice, below).
///
/// One heap could hold both.  Here the last tick's links (32,000 of 2000 players) are sorted once, and only the
/// nearest ones (one a player) are in the heap, which stays small; the two are merged.  The links come out the same:
/// the pairs are taken in the same order (by distance, then the lower place, then the higher), and of entries at one
/// place in it, which are entries of one pair, the order makes no difference (at most one of them links the pair, the
/// same one whichever comes first; one that comes after the pair filled a player only reads that player's next
/// nearest one, which never links anything, as the player has no room left).
///
/// What the order asks of a pair, which players have room and which pairs were or are linked, is read from arrays
/// by place in the room (a player's last links and its new ones, as places), not from the players.  (Not inlined
/// into the tick: there it made the every-pair loop of the small rooms 1 % slower.)
#[inline(never)]
fn link_many(slots: &[Option<Player>], list: &[u32], w: &Weigh, s: &mut Scratch) {
    let m = list.len();
    let Scratch {
        pos, ahead, deg, local: at, fresh, grid, heap, near, grid_a, near_a, found, olds, olinks, ostart, fcount, flinks, ..
    } = s;
    let cand = |d: f64, i: usize, j: usize, nearest: bool| Cand::new(d, i as u32, j as u32, nearest);
    grid.build(pos);
    grid_a.build(ahead);
    heap.clear();
    near.clear();
    near_a.clear();
    olds.clear();
    olinks.clear();
    ostart.clear();
    for (i, &slot) in list.iter().enumerate() {
        ostart.push(olinks.len() as u32);
        if let Some(a) = player(slots, slot) {
            for l in &a.links {
                let Some(j) = local(at, l.slot) else { continue };
                olinks.push(j as u32);
                // each link once: by its lower end, or by the only end that lists it (j's links are in already)
                if i < j || !has_place(&olinks[ostart[j] as usize..ostart[j + 1] as usize], i as u32) {
                    // a link's place in the order: younger than `hold_ms` first, older at `keep` its distance
                    let d = if w.now - l.since < w.hold_ms { -1.0 } else { apart(pos, ahead, i, j) * w.keep };
                    olds.push(cand(d, i, j, false));
                }
            }
        }
        let mut n = Near::new(grid, pos, i as u32, found.pop().unwrap_or_default());
        if let Some((d, j)) = n.next(grid, pos) {
            heap.push(cand(d, i, j as usize, true));
        }
        near.push(n);
        let mut n = Near::new(grid_a, ahead, i as u32, found.pop().unwrap_or_default());
        if let Some((d, j)) = n.next(grid_a, ahead) {
            heap.push(Cand::ahead(d, i as u32, j));
        }
        near_a.push(n);
    }
    ostart.push(olinks.len() as u32);
    olds.sort_unstable_by_key(|c| (order_key(c.d), c.pair()));
    let old_of = |i: usize| &olinks[ostart[i] as usize..ostart[i + 1] as usize];
    // linked at the last tick, at either end
    let old = |i: usize, j: usize| has_place(old_of(i), j as u32) || has_place(old_of(j), i as u32);
    // each place's new links so far, as places (`stride` a place, its degree at most)
    let stride = deg.iter().copied().max().unwrap_or(0);
    fcount.clear();
    fcount.resize(m, 0);
    flinks.clear();
    flinks.resize(m * stride, 0);
    let room = |fcount: &[u32], i: usize| (fcount[i] as usize) < deg[i];
    let mut o = 0;
    loop {
        // the next in the order: the heap's nearest one or the next link of the last tick
        let take_old = match (olds.get(o), heap.peek()) {
            (None, None) => break,
            (Some(x), Some(y)) => !before(y, x),
            (Some(_), None) => true,
            (None, Some(_)) => false,
        };
        let c = if take_old {
            o += 1;
            olds[o - 1]
        } else {
            match heap.pop() {
                Some(c) => c,
                None => break,
            }
        };
        let (i, j) = (c.i() as usize, c.j() as usize);
        if c.nearest() {
            // i's next nearest one of that walk, while it has room
            if room(fcount, i) {
                if c.by_ahead() {
                    if let Some((d, k)) = near_a[i].next(grid_a, ahead) {
                        heap.push(Cand::ahead(d, i as u32, k));
                    }
                } else if let Some((d, k)) = near[i].next(grid, pos) {
                    heap.push(cand(d, i, k as usize, true));
                }
            }
            // a link of the last tick: in the order at its own place
            if old(i, j) {
                continue;
            }
        }
        if room(fcount, i) && room(fcount, j) && !has_place(&flinks[i * stride..i * stride + fcount[i] as usize], j as u32) {
            // a nearest one is linked since now, a link of the last tick since it was made (one of i's links)
            let since = if c.nearest() {
                w.now
            } else {
                player(slots, list[i]).and_then(|a| a.links.iter().find(|l| l.slot == list[j])).map_or(w.now, |l| l.since)
            };
            join(fresh, list[i], list[j], since);
            for (a, b) in [(i, j), (j, i)] {
                flinks[a * stride + fcount[a] as usize] = b as u32;
                fcount[a] += 1;
            }
        }
    }
    for n in near.drain(..).chain(near_a.drain(..)) {
        found.push(n.into_found());
    }
}
