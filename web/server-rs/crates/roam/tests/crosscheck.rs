//! The hub against the Node server's own (web/server/roam-hub.mjs, run under node by crosscheck.mjs): the same
//! frames in, at the same times, and the same PEERS frames out, byte for byte (the hub's id and sequence fixed in
//! both), every one of them in the same order, tick after tick; the same info() (as JSON), console lines, vips()
//! and links.  Rooms small enough for every pair and larger ones (past exactRoom: the grid, the heap), up to the
//! 2048 players a hub takes; players on a lattice and on a few spots (pairs at one distance, where only the order
//! of the players decides), moving, leaving with BYE, falling silent, leaving the switch, coming back as another
//! start of the game, changing rooms, going stale; cores of version 1 and 2, other degrees, keeps and holds; busy
//! servers whose cap moves; bad and odd datagrams.  And Math.hypot itself, bit for bit.

mod kit;

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use bytes::Bytes;
use kit::*;
use nfsu2_roam::{Hub, RoamOptions, hypot};
use nfsu2_util::js::number_to_string;
use nfsu2_util::json::stringify;
use parking_lot::Mutex;
use serde_json::{Value, json};

/// splitmix64: the scenarios' own random numbers, the same on every run
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn below(&mut self, n: usize) -> usize {
        ((self.unit() * n as f64) as usize).min(n.saturating_sub(1))
    }
    fn chance(&mut self, p: f64) -> bool {
        self.unit() < p
    }
    fn id(&mut self) -> u32 {
        loop {
            let v = self.next() as u32;
            if v != 0 {
                return v;
            }
        }
    }
}

enum Ev {
    At(f64),
    Frame(u32, Vec<u8>),
    Gone(u32),
    Tick(f64),
    Info,
}

struct Scenario {
    name: &'static str,
    opts: Vec<(&'static str, f64)>,
    id: u32,
    events: Vec<Ev>,
}

#[derive(Clone)]
struct Spec {
    name: &'static str,
    seed: u64,
    n: usize,
    ticks: usize,
    opts: Vec<(&'static str, f64)>,
    area: f64,
    rooms: usize,
    lattice: f64,
    spots: usize,
    core_v1: f64,
    events: bool,
    newcomers: bool,
    ports: usize,
    z: f64,
    bad: f64,
    busy: fn(usize, &mut Rng) -> f64,
}

impl Default for Spec {
    fn default() -> Self {
        Spec {
            name: "",
            seed: 1,
            n: 50,
            ticks: 10,
            opts: vec![],
            area: 500.0,
            rooms: 1,
            lattice: 0.0,
            spots: 0,
            core_v1: 0.1,
            events: true,
            newcomers: true,
            ports: 1,
            z: 20.0,
            bad: 0.01,
            busy: |_, _| 0.0,
        }
    }
}

struct Bot {
    vip: u32,
    port: u16,
    id: u32,
    room: u32,
    core: u16,
    p: [f64; 3],
    vel: [f64; 3],
    active: bool,
    quiet: bool,
    no_snap: bool,
}

/// the odd and the bad: what a player's datagrams may also be
fn odd(b: &Bot, r: &mut Rng) -> Vec<u8> {
    let f = |d: &[u8]| frame_ports(b.vip, d, b.port, 47210);
    let h = |o: HelloOpts| hello_with(b.id, &HelloOpts { room: b.room, core: b.core, ..o });
    match r.below(18) {
        // a bit off (the CRC no longer fits)
        0 => {
            let mut x = f(&hello(b.id));
            let i = 16 + r.below(x.len() - 16);
            x[i] ^= 1 << r.below(8);
            x
        }
        // not a datagram (another kind of frame)
        1 => {
            let mut x = f(&snap(b.id, b.p));
            x[0] = 2;
            x
        }
        2 => f(&hello(b.id))[..r.below(36)].to_vec(),
        3 => frame_ports(b.vip, &snap(b.id, b.p), 0, 47210),
        // a SNAP before any HELLO (nobody new)
        4 => frame_ports(b.vip, &snap(b.id, b.p), b.port.wrapping_add(7), 47210),
        // another sender's SNAP on the endpoint: not its position
        5 => f(&snap(b.id ^ 0x5555, [b.p[0] + 50.0, b.p[1], b.p[2]])),
        6 => f(&snap(b.id, [b.p[0], 25000.0, 0.0])),
        7 => f(&h(HelloOpts { status: 6, ..Default::default() })),
        8 => f(&h(HelloOpts { name: b"bad\x7fname", ..Default::default() })),
        9 => f(&h(HelloOpts { name: b"a name of twenty-five chr", ..Default::default() })),
        // a type the hub does not read (it counts as a word from the player)
        10 => f(&dgram(5, b.id, &[1, 2, 3])),
        // core version 1 for a while
        11 => f(&hello_with(b.id, &HelloOpts { room: b.room, core: 1, ..Default::default() })),
        12 => frame_ports(b.vip, &bye(b.id), b.port.wrapping_add(9), 47210),
        13 => f(&dgram(5, b.id, &[0u8; 1190])),
        // two states: the newest one's position
        14 => f(&snap_n(b.id, [b.p[0] - 3.0, b.p[1], b.p[2]], 3, 2)),
        15 => f(&snap(b.id, [f64::NAN, 0.0, 0.0])),
        16 => f(&snap_n(b.id, b.p, 6, 1)),
        // more endpoints of one browser
        _ => frame_ports(b.vip, &h(HelloOpts::default()), 47215 + r.below(3) as u16, 47210),
    }
}

fn make(s: &Spec) -> Scenario {
    let mut r = Rng(s.seed);
    let room_hash: Vec<u32> = (0..s.rooms).map(|i| if i == 0 { 0 } else { fnv1a(&format!("room{i}")) }).collect();
    let spots: Vec<[f64; 3]> = (0..s.spots).map(|_| [r.unit() * 100.0 - 50.0, r.unit() * 100.0 - 50.0, r.unit() * 5.0]).collect();
    let side = (s.n as f64).sqrt().ceil() as usize;
    let new_bot = |i: usize, r: &mut Rng| {
        let slot = (i / s.ports) as u32;
        let p = if !spots.is_empty() {
            spots[i % spots.len()]
        } else if s.lattice > 0.0 {
            [(i % side) as f64 * s.lattice, (i / side) as f64 * s.lattice, 0.0]
        } else {
            [r.unit() * s.area - s.area / 2.0, r.unit() * s.area - s.area / 2.0, r.unit() * s.z]
        };
        let vel = if !spots.is_empty() {
            [0.0; 3]
        } else if s.lattice > 0.0 {
            [r.below(3) as f64 - 1.0, r.below(3) as f64 - 1.0, 0.0]
        } else {
            [r.unit() * 30.0 - 15.0, r.unit() * 30.0 - 15.0, 0.0]
        };
        Bot {
            vip: 0x0A4D_0100 + slot,
            port: 47210 + (i % s.ports) as u16,
            id: r.id(),
            room: room_hash[r.below(s.rooms)],
            core: if r.chance(s.core_v1) { 1 } else { 2 },
            p,
            vel,
            active: true,
            quiet: false,
            no_snap: false,
        }
    };
    let mut bots: Vec<Bot> = (0..s.n).map(|i| new_bot(i, &mut r)).collect();
    let mut events = Vec::new();
    let mut t = 1_000_000.0;
    for k in 0..s.ticks {
        // a time jump past staleMs once: whoever sends no SNAP in it goes stale, whoever sends nothing goes
        t += if s.events && k + 3 == s.ticks { 61_000.0 } else { 1000.0 };
        let mut step = Vec::new();
        if s.events && k > 0 {
            for b in bots.iter_mut() {
                let e = r.unit();
                if !b.active {
                    // back, as another start of the game
                    if e < 0.3 {
                        b.active = true;
                        b.id = r.id();
                    }
                    continue;
                }
                if e < 0.02 {
                    b.active = false;
                    step.push(Ev::Frame(b.vip, frame_ports(b.vip, &bye(b.id), b.port, 47210)));
                } else if e < 0.03 {
                    b.active = false;
                    step.push(Ev::Gone(b.vip));
                } else if e < 0.05 {
                    // falls silent (gone after goneMs), or talks again
                    b.quiet = !b.quiet;
                } else if e < 0.06 {
                    // HELLOs only: its position grows old
                    b.no_snap = !b.no_snap;
                } else if e < 0.07 && s.rooms > 1 {
                    b.room = room_hash[r.below(s.rooms)];
                } else if e < 0.075 {
                    // another start of the game on the endpoint
                    b.id = r.id();
                }
            }
            if s.newcomers && k % 3 == 1 {
                for _ in 0..(s.n / 50).max(1) {
                    let b = new_bot(bots.len(), &mut r);
                    bots.push(b);
                }
            }
        }
        for b in bots.iter_mut() {
            if !b.active || b.quiet {
                continue;
            }
            let dport = if r.chance(0.01) { 47300 } else { 47210 };
            let name = format!("bot{}", b.id % 1000);
            let o = HelloOpts { room: b.room, core: b.core, name: name.as_bytes(), ..Default::default() };
            step.push(Ev::Frame(b.vip, frame_ports(b.vip, &hello_with(b.id, &o), b.port, dport)));
            if !b.no_snap {
                for d in 0..3 {
                    b.p[d] = (b.p[d] + b.vel[d]).clamp(-19000.0, 19000.0);
                }
                if r.chance(0.01) && spots.is_empty() && s.lattice == 0.0 {
                    b.p = [r.unit() * s.area - s.area / 2.0, r.unit() * s.area - s.area / 2.0, r.unit() * s.z];
                }
                step.push(Ev::Frame(b.vip, frame_ports(b.vip, &snap(b.id, b.p), b.port, dport)));
            }
            if r.chance(s.bad) {
                step.push(Ev::Frame(b.vip, odd(b, &mut r)));
            }
        }
        // the frames of one second in an order of their own, over its last second
        for i in (1..step.len()).rev() {
            let j = r.below(i + 1);
            step.swap(i, j);
        }
        let mut at = t - 1000.0 + r.unit();
        events.push(Ev::At(at));
        // about every other second a look in between (after BYEs and departures a link may be listed at one end)
        let look = 0.5 / step.len().max(1) as f64;
        for e in step {
            if r.chance(0.1) {
                at += r.unit() * (t - at) * 0.2;
                events.push(Ev::At(at));
            }
            if r.chance(look) {
                events.push(Ev::Info);
            }
            events.push(e);
        }
        events.push(Ev::At(t));
        if r.chance(0.2) {
            events.push(Ev::Info);
        }
        events.push(Ev::Tick((s.busy)(k, &mut r)));
        if k % 4 == 3 || k + 1 == s.ticks {
            events.push(Ev::Info);
        }
    }
    Scenario { name: s.name, opts: s.opts.clone(), id: r.id(), events }
}

fn scenarios() -> Vec<Scenario> {
    let d = Spec::default;
    let specs = [
        Spec { name: "a lattice, 10 m apart", seed: 1, n: 40, ticks: 15, lattice: 10.0, ..d() },
        Spec { name: "rooms of every pair", seed: 2, n: 150, ticks: 15, area: 300.0, rooms: 4, ..d() },
        Spec {
            name: "degree 3, keep 0.7, hold 2 s",
            seed: 3,
            n: 60,
            ticks: 15,
            opts: vec![("degree", 3.0), ("keep", 0.7), ("holdMs", 2000.0)],
            area: 200.0,
            ..d()
        },
        Spec { name: "300 in one room: the grid", seed: 4, n: 300, ticks: 12, area: 800.0, ..d() },
        Spec { name: "700 in a crowd, two rooms", seed: 5, n: 700, ticks: 10, area: 150.0, rooms: 2, ..d() },
        Spec { name: "1000 in one room", seed: 6, n: 1000, ticks: 10, area: 2500.0, ..d() },
        Spec {
            name: "the grid for small rooms (exactRoom 1), a lattice",
            seed: 7,
            n: 60,
            ticks: 15,
            opts: vec![("exactRoom", 1.0)],
            lattice: 5.0,
            ..d()
        },
        Spec { name: "two spots: every distance one of two", seed: 8, n: 50, ticks: 10, spots: 2, events: false, ..d() },
        Spec { name: "two spots, the grid", seed: 9, n: 50, ticks: 10, opts: vec![("exactRoom", 1.0)], spots: 2, events: false, ..d() },
        Spec { name: "400 on four spots past exactRoom", seed: 10, n: 400, ticks: 8, spots: 4, ..d() },
        Spec {
            name: "few places: maxPlayers 50, three endpoints a browser",
            seed: 11,
            n: 70,
            ticks: 10,
            opts: vec![("maxPlayers", 50.0)],
            area: 100.0,
            ports: 3,
            bad: 0.05,
            ..d()
        },
        Spec { name: "a flat crowd past exactRoom, all of core 1", seed: 12, n: 400, ticks: 8, area: 60.0, core_v1: 1.0, z: 0.0, ..d() },
        Spec {
            name: "short goneMs and staleMs",
            seed: 13,
            n: 80,
            ticks: 15,
            opts: vec![("goneMs", 1500.0), ("staleMs", 2500.0)],
            area: 300.0,
            ..d()
        },
        Spec {
            name: "a busy server, every pair",
            seed: 14,
            n: 120,
            ticks: 45,
            area: 200.0,
            busy: |k, _| {
                if k < 15 {
                    0.95
                } else if k < 22 {
                    0.7
                } else {
                    0.2
                }
            },
            ..d()
        },
        Spec {
            name: "a busy server now and then, the grid",
            seed: 15,
            n: 400,
            ticks: 30,
            opts: vec![("capDownMs", 2000.0), ("capUpMs", 3000.0)],
            area: 400.0,
            busy: |_, r| r.unit(),
            ..d()
        },
        Spec { name: "1500 in a city", seed: 16, n: 1500, ticks: 6, area: 8000.0, ..d() },
        Spec { name: "2100 in one room: 2048 at most", seed: 17, n: 2100, ticks: 4, area: 3000.0, events: false, ..d() },
        Spec { name: "bad and odd datagrams", seed: 18, n: 100, ticks: 15, rooms: 2, area: 200.0, bad: 0.3, ..d() },
        Spec {
            name: "degree 12, minDegree 3, busy every other second",
            seed: 19,
            n: 200,
            ticks: 20,
            opts: vec![("degree", 12.0), ("minDegree", 3.0), ("capDownMs", 1000.0), ("capUpMs", 1000.0)],
            area: 300.0,
            busy: |k, r| if k % 2 == 0 { 0.86 + r.unit() * 0.14 } else { r.unit() * 0.64 },
            ..d()
        },
        Spec {
            name: "exactRoom 20: rooms on both sides of it",
            seed: 20,
            n: 200,
            ticks: 15,
            opts: vec![("exactRoom", 20.0)],
            area: 200.0,
            rooms: 6,
            ..d()
        },
        Spec {
            name: "options that are no positive number keep their defaults",
            seed: 21,
            n: 60,
            ticks: 10,
            opts: vec![("degree", 0.0), ("keep", -1.0), ("holdMs", 0.0), ("goneMs", -5.0), ("busyHigh", 0.0)],
            area: 200.0,
            busy: |k, _| if k < 6 { 0.9 } else { 0.1 },
            ..d()
        },
    ];
    specs.iter().map(make).collect()
}

fn options(opts: &[(&str, f64)]) -> RoamOptions {
    let mut o = RoamOptions::default();
    for &(k, v) in opts {
        match k {
            "degree" => o.degree = v as usize,
            "exactRoom" => o.exact_room = v as usize,
            "keep" => o.keep = v,
            "holdMs" => o.hold_ms = v,
            "staleMs" => o.stale_ms = v,
            "goneMs" => o.gone_ms = v,
            "maxPerVip" => o.max_per_vip = v as usize,
            "maxPlayers" => o.max_players = v as usize,
            "minDegree" => o.min_degree = v as usize,
            "busyHigh" => o.busy_high = v,
            "busyLow" => o.busy_low = v,
            "capDownMs" => o.cap_down_ms = v,
            "capUpMs" => o.cap_up_ms = v,
            _ => panic!("no option {k}"),
        }
    }
    o
}

/// Math.hypot's cases: differences small and large, a zero or two among them, and the odd ones
fn hypots() -> Vec<[f64; 3]> {
    let mut r = Rng(99);
    let mut v: Vec<[f64; 3]> = (0..20_000)
        .map(|_| {
            let mut s = || match r.below(5) {
                0 => r.unit() * 40000.0 - 20000.0,
                1 => r.unit() * 2.0 - 1.0,
                2 => (r.unit() - 0.5) * 1e-6,
                3 => (r.unit() * 40000.0 - 20000.0) as f32 as f64 - (r.unit() * 40000.0 - 20000.0) as f32 as f64,
                _ => {
                    if r.below(5) == 0 {
                        0.0
                    } else {
                        r.below(1000) as f64 - 500.0
                    }
                }
            };
            [s(), s(), s()]
        })
        .collect();
    let odd = [0.0, -0.0, 1e-310, 5e-324, 1e300, 1.7976931348623157e308, f64::INFINITY, f64::NEG_INFINITY, f64::NAN, 3.0, 4.0, 12.0];
    for &x in &odd {
        for &y in &odd {
            v.push([x, y, 4.0]);
            v.push([x, 3.0, y]);
        }
    }
    v
}

fn put32(b: &mut Vec<u8>, v: u32) {
    b.extend_from_slice(&v.to_le_bytes());
}

fn put64(b: &mut Vec<u8>, v: f64) {
    b.extend_from_slice(&v.to_le_bytes());
}

fn input(hyp: &[[f64; 3]], scen: &[Scenario]) -> Vec<u8> {
    let mut b = Vec::new();
    put32(&mut b, hyp.len() as u32);
    for h in hyp {
        h.iter().for_each(|&x| put64(&mut b, x));
    }
    put32(&mut b, scen.len() as u32);
    for s in scen {
        let opts: Vec<String> = s.opts.iter().map(|(k, v)| format!("\"{k}\":{}", number_to_string(*v))).collect();
        let opts = format!("{{{}}}", opts.join(","));
        put32(&mut b, opts.len() as u32);
        b.extend_from_slice(opts.as_bytes());
        put32(&mut b, s.id);
        put32(&mut b, s.events.len() as u32);
        for e in &s.events {
            match e {
                Ev::At(t) => {
                    b.push(0);
                    put64(&mut b, *t);
                }
                Ev::Frame(from, f) => {
                    b.push(1);
                    put32(&mut b, *from);
                    put32(&mut b, f.len() as u32);
                    b.extend_from_slice(f);
                }
                Ev::Gone(vip) => {
                    b.push(2);
                    put32(&mut b, *vip);
                }
                Ev::Tick(busy) => {
                    b.push(3);
                    put64(&mut b, *busy);
                }
                Ev::Info => b.push(4),
            }
        }
    }
    b
}

/// node's answers, read in order
struct Reader<'a> {
    b: &'a [u8],
    o: usize,
}

impl Reader<'_> {
    fn bytes(&mut self, n: usize) -> &[u8] {
        let s = &self.b[self.o..self.o + n];
        self.o += n;
        s
    }
    fn u32(&mut self) -> u32 {
        u32::from_le_bytes(self.bytes(4).try_into().unwrap())
    }
    fn f64(&mut self) -> f64 {
        f64::from_le_bytes(self.bytes(8).try_into().unwrap())
    }
    fn str(&mut self) -> String {
        let n = self.u32() as usize;
        String::from_utf8(self.bytes(n).to_vec()).unwrap()
    }
}

/// a PEERS frame as words, for a message
fn show(vip: u32, f: &[u8]) -> String {
    let l: Vec<String> =
        if f.len() >= 33 { peers_of(f).iter().map(|e| format!("{}:{}:{}", e.vip, e.port, e.id)).collect() } else { vec![] };
    format!("{vip}:{}>{}", if f.len() >= 16 { u16::from_be_bytes([f[14], f[15]]) } else { 0 }, l.join(","))
}

/// where two strings part, with some of each around it
fn parting(a: &str, b: &str) -> String {
    let i = a.bytes().zip(b.bytes()).take_while(|(x, y)| x == y).count();
    let from = i.saturating_sub(80);
    let cut = |s: &str| s.get(from..(i + 80).min(s.len())).unwrap_or("").to_string();
    format!("at {i}: rust …{}… | node …{}…", cut(a), cut(b))
}

#[test]
fn links_as_roam_hub_mjs() {
    if !Command::new("node").arg("--version").output().is_ok_and(|o| o.status.success()) {
        eprintln!("no node: skipped");
        return;
    }
    let hyp = hypots();
    let scen = scenarios();
    let inp = input(&hyp, &scen);
    let mut child = Command::new("node")
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/crosscheck.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("node");
    let mut stdin = child.stdin.take().expect("stdin");
    let writer = std::thread::spawn(move || stdin.write_all(&inp));
    let mut out = Vec::new();
    child.stdout.take().expect("stdout").read_to_end(&mut out).expect("node's answer");
    writer.join().expect("writer").expect("node's input");
    assert!(child.wait().expect("node").success(), "node failed");
    let mut js = Reader { b: &out, o: 0 };

    // Math.hypot, bit for bit
    let mut hyp_diff = Vec::new();
    for h in &hyp {
        let (a, b) = (hypot(h[0], h[1], h[2]), js.f64());
        if a.to_bits() != b.to_bits() {
            hyp_diff.push(format!("hypot({}, {}, {}): rust {a:e}, node {b:e}", h[0], h[1], h[2]));
        }
    }
    assert!(hyp_diff.is_empty(), "{} of {} hypots differ: {:?}", hyp_diff.len(), hyp.len(), &hyp_diff[..hyp_diff.len().min(10)]);

    let (mut ticks, mut lists, mut links, mut records, mut most) = (0usize, 0usize, 0u64, 0usize, 0usize);
    let mut problems: Vec<String> = Vec::new();
    for s in &scen {
        let t = Arc::new(AtomicU64::new(0f64.to_bits()));
        let busy = Arc::new(AtomicU64::new(0f64.to_bits()));
        let logs = Arc::new(Mutex::new(Vec::<String>::new()));
        let sent = Arc::new(Mutex::new(Vec::<(u32, Bytes)>::new()));
        let sc = AtomicU64::new(0);
        let (t2, b2, l2, s2) = (t.clone(), busy.clone(), logs.clone(), sent.clone());
        let mut hub = Hub::new(
            options(&s.opts),
            Box::new(move || f64::from_bits(t2.load(Ordering::Relaxed))),
            Box::new(move || f64::from_bits(b2.load(Ordering::Relaxed))),
            Box::new(move |l: &str| l2.lock().push(l.to_string())),
            Box::new(move |vip, f| {
                s2.lock().push((vip, f));
                // every 11th send from the 8th on does not go (as crosscheck.mjs's)
                sc.fetch_add(1, Ordering::Relaxed) % 11 != 7
            }),
            s.id,
        );
        let record = |hub: &Hub, full: bool| {
            let mut info = hub.info();
            info.as_object_mut().expect("an object").shift_remove("tickMsMax");
            let mut r = serde_json::Map::new();
            r.insert("info".into(), info);
            r.insert("logs".into(), Value::from(std::mem::take(&mut *logs.lock())));
            if full {
                let mut v: Vec<u32> = hub.vips().into_iter().collect();
                v.sort_unstable();
                r.insert("vips".into(), Value::from(v));
                r.insert("links".into(), Value::Array(hub.links().into_iter().map(|(k, l)| json!([k, l])).collect()));
            }
            stringify(&Value::Object(r))
        };
        let mut k = 0;
        for (n, e) in s.events.iter().enumerate() {
            match e {
                Ev::At(x) => t.store(x.to_bits(), Ordering::Relaxed),
                Ev::Frame(from, f) => hub.frame(*from, f),
                Ev::Gone(vip) => hub.peer_gone(*vip),
                Ev::Tick(b) => {
                    busy.store(b.to_bits(), Ordering::Relaxed);
                    hub.tick();
                    let mine = std::mem::take(&mut *sent.lock());
                    let count = js.u32() as usize;
                    let theirs: Vec<(u32, Vec<u8>)> = (0..count)
                        .map(|_| {
                            let vip = js.u32();
                            let len = js.u32() as usize;
                            (vip, js.bytes(len).to_vec())
                        })
                        .collect();
                    ticks += 1;
                    lists += mine.len();
                    links += mine.iter().map(|(_, f)| f.get(32).copied().unwrap_or(0) as u64).sum::<u64>();
                    most = most.max(mine.len());
                    let first = mine.iter().zip(&theirs).position(|((va, fa), (vb, fb))| va != vb || fa[..] != fb[..]);
                    if mine.len() != theirs.len() || first.is_some() {
                        let i = first.unwrap_or(mine.len().min(theirs.len()));
                        problems.push(format!(
                            "{}, tick {k} (event {n}): {} lists vs node's {}; first difference at {i}: {} | {}",
                            s.name,
                            mine.len(),
                            theirs.len(),
                            mine.get(i).map_or("-".into(), |(v, f)| show(*v, f)),
                            theirs.get(i).map_or("-".into(), |(v, f)| show(*v, f)),
                        ));
                    }
                    let (a, b) = (record(&hub, false), js.str());
                    records += 1;
                    if a != b {
                        problems.push(format!("{}, tick {k}: {}", s.name, parting(&a, &b)));
                    }
                    k += 1;
                }
                Ev::Info => {
                    let (a, b) = (record(&hub, true), js.str());
                    records += 1;
                    if a != b {
                        problems.push(format!("{}, before tick {k} (event {n}): {}", s.name, parting(&a, &b)));
                    }
                }
            }
        }
    }
    assert_eq!(js.o, out.len(), "node said more than was read");
    println!(
        "{} scenarios, {ticks} ticks, {lists} PEERS lists ({links} links in all, up to {most} players a tick) and {records} info records \
         compared; {} hypots; {} differences",
        scen.len(),
        hyp.len(),
        problems.len()
    );
    assert!(lists >= 20_000, "at least 20,000 lists ({lists})");
    assert!(problems.is_empty(), "{}", problems[..problems.len().min(20)].join("\n"));
}
