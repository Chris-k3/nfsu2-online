//! The server's stand-in for EA's online servers of NFS Underground 2, for the game's own Online mode (main menu,
//! Online) between browsers on this server: the port of web/server/online/, rule for rule, with the same files in
//! the state folder (online/stats.json, online/buddies.json, read and written byte for byte as the JS does) and the
//! same console lines.
//!
//! - browser: lifted DirtySock -> winsock.c (pcnfs05.ea.com = 10.77.0.1) -> runtime/web/net_lan.c -> page -> /lan
//!   WebSocket -> the switch (nfsu2-lan)
//! - switch: frames to 10.77.0.1 -> [`OnlineHost`] -> vhost.rs (TCP, ICMP) -> the services below, by port:
//!   20920 the redirector (@dir -> our lobby's address; no @tic: no RC4, no SSL), 20922 the lobby (login under any
//!   name but a slur, personas, rooms, chat, games: lobby.rs), 13505 EA Messenger (friends, presence, messages,
//!   invites: buddy.rs), 80 the news and terms pages the config names (http.rs)
//!
//! Race traffic never comes here: the players' browsers send it to each other through the switch (UDP 3658, a star
//! around the game's creator), as in LAN play.  Every address a player learns is a virtual one (10.77.x.x).
//!
//! What the server keeps: sessions, rooms, games and chat in memory only; on disk only the races' public results per
//! persona (stats.rs) and each persona's friends list (buddy.rs), names only, under the server's --state directory.
//! Nothing secret is ever read (aries.rs SECRET_KEYS: the password, the CD key and the file checksum are passed over
//! undecoded).  The log names players by persona and virtual address only, never their real address or what they
//! typed as a password.  The lines a client causes (logins, games, races, complaints, friends) go through
//! `log(line, key)` with that client's opaque group id as the key: the server shows at most a few a minute per
//! client (server.mjs logLimited; the Online audit's ONL-8).
//!
//! The whole of it runs on one thread of its own, as it ran on Node's one thread: the switch posts it its frames in
//! order ([`OnlineHost`] is a `nfsu2_util::Host`), and its timers (the lobby's ticks, the services' time-outs, the
//! saves) run on that thread between them.  Its load is small (the .NET port: 120 lobby clients took 0.1-0.2
//! cores) and its state is one tangle of sessions, rooms, games and friends, so one thread and no locks is both the
//! simplest and the fastest.

#[macro_use]
mod aries;
mod buddy;
mod core;
mod files;
mod http;
mod jsonparse;
mod jsx;
mod lobby;
mod omap;
mod stats;
mod timers;
mod trace;
mod vhost;

#[cfg(test)]
mod tests;

use std::collections::HashSet;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, mpsc};
use std::thread::JoinHandle;
use std::time::Duration;

use bytes::Bytes;
use nfsu2_util::{FrameCtx, Host, SwitchSend, Tap, mono_ms, now_ms};
use parking_lot::Mutex;
use tokio::sync::oneshot;

pub use crate::trace::LobbyTrace;

/// 10.77.0.1 (vhost.mjs `VHOST_VIP`)
pub const VHOST_VIP: u32 = 0x0A4D_0001;
/// vhost.mjs `VHOST_NAME`
pub const VHOST_NAME: &str = "NFSU2 Online";

/// index.mjs `PORTS`
pub const PORT_REDIRECTOR: u16 = 20920;
pub const PORT_LOBBY: u16 = 20922;
pub const PORT_BUDDY: u16 = 13505;
pub const PORT_HTTP: u16 = 80;

/// a console line and the client it is for (None: the server's own), on the host's thread
pub(crate) type LogFn = Rc<dyn Fn(&str, Option<&str>)>;

/// the host's two clocks: `now` the JS `Date.now()` its rules read (a test's own in the tests), `timer` the one its
/// timers run on (monotonic)
pub(crate) struct Clocks {
    pub now: Box<dyn Fn() -> f64>,
    pub timer: Box<dyn Fn() -> f64>,
}

/// What the Online host is given (index.mjs `OnlineHost` opts).
#[derive(Clone)]
pub struct OnlineOptions {
    /// where stats.json and buddies.json are kept (the server's --state/online); None: in memory only
    pub state_dir: Option<PathBuf>,
    /// a console line, and the opaque group id of the client that caused it (None: the server's own line); the
    /// server shows at most a few a minute per client (server.mjs logLimited, the Online audit's ONL-8)
    #[allow(clippy::type_complexity)]
    pub log: Arc<dyn Fn(&str, Option<&str>) + Send + Sync>,
    /// the dev trace: sees every frame the host sends
    pub tap: Option<Tap>,
}

enum Event {
    Frame(u32, Bytes, FrameCtx),
    PeerGone(u32),
    Info(oneshot::Sender<serde_json::Value>),
    Vips(oneshot::Sender<HashSet<u32>>),
    Attach(SwitchSend),
    Stop,
}

/// The Online host on a thread of its own.
pub struct OnlineHost {
    tx: mpsc::Sender<Event>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl OnlineHost {
    /// starts its thread (and reads the state folder's files)
    pub fn spawn(o: OnlineOptions) -> Arc<OnlineHost> {
        let (tx, rx) = mpsc::channel();
        let thread = std::thread::Builder::new().name("online".into()).spawn(move || run(o, rx)).expect("the online host's thread");
        Arc::new(OnlineHost { tx, thread: Mutex::new(Some(thread)) })
    }
    /// the switch's way to its browsers
    pub fn attach_switch(&self, send: SwitchSend) {
        let _ = self.tx.send(Event::Attach(send));
    }
}

fn run(o: OnlineOptions, rx: mpsc::Receiver<Event>) {
    let log = o.log.clone();
    let mut core = core::Core::new(core::CoreOptions {
        state_dir: o.state_dir,
        log: Rc::new(move |line: &str, key: Option<&str>| log(line, key)),
        tap: o.tap,
        clocks: Rc::new(Clocks { now: Box::new(|| now_ms() as f64), timer: Box::new(mono_ms) }),
        limits: Default::default(),
        buddy_limits: Default::default(),
        vhost: Default::default(),
    });
    loop {
        let ev = match core.next_due() {
            Some(t) => {
                let wait = t - mono_ms();
                if wait <= 0.0 {
                    guarded(&mut core, None, |c| c.run_due(mono_ms()));
                    continue;
                }
                match rx.recv_timeout(Duration::from_secs_f64(wait / 1000.0)) {
                    Ok(e) => Some(e),
                    Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(mpsc::RecvTimeoutError::Disconnected) => Some(Event::Stop),
                }
            }
            None => Some(rx.recv().unwrap_or(Event::Stop)),
        };
        match ev {
            None => {}
            Some(Event::Frame(from, data, ctx)) => guarded(&mut core, Some((from, &data)), |c| c.frame(from, &data, &ctx)),
            Some(Event::PeerGone(vip)) => guarded(&mut core, None, |c| c.peer_gone(vip)),
            Some(Event::Info(tx)) => {
                let _ = tx.send(core.info());
            }
            Some(Event::Vips(tx)) => {
                let _ = tx.send(core.vips());
            }
            Some(Event::Attach(send)) => core.attach(send),
            Some(Event::Stop) => {
                guarded(&mut core, None, |c| c.stop());
                return;
            }
        }
        guarded(&mut core, None, |c| c.run_due(mono_ms()));
    }
}

/// one event, and what the JS did when a handler threw: the error on the console, the stream the frame came on
/// closed (vhost.mjs: "service error"); the host goes on
fn guarded(core: &mut core::Core, frame: Option<(u32, &[u8])>, f: impl FnOnce(&mut core::Core)) {
    if let Err(e) = catch_unwind(AssertUnwindSafe(|| f(core))) {
        let what = e.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| e.downcast_ref::<String>().cloned()).unwrap_or_default();
        let _ = catch_unwind(AssertUnwindSafe(|| {
            core.console_error(&format!("[online] a service failed: {what}"));
            core.cause = None;
            if let Some((from, data)) = frame {
                core.fail_stream(from, data);
            }
            core.purge();
        }));
    }
}

impl Host for OnlineHost {
    fn vip(&self) -> u32 {
        VHOST_VIP
    }
    fn name(&self) -> &str {
        VHOST_NAME
    }
    fn listed(&self) -> bool {
        true
    }
    fn frame(&self, from: u32, data: Bytes, ctx: FrameCtx) {
        let _ = self.tx.send(Event::Frame(from, data, ctx));
    }
    fn peer_gone(&self, vip: u32) {
        let _ = self.tx.send(Event::PeerGone(vip));
    }
    /// index.mjs `info()`: the virtual host's counts and the lobby's (`personas`, `racing`, ...)
    fn info(&self) -> oneshot::Receiver<serde_json::Value> {
        let (tx, rx) = oneshot::channel();
        let _ = self.tx.send(Event::Info(tx));
        rx
    }
    fn vips(&self) -> oneshot::Receiver<HashSet<u32>> {
        let (tx, rx) = oneshot::channel();
        let _ = self.tx.send(Event::Vips(tx));
        rx
    }
    /// the server stops: the lobby's links go, stats.json and buddies.json are written, the timers end.  Returns once
    /// that is done (the files are written before the process goes).
    fn stop(&self) {
        let _ = self.tx.send(Event::Stop);
        let t = self.thread.lock().take();
        if let Some(t) = t
            && t.thread().id() != std::thread::current().id()
        {
            let _ = t.join();
        }
    }
}
