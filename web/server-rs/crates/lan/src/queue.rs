//! The line: when every place is taken, a page that can wait (/lan?queue, `AttachOpts::queue`) is not closed with "LAN
//! full" but waits in line, first come first served, and takes the first place that frees up once everyone before it
//! has one.  While anyone waits every newcomer waits too, so asking again and again never passes the line (a page of
//! before, which cannot wait, gets "LAN full" as it did, until the line is empty); only a page with its token back for
//! the address it held (a dropped player, `reserve_ms`) goes in at once: that place was never free.
//!
//! What a waiting page hears: {"t":"queue","pos":p,"of":n,"eta":s,"ticket":"..."} at once (the ticket only then), the
//! same without the ticket every `line_tell_ms` when its place changed, and its welcome when its turn comes (from then
//! on it is a player like any other).  pos: its place, 1 the next in; of: everyone in line; eta: about how many seconds
//! until its turn, at the pace places freed up in the last `PACE_MS` (left out until a few went in).
//!
//! A waiting page's connection that ends without the page letting it go (a dropped link: not 1000 "idle" or
//! "closed") keeps its place for `reserve_ms`, as a dropped player's address is kept: the page comes back with
//! ?resume and the ticket in its hello and takes its place again.  Meanwhile the ones after it go in as places free up,
//! and it is the first of them once it is back.  What a page sends while it waits: its hello (kept for its welcome),
//! {"t":"lan"} (kept the same way), {"t":"ping"} (answered); its frames go nowhere.  One that sends nothing for
//! `SILENT_MS` is gone (the page pings every 2 s), and so is its place.

use std::collections::VecDeque;
use std::sync::Arc;

use bytes::Bytes;
use indexmap::IndexMap;
use nfsu2_util::{Bucket, mono_ms, now_ms};
use serde_json::{Map, Value};

use crate::conn::{Conn, Out};
use crate::members::{Members, held_address};
use crate::text::{new_token, parse_json, token_fits, token_hash};
use crate::{AttachCtx, LanSwitch};

/// the pace of the line is what went in this long ago or since (ms)
const PACE_MS: f64 = 10.0 * 60_000.0;
/// at least this many went in before a page is told how long it may wait
const PACE_MIN: usize = 3;
/// a waiting page that sends nothing for this long has gone (ms)
const SILENT_MS: f64 = 60_000.0;

/// One in line.
pub(crate) struct Waiter {
    /// its connection; none while it is away (its place kept for its ticket until `until`)
    conn: Option<(Arc<Conn>, Arc<AttachCtx>)>,
    ticket: [u8; 32],
    until: i64,
    /// the place it was last told (0: none yet)
    told: usize,
}

/// The pages waiting for a place, in their order (under the `members` lock).
#[derive(Default)]
pub(crate) struct Line {
    /// by a number of their own: a page back with its ticket takes its entry again
    waiters: IndexMap<u64, Waiter>,
    next: u64,
    /// when the last ones went in (mono ms, `PACE_MS`)
    went_in: VecDeque<f64>,
    /// since when anyone has waited (mono ms), and the longest wait of those that went in since (ms)
    since: Option<f64>,
    longest: f64,
    /// when the waiting pages were last told their places (mono ms)
    told_at: f64,
}

impl Line {
    /// anyone waits (or is away and keeps a place)
    pub(crate) fn waiting(&self) -> bool {
        !self.waiters.is_empty()
    }
    pub(crate) fn len(&self) -> usize {
        self.waiters.len()
    }
    /// the line's pace: places a second (None until `PACE_MIN` went in)
    fn pace(&mut self, now: f64) -> Option<f64> {
        while self.went_in.front().is_some_and(|&t| t < now - PACE_MS) {
            self.went_in.pop_front();
        }
        let n = self.went_in.len();
        if n < PACE_MIN {
            return None;
        }
        // over the window, or the time since the line began when that is shorter (a minute at least)
        let span = (now - self.since.unwrap_or(now)).clamp(60_000.0, PACE_MS);
        Some(n as f64 / (span / 1000.0))
    }
}

/// What a waiting connection sent (its `Conn::wait`, its own lock: never taken before the `members` lock).
#[derive(Default)]
pub(crate) struct Wait {
    /// its entry in line (0: not in line)
    pub(crate) id: u64,
    /// its hello and LAN play, for its welcome
    hello: Option<Map<String, Value>>,
    texts: Option<Bucket>,
    /// when it last sent anything (mono ms)
    last_in: f64,
}

/// {"t":"queue",...}
fn told(pos: usize, of: usize, eta: Option<f64>, ticket: Option<&str>) -> Bytes {
    let mut s = format!(r#"{{"t":"queue","pos":{pos},"of":{of}"#);
    if let Some(e) = eta {
        s.push_str(&format!(r#","eta":{}"#, e.round() as u64));
    }
    if let Some(t) = ticket {
        s.push_str(&format!(r#","ticket":"{t}""#));
    }
    s.push('}');
    Bytes::from(s)
}

impl LanSwitch {
    /// conn waits in line (false: the line is full, or the connection is gone)
    pub(crate) fn enqueue(&self, m: &mut Members, conn: &Arc<Conn>, ctx: &Arc<AttachCtx>, hello: Option<Map<String, Value>>) -> bool {
        if m.line.waiters.len() >= self.o.max_waiting || !conn.open() {
            return false;
        }
        let now = mono_ms();
        m.line.next += 1;
        let id = m.line.next;
        let ticket = new_token();
        *conn.wait.lock() = Wait { id, hello, texts: Some(Bucket::new_at(self.o.text_rate, now)), last_in: now };
        let of = m.line.waiters.len() + 1;
        m.line.waiters.insert(id, Waiter { conn: Some((conn.clone(), ctx.clone())), ticket: token_hash(&ticket), until: 0, told: of });
        if m.line.since.is_none() {
            m.line.since = Some(now);
            m.line.longest = 0.0;
        }
        self.stats.queued.inc();
        let eta = m.line.pace(now).map(|p| of as f64 / p);
        conn.push(Out::Text(told(of, of, eta, Some(&ticket))));
        true
    }

    /// a page back with its ticket takes its place in line again (its connection of before, if the switch still holds
    /// it, goes); false: no place in line has that ticket
    pub(crate) fn rejoin(
        &self,
        m: &mut Members,
        conn: &Arc<Conn>,
        ctx: &Arc<AttachCtx>,
        hello: Option<Map<String, Value>>,
        ticket: &str,
    ) -> bool {
        // (compared in constant time, as a token is)
        let Some(pos) = m.line.waiters.values().position(|w| token_fits(ticket, &w.ticket)) else { return false };
        let now = mono_ms();
        let of = m.line.waiters.len();
        let (&id, w) = m.line.waiters.get_index_mut(pos).expect("its place");
        if let Some((old, _)) = w.conn.replace((conn.clone(), ctx.clone())) {
            old.terminate();
        }
        w.until = 0;
        w.told = pos + 1;
        *conn.wait.lock() = Wait { id, hello, texts: Some(Bucket::new_at(self.o.text_rate, now)), last_in: now };
        self.stats.rejoined.inc();
        let eta = m.line.pace(now).map(|p| (pos + 1) as f64 / p);
        conn.push(Out::Text(told(pos + 1, of, eta, None)));
        true
    }

    /// a connection that ended while it waited: its place goes when the page let go (1000 "idle" or "closed"), else
    /// it is kept for its ticket for `reserve_ms` (a newer connection of the same page that took it changes nothing)
    pub(crate) fn left_line(&self, conn: &Arc<Conn>) {
        let id = conn.wait.lock().id;
        if id == 0 {
            return;
        }
        let (code, reason) = conn.close_code();
        let done = code == 1000 && (&reason[..] == b"idle" || &reason[..] == b"closed");
        let mut m = self.members.lock();
        let Some(w) = m.line.waiters.get_mut(&id) else { return };
        if !w.conn.as_ref().is_some_and(|(c, _)| Arc::ptr_eq(c, conn)) {
            return;
        }
        if done {
            m.line.waiters.shift_remove(&id);
            self.stats.line_left.inc();
            if !m.line.waiting() {
                m.line.since = None;
            }
        } else {
            w.conn = None;
            w.until = now_ms() + self.o.reserve_ms;
        }
    }

    /// The line's first ones take the places that are free, as many as there are.
    pub(crate) fn let_in(&self) {
        loop {
            let mut m = self.members.lock();
            // (one whose connection is closing is passed over: its close comes next)
            let Some((&id, (conn, ctx))) =
                m.line.waiters.iter().find_map(|(id, w)| w.conn.as_ref().filter(|(c, _)| c.open()).map(|c| (id, c.clone())))
            else {
                return;
            };
            let hello = conn.wait.lock().hello.clone();
            let held = held_address(&m, hello.as_ref());
            let Some((vip, old, resumed)) = self.place(&mut m, held, true) else { return };
            m.line.waiters.shift_remove(&id);
            *conn.wait.lock() = Wait::default();
            let now = mono_ms();
            m.line.went_in.push_back(now);
            if let Some(since) = m.line.since {
                m.line.longest = m.line.longest.max(now - since);
            }
            if !m.line.waiting() {
                m.line.since = None;
            }
            self.stats.line_in.inc();
            let (peer, count) = self.seat(&mut m, &conn, &ctx, hello, vip, old);
            drop(m);
            if let Some(f) = &ctx.on_join {
                f(peer.vip, resumed, count);
            }
        }
    }

    /// Every second while anyone waits: the places kept for those away run out, the silent ones go, the free places
    /// are taken, and every `line_tell_ms` the waiting pages whose place changed hear it.
    pub(crate) fn line_tick(&self) {
        let now = mono_ms();
        let silent: Vec<Arc<Conn>> = {
            let mut m = self.members.lock();
            if !m.line.waiting() {
                return;
            }
            let wall = now_ms();
            let before = m.line.waiters.len();
            m.line.waiters.retain(|_, w| w.conn.is_some() || w.until > wall);
            for _ in m.line.waiters.len()..before {
                self.stats.line_left.inc();
            }
            if !m.line.waiting() {
                m.line.since = None;
            }
            m.line
                .waiters
                .values()
                .filter_map(|w| w.conn.as_ref().map(|(c, _)| c))
                .filter(|c| c.wait.lock().last_in < now - SILENT_MS)
                .cloned()
                .collect()
        };
        for c in silent {
            c.terminate();
        }
        self.let_in();
        let mut out = Vec::new();
        {
            let mut m = self.members.lock();
            if !m.line.waiting() || now - m.line.told_at < self.o.line_tell_ms as f64 {
                return;
            }
            m.line.told_at = now;
            let pace = m.line.pace(now);
            let of = m.line.waiters.len();
            for (i, w) in m.line.waiters.values_mut().enumerate() {
                if let Some((c, _)) = w.conn.as_ref().filter(|_| w.told != i + 1) {
                    w.told = i + 1;
                    out.push((c.clone(), told(i + 1, of, pace.map(|p| (i + 1) as f64 / p), None)));
                }
            }
        }
        for (c, msg) in out {
            c.push(Out::Text(msg));
        }
    }

    /// a control message from a page in line: its hello and LAN play are kept for its welcome, a ping is answered
    /// (`text_rate`, `max_text` as for a player)
    pub(crate) fn waiting_text(&self, conn: &Conn, b: &Bytes) {
        let now = mono_ms();
        let mut w = conn.wait.lock();
        if w.id == 0 {
            return;
        }
        w.last_in = now;
        if b.len() > self.o.max_text || !w.texts.as_mut().is_some_and(|t| t.take_at(now, 1.0)) {
            self.stats.limited.inc();
            return;
        }
        let Some(Value::Object(m)) = parse_json(b) else { return };
        match m.get("t").and_then(Value::as_str) {
            Some("hello") => {
                if w.hello.is_none() {
                    w.hello = Some(m);
                }
            }
            Some("lan") => {
                if let (Some(h), Some(on)) = (w.hello.as_mut(), m.get("on")) {
                    h.insert("lan".into(), on.clone());
                }
            }
            Some("ping") => {
                if let Some(id) = m.get("id").and_then(nfsu2_util::json::safe_integer) {
                    conn.push(Out::Text(Bytes::from(format!(r#"{{"t":"pong","id":{id}}}"#))));
                }
            }
            _ => {}
        }
    }

    /// pages in line now, and of those that went in since the line last began, the longest wait (s)
    pub(crate) fn line_view(&self) -> (usize, u64) {
        let m = self.members.lock();
        (m.line.len(), (m.line.longest / 1000.0) as u64)
    }
}
