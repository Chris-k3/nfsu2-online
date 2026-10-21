//! A crowd of simulated free-roam players for the server, light enough that 2000 of them leave the cores to the
//! server: what web/tools/roam-crowd.mjs does, without the game's own core (which costs each of its bots a wasm
//! instance).  Each bot is a page in free roam with the hub on: one /lan WebSocket (its own client address by
//! X-Forwarded-For, so the per-address limits see 2000 clients), a hello that takes bundles, a HELLO to the hub every
//! second and a SNAP twice a second (runtime/roam_core.c's layouts), and to each friend on the hub's last PEERS list
//! a SNAP 20 times a second (and a HELLO every second), each as one bundle entry for all of them, as the page sends
//! them (web/src/net TxBundle).  What it measures, from the players' side:
//!   - how many friends each has (the hub's lists: 32 when the server keeps up, fewer when its busy cap cuts them)
//!   - snapshots sent (one per friend) and received, so how many got lost on the way (the switch drops a datagram
//!     for a receiver that is too far behind, nfsu2-lan's `roam_queue`)
//!   - a snapshot's delay from sender to friend through the switch (the SNAP's own clock field carries the send
//!     time; one clock for every bot), and the switch's answer to the page's ping
//!   - WebSocket messages each way (what the server and the tunnel in front pay for)
//!
//!   nfsu2-roamload --base http://127.0.0.1:8691 [--n 2000] [--seconds 60] [--rate 20] [--spread 2000] [--room 7]
//!        [--stagger-ms 5] [--first 0] [--threads 4] [--out file.json]
//!   --rate      snapshots a second to each friend (the game: 20; Settings allow 60)
//!   --spread    the players' area, a square this many metres a side (each drives a circle of 40 m in it)
//!   --first     the first bot's number (two generators against one server: --first 0 and --first 1000)

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use nfsu2_util::Counter;
use parking_lot::Mutex;
use tokio::time::{MissedTickBehavior, interval_at, sleep};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};

const HUB: u32 = 0x0A4D_00FD;
const PORT: u16 = 47210;
const KIND_UDP: u8 = 1;
const KIND_BUNDLE: u8 = 32;
const MSG_HELLO: u8 = 1;
const MSG_PEERS: u8 = 2;
const MSG_SNAP: u8 = 3;
const HF_ALL: u16 = 0x0020;
const HF_STATEX: u16 = 0x0040;
const CORE_VER: u16 = 4;

struct Args {
    host: String,
    n: usize,
    seconds: u64,
    rate: f64,
    spread: f64,
    room: u32,
    stagger_ms: u64,
    first: usize,
    threads: usize,
    out: String,
}

fn args() -> Args {
    let a: Vec<String> = std::env::args().collect();
    let opt =
        |k: &str, d: &str| -> String { a.iter().position(|x| x == k).and_then(|i| a.get(i + 1)).cloned().unwrap_or_else(|| d.to_string()) };
    let base = opt("--base", "http://127.0.0.1:8080");
    let host = base.trim_start_matches("http://").trim_start_matches("ws://").trim_end_matches('/').to_string();
    Args {
        host,
        n: opt("--n", "2000").parse().expect("--n"),
        seconds: opt("--seconds", "60").parse().expect("--seconds"),
        rate: opt("--rate", "20").parse().expect("--rate"),
        spread: opt("--spread", "2000").parse().expect("--spread"),
        room: opt("--room", "7").parse().expect("--room"),
        stagger_ms: opt("--stagger-ms", "5").parse().expect("--stagger-ms"),
        first: opt("--first", "0").parse().expect("--first"),
        threads: opt("--threads", "4").parse().expect("--threads"),
        out: opt("--out", ""),
    }
}

/// A histogram of microseconds: 10 µs steps below 1 ms, 100 µs to 10 ms, 1 ms to 100 ms, 10 ms to 1 s, 100 ms to
/// 10 s, one bucket beyond.
const BUCKETS: usize = 461;
fn bucket(us: u64) -> usize {
    match us {
        0..1_000 => (us / 10) as usize,
        1_000..10_000 => 100 + ((us - 1_000) / 100) as usize,
        10_000..100_000 => 190 + ((us - 10_000) / 1_000) as usize,
        100_000..1_000_000 => 280 + ((us - 100_000) / 10_000) as usize,
        1_000_000..10_000_000 => 370 + ((us - 1_000_000) / 100_000) as usize,
        _ => 460,
    }
}
/// a bucket's upper end, in ms
fn bucket_ms(b: usize) -> f64 {
    let us = match b {
        0..100 => (b + 1) * 10,
        100..190 => 1_000 + (b - 99) * 100,
        190..280 => 10_000 + (b - 189) * 1_000,
        280..370 => 100_000 + (b - 279) * 10_000,
        370..460 => 1_000_000 + (b - 369) * 100_000,
        _ => 10_000_000,
    };
    us as f64 / 1000.0
}
fn pct(h: &[u64], p: f64) -> Option<f64> {
    let n: u64 = h.iter().sum();
    if n == 0 {
        return None;
    }
    let want = ((p / 100.0) * n as f64).ceil().max(1.0) as u64;
    let mut acc = 0;
    for (b, c) in h.iter().enumerate() {
        acc += c;
        if acc >= want {
            return Some(bucket_ms(b));
        }
    }
    Some(bucket_ms(BUCKETS - 1))
}

#[derive(Default)]
struct Hists {
    lat: Vec<u64>,
    ping: Vec<u64>,
}

struct Shared {
    t0: Instant,
    stop: AtomicBool,
    welcomed: AtomicU64,
    refused: AtomicU64,
    closed: AtomicU64,
    failed: AtomicU64,
    msgs_out: Counter,
    msgs_in: Counter,
    deliveries: Counter,
    snaps_out: Counter,
    dgrams_in: Counter,
    snaps_in: Counter,
    peers: Vec<AtomicU32>,
    window: Mutex<Hists>,
    total: Mutex<Hists>,
}

impl Shared {
    fn us(&self) -> u32 {
        self.t0.elapsed().as_micros() as u32
    }
}

fn hdr(w: &mut Vec<u8>, kind: u8, sender: u32, seq: u16, flags: u16) {
    w.extend_from_slice(b"N2FR");
    w.push(1);
    w.push(kind);
    w.extend_from_slice(&[0, 0]);
    w.extend_from_slice(&sender.to_le_bytes());
    w.extend_from_slice(&seq.to_le_bytes());
    w.extend_from_slice(&flags.to_le_bytes());
}
fn finish(mut w: Vec<u8>) -> Vec<u8> {
    let len = (w.len() + 4) as u16;
    w[6..8].copy_from_slice(&len.to_le_bytes());
    let crc = crc32fast::hash(&w);
    w.extend_from_slice(&crc.to_le_bytes());
    w
}
fn hello(id: u32, seq: u16, name: &str, room: u32) -> Vec<u8> {
    let mut w = Vec::with_capacity(64);
    hdr(&mut w, MSG_HELLO, id, seq, HF_ALL | HF_STATEX);
    w.extend_from_slice(&CORE_VER.to_le_bytes());
    w.push(0); // platform
    w.push(0); // status: free roam
    w.extend_from_slice(&PORT.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes()); // cfg_rev
    w.extend_from_slice(&room.to_le_bytes());
    w.push(name.len() as u8);
    w.extend_from_slice(name.as_bytes());
    w.push(0); // ids seen
    finish(w)
}
/// a SNAP of one state (with its extension for a friend, without for the hub), `t_us` the send time
fn snap(id: u32, seq: u16, t_us: u32, p: [f32; 3], statex: bool) -> Vec<u8> {
    let mut w = Vec::with_capacity(112);
    hdr(&mut w, MSG_SNAP, id, seq, if statex { HF_STATEX } else { 0 });
    w.extend_from_slice(&[0, 0, 1, 0, 1, 0]); // status, epoch, cfg_rev, n = 1, clock
    w.extend_from_slice(&t_us.to_le_bytes());
    for x in p {
        w.extend_from_slice(&x.to_le_bytes());
    }
    w.extend_from_slice(&[0u8; 12]); // velocity
    for q in [0f32, 0.0, 0.0, 1.0] {
        w.extend_from_slice(&q.to_le_bytes());
    }
    w.extend_from_slice(&[0u8; 8]);
    if statex {
        w.push(12);
        w.extend_from_slice(&[0u8; 11]);
    }
    finish(w)
}
/// a switch frame of kind 1 around a datagram
fn frame(dst: u32, dgram: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(16 + dgram.len());
    f.push(KIND_UDP);
    f.extend_from_slice(&[0, 0, 0]);
    f.extend_from_slice(&0u32.to_be_bytes());
    f.extend_from_slice(&dst.to_be_bytes());
    f.extend_from_slice(&PORT.to_be_bytes());
    f.extend_from_slice(&PORT.to_be_bytes());
    f.extend_from_slice(dgram);
    f
}
/// a bundle entry: the frame to each of `to` (none: to its own destination)
fn entry(b: &mut Vec<u8>, to: &[u32], f: &[u8]) {
    b.push(to.len() as u8);
    b.push(0);
    b.extend_from_slice(&(f.len() as u16).to_be_bytes());
    for v in to {
        b.extend_from_slice(&v.to_be_bytes());
    }
    b.extend_from_slice(f);
}

struct Bot {
    i: usize,
    id: u32,
    name: String,
    room: u32,
    seq: u16,
    centre: (f64, f64),
    phase: f64,
    friends: Vec<u32>,
    lat: Vec<u64>,
    ping: Vec<u64>,
    pings: Vec<(u64, Instant)>,
    ping_id: u64,
}

impl Bot {
    fn pos(&self, t: f64) -> [f32; 3] {
        let a = self.phase + t * 15.0 / 40.0;
        [(self.centre.0 + 40.0 * a.cos()) as f32, (self.centre.1 + 40.0 * a.sin()) as f32, 10.0]
    }
    fn next_seq(&mut self) -> u16 {
        self.seq = self.seq.wrapping_add(1);
        self.seq
    }
    /// one switch frame from the server
    fn take(&mut self, sh: &Shared, f: &[u8]) {
        if f.len() < 16 + 20 || f[0] != KIND_UDP {
            return;
        }
        sh.dgrams_in.inc();
        let src = u32::from_be_bytes([f[4], f[5], f[6], f[7]]);
        let m = &f[16..];
        if &m[0..4] != b"N2FR" {
            return;
        }
        match m[5] {
            MSG_PEERS if src == HUB && m.len() >= 21 => {
                let n = m[16] as usize;
                if m.len() < 17 + 10 * n + 4 {
                    return;
                }
                self.friends.clear();
                for k in 0..n {
                    let o = 17 + 10 * k;
                    self.friends.push(u32::from_be_bytes([m[o], m[o + 1], m[o + 2], m[o + 3]]));
                }
                sh.peers[self.i].store(n as u32, Ordering::Relaxed);
            }
            MSG_SNAP if m.len() >= 26 => {
                sh.snaps_in.inc();
                let t = u32::from_le_bytes([m[22], m[23], m[24], m[25]]);
                let d = sh.us().wrapping_sub(t) as u64;
                // a wrapped or future clock (cannot happen within one process) is left out
                if d < 3_600_000_000 {
                    self.lat[bucket(d)] += 1;
                }
            }
            _ => {}
        }
    }
    fn message(&mut self, sh: &Shared, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        if data[0] != KIND_BUNDLE {
            return self.take(sh, data);
        }
        let mut at = 4;
        while at + 4 <= data.len() {
            let k = data[at] as usize;
            let len = u16::from_be_bytes([data[at + 2], data[at + 3]]) as usize;
            let f = at + 4 + 4 * k;
            if f + len > data.len() {
                return;
            }
            self.take(sh, &data[f..f + len]);
            at = f + len;
        }
    }
    fn flush_hists(&mut self, sh: &Shared) {
        let mut w = sh.window.lock();
        for (a, b) in w.lat.iter_mut().zip(&self.lat) {
            *a += b;
        }
        for (a, b) in w.ping.iter_mut().zip(&self.ping) {
            *a += b;
        }
        drop(w);
        let mut t = sh.total.lock();
        for (a, b) in t.lat.iter_mut().zip(&self.lat) {
            *a += b;
        }
        for (a, b) in t.ping.iter_mut().zip(&self.ping) {
            *a += b;
        }
        self.lat.iter_mut().for_each(|x| *x = 0);
        self.ping.iter_mut().for_each(|x| *x = 0);
    }
}

async fn run_bot(i: usize, a: Arc<Args>, sh: Arc<Shared>) {
    let n = a.first + i;
    let mut req = format!("ws://{}/lan", a.host).into_client_request().expect("url");
    let xff = format!("198.18.{}.{}", (n >> 8) & 255, n & 255);
    req.headers_mut().insert("x-forwarded-for", HeaderValue::from_str(&xff).expect("xff"));
    let ws = match tokio_tungstenite::connect_async(req).await {
        Ok((ws, _)) => ws,
        Err(_) => {
            sh.failed.fetch_add(1, Ordering::Relaxed);
            return;
        }
    };
    let (mut tx, mut rx) = ws.split();
    // the welcome
    loop {
        match rx.next().await {
            Some(Ok(Message::Text(t))) if t.contains("\"welcome\"") => break,
            Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                sh.refused.fetch_add(1, Ordering::Relaxed);
                return;
            }
            _ => {}
        }
    }
    sh.welcomed.fetch_add(1, Ordering::Relaxed);
    let name = format!("bot{n}");
    let hello_msg = format!("{{\"t\":\"hello\",\"name\":\"{name}\",\"deltas\":1,\"lan\":0,\"bundle\":1}}");
    if tx.send(Message::Text(hello_msg.into())).await.is_err() {
        sh.closed.fetch_add(1, Ordering::Relaxed);
        return;
    }
    // where it drives: a fixed scatter over the square, the same for every run
    let h = |k: u64| {
        ((n as u64 + 1).wrapping_mul(0x9E37_79B9_7F4A_7C15).wrapping_add(k).wrapping_mul(0xBF58_476D_1CE4_E5B9) >> 11) as f64
            / (1u64 << 53) as f64
    };
    let mut bot = Bot {
        i,
        id: (nfsu2_util::rand::u32() | 1),
        name,
        room: a.room,
        seq: 0,
        centre: ((h(1) - 0.5) * a.spread, (h(2) - 0.5) * a.spread),
        phase: h(3) * std::f64::consts::TAU,
        friends: Vec::new(),
        lat: vec![0; BUCKETS],
        ping: vec![0; BUCKETS],
        pings: Vec::new(),
        ping_id: 0,
    };
    let now = tokio::time::Instant::now();
    let period = Duration::from_secs_f64(1.0 / a.rate);
    let jitter = |k: u64, max: Duration| Duration::from_secs_f64(h(k) * max.as_secs_f64());
    let mut snap_iv = interval_at(now + jitter(4, period), period);
    let mut hello_iv = interval_at(now + jitter(5, Duration::from_secs(1)), Duration::from_secs(1));
    let mut hub_iv = interval_at(now + jitter(6, Duration::from_millis(500)), Duration::from_millis(500));
    let mut ping_iv = interval_at(now + jitter(7, Duration::from_secs(2)), Duration::from_secs(2));
    let mut flush_iv = interval_at(now + jitter(8, Duration::from_secs(1)), Duration::from_secs(1));
    for iv in [&mut snap_iv, &mut hello_iv, &mut hub_iv, &mut ping_iv, &mut flush_iv] {
        iv.set_missed_tick_behavior(MissedTickBehavior::Delay);
    }
    // the first HELLO at once: the hub starts a player with it
    let first = frame(HUB, &hello(bot.id, 0, &bot.name, bot.room));
    let mut b = vec![KIND_BUNDLE, 0, 0, 0];
    entry(&mut b, &[], &first);
    let _ = tx.send(Message::Binary(Bytes::from(b))).await;
    sh.msgs_out.inc();
    let t0 = sh.t0;
    loop {
        if sh.stop.load(Ordering::Relaxed) {
            let _ = tx.send(Message::Close(None)).await;
            return;
        }
        let out: Option<Vec<u8>> = tokio::select! {
            m = rx.next() => match m {
                Some(Ok(Message::Binary(d))) => { sh.msgs_in.inc(); bot.message(&sh, &d); None }
                Some(Ok(Message::Text(t))) => {
                    sh.msgs_in.inc();
                    if let Some(p) = t.find("\"pong\"").and(t.find("\"id\":")) {
                        let id: u64 = t[p + 5..].trim_end_matches('}').parse().unwrap_or(u64::MAX);
                        if let Some(k) = bot.pings.iter().position(|(x, _)| *x == id) {
                            let (_, at) = bot.pings.swap_remove(k);
                            bot.ping[bucket(at.elapsed().as_micros() as u64)] += 1;
                        }
                    }
                    None
                }
                Some(Ok(_)) => None,
                Some(Err(_)) | None => { sh.closed.fetch_add(1, Ordering::Relaxed); bot.flush_hists(&sh); return; }
            },
            _ = snap_iv.tick() => {
                if bot.friends.is_empty() { None } else {
                    let t = t0.elapsed().as_secs_f64();
                    let seq = bot.next_seq();
                    let f = frame(0, &snap(bot.id, seq, sh.us(), bot.pos(t), true));
                    let mut b = Vec::with_capacity(8 + 4 * bot.friends.len() + f.len());
                    b.extend_from_slice(&[KIND_BUNDLE, 0, 0, 0]);
                    entry(&mut b, &bot.friends, &f);
                    sh.deliveries.add(bot.friends.len() as u64);
                    sh.snaps_out.add(bot.friends.len() as u64);
                    Some(b)
                }
            }
            _ = hello_iv.tick() => {
                let seq = bot.next_seq();
                let hub = frame(HUB, &hello(bot.id, seq, &bot.name, bot.room));
                let mut b = vec![KIND_BUNDLE, 0, 0, 0];
                entry(&mut b, &[], &hub);
                if !bot.friends.is_empty() {
                    let f = frame(0, &hello(bot.id, seq, &bot.name, bot.room));
                    entry(&mut b, &bot.friends, &f);
                    sh.deliveries.add(bot.friends.len() as u64);
                }
                Some(b)
            }
            _ = hub_iv.tick() => {
                let t = t0.elapsed().as_secs_f64();
                let seq = bot.next_seq();
                Some(frame(HUB, &snap(bot.id, seq, sh.us(), bot.pos(t), false)))
            }
            _ = ping_iv.tick() => {
                bot.ping_id += 1;
                bot.pings.push((bot.ping_id, Instant::now()));
                if bot.pings.len() > 16 { bot.pings.remove(0); }
                let m = format!("{{\"t\":\"ping\",\"id\":{}}}", bot.ping_id);
                sh.msgs_out.inc();
                if tx.send(Message::Text(m.into())).await.is_err() { sh.closed.fetch_add(1, Ordering::Relaxed); return; }
                None
            }
            _ = flush_iv.tick() => { bot.flush_hists(&sh); None }
        };
        if let Some(b) = out {
            sh.msgs_out.inc();
            if tx.send(Message::Binary(Bytes::from(b))).await.is_err() {
                sh.closed.fetch_add(1, Ordering::Relaxed);
                return;
            }
        }
    }
}

fn raise_nofile() {
    // SAFETY: plain libc calls on a struct they fill
    unsafe {
        let mut r: libc::rlimit = std::mem::zeroed();
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut r) == 0 && r.rlim_cur < r.rlim_max {
            r.rlim_cur = r.rlim_max;
            libc::setrlimit(libc::RLIMIT_NOFILE, &r);
        }
    }
}

fn main() {
    raise_nofile();
    let a = Arc::new(args());
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(a.threads).enable_all().build().expect("runtime");
    rt.block_on(async move {
        let sh = Arc::new(Shared {
            t0: Instant::now(),
            stop: AtomicBool::new(false),
            welcomed: AtomicU64::new(0),
            refused: AtomicU64::new(0),
            closed: AtomicU64::new(0),
            failed: AtomicU64::new(0),
            msgs_out: Counter::new(),
            msgs_in: Counter::new(),
            deliveries: Counter::new(),
            snaps_out: Counter::new(),
            dgrams_in: Counter::new(),
            snaps_in: Counter::new(),
            peers: (0..a.n).map(|_| AtomicU32::new(0)).collect(),
            window: Mutex::new(Hists { lat: vec![0; BUCKETS], ping: vec![0; BUCKETS] }),
            total: Mutex::new(Hists { lat: vec![0; BUCKETS], ping: vec![0; BUCKETS] }),
        });
        let mut tasks = Vec::new();
        for i in 0..a.n {
            let (a2, sh2) = (a.clone(), sh.clone());
            tasks.push(tokio::spawn(async move {
                sleep(Duration::from_millis(a2.stagger_ms * i as u64)).await;
                run_bot(i, a2, sh2).await
            }));
        }
        let mut samples = Vec::new();
        let mut last = (0u64, 0u64, 0u64, 0u64, 0u64, 0u64);
        let mut last_t = Instant::now();
        let ramp = Duration::from_millis(a.stagger_ms * a.n as u64);
        let end = Instant::now() + ramp + Duration::from_secs(a.seconds);
        let mut steady = Hists { lat: vec![0; BUCKETS], ping: vec![0; BUCKETS] };
        let (mut steady_dl, mut steady_in) = (0u64, 0u64);
        while Instant::now() < end {
            sleep(Duration::from_secs(5)).await;
            let dt = last_t.elapsed().as_secs_f64();
            last_t = Instant::now();
            let now = (sh.msgs_out.get(), sh.msgs_in.get(), sh.deliveries.get(), sh.dgrams_in.get(), sh.snaps_out.get(), sh.snaps_in.get());
            let w = std::mem::replace(&mut *sh.window.lock(), Hists { lat: vec![0; BUCKETS], ping: vec![0; BUCKETS] });
            let welcomed = sh.welcomed.load(Ordering::Relaxed);
            let linked: Vec<u32> = sh.peers.iter().map(|p| p.load(Ordering::Relaxed)).filter(|p| *p > 0).collect();
            let peers_mean = if linked.is_empty() { 0.0 } else { linked.iter().sum::<u32>() as f64 / linked.len() as f64 };
            let snaps_out = (now.4 - last.4) as f64;
            let snaps_in = (now.5 - last.5) as f64;
            let in_steady = last_t.duration_since(sh.t0) > ramp + Duration::from_secs(10);
            if in_steady {
                for (x, y) in steady.lat.iter_mut().zip(&w.lat) {
                    *x += y;
                }
                for (x, y) in steady.ping.iter_mut().zip(&w.ping) {
                    *x += y;
                }
                steady_dl += now.4 - last.4;
                steady_in += now.5 - last.5;
            }
            let s = serde_json::json!({
                "t": (last_t.duration_since(sh.t0).as_secs_f64() * 10.0).round() / 10.0,
                "players": welcomed - sh.closed.load(Ordering::Relaxed),
                "linked": linked.len(), "peersMean": (peers_mean * 10.0).round() / 10.0,
                "msgsOutPerS": ((now.0 - last.0) as f64 / dt).round(), "msgsInPerS": ((now.1 - last.1) as f64 / dt).round(),
                "deliveriesPerS": ((now.2 - last.2) as f64 / dt).round(), "dgramsInPerS": ((now.3 - last.3) as f64 / dt).round(),
                "snapLossPct": if snaps_out > 0.0 { (((snaps_out - snaps_in) / snaps_out * 1000.0).round() / 10.0).max(0.0) } else { 0.0 },
                "latencyMs": { "p50": pct(&w.lat, 50.0), "p90": pct(&w.lat, 90.0), "p99": pct(&w.lat, 99.0), "max": pct(&w.lat, 100.0) },
                "pingMs": { "p50": pct(&w.ping, 50.0), "p99": pct(&w.ping, 99.0), "max": pct(&w.ping, 100.0) },
                "refused": sh.refused.load(Ordering::Relaxed), "failed": sh.failed.load(Ordering::Relaxed), "closed": sh.closed.load(Ordering::Relaxed),
            });
            println!("{s}");
            samples.push(s);
            last = now;
        }
        sh.stop.store(true, Ordering::Relaxed);
        sleep(Duration::from_millis(500)).await;
        let t = sh.total.lock();
        let summary = serde_json::json!({
            "n": a.n, "rate": a.rate, "spread": a.spread, "seconds": a.seconds,
            "welcomed": sh.welcomed.load(Ordering::Relaxed), "refused": sh.refused.load(Ordering::Relaxed),
            "failed": sh.failed.load(Ordering::Relaxed), "closed": sh.closed.load(Ordering::Relaxed),
            "steady": {
                "snapLossPct": if steady_dl > 0 { ((steady_dl as f64 - steady_in as f64) / steady_dl as f64 * 1000.0).round() / 10.0 } else { 0.0 },
                "latencyMs": { "p50": pct(&steady.lat, 50.0), "p90": pct(&steady.lat, 90.0), "p99": pct(&steady.lat, 99.0), "p999": pct(&steady.lat, 99.9), "max": pct(&steady.lat, 100.0) },
                "pingMs": { "p50": pct(&steady.ping, 50.0), "p90": pct(&steady.ping, 90.0), "p99": pct(&steady.ping, 99.0), "max": pct(&steady.ping, 100.0) },
            },
            "all": {
                "latencyMs": { "p50": pct(&t.lat, 50.0), "p99": pct(&t.lat, 99.0), "max": pct(&t.lat, 100.0) },
                "pingMs": { "p50": pct(&t.ping, 50.0), "p99": pct(&t.ping, 99.0), "max": pct(&t.ping, 100.0) },
            },
        });
        drop(t);
        println!("{summary}");
        if !a.out.is_empty() {
            let doc = serde_json::json!({ "summary": summary, "samples": samples });
            std::fs::write(&a.out, serde_json::to_string_pretty(&doc).unwrap()).expect("--out");
        }
        std::process::exit(0);
    });
}
