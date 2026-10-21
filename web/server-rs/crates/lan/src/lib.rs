//! The virtual LAN switch: the port of web/server/lan.mjs, rule for rule (its long comment at the top is the
//! protocol and the reasoning behind every limit; this crate keeps the same frames, messages, limits, counts and
//! file), on every core instead of Node's one thread.
//!
//! # How the work is shared out
//!
//! Each connection has two tasks on the multi-threaded runtime: a reader and a writer.
//!
//! - The reader reads the client's messages and routes each frame itself, on whatever core it runs: the sender's
//!   own buckets (behind its own lock, uncontended but for the Online host's charges), its client's and site's
//!   (behind theirs: shared only by that client's connections), then the receivers.  No lock is shared by all.
//! - Who is on the switch changes under one lock (`members`: admit, leave, reservations, the peer-list changes,
//!   the store); routing never takes it.  A frame finds its receiver in a fixed table of the 2000 addresses (an
//!   `ArcSwapOption<Peer>` per address: one atomic load), a broadcast walks a copy-on-write list of every peer.
//! - Each receiver has its own queue (`OutQueue`: a short lock, a byte count the senders read for the queue
//!   rules, a wake-up for its writer).  Its writer takes everything queued at once and puts it into one write:
//!   under load many frames leave in one system call.  For a page that takes bundles the writer makes them from the
//!   datagrams queued (one frame alone goes as it is), and free roam's datagrams wait for the next tick of the
//!   bundle clock when nothing else is queued: Node bundled what came in one turn of its event loop, a turn that
//!   grew with the load; here the clock does it (without it every datagram wakes its writer: the .NET port measured
//!   2.19 against 0.94 cores).  Text and stream segments wake it at once.
//! - The clock's tick follows the crowd: `bundle_ms` (4 ms) while few take bundles, longer as more do, so that the
//!   switch sends about `bundle_budget` (125,000) bundles a second in all, up to `bundle_max_ms` (25 ms).  What a
//!   crowd costs is its messages, not its bytes: each is a TCP segment, which the kernel (and the tunnel in front,
//!   cloudflared, again) pays for whole.  2000 players in free roam with 32 friends each, on 6 cores of a Ryzen
//!   5900X: at 4 ms, 374,000 messages a second and 8.5 cores, not keeping up (the hub cut their links to 22); at
//!   16 ms, 132,000 messages, 4.2 cores, every link, a snapshot 11 ms (p50) to 25 ms (p99) from player to player.
//!   Free roam draws friends' cars 100 ms in the past.
//! - The Online host and the free-roam hub are actors on threads of their own (nfsu2-util `Host`); the switch
//!   posts them their frames in order and they send through [`LanSwitch::send_to`] from their thread.
//! - Counters that every frame touches are sharded (`nfsu2_util::Counter`); the per-peer ones are the peer's own.
//!
//! What Node's `ws.bufferedAmount` was is the receiver's `buffered` count here: bytes handed to its writer and not
//! yet taken by the kernel.  The datagrams waiting for the bundle clock are counted apart (Node's `p.outBytes`), so
//! every rule reads what it read in Node: `roamQueue` and `shedQueue` both, `sendBuffer`, `onlineQueue` and the
//! stream pump `buffered` alone.
//!
//! A frame is never written to in place: a datagram is copied once, by its receiver's writer, into the bytes that
//! go out, with its source (the sender's address) and its destination written there.  So a bundle's frame goes to
//! its 32 receivers as 32 references to the bytes the sender's reader read, and no receiver needs a copy of its own.
//!
//! # The ws library's behaviour kept
//!
//! A close frame from the client is answered with one (its code) and the connection ends; the 'close' the switch
//! sees has the client's code and reason (1005 without a code), or 1006 when the connection ended without one.
//! `close(code, reason)` sends a close frame and waits up to 30 s for the client's before the connection goes;
//! `terminate()` ends it at once (1006).  A protocol error (nfsu2-ws `ReadError::Protocol`) sends that close
//! frame (its code only, as ws did) and ends the connection.  Nothing the client sends after a close counts.

mod conn;
mod impair;
mod members;
mod reader;
mod route;
mod store;
mod text;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU8, AtomicU64, Ordering::Relaxed};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use arc_swap::{ArcSwap, ArcSwapOption};
use bytes::Bytes;
use nfsu2_util::{Bucket, Charge, Counter, Host, SendResult, SwitchSend, Tap};
use parking_lot::Mutex;
use serde_json::{Map, Value};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_util::sync::CancellationToken;

use conn::{Conn, Out};

pub use text::{clean_name, vip_num};

/// 10.77.0.0/21's mask, which the welcome tells the page
pub const MASK: &str = "255.255.248.0";
/// addresses the switch hands out: host bytes 2-251 in each of the eight /24s
pub const ADDRS: usize = 2000;
pub const BROADCAST: u32 = 0xFFFF_FFFF;

const BASE: u32 = (10 << 24) | (77 << 16);
/// free roam's datagrams (and LAN play's broadcasts): dropped first (roamQueue)
const KIND_UDP: u8 = 1;
/// LAN play's UDP and ICMP (with TCP, kinds 3-5): broadcasts only to the browsers with LAN play open
const KIND_LAN_UDP: u8 = 3;
const KIND_LAN_ICMP: u8 = 5;
/// LAN play's TCP segments: never dropped
const KIND_STREAM: u8 = 4;
/// several frames in one message (lan.mjs's comment)
const KIND_BUNDLE: u8 = 32;
/// a receiver with less than this queued gets stream segments at once
const STREAM_LOW: usize = 64 << 10;
/// bytes in one bundle to a client at most
const BUNDLE_OUT: usize = 32 << 10;
/// how long ws waited for the client's close frame after its own (`closeTimeout`)
const CLOSE_TIMEOUT: Duration = Duration::from_secs(30);

/// lan.mjs `LAN_DEFAULTS` (the meaning of each is in lan.mjs's comment)
#[derive(Clone, Debug)]
pub struct LanOptions {
    pub max_peers: usize,
    pub max_frame: usize,
    pub max_bundle: usize,
    pub frame_rate: f64,
    pub byte_rate: f64,
    pub group_frame_rate: f64,
    pub group_byte_rate: f64,
    pub site_frame_rate: f64,
    pub site_byte_rate: f64,
    pub text_rate: f64,
    pub max_text: usize,
    pub ctl_rate: f64,
    pub shed_queue: usize,
    pub roam_queue: usize,
    pub stream_queue: usize,
    pub stream_share: usize,
    pub stall_ms: f64,
    pub send_buffer: usize,
    pub keepalive_ms: u64,
    pub idle_ms: i64,
    pub reserve_ms: i64,
    pub group_reserve: usize,
    pub site_reserve: usize,
    pub resume_wait_ms: u64,
    pub online_queue: usize,
    pub peers_ms: u64,
    pub full_peers_ms: f64,
    /// the bundle clock's shortest tick (0: no clock, a datagram wakes its writer at once)
    pub bundle_ms: u64,
    /// its longest: the tick grows from `bundle_ms` as more players take bundles, towards `bundle_budget` bundles a
    /// second in all (the crate doc says why); `bundle_ms` or less: a fixed tick
    pub bundle_max_ms: u64,
    pub bundle_budget: u64,
    /// SO_SNDBUF for /lan connections (NFSU2_LAN_SNDBUF; 0: the kernel's own, which Linux grows to megabytes)
    pub send_buffer_os: usize,
    /// the largest WebSocket message a client may send (server.mjs `LIMITS.wsMaxPayload`, the ws library's
    /// `maxPayload`: a larger one closes the connection with 1009); the switch drops frames over `max_frame` and
    /// bundles over `max_bundle` itself
    pub max_payload: usize,
}

impl Default for LanOptions {
    fn default() -> Self {
        LanOptions {
            max_peers: 128,
            max_frame: 8192,
            max_bundle: 64 << 10,
            frame_rate: 2500.0,
            byte_rate: (256 << 10) as f64,
            group_frame_rate: 5000.0,
            group_byte_rate: (512 << 10) as f64,
            site_frame_rate: 10000.0,
            site_byte_rate: (1 << 20) as f64,
            text_rate: 20.0,
            max_text: 1024,
            ctl_rate: 10.0,
            shed_queue: 256 << 10,
            roam_queue: 64 << 10,
            stream_queue: 2 << 20,
            stream_share: 1 << 20,
            stall_ms: 1000.0,
            send_buffer: 8 << 20,
            keepalive_ms: 25_000,
            idle_ms: 10 * 60_000,
            reserve_ms: 60_000,
            group_reserve: 8,
            site_reserve: 16,
            resume_wait_ms: 5_000,
            online_queue: 1 << 20,
            peers_ms: 250,
            full_peers_ms: 1000.0,
            bundle_ms: 4,
            bundle_max_ms: 25,
            bundle_budget: 125_000,
            send_buffer_os: 0,
            max_payload: 64 << 10,
        }
    }
}

impl LanOptions {
    /// lan.mjs takes only finite numbers above 0 from its options: a 0 (or a negative or non-finite rate) keeps the
    /// default.  (`bundle_ms` and `send_buffer_os` are not lan.mjs's: their 0 means what it says.)
    fn sane(mut self) -> Self {
        let d = LanOptions::default();
        macro_rules! whole {
            ($($f:ident),*) => { $( if self.$f == 0 { self.$f = d.$f; } )* };
        }
        macro_rules! signed {
            ($($f:ident),*) => { $( if self.$f <= 0 { self.$f = d.$f; } )* };
        }
        macro_rules! real {
            ($($f:ident),*) => { $( if !(self.$f.is_finite() && self.$f > 0.0) { self.$f = d.$f; } )* };
        }
        whole!(
            max_peers,
            max_frame,
            max_bundle,
            max_text,
            shed_queue,
            roam_queue,
            stream_queue,
            stream_share,
            send_buffer,
            keepalive_ms,
            group_reserve,
            site_reserve,
            resume_wait_ms,
            online_queue,
            peers_ms,
            max_payload,
            bundle_budget
        );
        signed!(idle_ms, reserve_ms);
        real!(
            frame_rate,
            byte_rate,
            group_frame_rate,
            group_byte_rate,
            site_frame_rate,
            site_byte_rate,
            text_rate,
            ctl_rate,
            stall_ms,
            full_peers_ms
        );
        self
    }
}

/// `AttachOpts::on_join`: (vip, resumed, players on the switch now)
pub type OnJoin = Box<dyn Fn(u32, bool, usize) + Send + Sync>;
/// `AttachOpts::on_leave`: (vip, name, players on the switch now)
pub type OnLeave = Box<dyn Fn(u32, &str, usize) + Send + Sync>;

/// What the server tells the switch about a new connection (lan.mjs `attach` opts).
#[derive(Default)]
pub struct AttachOpts {
    /// the client asked for /lan?resume (its first message says which address, with the token)
    pub resume: bool,
    /// an opaque id shared by the connections of one client address (their shared limits); None: one of its own
    pub group: Option<String>,
    /// the same for one site (an IPv6 /48), or none
    pub site: Option<String>,
    /// for the server's console: (vip, resumed, players on the switch now)
    pub on_join: Option<OnJoin>,
    /// (vip, name, players on the switch now)
    pub on_leave: Option<OnLeave>,
}

/// lan.mjs `breakdown()`
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Breakdown {
    pub players: usize,
    pub online: usize,
    pub lan: usize,
    pub roam: usize,
    pub older: usize,
    pub other: usize,
    pub bundles: usize,
}

/// Why the switch closed a connection (lan.mjs `cuts`): a control-frame flood, a queue over sendBuffer (when
/// sending; on the keepalive tick), no pong to its ping, idle, a client that flooded a receiver with stream segments,
/// a receiver that stopped reading the stream segments it was sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Cut {
    Flood,
    Slow,
    Queue,
    Dead,
    Idle,
    Hog,
    Stall,
}

const CUT_NAMES: [&str; 7] = ["flood", "slow", "queue", "dead", "idle", "hog", "stall"];

/// The switch's counts (lan.mjs's `frames`, `bytes`, ... and `cuts`): sharded, every frame adds to some.
#[derive(Default)]
pub(crate) struct Stats {
    frames: Counter,
    bytes: Counter,
    dropped: Counter,
    limited: Counter,
    refused: Counter,
    /// datagrams dropped for a receiver's full queue
    shed: Counter,
    bundles_in: Counter,
    bundles_out: Counter,
    /// addresses given back to their token
    resumed: Counter,
    /// addresses freed at once: the page closed its connection itself
    released: Counter,
    /// reservations a client gave up for its newer ones (groupReserve, siteReserve)
    evicted: Counter,
    /// frames the impairment lost
    lost: Counter,
    cuts: [Counter; 7],
}

impl Stats {
    fn cut(&self, why: Cut) {
        self.cuts[why as usize].inc();
    }
}

/// A token bucket pair: frames and bytes a second.
#[derive(Clone)]
pub(crate) struct Pair {
    frames: Bucket,
    bytes: Bucket,
}

impl Pair {
    fn new(frame_rate: f64, byte_rate: f64) -> Self {
        Pair { frames: Bucket::new(frame_rate), bytes: Bucket::new(byte_rate) }
    }
    /// refilled to `now`: the frames and bytes there
    fn refill(&mut self, now: f64) -> (f64, f64) {
        self.frames.has_at(now, 0.0);
        self.bytes.has_at(now, 0.0);
        (self.frames.v, self.bytes.v)
    }
    /// what `refill` found there paid for some of it (lan.mjs `take`, once for several)
    fn spend_paid(&mut self, frames: f64, bytes: f64) {
        self.frames.v -= frames;
        self.bytes.v -= bytes;
    }
    /// a host's frame charged: false once a bucket is in debt (both are spent, as lan.mjs's `|` did)
    fn spend(&mut self, now: f64, frames: f64, bytes: f64) -> bool {
        let a = self.frames.spend_at(now, frames);
        let b = self.bytes.spend_at(now, bytes);
        a & b
    }
}

/// The limits shared by the connections of one client address (a group) or of one site.
pub(crate) struct Group {
    id: Arc<str>,
    buckets: Mutex<Pair>,
}

/// A text message's and a control frame's buckets: its reader's own.
struct CtlBuckets {
    texts: Bucket,
    ctl: Bucket,
}

const LAN_NULL: u8 = 0;
const LAN_OFF: u8 = 1;
const LAN_ON: u8 = 2;

/// A player on the switch (lan.mjs's `peer`): one connection holding one address.
pub(crate) struct Peer {
    vip: u32,
    conn: Arc<Conn>,
    group: Arc<Group>,
    site: Option<Arc<Group>>,
    token_hash: [u8; 32],
    /// its first hello's name ("player" until then)
    name: OnceLock<Box<str>>,
    /// its first hello came (the name, and deltas: it takes the changes to the peer list)
    hello: AtomicBool,
    deltas: AtomicBool,
    /// it takes bundles (its hello said so)
    bundle: AtomicBool,
    /// LAN play open: said nothing (a page of before), off, on
    lan: AtomicU8,
    frames_in: AtomicU64,
    frames_out: AtomicU64,
    /// its reader posted a frame to the Online host while it handled the message it read last (route.rs; the reader
    /// then waits while the host's backlog is long: `online_backlog`)
    fed_online: AtomicBool,
    /// frames and bytes: its reader's routing and the Online host's charges
    buckets: Mutex<Pair>,
    ctl: Mutex<CtlBuckets>,
    alive: AtomicBool,
    last_in: AtomicI64,
    /// the payload of the switch's last ping, until its pong
    ping: Mutex<Option<[u8; 8]>>,
}

impl Peer {
    fn name(&self) -> &str {
        self.name.get().map(|n| &**n).unwrap_or("player")
    }
    fn lan(&self) -> Option<bool> {
        match self.lan.load(Relaxed) {
            LAN_OFF => Some(false),
            LAN_ON => Some(true),
            _ => None,
        }
    }
    fn open(&self) -> bool {
        self.conn.open()
    }
    fn takes_bundles(&self) -> bool {
        self.bundle.load(Relaxed)
    }
}

/// What the switch keeps of a connection while it is open (lan.mjs `attach`'s closure).
pub(crate) struct AttachCtx {
    resume: bool,
    group: Arc<Group>,
    site: Option<Arc<Group>>,
    on_join: Option<OnJoin>,
    on_leave: Option<OnLeave>,
}

/// The sender's buckets while the Online host handles its frame (lan.mjs `this.cause`): what the host sends because
/// of it is spent from them, and once one ran dry the host closes that stream (`overrun`).
struct Cause {
    peer: Arc<Peer>,
    stats: Arc<Stats>,
    over: AtomicBool,
    counted: AtomicBool,
}

impl Charge for Cause {
    fn spend(&self, frames: u32, bytes: usize) {
        let now = nfsu2_util::mono_ms();
        let (f, b) = (frames as f64, bytes as f64);
        // the same order as the reader's: connection, client, site
        let mut ok = self.peer.buckets.lock().spend(now, f, b);
        ok &= self.peer.group.buckets.lock().spend(now, f, b);
        if let Some(s) = &self.peer.site {
            ok &= s.buckets.lock().spend(now, f, b);
        }
        if !ok {
            self.over.store(true, Relaxed);
        }
    }
    fn overspent(&self) -> bool {
        let over = self.over.load(Relaxed);
        if over && !self.counted.swap(true, Relaxed) {
            self.stats.limited.inc();
        }
        over
    }
}

/// the clients (or sites) with connections on the switch, by id: their limits and how many connections share them
type Groups = HashMap<Arc<str>, (Arc<Group>, usize)>;

/// The switch.
pub struct LanSwitch {
    o: LanOptions,
    me: Weak<LanSwitch>,
    /// --lan-impair (test aid, only with the server's --dev)
    impair: Option<impair::Impair>,
    online: Option<Arc<dyn Host>>,
    roam: Option<Arc<dyn Host>>,
    /// their addresses (a host's never changes: looked up once, not for every frame)
    online_vip: Option<u32>,
    roam_vip: Option<u32>,
    /// the frames posted to the Online host and not handled yet (nfsu2_util::Backlog): its senders wait past 4096
    online_backlog: Arc<nfsu2_util::host::Backlog>,
    tap: Option<Tap>,
    store: Option<Arc<store::Store>>,
    /// the peer at each of the 2000 addresses (`slot()`), for unicast without a lock
    table: Box<[ArcSwapOption<Peer>]>,
    /// every peer, in the order the JS Map kept them (broadcasts, the timers, info)
    all: ArcSwap<Vec<Arc<Peer>>>,
    members: Mutex<members::Members>,
    /// LAN play's stream segments queued at their receivers (rare traffic: one lock for all of them)
    streams: Mutex<route::Streams>,
    groups: Mutex<Groups>,
    sites: Mutex<Groups>,
    anon: AtomicU64,
    conn_ids: AtomicU64,
    stats: Arc<Stats>,
    /// the bundle clock (none at bundle_ms 0)
    clock: Option<Arc<conn::Clock>>,
    stopped: CancellationToken,
}

/// The bundle clock's tick for `n` players who take bundles: what sends them `bundle_budget` bundles a second in all
/// (one each a tick), from `bundle_ms` up to `bundle_max_ms`
fn bundle_tick(o: &LanOptions, n: u64) -> Duration {
    let lo = o.bundle_ms * 1000;
    let hi = o.bundle_max_ms.max(o.bundle_ms) * 1000;
    Duration::from_micros((n * 1_000_000 / o.bundle_budget.max(1)).clamp(lo, hi))
}

/// The table's index of an address the switch hands out: its /24 and its host byte, the reverse of `vip_at`.
fn slot(vip: u32) -> Option<usize> {
    let host = vip & 255;
    if vip & 0xFFFF_F800 != BASE || !(2..=251).contains(&host) {
        return None;
    }
    Some(((vip >> 8) & 7) as usize + 8 * (host as usize - 2))
}

impl LanSwitch {
    /// lan.mjs `new LanSwitch(opts)`: `impair` the --lan-impair spec ("" for none), the hosts (the Online host and
    /// the free-roam hub; give them `switch_send()` afterwards), the dev trace, and the store (the state folder's
    /// lan-addresses.json: the addresses held and reserved, by the hashes of their tokens, outlive a restart).
    /// Starts the switch's timers: call it on the tokio runtime.
    pub fn new(
        o: LanOptions,
        impair: &str,
        online: Option<Arc<dyn Host>>,
        roam: Option<Arc<dyn Host>>,
        tap: Option<Tap>,
        store: Option<PathBuf>,
    ) -> Arc<LanSwitch> {
        let o = o.sane();
        let store = store.map(|p| Arc::new(store::Store::new(p)));
        let mut m = members::Members::new();
        // the addresses of before a restart: reserved for their tokens again
        if let Some(st) = &store {
            let until = nfsu2_util::now_ms() + o.reserve_ms;
            for (v, hash) in st.load() {
                m.reserved.insert(v, members::Reservation { hash, until, group: None, site: None });
            }
        }
        let clock = (o.bundle_ms > 0).then(|| Arc::new(conn::Clock::new(Duration::from_millis(o.bundle_ms))));
        let sw = Arc::new_cyclic(|me| LanSwitch {
            impair: impair::Impair::parse(impair),
            online_vip: online.as_ref().map(|h| h.vip()),
            roam_vip: roam.as_ref().map(|h| h.vip()),
            // (about 20 ms of the host's work; its lobby's frames are small, each a copy of its own)
            online_backlog: nfsu2_util::host::Backlog::new(4096, 1024),
            online,
            roam,
            tap,
            store,
            table: (0..ADDRS).map(|_| ArcSwapOption::empty()).collect(),
            all: ArcSwap::from_pointee(Vec::new()),
            members: Mutex::new(m),
            streams: Mutex::new(route::Streams::default()),
            groups: Mutex::new(HashMap::new()),
            sites: Mutex::new(HashMap::new()),
            anon: AtomicU64::new(0),
            conn_ids: AtomicU64::new(0),
            stats: Arc::new(Stats::default()),
            clock,
            stopped: CancellationToken::new(),
            me: me.clone(),
            o,
        });
        sw.start_timers();
        sw
    }

    fn start_timers(self: &Arc<Self>) {
        // WebSocket pings keep proxies from cutting a quiet connection and find dead ones
        let me = self.me.clone();
        let stopped = self.stopped.clone();
        let period = Duration::from_millis(self.o.keepalive_ms);
        tokio::spawn(async move {
            let mut iv = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    _ = stopped.cancelled() => return,
                    _ = iv.tick() => {}
                }
                let Some(sw) = me.upgrade() else { return };
                sw.keepalive();
            }
        });
        if let Some(clock) = &self.clock {
            conn::Clock::start(Arc::downgrade(clock));
            if self.o.bundle_max_ms > self.o.bundle_ms {
                // every second: the tick for the players who take bundles now
                let (me, stopped) = (self.me.clone(), self.stopped.clone());
                tokio::spawn(async move {
                    let mut iv = tokio::time::interval(Duration::from_secs(1));
                    loop {
                        tokio::select! {
                            _ = stopped.cancelled() => return,
                            _ = iv.tick() => {}
                        }
                        let Some(sw) = me.upgrade() else { return };
                        let n = sw.all.load().iter().filter(|p| p.takes_bundles() && p.open()).count() as u64;
                        if let Some(c) = &sw.clock {
                            c.set_period(bundle_tick(&sw.o, n));
                        }
                    }
                });
            }
        }
        if let Some(im) = &self.impair {
            im.start(self.me.clone());
        }
    }

    /// A new connection, its WebSocket handshake answered already: `r`/`w` its halves, `pre` the bytes read past the
    /// handshake (lan.mjs `attach(ws, null, opts)`).  Its tasks run until it closes.
    pub fn attach<R, W>(self: &Arc<Self>, r: R, w: W, pre: Bytes, opts: AttachOpts)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let group = self.join_group(false, opts.group.as_deref());
        let site = opts.site.as_deref().map(|s| self.join_group(true, Some(s)));
        let ctx = Arc::new(AttachCtx { resume: opts.resume, group, site, on_join: opts.on_join, on_leave: opts.on_leave });
        let conn = Arc::new(Conn::new(self.conn_ids.fetch_add(1, Relaxed)));
        // without ?resume the welcome comes at once; a resume's hello comes first (the reader waits for it)
        if !ctx.resume {
            self.admit(&conn, &ctx, None);
        }
        tokio::spawn(conn::run(self.clone(), conn, r, w, pre, ctx));
    }

    /// lan.mjs `group(map, id, ...)`: the limits of one client (or site), shared by its connections
    fn join_group(&self, site: bool, id: Option<&str>) -> Arc<Group> {
        let key: Arc<str> = match id {
            Some(id) => id.into(),
            None => format!("#{}", self.anon.fetch_add(1, Relaxed) + 1).into(),
        };
        let (map, fr, br) = if site {
            (&self.sites, self.o.site_frame_rate, self.o.site_byte_rate)
        } else {
            (&self.groups, self.o.group_frame_rate, self.o.group_byte_rate)
        };
        let mut m = map.lock();
        let e = m.entry(key.clone()).or_insert_with(|| (Arc::new(Group { id: key, buckets: Mutex::new(Pair::new(fr, br)) }), 0));
        e.1 += 1;
        e.0.clone()
    }

    /// lan.mjs `release(map, g)`: a connection of that client is gone
    fn leave_group(&self, site: bool, g: &Arc<Group>) {
        let mut m = if site { self.sites.lock() } else { self.groups.lock() };
        if let Some(e) = m.get_mut(&g.id).filter(|e| Arc::ptr_eq(&e.0, g)) {
            e.1 = e.1.saturating_sub(1);
            if e.1 == 0 {
                m.remove(&g.id);
            }
        }
    }

    /// lan.mjs `sendTo(vip, data)`: a host's frame to one browser (never through the impairment), charged to `cause`
    /// when given
    pub fn send_to(&self, vip: u32, data: Bytes, cause: Option<&dyn Charge>) -> SendResult {
        let guard = slot(vip).map(|i| self.table[i].load());
        let Some(p) = guard.as_ref().and_then(|g| g.as_ref()).filter(|p| p.open()) else {
            self.stats.dropped.inc();
            return SendResult::Gone;
        };
        if p.conn.out.buffered() > self.o.online_queue {
            self.stats.shed.inc();
            return SendResult::Full;
        }
        if let Some(c) = cause {
            c.spend(1, data.len());
        }
        if !self.send(p, Out::Raw(data)) {
            return SendResult::Full;
        }
        p.frames_out.fetch_add(1, Relaxed);
        SendResult::Sent
    }

    /// `send_to` as the closure the hosts take (`attach_switch`)
    pub fn switch_send(self: &Arc<Self>) -> SwitchSend {
        let me = Arc::downgrade(self);
        Arc::new(move |vip, data, cause| match me.upgrade() {
            Some(s) => s.send_to(vip, data, cause),
            None => SendResult::Gone,
        })
    }

    /// players on the switch now (lan.mjs `peers.size`)
    pub fn peer_count(&self) -> usize {
        self.all.load().len()
    }

    /// lan.mjs `full`: a newcomer would get "LAN full" now
    pub fn full(&self) -> bool {
        self.members.lock().full(self.o.max_peers)
    }

    /// lan.mjs `breakdown()`: what the players on the switch do, each counted once, in this order: Online mode (the
    /// online host's vips()), the LAN or Online screens open, free roam (the hub's vips()), a page from before the
    /// page said whether LAN play is open (it holds its place until its tab closes), the rest (leaving: the page
    /// lets go 10 s after the last network feature; or starting: free roam not yet heard by the hub); and apart from
    /// that, how many of them take bundles (a page loaded since the switch has them)
    pub async fn breakdown(&self) -> Breakdown {
        let online = match &self.online {
            Some(h) => h.vips().await.unwrap_or_default(),
            None => Default::default(),
        };
        let roam = match &self.roam {
            Some(h) => h.vips().await.unwrap_or_default(),
            None => Default::default(),
        };
        let all = self.all.load();
        let mut n = Breakdown { players: all.len(), ..Breakdown::default() };
        for p in all.iter() {
            let lan = p.lan();
            if online.contains(&p.vip) {
                n.online += 1;
            } else if lan == Some(true) {
                n.lan += 1;
            } else if roam.contains(&p.vip) {
                n.roam += 1;
            } else if lan.is_none() {
                n.older += 1;
            } else {
                n.other += 1;
            }
            if p.takes_bundles() {
                n.bundles += 1;
            }
        }
        n
    }

    /// lan.mjs `info()`, as JSON (for the tests: names and virtual addresses only, never a real address)
    pub async fn info(&self) -> Value {
        let s = &self.stats;
        let peers: Vec<Value> = self
            .all
            .load()
            .iter()
            .map(|p| {
                let mut e = Map::new();
                e.insert("vip".into(), nfsu2_util::vip_str(p.vip).into());
                e.insert("name".into(), p.name().into());
                e.insert("framesIn".into(), p.frames_in.load(Relaxed).into());
                e.insert("framesOut".into(), p.frames_out.load(Relaxed).into());
                Value::Object(e)
            })
            .collect();
        let reserved = self.members.lock().reserved.len();
        let mut m = Map::new();
        m.insert("peers".into(), Value::Array(peers));
        for (k, c) in [
            ("frames", &s.frames),
            ("bytes", &s.bytes),
            ("dropped", &s.dropped),
            ("limited", &s.limited),
            ("refused", &s.refused),
            ("shed", &s.shed),
            ("bundlesIn", &s.bundles_in),
            ("bundlesOut", &s.bundles_out),
            ("resumed", &s.resumed),
            ("released", &s.released),
        ] {
            m.insert(k.into(), c.get().into());
        }
        m.insert("reserved".into(), reserved.into());
        m.insert("evicted".into(), s.evicted.get().into());
        let mut cuts = Map::new();
        for (i, k) in CUT_NAMES.iter().enumerate() {
            cuts.insert((*k).into(), s.cuts[i].get().into());
        }
        m.insert("cuts".into(), Value::Object(cuts));
        if let Some(im) = &self.impair {
            m.insert("impair".into(), im.spec_json());
            m.insert("lost".into(), s.lost.get().into());
        }
        if let Some(h) = &self.online {
            m.insert("online".into(), h.info().await.unwrap_or(Value::Null));
        }
        if let Some(h) = &self.roam {
            m.insert("roam".into(), h.info().await.unwrap_or(Value::Null));
        }
        Value::Object(m)
    }

    /// lan.mjs `stop()`: the timers end, the store is written, the hosts stop
    pub fn stop(&self) {
        self.stopped.cancel();
        self.flush_now();
        if let Some(h) = &self.online {
            h.stop();
        }
        if let Some(h) = &self.roam {
            h.stop();
        }
    }

    /// WebSocket pings keep proxies from cutting a quiet connection and find dead ones (lan.mjs `keepalive()`, every
    /// keepaliveMs; public for the tests)
    #[doc(hidden)]
    pub fn keepalive(&self) {
        let now = nfsu2_util::now_ms();
        {
            let mut m = self.members.lock();
            let before = m.reserved.len();
            m.reserved.retain(|_, r| r.until > now);
            if m.reserved.len() != before {
                self.persist(&mut m);
            }
        }
        for p in self.all.load().iter() {
            if !p.open() || !self.room(p, Cut::Queue) {
                continue;
            }
            let alive = p.alive.load(Relaxed);
            if !alive || now - p.last_in.load(Relaxed) > self.o.idle_ms {
                self.cut(p, if alive { Cut::Idle } else { Cut::Dead });
                continue;
            }
            p.alive.store(false, Relaxed);
            let mut data = [0u8; 8];
            nfsu2_util::rand::fill(&mut data);
            *p.ping.lock() = Some(data);
            p.conn.push(Out::Ping(data));
        }
    }

    /// a peer the switch disconnects, counted once by why
    fn cut(&self, p: &Peer, why: Cut) {
        if p.conn.terminate() {
            self.stats.cut(why);
        }
    }

    /// lan.mjs `room(p)`: room in p's queue; a peer that cannot keep up is disconnected instead of buffered without
    /// end
    fn room(&self, p: &Peer, why: Cut) -> bool {
        if p.conn.out.buffered() <= self.o.send_buffer {
            return true;
        }
        self.cut(p, why);
        false
    }

    /// lan.mjs `send(p, data)`: to one peer, when there is room
    fn send(&self, p: &Peer, out: Out) -> bool {
        if !self.room(p, Cut::Slow) {
            self.stats.dropped.inc();
            return false;
        }
        p.conn.push(out);
        true
    }

    // ---- for the tests: what lan.test.mjs reads of the switch's insides ----

    /// the peers in the order the JS Map kept them
    #[doc(hidden)]
    pub fn peers_view(&self) -> Vec<PeerView> {
        self.all
            .load()
            .iter()
            .map(|p| PeerView {
                vip: p.vip,
                name: p.name().to_string(),
                hello: p.hello.load(Relaxed),
                deltas: p.deltas.load(Relaxed),
                bundle: p.takes_bundles(),
                lan: p.lan(),
                open: p.open(),
                buffered: p.conn.out.buffered(),
            })
            .collect()
    }

    /// the reservations in the order the JS Map kept them
    #[doc(hidden)]
    pub fn reserved_view(&self) -> Vec<ReservedView> {
        self.members
            .lock()
            .reserved
            .iter()
            .map(|(v, r)| ReservedView {
                vip: *v,
                until: r.until,
                group: r.group.as_deref().map(str::to_string),
                site: r.site.as_deref().map(str::to_string),
            })
            .collect()
    }

    /// lan.test.mjs's `lan.reserved.set(v, { hash, until, group, site })`
    #[doc(hidden)]
    pub fn reserve_for_test(&self, vip: u32, hash: [u8; 32], until: i64, group: Option<&str>, site: Option<&str>) {
        self.members
            .lock()
            .reserved
            .insert(vip, members::Reservation { hash, until, group: group.map(Arc::from), site: site.map(Arc::from) });
    }

    #[doc(hidden)]
    pub fn clear_reserved(&self) {
        self.members.lock().reserved.clear();
    }

    /// every reservation ends now (lan.test.mjs: `r.until = Date.now() - 1`)
    #[doc(hidden)]
    pub fn expire_reserved(&self) {
        let now = nfsu2_util::now_ms();
        for r in self.members.lock().reserved.values_mut() {
            r.until = now - 1;
        }
    }

    /// lan.mjs `allocate()`
    #[doc(hidden)]
    pub fn allocate(&self) -> u32 {
        self.members.lock().allocate()
    }

    /// every peer's connection ends at once (the JS harness's `for (const c of wss.clients) c.terminate()`)
    #[doc(hidden)]
    pub fn terminate_all(&self) {
        for p in self.all.load().iter() {
            p.conn.terminate();
        }
    }
}

/// A peer as the tests see it.
#[doc(hidden)]
#[derive(Clone, Debug)]
pub struct PeerView {
    pub vip: u32,
    pub name: String,
    pub hello: bool,
    pub deltas: bool,
    pub bundle: bool,
    pub lan: Option<bool>,
    pub open: bool,
    /// ws.bufferedAmount
    pub buffered: usize,
}

/// A reservation as the tests see it.
#[doc(hidden)]
#[derive(Clone, Debug)]
pub struct ReservedView {
    pub vip: u32,
    pub until: i64,
    pub group: Option<String>,
    pub site: Option<String>,
}

/// lan.mjs `vipAt(i)`: the i-th address in the order they are handed out (round the eight /24s)
pub fn vip_at(i: usize) -> u32 {
    10 << 24 | 77 << 16 | ((i & 7) << 8) as u32 | ((i >> 3) as u32 + 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundle_tick_follows_the_crowd() {
        let o = LanOptions::default();
        assert_eq!(bundle_tick(&o, 0), Duration::from_millis(4));
        assert_eq!(bundle_tick(&o, 500), Duration::from_millis(4));
        assert_eq!(bundle_tick(&o, 1000), Duration::from_millis(8));
        assert_eq!(bundle_tick(&o, 2000), Duration::from_millis(16));
        assert_eq!(bundle_tick(&o, 5000), Duration::from_millis(25));
        let fixed = LanOptions { bundle_ms: 10, bundle_max_ms: 10, ..LanOptions::default() };
        assert_eq!(bundle_tick(&fixed, 2000), Duration::from_millis(10));
    }

    #[test]
    fn slots_are_the_order_addresses_are_handed_out_in() {
        for i in 0..ADDRS {
            assert_eq!(slot(vip_at(i)), Some(i));
        }
        for v in [BASE, BASE | 1, BASE | 252, BASE | 255, BASE | 0x800 | 2, 0, BROADCAST, BASE | 0x0700 | 0xFD] {
            assert_eq!(slot(v), None, "{v:x}");
        }
    }

    #[test]
    fn options_keep_the_defaults_for_zero() {
        let o = LanOptions { max_peers: 0, frame_rate: -1.0, idle_ms: 0, stall_ms: f64::NAN, bundle_ms: 0, ..LanOptions::default() }.sane();
        let d = LanOptions::default();
        assert_eq!(o.max_peers, d.max_peers);
        assert_eq!(o.frame_rate, d.frame_rate);
        assert_eq!(o.idle_ms, d.idle_ms);
        assert_eq!(o.stall_ms, d.stall_ms);
        assert_eq!(o.bundle_ms, 0);
    }
}
