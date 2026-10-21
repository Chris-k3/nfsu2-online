//! EA Messenger (buddy.mjs; the game's "buddy server", port 13505 of the online host): friends lists, who is online
//! and what they do, messages, and game invites, between the personas logged in to this server's lobby.
//!
//! The game's buddy client (SPEED2.EXE BuddyApi, 0x74BC50-0x74F5F0) speaks the lobby's framing with upper-case
//! commands.  It logs in with AUTH and the LKEY its lobby login was given (lobby.rs `select_persona`): that key, from
//! the same browser, not anything typed, says which persona this connection is.  What it sends and what it is
//! answered here:
//!
//! - AUTH PROD VERS PRES USER LKEY -> AUTH TITL="EA MESSENGER" (unknown key: code "pass"; a second AUTH on a
//!   connection that is logged in: code "logn")
//! - EPGT LRSC ID -> EPGT ID ENAB=N ADDR=
//! - RGET LIST=B|I ID -> RGET ID SIZE=n, then n x ROST ID USER (the friends, or the blocked), then PGET for each
//!   friend online
//! - RADD/RDEL LIST USER ID -> RADD/RDEL ID; a friend added is told (RNOT USER) and the adder gets the friend's
//!   presence (LIST I: blocking)
//! - RADM USER PRES ID -> RADM ID; to the persona: RNOT USER (the asker) CHNG=A ATTR=0x80000, a friend request (the
//!   game's "pending" bits: which is which UNVERIFIED)
//! - RRSP USER ANSW ID -> the answer: both are friends (RNOT USER CHNG=A ATTR=0, PGET) unless ANSW says no (its
//!   coding is UNVERIFIED); a request back from the asked persona (RADM, "Send Friend Request" in its menu) counts
//!   as yes
//! - PADD/PDEL USER -> ack, and that player's presence (the Messenger's "All" list: players searched for or met; in
//!   memory only)
//! - PSET SHOW STAT PROD -> ack; when it changed, PGET USER SHOW STAT PROD TITL EXTR ATTR to every online player who
//!   has this persona as a friend (at most once a second, the latest)
//! - SEND USER BODY SUBJ TYPE -> SEND; RECV USER (the sender) BODY SUBJ TYPE TIME to the persona
//! - GINV/GRSP/GRVK USER ... -> ack; passed on to the persona (USER = the sender)
//! - USCH USER MAXR ID -> USCH ID SIZE=n, then n x USER ID USER (the Search: personas online or known from their
//!   races whose names start with the text)
//! - PING -> PING;  DISC -> closed
//!
//! Field names from the game's own code; the exact use the game makes of each (screens, invites) was checked only in
//! part.
//!
//! Kept: each persona's friends list (names only) in <state>/online/buddies.json, so a friend is still one after a
//! restart.  A persona belongs to whoever plays under its name (there are no accounts), so whoever takes a name that
//! is not online sees and can change its friends list (docs/web/PLAYING.md).  The blocked list is the session's own:
//! kept while the persona is online, where it is the only place a block matters (messages, invites and requests go
//! to personas online), and never stored (the Online audit's ONL-6: the next holder of the name could read and empty
//! it).  Messages and invites are passed on and forgotten (to a persona online now).  Limits: 50 friends, 50
//! blocked; `lists` friends lists, the least recently seen going first, new ones `list_rate` an hour per client;
//! messages `msg_rate` a second (burst 3 x), the lists and the search `heavy_rate` a second (burst 4), over that:
//! closed (the Online audit's ONL-1, ONL-3); chat messages 2 a second (burst 5) and 500 characters; a blocked
//! persona's messages and invites never arrive.
//!
//! A buddy connection's state (the JS `b`) stays readable until the event that closed it is over, as the JS object
//! stays with the code that holds it (a handler whose own answer failed goes on with `b.persona` null).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use indexmap::IndexMap;
use nfsu2_util::json;
use serde_json::Value;

use crate::aries::{FieldMap, Fields, FrameReader, V, encode_frame};
use crate::core::Core;
use crate::jsx::{self, clean_text, lower, strip_at, valid_name};
use crate::lobby::{LBucket, four_printable};
use crate::omap::OrderedMap;
use crate::timers::{Action, TimerId};
use crate::vhost::{ConnId, Svc};

const MAX_LIST: usize = 50;
const TITL: &str = "Need for Speed Underground 2 [PC]";

/// buddy.mjs BUDDY_LIMITS
#[derive(Clone, Copy, Debug)]
pub struct BuddyLimits {
    pub lists: f64,
    pub list_rate: f64,
    pub msg_rate: f64,
    pub heavy_rate: f64,
    pub presence_ms: f64,
}

impl Default for BuddyLimits {
    fn default() -> Self {
        BuddyLimits { lists: 5000.0, list_rate: 20.0, msg_rate: 10.0, heavy_rate: 1.0, presence_ms: 1000.0 }
    }
}

/// a persona's friends list: its name, the friends (lower case -> the name as given; the JS's Set `B` and its Map
/// `names`, which change together), the month it was last seen
pub struct FriendsList {
    pub name: String,
    pub b: IndexMap<String, String>,
    pub seen: String,
}

/// one EA Messenger connection (the JS `b`)
pub struct Buddy {
    pub conn: ConnId,
    vip: u32,
    group: Arc<str>,
    pub persona: Option<String>,
    /// the persona in lower case (the key of its friends list and of `online`), while there is one
    key: String,
    show: String,
    stat: String,
    prod: String,
    msgs_t: f64,
    msgs_v: f64,
    met: HashSet<String>,
    /// the blocked (lower case -> the name as given), the session's own
    blocked: IndexMap<String, String>,
    told: Option<f64>,
    presence_timer: Option<TimerId>,
    rate: LBucket,
    heavy: LBucket,
    tries: u32,
    reader: FrameReader,
    login_timer: Option<TimerId>,
}

pub struct Buddies {
    pub l: BuddyLimits,
    dir: Option<PathBuf>,
    save_ms: f64,
    /// lower-case persona -> its friends list, least recently seen first
    pub lists: OrderedMap<String, FriendsList>,
    /// lower-case persona -> buddy connection
    online: OrderedMap<String, u64>,
    /// lower-case persona -> the lists (their owners, lower case) that have it as a friend, and the connections that
    /// met it: who hears of its presence (the JS goes through every online persona for each presence; these keep it
    /// to the ones that hear)
    fans: HashMap<String, HashSet<String>>,
    met_by: HashMap<String, HashSet<u64>>,
    /// "from>to" (lower case) -> when: friend requests waiting for an answer
    requests: HashMap<String, f64>,
    /// client group -> bucket: new friends lists
    made: HashMap<Arc<str>, LBucket>,
    timer: Option<TimerId>,
    dirty: bool,
    pub conns: HashMap<u64, Buddy>,
    graveyard: Vec<u64>,
    next: u64,
}

impl Buddies {
    pub fn new(dir: Option<PathBuf>, l: BuddyLimits) -> Buddies {
        let mut b = Buddies {
            l,
            dir,
            save_ms: 10_000.0,
            lists: OrderedMap::new(),
            online: OrderedMap::new(),
            fans: HashMap::new(),
            met_by: HashMap::new(),
            requests: HashMap::new(),
            made: HashMap::new(),
            timer: None,
            dirty: false,
            conns: HashMap::new(),
            graveyard: Vec::new(),
            next: 0,
        };
        if b.dir.is_some() {
            b.load();
        }
        b
    }

    fn file(&self) -> Option<PathBuf> {
        self.dir.as_ref().map(|d| d.join("buddies.json"))
    }

    fn load(&mut self) {
        let Some(file) = self.file() else { return };
        let Ok(bytes) = std::fs::read(&file) else { return };
        let Ok(j) = crate::jsonparse::parse(&String::from_utf8_lossy(&bytes)) else { return };
        let mut rows: Vec<(&serde_json::Map<String, Value>, String, String)> = match j.get("personas") {
            Some(Value::Array(a)) => a
                .iter()
                .filter_map(|r| {
                    let o = r.as_object()?;
                    let name = o.get("name")?.as_str()?;
                    if !valid_name(name) {
                        return None;
                    }
                    // (a `seen` that is not a string counts as none: see stats.rs `clean`)
                    let seen = o.get("seen").and_then(Value::as_str).filter(|s| jsx::is_month(s)).unwrap_or("1970-01");
                    Some((o, name.to_string(), seen.to_string()))
                })
                .collect(),
            _ => Vec::new(),
        };
        rows.sort_by(|a, b| a.2.cmp(&b.2));
        let from = rows.len().saturating_sub(self.l.lists as usize);
        // (a file of before the audit also has the blocked lists, I: they are not read)
        for (r, name, seen) in rows.drain(from..) {
            let mut l = FriendsList { name: name.clone(), b: IndexMap::new(), seen };
            if let Some(Value::Array(b)) = r.get("B") {
                for n in b.iter().take(MAX_LIST) {
                    if let Some(n) = n.as_str().filter(|n| valid_name(n)) {
                        l.b.insert(lower(n), n.to_string());
                    }
                }
            }
            if !l.b.is_empty() {
                self.lists.insert(lower(&name), l);
            }
        }
        // (a name twice in the file: the later list in the earlier one's place, as JS's Map.set)
        let owners: Vec<(String, Vec<String>)> = self.lists.iter().map(|(o, l)| (o.clone(), l.b.keys().cloned().collect())).collect();
        for (owner, friends) in owners {
            for k in friends {
                self.fans.entry(k).or_default().insert(owner.clone());
            }
        }
    }

    /// a friend on owner's list (false: it has none)
    fn add_friend(&mut self, owner: &str, k: String, name: String) -> bool {
        let Some(l) = self.lists.get_mut(owner) else { return false };
        l.b.insert(k.clone(), name);
        self.fans.entry(k).or_default().insert(owner.to_string());
        true
    }

    /// a friend off owner's list (false: it was not on it)
    fn remove_friend(&mut self, owner: &str, k: &str) -> bool {
        if !self.lists.get_mut(owner).is_some_and(|l| l.b.shift_remove(k).is_some()) {
            return false;
        }
        self.unfan(k, owner);
        true
    }

    /// a list goes (the store is full)
    fn drop_list(&mut self, owner: &str) {
        if let Some(l) = self.lists.remove(owner) {
            for k in l.b.keys() {
                self.unfan(k, owner);
            }
        }
    }

    fn unfan(&mut self, k: &str, owner: &str) {
        if let Some(s) = self.fans.get_mut(k) {
            s.remove(owner);
            if s.is_empty() {
                self.fans.remove(k);
            }
        }
    }

    /// buddies.json as the JS writes it
    pub fn serialize(&self) -> String {
        let mut s = String::from("{\"v\":2,\"note\":\"NFSU2 online friends lists (persona names only)\",\"personas\":[");
        let mut first = true;
        for l in self.lists.values().filter(|l| !l.b.is_empty()) {
            if !first {
                s.push(',');
            }
            first = false;
            s.push_str("{\"name\":");
            json::write_str(&mut s, &l.name);
            s.push_str(",\"seen\":");
            json::write_str(&mut s, &l.seen);
            s.push_str(",\"B\":[");
            for (i, n) in l.b.values().enumerate() {
                if i > 0 {
                    s.push(',');
                }
                json::write_str(&mut s, n);
            }
            s.push_str("]}");
        }
        s.push_str("]}");
        s
    }

    /// a persona's friends list, or None: none is made by asking
    pub fn list(&self, name: &str) -> Option<&FriendsList> {
        self.lists.get(&lower(name))
    }

    pub fn purge(&mut self) {
        for id in std::mem::take(&mut self.graveyard) {
            let Some(x) = self.conns.remove(&id) else { continue };
            for k in x.met {
                if let Some(s) = self.met_by.get_mut(&k) {
                    s.remove(&id);
                    if s.is_empty() {
                        self.met_by.remove(&k);
                    }
                }
            }
        }
    }
}

fn presence(b: &Buddy) -> Fields {
    fields![
        ("USER", &b.persona),
        ("SHOW", &b.show),
        ("STAT", &b.stat),
        ("PROD", &b.prod),
        ("TITL", TITL),
        ("EXTR", "NFS-CONSOLE-2005"),
        ("ATTR", "D")
    ]
}

fn offline(name: &str) -> Fields {
    fields![("USER", name), ("SHOW", "DISC"), ("STAT", ""), ("PROD", ""), ("TITL", TITL), ("EXTR", "NFS-CONSOLE-2005"), ("ATTR", "D")]
}

/// what the JS throws where it reads `b.persona.toLowerCase()` once the connection's persona is gone
fn null_persona() -> String {
    "TypeError: Cannot read properties of null (reading 'toLowerCase')".into()
}

impl Core {
    /// `b.send(kind, fields, code)`: the connection's words to the game (an error: a field name that is not one,
    /// which the JS throws)
    fn bsend(&mut self, b: u64, kind: &str, fields: &[(std::borrow::Cow<'static, str>, V)], code: &str) -> Result<(), String> {
        let f = encode_frame(kind, code, fields)?;
        if let Some(conn) = self.buddies.conns.get(&b).map(|x| x.conn) {
            self.conn_write(conn, &f);
        }
        Ok(())
    }

    /// a message encoded once, to one more connection
    fn bsend_frame(&mut self, b: u64, frame: &[u8]) {
        if let Some(conn) = self.buddies.conns.get(&b).map(|x| x.conn) {
            self.conn_write(conn, frame);
        }
    }

    fn bnow(&self) -> f64 {
        (self.clocks.now)()
    }

    pub fn buddy_connect(&mut self, c: ConnId) {
        let Some((vip, _, group, _)) = self.conn_ids(c) else { return };
        let now = self.bnow();
        let l = self.buddies.l;
        self.buddies.next += 1;
        let id = self.buddies.next;
        let t = self.set_timeout(60_000.0, Action::BuddyLogin(id));
        self.buddies.conns.insert(
            id,
            Buddy {
                conn: c,
                vip,
                group,
                persona: None,
                key: String::new(),
                show: "CHAT".into(),
                stat: String::new(),
                prod: String::new(),
                msgs_t: now,
                msgs_v: 5.0,
                met: HashSet::new(),
                blocked: IndexMap::new(),
                told: None,
                presence_timer: None,
                rate: LBucket::new(l.msg_rate, 3.0 * l.msg_rate, now),
                heavy: LBucket::new(l.heavy_rate, 4.0, now),
                tries: 0,
                reader: FrameReader::default(),
                login_timer: Some(t),
            },
        );
        self.set_svc(c, Svc::Buddy(id));
    }

    /// the 60 s for a login are over
    pub fn buddy_login_idle(&mut self, b: u64) {
        if let Some(conn) = self.buddies.conns.get(&b).map(|x| x.conn) {
            self.conn_destroy(conn, "buddy: no login");
        }
    }

    /// the connection closed (onclose): its login timer ends, it is gone
    pub fn buddy_closed(&mut self, b: u64) {
        if let Some(t) = self.buddies.conns.get_mut(&b).and_then(|x| x.login_timer.take()) {
            self.timers.clear(t);
        }
        self.buddy_gone(b);
        self.buddies.graveyard.push(b);
    }

    pub fn buddy_data(&mut self, b: u64, buf: &[u8]) {
        let Some(x) = self.buddies.conns.get_mut(&b) else { return };
        let msgs = x.reader.push(buf);
        let conn = x.conn;
        for m in msgs {
            if !self.conn_open(conn) {
                return;
            }
            let now = self.bnow();
            if !self.buddies.conns.get_mut(&b).is_some_and(|x| x.rate.take(now, 1.0)) {
                return self.conn_destroy(conn, "buddy: too many messages");
            }
            if !four_printable(&m.kind) {
                return self.conn_destroy(conn, "buddy: not the lobby protocol");
            }
            let f = FieldMap::parse(&m.body);
            if let Err(e) = self.buddy_message(b, &m.kind, &f) {
                // the first line of the JS's e.stack (its frames are not written)
                let e = if e.starts_with("TypeError") { e } else { format!("Error: {e}") };
                self.console_error(&format!("[online] buddy \"{}\" failed: {e}", m.kind));
                return self.conn_destroy(conn, "server error");
            }
        }
        if self.buddies.conns.get(&b).is_some_and(|x| x.reader.error.is_some()) {
            self.conn_destroy(conn, "buddy: not the lobby protocol");
        }
    }

    /// buddy.mjs `gone(b)`
    pub fn buddy_gone(&mut self, b: u64) {
        let Some(x) = self.buddies.conns.get_mut(&b) else { return };
        if let Some(t) = x.presence_timer.take() {
            self.timers.clear(t);
        }
        if x.persona.is_none() {
            return;
        }
        // every name that points at this connection (there is one: a second AUTH is refused)
        let keys: Vec<String> = self.buddies.online.iter().filter(|(_, o)| **o == b).map(|(k, _)| k.clone()).collect();
        for k in &keys {
            self.buddies.online.remove(k);
        }
        if !keys.is_empty() {
            let _ = self.buddy_announce(b, true);
        }
        if let Some(x) = self.buddies.conns.get_mut(&b) {
            x.persona = None;
            x.key.clear();
        }
    }

    fn touch_lists(&mut self) {
        self.buddies.dirty = true;
        if self.buddies.dir.is_none() || self.buddies.timer.is_some() {
            return;
        }
        let ms = self.buddies.save_ms;
        self.buddies.timer = Some(self.set_timeout(ms, Action::BuddySave));
    }

    /// the friends lists' save timer fired
    pub fn buddy_save_timer(&mut self) {
        self.buddies.timer = None;
        self.buddy_save();
    }

    pub fn buddy_save(&mut self) {
        let Some(dir) = self.buddies.dir.clone() else { return };
        if !self.buddies.dirty {
            return;
        }
        let body = self.buddies.serialize();
        match crate::files::write_atomic(&dir, &dir.join("buddies.json"), body.as_bytes()) {
            Ok(()) => self.buddies.dirty = false,
            Err(e) => (self.log)(&format!("[online] the friends lists could not be written: {e}"), None),
        }
    }

    pub fn buddy_stop(&mut self) {
        if let Some(t) = self.buddies.timer.take() {
            self.timers.clear(t);
        }
        self.buddy_save();
    }

    /// a persona's friends list, made if needed (on behalf of client `group`): false when that client made its share
    /// of new lists this hour; the least recently seen list goes when there are too many
    fn make_list(&mut self, name: &str, group: &Arc<str>) -> bool {
        let k = lower(name);
        if self.buddies.lists.contains_key(&k) {
            return true;
        }
        let now = self.bnow();
        let l = self.buddies.l;
        if !self.buddies.made.contains_key(group) {
            if self.buddies.made.len() >= 10_000 {
                self.buddies.made.retain(|_, x| !(x.take(now, 0.0) && x.v >= x.cap));
            }
            self.buddies.made.insert(group.clone(), LBucket::new(l.list_rate / 3600.0, l.list_rate, now));
        }
        if !self.buddies.made.get_mut(group).expect("just made").take(now, 1.0) {
            return false;
        }
        while self.buddies.lists.len() as f64 >= l.lists {
            let Some(old) = self.buddies.lists.first_key().cloned() else { break };
            self.buddies.drop_list(&old);
            self.buddies.dirty = true;
        }
        self.buddies.lists.insert(k, FriendsList { name: name.to_string(), b: IndexMap::new(), seen: jsx::month_of(now) });
        true
    }

    /// a persona was seen: its list moves to the most recently seen end
    fn seen_list(&mut self, name: &str) {
        let k = lower(name);
        if !self.buddies.lists.contains_key(&k) {
            return;
        }
        self.buddies.lists.move_to_end(&k);
        let m = jsx::month_of(self.bnow());
        let l = self.buddies.lists.get_mut(&k).expect("there");
        if l.seen != m {
            l.seen = m;
            self.touch_lists();
        }
    }

    /// every online persona that has b as a friend gets its presence now
    fn buddy_announce(&mut self, b: u64, gone: bool) -> Result<(), String> {
        let x = &self.buddies.conns[&b];
        let Some(p) = x.persona.clone() else { return Err(null_persona()) };
        let me = lower(&p);
        let what = if gone { offline(&p) } else { presence(x) };
        let now = self.bnow();
        self.buddies.conns.get_mut(&b).expect("held").told = Some(now);
        let frame = encode_frame("PGET", "", &what)?;
        // the online personas that have b as a friend or met it, in the order of `online` (the JS's): what is on the
        // lists and who met whom do not change while this goes out, and a connection is in `online` exactly while it
        // has a persona (one that went during this loop is passed over, as the JS's Map passes over what was deleted)
        let bs = &self.buddies;
        let mut hear: Vec<(u64, u64)> = Vec::new();
        for owner in bs.fans.get(&me).into_iter().flatten() {
            if let Some((place, o)) = bs.online.get_placed(owner) {
                hear.push((place, *o));
            }
        }
        for o in bs.met_by.get(&me).into_iter().flatten() {
            if let Some(ox) = bs.conns.get(o)
                && ox.persona.is_some()
                && let Some((place, x)) = bs.online.get_placed(&ox.key)
                && x == o
            {
                hear.push((place, *o));
            }
        }
        hear.sort_unstable();
        hear.dedup();
        for (_, o) in hear {
            if o != b && self.buddies.conns.get(&o).is_some_and(|x| x.persona.is_some()) {
                self.bsend_frame(o, &frame);
            }
        }
        Ok(())
    }

    /// b's presence changed: out now, or the latest of it once presence_ms has passed since the last
    fn presence_changed(&mut self, b: u64) -> Result<(), String> {
        let x = &self.buddies.conns[&b];
        if x.presence_timer.is_some() {
            return Ok(());
        }
        let wait = x.told.unwrap_or(f64::NEG_INFINITY) + self.buddies.l.presence_ms - self.bnow();
        if wait <= 0.0 {
            return self.buddy_announce(b, false);
        }
        let t = self.set_timeout(wait, Action::Presence(b));
        self.buddies.conns.get_mut(&b).expect("held").presence_timer = Some(t);
        Ok(())
    }

    /// a held-back presence goes out
    pub fn presence_timer(&mut self, b: u64) {
        let Some(x) = self.buddies.conns.get_mut(&b) else { return };
        x.presence_timer = None;
        if x.persona.is_some() {
            let _ = self.buddy_announce(b, false);
        }
    }

    /// b and the persona who become friends (each on the other's list), both told (RNOT ATTR=0: no request pending
    /// any more) with each other's presence
    fn befriend(&mut self, b: u64, who: &str, how: &str) -> Result<(), String> {
        let x = &self.buddies.conns[&b];
        let Some(bp) = x.persona.clone() else { return Err(null_persona()) };
        let group = x.group.clone();
        let (k, me) = (lower(who), lower(&bp));
        self.buddies.requests.remove(&format!("{k}>{me}"));
        self.buddies.requests.remove(&format!("{me}>{k}"));
        let full_without = |l: Option<&FriendsList>, n: &str| l.is_some_and(|l| l.b.len() >= MAX_LIST && !l.b.contains_key(n));
        if full_without(self.buddies.list(&bp), &k) || full_without(self.buddies.list(who), &me) {
            return Ok(());
        }
        let mine = self.make_list(&bp, &group);
        let them = mine && self.make_list(who, &group);
        if !mine || !them {
            return Ok(());
        }
        // (a list the second one pushed out of the store takes its friend nowhere, as in the JS)
        for (l, n) in [(&me, who), (&k, bp.as_str())] {
            self.buddies.add_friend(l, lower(n), n.to_string());
        }
        self.touch_lists();
        (self.log)(&format!("[online] \"{bp}\" and \"{who}\" are friends ({how})"), Some(&group));
        let o = self.buddies.online.get(&k).copied();
        self.bsend(b, "RNOT", &fields![("USER", who), ("CHNG", "A"), ("ATTR", 0)], "")?;
        let p = match o.and_then(|o| self.buddies.conns.get(&o)) {
            Some(ox) => presence(ox),
            None => offline(who),
        };
        self.bsend(b, "PGET", &p, "")?;
        if let Some(o) = o {
            let bp2 = self.buddies.conns.get(&b).and_then(|x| x.persona.clone());
            self.bsend(o, "RNOT", &fields![("USER", bp2), ("CHNG", "A"), ("ATTR", 0)], "")?;
            let p = presence(&self.buddies.conns[&b]);
            self.bsend(o, "PGET", &p, "")?;
        }
        Ok(())
    }

    /// the AUTH tried again
    pub fn buddy_retry(&mut self, b: u64, f: FieldMap) {
        let Some(x) = self.buddies.conns.get(&b) else { return };
        if !self.conn_open(x.conn) || x.persona.is_some() {
            return;
        }
        let _ = self.buddy_message(b, "AUTH", &f);
    }

    fn buddy_message(&mut self, b: u64, kind: &str, f: &FieldMap) -> Result<(), String> {
        let with_id: Fields = match f.get("ID") {
            Some(id) => fields![("ID", id)],
            None => vec![],
        };
        let wid = |mut extra: Fields| {
            let mut v = with_id.clone();
            v.append(&mut extra);
            v
        };
        let x = &self.buddies.conns[&b];
        if kind == "AUTH" {
            if x.persona.is_some() {
                return self.bsend(b, "AUTH", &fields![("TITL", "EA MESSENGER")], "logn");
            }
            // the lobby's key for this browser's persona: the only thing that says who this is
            let key = f.str("LKEY").to_string();
            let vip = x.vip;
            // the first of the live sessions with this key from this browser (the JS looks through all of them: the
            // others are not of this browser)
            let s = if key.encode_utf16().count() >= 24 {
                self.lobby.of_vip(vip).iter().copied().find(|id| {
                    let y = self.lobby.s(*id);
                    y.vip == vip && y.lkey.as_ref().is_some_and(|l| !l.is_empty() && l.starts_with(&key))
                })
            } else {
                None
            };
            let Some(s) = s else {
                let x = self.buddies.conns.get_mut(&b).expect("held");
                x.tries += 1;
                // the lobby login may finish a moment later
                if x.tries <= 6 {
                    self.set_timeout(500.0, Action::BuddyRetry(b, f.clone()));
                    return Ok(());
                }
                return self.bsend(b, "AUTH", &fields![("TITL", "EA MESSENGER")], "pass");
            };
            if let Some(t) = self.buddies.conns.get_mut(&b).and_then(|x| x.login_timer.take()) {
                self.timers.clear(t);
            }
            let persona = self.lobby.s(s).persona.clone().unwrap_or_default();
            let k = lower(&persona);
            if let Some(old) = self.buddies.online.get(&k).copied().filter(|o| *o != b)
                && let Some(conn) = self.buddies.conns.get(&old).map(|x| x.conn)
            {
                self.conn_destroy(conn, "logged in again");
            }
            if let Some(x) = self.buddies.conns.get_mut(&b) {
                x.persona = Some(persona.clone());
                x.key = k.clone();
            }
            self.buddies.online.insert(k, b);
            self.seen_list(&persona);
            return self.bsend(b, "AUTH", &fields![("TITL", "EA MESSENGER")], "");
        }
        if kind == "PING" {
            return self.bsend(b, "PING", &[], "");
        }
        if kind == "DISC" {
            self.buddy_gone(b);
            let conn = self.buddies.conns[&b].conn;
            self.conn_end(conn);
            return Ok(());
        }
        let short = jsx::slice16(kind, 4).to_string();
        let Some(bp) = self.buddies.conns[&b].persona.clone() else { return self.bsend(b, &short, &[], "auth") };
        let me = lower(&bp);
        let group = self.buddies.conns[&b].group.clone();
        let list_of = |f: &FieldMap| if f.str("LIST").to_uppercase() == "I" { "I" } else { "B" };
        let list_field = |f: &FieldMap| if f.has("LIST") { list_of(f) } else { "B" };
        match kind {
            "EPGT" => self.bsend(b, "EPGT", &wid(fields![("ENAB", "N"), ("ADDR", "")]), ""),
            "RGET" => {
                let now = self.bnow();
                if !self.buddies.conns.get_mut(&b).expect("held").heavy.take(now, 1.0) {
                    return self.bsend(b, "RGET", &with_id, "full");
                }
                let which = list_field(f);
                let names: Vec<String> = if which == "I" {
                    self.buddies.conns[&b].blocked.values().cloned().collect()
                } else {
                    self.buddies.list(&bp).map_or(vec![], |l| l.b.values().cloned().collect())
                };
                self.bsend(b, "RGET", &wid(fields![("SIZE", names.len())]), "")?;
                for n in &names {
                    self.bsend(b, "ROST", &wid(fields![("USER", n), ("LIST", which)]), "")?;
                }
                if which == "B" {
                    for n in &names {
                        let p = match self.buddies.online.get(&lower(n)).and_then(|o| self.buddies.conns.get(o)) {
                            Some(o) => presence(o),
                            None => offline(n),
                        };
                        self.bsend(b, "PGET", &p, "")?;
                    }
                }
                Ok(())
            }
            "RADD" | "RDEL" => {
                let which = list_field(f);
                let who = strip_at(f.str("USER")).to_string();
                if !valid_name(&who) || lower(&who) == me {
                    return self.bsend(b, kind, &with_id, "user");
                }
                let k = lower(&who);
                // the session's own (see the module's text)
                if which == "I" {
                    let x = self.buddies.conns.get_mut(&b).expect("held");
                    if kind == "RADD" {
                        if x.blocked.len() >= MAX_LIST && !x.blocked.contains_key(&k) {
                            return self.bsend(b, kind, &with_id, "full");
                        }
                        x.blocked.insert(k, who);
                    } else {
                        x.blocked.shift_remove(&k);
                    }
                    return self.bsend(b, kind, &with_id, "");
                }
                if kind == "RDEL" {
                    if self.buddies.remove_friend(&me, &k) {
                        self.touch_lists();
                    }
                    return self.bsend(b, kind, &with_id, "");
                }
                let cur = self.buddies.list(&bp);
                if cur.is_some_and(|l| l.b.len() >= MAX_LIST && !l.b.contains_key(&k)) {
                    return self.bsend(b, kind, &with_id, "full");
                }
                if cur.is_none() && !self.make_list(&bp, &group) {
                    return self.bsend(b, kind, &with_id, "full");
                }
                self.buddies.add_friend(&me, k.clone(), who.clone());
                self.touch_lists();
                self.bsend(b, kind, &with_id, "")?;
                let o = self.buddies.online.get(&k).copied();
                let p = match o.and_then(|o| self.buddies.conns.get(&o)) {
                    Some(ox) => presence(ox),
                    None => offline(&who),
                };
                self.bsend(b, "PGET", &p, "")?;
                if let Some(o) = o.filter(|o| self.buddies.conns.get(o).is_some_and(|x| !x.blocked.contains_key(&me))) {
                    let bp2 = self.buddies.conns.get(&b).and_then(|x| x.persona.clone());
                    self.bsend(o, "RNOT", &fields![("USER", bp2), ("LIST", "B")], "")?;
                }
                Ok(())
            }
            "RADM" => {
                // a friend request (Send Friend Request): to the persona, which answers with RRSP
                let who = strip_at(f.str("USER")).to_string();
                let k = lower(&who);
                if !valid_name(&who) || k == me {
                    return self.bsend(b, kind, &with_id, "user");
                }
                if self.buddies.list(&bp).is_some_and(|l| l.b.len() >= MAX_LIST && !l.b.contains_key(&k)) {
                    return self.bsend(b, kind, &with_id, "full");
                }
                self.bsend(b, kind, &with_id, "")?;
                let Some(o) = self.buddies.online.get(&k).copied() else { return Ok(()) };
                // offline, or blocked by that persona
                if self.buddies.conns.get(&o).is_none_or(|x| x.blocked.contains_key(&me)) {
                    return Ok(());
                }
                // two requests that cross (the asked one asks back: "Send Friend Request" in the asker's menu) make
                // friends
                if self.buddies.requests.contains_key(&format!("{k}>{me}")) {
                    return self.befriend(b, &who, "asked back");
                }
                if self.buddies.requests.len() > 10_000 {
                    self.buddies.requests.clear();
                }
                let now = self.bnow();
                self.buddies.requests.insert(format!("{me}>{k}"), now);
                let bp2 = self.buddies.conns.get(&b).and_then(|x| x.persona.clone());
                (self.log)(&format!("[online] \"{}\" asked \"{who}\" to be friends", bp2.as_deref().unwrap_or("null")), Some(&group));
                // a roster update for the asked one: the asker, with a "request" bit in ATTR (the game keeps two
                // such bits, 0x40000 and 0x80000, and clears them when the request is answered: RNOT, 0x74E2B0;
                // with 0x80000 the asker appears on the list, the menu offers no accept: the asked one answers with
                // a request back), then the asker's presence for that entry
                self.bsend(o, "RNOT", &fields![("USER", bp2), ("CHNG", "A"), ("ATTR", 0x80000)], "")?;
                let p = presence(&self.buddies.conns[&b]);
                self.bsend(o, "PGET", &p, "")
            }
            "RRSP" => {
                // the answer to a friend request; ANSW's coding is UNVERIFIED: anything but a "no" accepts
                let who = strip_at(f.str("USER")).to_string();
                let k = lower(&who);
                let key = format!("{k}>{me}");
                let asked = self.buddies.requests.get(&key).copied();
                self.bsend(b, kind, &with_id, "")?;
                let now = self.bnow();
                let Some(asked) = asked.filter(|a| now - a <= 3_600_000.0) else { return Ok(()) };
                let _ = asked;
                self.buddies.requests.remove(&key);
                let answer = f.str("ANSW");
                let a = answer.to_lowercase();
                if a.starts_with('n') || a.starts_with('d') || a.starts_with('0') || a.starts_with("false") {
                    let bp2 = self.buddies.conns.get(&b).and_then(|x| x.persona.clone());
                    (self.log)(
                        &format!("[online] \"{}\" declined \"{who}\"'s friend request", bp2.as_deref().unwrap_or("null")),
                        Some(&group),
                    );
                    return Ok(());
                }
                self.befriend(b, &who, &format!("ANSW={}", clean_text(answer, 8)))
            }
            "PADD" | "PDEL" => {
                // the Messenger's "All" list: players this one searched for or met (in memory only); their presence
                let who = strip_at(f.str("USER")).to_string();
                self.bsend(b, kind, &with_id, "")?;
                if !valid_name(&who) {
                    return Ok(());
                }
                let x = self.buddies.conns.get_mut(&b).expect("held");
                let k = lower(&who);
                if kind == "PDEL" {
                    if x.met.remove(&k)
                        && let Some(s) = self.buddies.met_by.get_mut(&k)
                    {
                        s.remove(&b);
                        if s.is_empty() {
                            self.buddies.met_by.remove(&k);
                        }
                    }
                    return Ok(());
                }
                if x.met.len() < MAX_LIST && x.met.insert(k.clone()) {
                    self.buddies.met_by.entry(k).or_default().insert(b);
                }
                let p = match self.buddies.online.get(&lower(&who)).and_then(|o| self.buddies.conns.get(o)) {
                    Some(o) => presence(o),
                    None => offline(&who),
                };
                self.bsend(b, "PGET", &p, "")
            }
            "USCH" => {
                // Search: personas online now or known from their races whose name starts with the text (at most
                // MAXR, 20)
                let now = self.bnow();
                if !self.buddies.conns.get_mut(&b).expect("held").heavy.take(now, 1.0) {
                    return self.bsend(b, "USCH", &wid(fields![("SIZE", 0)]), "");
                }
                let q = jsx::slice16(&lower(strip_at(f.str("USER"))), 15).to_string();
                let max = 20i32.min(1i32.max(jsx::to_int32(f.num("MAXR", 20.0)))) as usize;
                let mut found: IndexMap<String, String> = IndexMap::new();
                if !q.is_empty() {
                    // (by_persona's keys are its sessions' personas in lower case: none made again for each)
                    for (k, s) in &self.lobby.by_persona {
                        if k.starts_with(&q)
                            && let Some(p) = &self.lobby.s(*s).persona
                        {
                            found.insert(k.clone(), p.clone());
                        }
                    }
                    for n in self.stats.starting_with(&q, max + 1) {
                        found.insert(lower(&n), n);
                    }
                }
                found.shift_remove(&me);
                let mut names: Vec<String> = found.into_values().collect();
                names.sort();
                names.truncate(max);
                self.bsend(b, "USCH", &wid(fields![("SIZE", names.len())]), "")?;
                for n in names {
                    self.bsend(b, "USER", &wid(fields![("USER", n)]), "")?;
                }
                Ok(())
            }
            "PSET" => {
                let show = jsx::slice16(f.get("SHOW").unwrap_or("CHAT"), 8).to_string();
                let stat = jsx::slice16(f.str("STAT"), 64).to_string();
                let prod = clean_text(f.str("PROD"), 64);
                self.bsend(b, "PSET", &with_id, "")?;
                let x = self.buddies.conns.get_mut(&b).expect("held");
                if x.told.is_some() && show == x.show && stat == x.stat && prod == x.prod {
                    return Ok(());
                }
                x.show = show;
                x.stat = stat;
                x.prod = prod;
                self.presence_changed(b)
            }
            "SEND" | "GINV" | "GRSP" | "GRVK" => {
                let to = strip_at(f.str("USER")).to_string();
                let o = self.buddies.online.get(&lower(&to)).copied();
                let t = self.bnow();
                let x = self.buddies.conns.get_mut(&b).expect("held");
                x.msgs_v = 5f64.min(x.msgs_v + (t - x.msgs_t) / 500.0);
                x.msgs_t = t;
                if x.msgs_v < 1.0 {
                    return self.bsend(b, kind, &with_id, "full");
                }
                x.msgs_v -= 1.0;
                self.bsend(b, kind, &with_id, "")?;
                // offline, or this sender is blocked
                let Some(o) = o else { return Ok(()) };
                let Some(ox) = self.buddies.conns.get(&o) else { return Ok(()) };
                if ox.persona.is_none() || ox.blocked.contains_key(&me) {
                    return Ok(());
                }
                let bp2 = self.buddies.conns.get(&b).and_then(|x| x.persona.clone());
                if kind == "SEND" {
                    let rec = fields![
                        ("USER", bp2),
                        ("BODY", clean_text(f.str("BODY"), 500)),
                        ("SUBJ", clean_text(f.str("SUBJ"), 64)),
                        ("TYPE", jsx::slice16(f.get("TYPE").unwrap_or("C"), 4)),
                        ("TIME", (t / 1000.0).floor())
                    ];
                    self.bsend(o, "RECV", &rec, "")
                } else {
                    // a game invite and its answers: the game's own fields, the sender named by the server
                    let mut rec = fields![("USER", bp2)];
                    let passed =
                        f.0.iter()
                            .filter_map(|(k, v)| Some((k, v.as_ref()?)))
                            .filter(|(k, _)| !["USER", "ID", "LKEY"].contains(&k.as_str()));
                    rec.extend(passed.take(12).map(|(k, v)| (std::borrow::Cow::from(k.clone()), V::S(clean_text(v, 128)))));
                    self.bsend(o, kind, &rec, "")
                }
            }
            _ => self.bsend(b, &short, &with_id, ""),
        }
    }
}
