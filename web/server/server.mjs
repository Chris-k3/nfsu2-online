// NFSU2 web: the server.
//
// Serves, to Chrome on this machine, on the LAN, or (on a VPS) over the
// internet:
//   /                  the web app (web/dist)
//   /game.wasm         the game module (out/web/nfsu2.wasm), brotli on the wire
//   /game.json         what was built (size, memory layout, revision)
//   /data/<path>       the NFSU2 install folder, read-only, with byte ranges: only
//                      what the game reads (GAME_ENTRIES below), never the rest
//                      of the folder (an installer's log, saves, mod settings)
//   /data-manifest     those files: path, size, mtime
//   /lan               WebSocket: the virtual LAN switch for multiplayer, with
//                      the game's Online mode served on its 10.77.0.1 (online/;
//                      --online off: none, the game then cannot connect) and
//                      free roam's hub on 10.77.0.253 (roam-hub.mjs: each
//                      player's peers are the players nearest to it; --roam-hub
//                      off: none, players find each other by broadcast)
//   /robots.txt        nothing to index
//   /players           how many play on this server now: { players, online }, two
//                      counts and nothing else (never cached)
//   test aids, only with --dev: the test pages (/test/) and source maps from
//   web/dist-dev (node build.mjs writes them there, never into web/dist), the
//   repo's test scripts (/tests/), PUT /artifacts/<name>.png (with --artifacts)
//
// There is no access control: whoever can reach the server may play, and the
// firewall in front of it decides who that is.  What the server does instead
// is say nothing about the machine (no host name, addresses, paths, versions
// or stack traces in any response; plain 4xx/5xx), keep every peer's real
// address to itself (lan.mjs), send security headers on every response, keep
// shared caches (a CDN such as Cloudflare) from storing anything, and limit
// what one client can make it do.  It answers only for its own names (the
// Host check below): a page of another site that points its own name at this
// machine (DNS rebinding) gets nothing, and neither does a scanner that
// connects to the bare address.  This console is the operator's own: it may
// name paths, but it names players only by their virtual address and
// nickname, never by their real address (--access-log is the one opt-in that
// records client addresses).
//
// Its own names (the Host a request may carry, and the Origin of a /lan page):
//   localhost, 127.0.0.1 and [::1], always (this machine);
//   with --tls-cert, the names in that certificate;
//   the names given with --host (required with --behind-proxy: the proxy
//   forwards the player's Host, and this server cannot know the public name).
// Anything else gets 421.  With --tls-cert, a TLS handshake for another name,
// or without a name (SNI), fails, so the certificate (and with it the domain)
// is shown only to whoever already asks for that domain; a certificate that
// names an IP address is shown for connections without a name too.
//
// HTTPS (Chrome allows WebGPU and SharedArrayBuffer only on secure origins;
// http://localhost is one) comes from one of:
//   --tls-cert <pem> --tls-key <pem>   a certificate (Let's Encrypt, or a
//                                      Cloudflare Origin CA certificate), read
//                                      again when the file changes or on SIGHUP
//   --behind-proxy                     a reverse proxy or tunnel on this machine
//                                      (Caddy, nginx, cloudflared) does TLS:
//                                      plain HTTP on 127.0.0.1:<http-port> only
//   (neither)                          no HTTPS: only this machine can play, over
//                                      http://localhost:<http-port>
// plus plain HTTP on 127.0.0.1:<http-port> for this machine (0 = none).
//
//   node web/server/server.mjs --data "<NFSU2 folder>" [--http-port 8080]
//        [--tls-cert <pem> --tls-key <pem> [--port 8443] [--bind <address>] | --behind-proxy --host <name>[,<name>...]]
//        [--host <name>[,<name>...]] [--state <dir>]
//        [--trusted-proxies cloudflare,<ip>,<cidr>,...] [--real-ip-header x-forwarded-for|cf-connecting-ip]
//        [--max-peers 64] [--online on|off] [--roam-hub on|off] [--access-log] [--dev [--artifacts <dir>] [--lan-impair <spec>] [--online-trace <file>]]
// Options with a value can also come from the environment as NFSU2_<OPTION>
// (NFSU2_DATA, NFSU2_PORT, NFSU2_TLS_CERT, ...); switches only from the command line.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { LanSwitch, LAN_WSS_OPTIONS, vipStr } from './lan.mjs';
import { OnlineHost } from './online/index.mjs';
import { RoamHub } from './roam-hub.mjs';
import { LobbyTrace } from './online/trace.mjs';
import { securityHeaders, cacheHeaders, etagMatches, makeProxyTrust,
  clientIp, viaHttps, forwardedHost, isLocalOrIp, bareIp, addressKey, siteKey, makeHostCheck, hostName } from './headers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

// ---- options ----
const VALUE_OPTS = ['--data', '--dist', '--wasm', '--port', '--http-port', '--bind', '--state', '--tls-cert', '--tls-key',
  '--trusted-proxies', '--real-ip-header', '--max-peers', '--artifacts', '--lan-impair', '--host', '--online', '--online-trace',
  '--roam-hub'];
const FLAG_OPTS = ['--behind-proxy', '--dev', '--access-log'];
function die(msg) { console.error(msg); process.exit(1); }
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (VALUE_OPTS.includes(a)) { if (++i >= process.argv.length) die(`${a} needs a value`); }
  else if (!FLAG_OPTS.includes(a)) die(`unknown option ${a}\noptions: ${[...VALUE_OPTS, ...FLAG_OPTS].join(' ')}`);
}
const envName = name => 'NFSU2_' + name.slice(2).toUpperCase().replace(/-/g, '_');
function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i > 1 ? process.argv[i + 1] : (process.env[envName(name)] ?? def);
}
// switches only on the command line (--dev must be asked for explicitly)
const flag = name => process.argv.includes(name);
function port(name, def) {
  const v = String(arg(name, def));
  if (!/^\d{1,5}$/.test(v) || +v > 65535) die(`${name}: a port number (0 = none), not "${v}"`);
  return +v;
}

const DATA = path.resolve(arg('--data', ''));
const DIST = path.resolve(arg('--dist', path.join(REPO, 'web/dist')));
// the test pages and source maps: their own folder next to the page's, looked in only with --dev
const DEV_DIST = DIST + '-dev';
const WASM = path.resolve(arg('--wasm', path.join(REPO, 'out/web/nfsu2.wasm')));
const GAME_JSON = WASM.replace(/\.wasm$/, '.json');
const STATE = path.resolve(arg('--state', path.join(REPO, 'out/web/server')));
const HTTPS_PORT = port('--port', 8443);
const HTTP_PORT = port('--http-port', 8080);
const BEHIND = flag('--behind-proxy');
const TLS_CERT = arg('--tls-cert', '') ? path.resolve(arg('--tls-cert', '')) : '';
const TLS_KEY = arg('--tls-key', '') ? path.resolve(arg('--tls-key', '')) : '';
const DEV = flag('--dev');
const ACCESS_LOG = flag('--access-log');
const ARTIFACTS = arg('--artifacts', '') ? path.resolve(arg('--artifacts', '')) : '';
const MAX_PEERS = +arg('--max-peers', 64);
// the public names (a domain), comma-separated; '*.' covers one label
const HOSTS = String(arg('--host', '')).split(',').map(h => h.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean);
// a test aid of the LAN-play tests (delay, loss, reordering on the switch; lan.mjs where it is implemented)
const LAN_IMPAIR = arg('--lan-impair', '');
// the game's Online mode (online/index.mjs): on unless --online off
const ONLINE = String(arg('--online', 'on')).toLowerCase();
// free roam's hub (roam-hub.mjs): each player's peers are the players nearest to it; on unless --roam-hub off
const ROAM_HUB = String(arg('--roam-hub', 'on')).toLowerCase();
// a test aid: the lobby protocol's messages, decoded and with every secret redacted, into a file (online/trace.mjs)
const ONLINE_TRACE = arg('--online-trace', '') ? path.resolve(arg('--online-trace', '')) : '';

if (!arg('--data', '') || !fs.existsSync(path.join(DATA, 'SPEED2.EXE'))) die(`usage: node web/server/server.mjs --data "<folder with SPEED2.EXE>"  (got: ${arg('--data', '') ? DATA : 'nothing'})`);
if (!!TLS_CERT !== !!TLS_KEY) die('--tls-cert and --tls-key go together');
if (BEHIND && TLS_CERT) die('--behind-proxy (the proxy does TLS) or --tls-cert/--tls-key (this server does), not both');
if (BEHIND && !HTTP_PORT) die('--behind-proxy needs --http-port: the port on 127.0.0.1 the proxy forwards to');
if (BEHIND && !HOSTS.length) die('--behind-proxy needs --host <name>: the name players open (game.example.com).  The server answers only\n' +
  'for its own names, so a page of another site cannot use it through a browser that reaches this machine.');
for (const h of HOSTS) if (!hostName(h.replace(/^\*\./, ''))) die(`--host: "${h}" is not a host name`);
if (ARTIFACTS && !DEV) die('--artifacts is a test aid: it needs --dev');
if (LAN_IMPAIR && !DEV) die('--lan-impair is a test aid: it needs --dev');
if (!['on', 'off'].includes(ONLINE)) die('--online: on or off');
if (!['on', 'off'].includes(ROAM_HUB)) die('--roam-hub: on or off');
if (ONLINE_TRACE && !DEV) die('--online-trace is a test aid: it needs --dev');
if (!Number.isInteger(MAX_PEERS) || MAX_PEERS < 1 || MAX_PEERS > 250) die('--max-peers: 1 to 250');
// how TLS is done: by a proxy in front, with the given certificate, or not at all (this machine only)
const TLS = BEHIND ? 'proxy' : TLS_CERT ? 'cert' : 'none';
if (TLS === 'cert' && !HTTPS_PORT) die('--tls-cert needs --port: the HTTPS port');
// where the TLS port listens: IPv6 and IPv4 ("::", dual stack; IPv4 alone where the machine has no IPv6), so
// AAAA records work
const BIND_SET = arg('--bind', '') !== '';
if (BIND_SET && TLS !== 'cert') die('--bind is for the HTTPS port (--tls-cert): the HTTP port listens on 127.0.0.1 only');
const BIND = BIND_SET ? String(arg('--bind', '')) : '::';
if (!HTTP_PORT && TLS === 'none') die('no port to listen on: --http-port is 0 and there is no --tls-cert');
let trust;
try { trust = makeProxyTrust(arg('--trusted-proxies', '')); } catch (e) { die(e.message); }
const REAL_IP = String(arg('--real-ip-header', trust.cloudflare ? 'cf-connecting-ip' : 'x-forwarded-for')).toLowerCase();
if (!['x-forwarded-for', 'cf-connecting-ip'].includes(REAL_IP)) die('--real-ip-header: x-forwarded-for or cf-connecting-ip');
// HSTS: over a certificate browsers check, this server's own or the proxy's
const HSTS_OK = TLS === 'cert' || TLS === 'proxy';
// The state folder holds keys (the ETag key, the switch's token hashes), and a --tls-key is one: never inside a
// folder this server serves, and the other way round (the audit's F5/DEP-6: --state inside --data served the keys
// in it at /data/state/...).  Compared as real paths (symbolic links followed), case-insensitively (the Mac's disk).
const realOrPlanned = p => { try { return fs.realpathSync(p); } catch { return path.join(realOrPlanned(path.dirname(p)), path.basename(p)); } };
const within = (a, b) => { const x = a.toLowerCase(), y = b.toLowerCase(); return x === y || x.startsWith(y.endsWith(path.sep) ? y : y + path.sep); };
{
  const served = [['--data', DATA], ['--dist', DIST], ['the test pages (--dist + "-dev")', DEV_DIST], ...(DEV ? [['the test scripts', path.join(REPO, 'tests')]] : [])]
    .map(([n, p]) => [n, realOrPlanned(p)]);
  const secret = [['--state', STATE], ...(ARTIFACTS ? [['--artifacts', ARTIFACTS]] : []), ...(TLS_KEY ? [['--tls-key', TLS_KEY]] : [])]
    .map(([n, p]) => [n, realOrPlanned(p)]);
  for (const [sn, sp] of secret) for (const [dn, dp] of served) {
    if (within(sp, dp)) die(`${sn} (${sp}) is inside ${dn} (${dp}), which this server hands to everyone: put it elsewhere`);
    if (sn === '--state' && within(dp, sp)) die(`${dn} (${dp}) is inside --state (${sp}), which holds keys: put them apart`);
  }
}
// private to this server's user (the files inside are 0600 too)
fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
try { if (fs.statSync(STATE).uid === process.getuid?.()) fs.chmodSync(STATE, 0o700); } catch { /* not ours to change */ }
const REAL_STATE = fs.realpathSync(STATE);
if (ARTIFACTS) fs.mkdirSync(ARTIFACTS, { recursive: true });

// ---- limits ----
// "Per client" below is per client address: an IPv4 address or an IPv6 /56 (headers.mjs addressKey); "per
// site" is per IPv6 /48 (siteKey: one site, or one free tunnel-broker allocation, which holds 256 /56s and
// would otherwise be 256 budgets for one client: the review of the audit's F3).
const LIMITS = {
  maxHeaderSize: 16 << 10,       // request line + headers (Node answers 431 above)
  handshakeTimeout: 15_000,      // a TLS handshake (Node's default is 120 s)
  headersTimeout: 15_000,        // the whole header must arrive within this (slow-loris)
  requestTimeout: 30_000,        // and the whole request (nothing here takes a body but test PUTs)
  // idle keep-alive connections: longer for Cloudflare's own connections when its
  // proxy connects here (--trusted-proxies cloudflare: it reuses an origin connection
  // for up to 900 s and fails a request on one the origin has just closed)
  keepAliveTimeout: 65_000,
  keepAliveCloudflare: 905_000,
  // a connection with nothing to do for this long goes (Node's socket timeout: it does not fire while a
  // write is still queued, so a response the client stopped reading is ended by the progress rule below)
  socketIdle: 120_000,
  // per listening socket: each player holds at most 6 HTTP connections and a WebSocket, so with
  // many players (a VPS with --max-peers 250) the port takes 8 per player
  maxConnections: Math.max(1024, MAX_PEERS * 8),
  // connections at once per client and per site, TCP peers that are not trusted proxies only: Chrome opens at
  // most 6 per server and a WebSocket, so this leaves room for a household of players behind one address, and
  // one client cannot take them all
  connsPerAddress: 64,
  connsPerSite: 128,
  // requests in progress at once per client and per site, counted by the client's own address also when a
  // proxy carries it (a proxy opens one connection here per request in progress, so without this one client
  // behind Caddy or a tunnel could hold all of them: the audit's F3).  The page's I/O worker keeps at most 8
  // block requests in flight.  More gets 429.
  requestsPerClient: 64,
  requestsPerSite: 128,
  // the last part of the connections (and of the requests in progress) is only for a client that holds none
  // yet: clients that already hold some can never lock a newcomer out
  freeShare: 0.25,
  // a response must move: at least progressBytes in every progressMs, and it may take responseMaxMs at
  // most (a 1 MiB block or the 7 MB module takes seconds; a client that stops reading, or reads a trickle,
  // is let go)
  progressBytes: 64 << 10,
  progressMs: 20_000,
  responseMaxMs: 15 * 60_000,
  pipelined: 4,                  // requests queued on one connection (browsers and proxies send one at a time)
  wsPerAddress: 8,               // /lan connections at once per client
  wsPerSite: 16,                 // and per site
  // opening /lan: a burst, then this many a second, per client (twice that per site).  A page reconnects
  // at most every 250 ms, backing off to every 5 s; a client that opens and closes connections as fast as it
  // can gets 429 (the review of the audit's F1: churning connections)
  lanOpenBurst: 20,
  lanOpenRate: 1,
  wsMaxPayload: 64 << 10,        // one WebSocket message (the switch drops frames over 8 KB)
  artifactBytes: 64 << 20,
};

// ---- responses ----
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};
const hstsFor = q => HSTS_OK && viaHttps(q, trust) && !isLocalOrIp(forwardedHost(q, trust) ?? q.headers.host);
function headers(q, extra = {}, cache = 'store') {
  return { ...securityHeaders({ hsts: hstsFor(q) }), ...cacheHeaders(cache), ...extra };
}
function plain(q, s, code, text, extra = {}) {
  const body = text + '\n';
  s.writeHead(code, headers(q, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body), ...extra }));
  s.end(q.method === 'HEAD' ? undefined : body);
}
const notFound = (q, s) => plain(q, s, 404, 'Not found');
// a response written on the raw socket (refused upgrades, broken requests): the same headers, nothing else
const STATUS = { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 408: 'Request Timeout', 421: 'Misdirected Request', 429: 'Too Many Requests', 431: 'Request Header Fields Too Large', 503: 'Service Unavailable' };
function rawResponse(code) {
  const h = { ...securityHeaders(), ...cacheHeaders(), 'content-length': 0, connection: 'close' };
  return `HTTP/1.1 ${code} ${STATUS[code]}\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`;
}
function refuseSocket(sock, code) {
  try { if (sock.writable) sock.end(rawResponse(code)); } catch { /* gone */ }
  setTimeout(() => sock.destroy(), 1000).unref();
}
// the console: one line, printable, short (a client chooses what is in a URL)
const printable = (x, n = 160) => String(x).replace(/[^\x20-\x7e]/g, '?').slice(0, n);
// Lines a client causes (refused requests and upgrades, joins and leaves, the access log): at most `per` a
// minute of one topic for one client, then one line that says how many were left out.  One client can no
// longer fill the journal, push the VPS's other logs out or make journald drop real players' lines (the
// audit's DEP-4).  The client is only the key of the count: no line names its address.
const quiet = new Map();
function logLimited(kind, topic, key, line, per) {
  const now = Date.now(), k = `${kind} ${topic} ${key}`;
  let b = quiet.get(k);
  if (b && now - b.t >= 60_000) { flushQuiet(k, b); b = null; }
  if (!b) { if (quiet.size >= 10_000) flushAllQuiet(true); quiet.set(k, b = { t: now, n: 0, left: 0, kind, topic }); }
  if (b.n++ < per) console.log(line); else b.left++;
}
function flushQuiet(k, b) {
  quiet.delete(k);
  if (b.left) console.log(`[${b.kind}] ${b.left} more ${b.topic} from one client in that minute (not shown)`);
}
function flushAllQuiet(force = false) {
  const now = Date.now();
  for (const [k, b] of quiet) if (force || now - b.t >= 60_000) flushQuiet(k, b);
}
setInterval(() => flushAllQuiet(), 15_000).unref();

// ---- per-client budgets ----
/**
 * What clients hold at once (connections, requests in progress): at most `per` for one client, `perSite` for
 * one site, `total` in all, and the last `free` share of the total only for a client (and site) that holds
 * none yet.
 */
class Budget {
  constructor(per, perSite, total = Infinity, free = 0) {
    this.per = per; this.perSite = perSite; this.total = total;
    this.open = Number.isFinite(total) ? total - Math.floor(total * free) : Infinity;
    this.by = new Map(); this.bySite = new Map(); this.n = 0;
  }
  /** one more for this client: false when it has its share */
  take(key, site) {
    const a = this.by.get(key) ?? 0, b = site ? this.bySite.get(site) ?? 0 : 0;
    if (a >= this.per || b >= this.perSite || this.n >= this.total) return false;
    if (this.n >= this.open && (a || b)) return false;
    this.by.set(key, a + 1); if (site) this.bySite.set(site, b + 1); this.n++;
    return true;
  }
  give(key, site) {
    const dec = (m, k) => { const v = (m.get(k) ?? 1) - 1; if (v > 0) m.set(k, v); else m.delete(k); };
    dec(this.by, key); if (site) dec(this.bySite, site); this.n--;
  }
  held(key) { return this.by.get(key) ?? 0; }
}
/** how often a client may do something: a token bucket per client and per site (twice the client's) */
class Rate {
  constructor(burst, perSec) { this.burst = burst; this.rate = perSec; this.m = new Map(); setInterval(() => this.prune(), 60_000).unref(); }
  one(k, scale) {
    const now = performance.now();
    let b = this.m.get(k);
    if (!b) this.m.set(k, b = { v: this.burst * scale, t: now, cap: this.burst * scale, rate: this.rate * scale });
    b.v = Math.min(b.cap, b.v + (now - b.t) / 1000 * b.rate); b.t = now;
    return b;
  }
  take(key, site) {
    const a = this.one(key, 1), b = site ? this.one('site ' + site, 2) : null;
    if (a.v < 1 || (b && b.v < 1)) return false;
    a.v--; if (b) b.v--;
    return true;
  }
  /** buckets that are full again hold nothing worth keeping */
  prune() {
    const now = performance.now();
    for (const [k, b] of this.m) if (b.v + (now - b.t) / 1000 * b.rate >= b.cap) this.m.delete(k);
  }
}

// ETags without file-system detail: a keyed hash (the key never leaves this machine)
const ETAG_KEY = (() => {
  const f = path.join(STATE, 'etag.key');
  try { const k = fs.readFileSync(f); if (k.length >= 32) return k; } catch { /* first run */ }
  const k = crypto.randomBytes(32); fs.writeFileSync(f, k, { mode: 0o600 }); return k;
})();
const etagOf = (...parts) => '"' + crypto.createHmac('sha256', ETAG_KEY).update(parts.join('\0')).digest('base64url').slice(0, 22) + '"';

// ---- the install folder: a manifest (walked once; refreshed when asked, at most every 10 s) ----
// Only what the game reads: its program, the LAN server module and its settings, and its data folders,
// compared case-insensitively.  The rest of an install folder never leaves this machine: an installer's
// uninstall log (unins000.dat names the PC, the Windows account and when it was installed), a SAVE folder
// that a widescreen fix writes the player's profiles into, mod plugins and their settings, backups, notes
// (the audit's PRIV-1).  Dot files are never served either.
const GAME_ENTRIES = ['speed2.exe', 'server.dll', 'server.cfg',
  'cars', 'credits', 'frontend', 'global', 'languages', 'memcard', 'movies', 'nis', 'pfdata', 'sound', 'speech', 'subtitles', 'tracks'];
const GAME_TOP = new Set(GAME_ENTRIES);
const gameEntry = name => GAME_TOP.has(name.toLowerCase());
let manifest = null, manifestAt = 0, manifestBuilding = null;
async function buildManifest() {
  const files = [];
  async function walk(dir, rel) {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || (!rel && !gameEntry(e.name))) continue;
      const abs = path.join(dir, e.name), r = rel ? rel + '/' + e.name : e.name;
      // never the state folder (keys), wherever it is (a second guard: the start refuses one inside the folder)
      if (e.isDirectory() && within(await fsp.realpath(abs).catch(() => abs), REAL_STATE)) continue;
      if (e.isDirectory()) { files.push({ p: r, d: 1 }); await walk(abs, r); }
      else if (e.isFile()) { const st = await fsp.stat(abs); files.push({ p: r, s: st.size, m: Math.floor(st.mtimeMs / 1000) }); }
      // symbolic links are left out: nothing outside the folder is ever served
    }
  }
  await walk(DATA, '');
  const body = JSON.stringify({ v: 1, files });
  manifest = { body, gz: zlib.gzipSync(body), etag: etagOf('manifest', crypto.createHash('sha256').update(body).digest('hex')), count: files.length };
  manifestAt = Date.now();
  return manifest;
}
function refreshManifest() {
  manifestBuilding ??= buildManifest().finally(() => { manifestBuilding = null; });
  return manifestBuilding;
}

// ---- files ----
/** the file under root that a URL path names; null for anything with a dot segment or outside root */
function resolveInside(root, urlPath) {
  if (urlPath.split('/').some(seg => seg.startsWith('.'))) return null;   // .., ., .git, .DS_Store, ...
  const p = path.resolve(root, '.' + path.posix.normalize('/' + urlPath));
  return p === root || p.startsWith(root + path.sep) ? p : null;
}
/** a file of the game (GAME_ENTRIES) under DATA that a URL path names, or null */
function resolveGame(urlPath) {
  const first = urlPath.split('/').find(Boolean);
  return first && gameEntry(first) ? resolveInside(DATA, urlPath) : null;
}
const realRoots = new Map();
/** the real path of p if it is still inside root once symbolic links are followed */
async function realInside(root, p) {
  let rr = realRoots.get(root);
  if (!rr) { try { rr = await fsp.realpath(root); } catch { return null; } realRoots.set(root, rr); }
  let rp; try { rp = await fsp.realpath(p); } catch { return null; }
  return rp.startsWith(rr + path.sep) ? rp : null;
}

/** the regular file under root that file names (null: none, or it leads outside root or into the state folder): { real, st } */
async function locate(root, file) {
  const real = file && await realInside(root, file);
  if (!real || within(real, REAL_STATE)) return null;
  let st;
  try { st = await fsp.stat(real); } catch { return null; }
  return st.isFile() ? { real, st } : null;
}

async function sendFile(q, s, root, file, { type, cache = 'store', extra = {}, found = null } = {}) {
  const f = found ?? await locate(root, file);
  if (!f) return notFound(q, s);
  const { real, st } = f;
  const etag = etagOf(real, st.size, st.mtimeMs);
  const h = headers(q, { 'content-type': type ?? TYPES[path.extname(real).toLowerCase()] ?? 'application/octet-stream',
    'accept-ranges': 'bytes', etag, ...extra }, cache);
  if (etagMatches(q.headers['if-none-match'], etag)) { s.writeHead(304, h); return s.end(); }
  // one range (bytes=a-b, a-, -n); anything else is answered with the whole file
  const range = q.headers.range && /^bytes=(\d*)-(\d*)$/.exec(String(q.headers.range).trim());
  let a = 0, b = st.size - 1, code = 200;
  if (range && !(range[1] === '' && range[2] === '')) {
    a = range[1] === '' ? Math.max(0, st.size - +range[2]) : +range[1];
    b = range[1] === '' || range[2] === '' ? st.size - 1 : Math.min(+range[2], st.size - 1);
    if (a > b || a >= st.size) { s.writeHead(416, { ...h, 'content-range': `bytes */${st.size}`, 'content-length': 0 }); return s.end(); }
    code = 206; h['content-range'] = `bytes ${a}-${b}/${st.size}`;
  }
  s.writeHead(code, { ...h, 'content-length': st.size ? b - a + 1 : 0 });
  if (q.method === 'HEAD' || !st.size) return s.end();
  const flow = mustFlow(s);
  // the open file lives as long as the answer and the connection: an answer still queued behind another on
  // its connection gets no 'close' of its own when the client goes (without this, a client that queued
  // thousands of requests and left kept as many files open, for good)
  const conn = q.socket;
  if (!conn || conn.destroyed) return;
  const rs = fs.createReadStream(real, { start: a, end: b });
  rs.on('data', c => { flow.bytes += c.length; });
  const stop = () => rs.destroy();
  rs.on('error', () => s.destroy());
  s.once('close', stop);
  conn.once('close', stop);
  rs.once('close', () => { s.off('close', stop); conn.off('close', stop); });
  rs.pipe(s);
}

// A response that does not move is let go: fewer than progressBytes in progressMs, or longer than
// responseMaxMs in all.  (A client that stopped reading kept its download, and the connection, for good:
// Node's socket timeout does not fire while a write waits, and a trickle of 1 KB every 30 s resets it.
// Together with the per-client budgets this keeps one client from holding the server's connections.)
const flowing = new Set();
let flowCuts = 0;
function mustFlow(s) {
  const now = Date.now(), f = { s, bytes: 0, mark: 0, at: now, t0: now };
  flowing.add(f);
  const done = () => flowing.delete(f);
  s.once('finish', done); s.once('close', done);
  return f;
}
setInterval(() => {
  const now = Date.now();
  for (const f of flowing) {
    if (f.bytes - f.mark >= LIMITS.progressBytes) { f.mark = f.bytes; f.at = now; }
    if (now - f.at > LIMITS.progressMs || now - f.t0 > LIMITS.responseMaxMs) { flowing.delete(f); flowCuts++; f.s.destroy(); }
  }
}, 2_500).unref();

// a test artifact (frame dump) from a page on this machine (--dev --artifacts only)
async function putArtifact(q, s, name) {
  const local = /^(127\.\d+\.\d+\.\d+|::1)$/.test(bareIp(q.socket.remoteAddress)) && !q.headers['x-forwarded-for'] && !q.headers['cf-connecting-ip'];
  if (!local || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}\.png$/.test(name)) return plain(q, s, 403, 'Forbidden');
  if (+(q.headers['content-length'] ?? 0) > LIMITS.artifactBytes) return plain(q, s, 413, 'Too large', { connection: 'close' });
  const parts = []; let n = 0;
  for await (const c of q) { n += c.length; if (n > LIMITS.artifactBytes) return plain(q, s, 413, 'Too large', { connection: 'close' }); parts.push(c); }
  await fsp.writeFile(path.join(ARTIFACTS, name), Buffer.concat(parts));
  s.writeHead(201, headers(q, { 'content-length': 0 })); s.end();
}

// game.wasm, brotli-compressed once per build (kept in memory, ~7 MB; quality
// 5 takes about half a second for the 65 MB module and is within a few
// percent of the best ratio for it)
let wasmBr = null;
// A large shared buffer (the brotli module, ~7 MB) to one client in 64 KB
// slices with backpressure.  s.end(buffer) would hand the whole buffer to the
// socket at once, and on TLS Node encrypts all of it into that connection's
// own memory: a client that asks and never reads costs ~6 MB each (the
// phase-3 secfix review measured +400 MB for 64 such connections).
function sendShared(s, buf, slice = 64 << 10) {
  let off = 0;
  const flow = mustFlow(s);
  const pump = () => {
    while (off < buf.length) {
      const end = Math.min(buf.length, off + slice);
      const more = s.write(buf.subarray(off, end));
      flow.bytes += end - off;
      off = end;
      if (!more) return;                    // wait for 'drain'
    }
    s.off('drain', pump);
    s.end();
  };
  s.on('drain', pump);
  s.on('close', () => { off = buf.length; s.off('drain', pump); });
  pump();
}

async function compressedWasm() {
  let st; try { st = await fsp.stat(WASM); } catch { return null; }
  const etag = etagOf('br', WASM, st.size, st.mtimeMs);
  if (wasmBr && wasmBr.etag === etag) return wasmBr.pending ?? wasmBr;
  const entry = { etag, body: null, pending: null };
  wasmBr = entry;
  entry.pending = (async () => {
    const raw = await fsp.readFile(WASM);
    const t0 = Date.now();
    entry.body = await new Promise((res, rej) => zlib.brotliCompress(raw, { params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }, (e, b) => e ? rej(e) : res(b)));
    console.log(`game.wasm compressed for the network: ${(raw.length / 1048576).toFixed(1)} MB -> ${(entry.body.length / 1048576).toFixed(1)} MB in ${Date.now() - t0} ms`);
    entry.pending = null;
    return entry;
  })().catch(e => { console.error('game.wasm compression failed:', e.message); wasmBr = null; return null; });
  return entry.pending;
}

// ---- routes ----
async function handler(q, s) {
  // HTTP/1.1 needs a Host (checked here, not by Node, so the answer has our headers)
  if (!q.headers.host && q.httpVersion !== '1.0') return plain(q, s, 400, 'Bad request', { connection: 'close' });
  // only this server's own names (DNS rebinding, scanners on the bare address): before anything else
  if (!ownHost(q)) return plain(q, s, 421, 'Misdirected request', { connection: 'close' });
  let u, p;
  try {
    // a path ("/x", origin form) is read as a path, never as "//host/path"; an absolute URL as itself
    u = new URL(q.url.startsWith('/') ? 'http://x' + q.url : q.url);
    // no encoded separator and, once decoded, no empty segment: every route compares the path it
    // sees, and a later normalisation that merged "//" or turned %2f into "/" would hand a file a
    // different path than the one checked (the phase-2 deploy review's /%2ftest/... finding)
    if (/%(2f|5c)/i.test(u.pathname)) throw new Error('separator');
    p = decodeURIComponent(u.pathname);
  } catch { return plain(q, s, 400, 'Bad request'); }
  if (/[\x00-\x1f\x7f\\]/.test(p) || p.includes('//')) return plain(q, s, 400, 'Bad request');
  if (q.method === 'PUT' && DEV && ARTIFACTS && p.startsWith('/artifacts/')) return putArtifact(q, s, p.slice(11));
  if (q.method !== 'GET' && q.method !== 'HEAD') return plain(q, s, 405, 'Method not allowed', { allow: 'GET, HEAD', connection: 'close' });
  // nothing here takes a request body
  if (+(q.headers['content-length'] ?? 0) > 0 || q.headers['transfer-encoding']) return plain(q, s, 413, 'Too large', { connection: 'close' });
  if (p === '/data-manifest') {
    if (!manifest || (u.searchParams.has('refresh') && Date.now() - manifestAt > 10_000)) await refreshManifest();
    const gz = /\bgzip\b/.test(q.headers['accept-encoding'] || '');
    const h = headers(q, { 'content-type': 'application/json', etag: manifest.etag, vary: 'accept-encoding' }, 'revalidate');
    if (etagMatches(q.headers['if-none-match'], manifest.etag)) { s.writeHead(304, h); return s.end(); }
    const body = gz ? manifest.gz : manifest.body;
    s.writeHead(200, { ...h, 'content-length': Buffer.byteLength(body), ...(gz ? { 'content-encoding': 'gzip' } : {}) });
    return s.end(q.method === 'HEAD' ? undefined : body);
  }
  // the game's files are bytes for the game, whatever their names say
  if (p.startsWith('/data/')) return sendFile(q, s, DATA, resolveGame(p.slice(5)), { type: 'application/octet-stream' });
  if (p === '/game.wasm') {
    // 65 MB of code compresses to ~7 MB: other PCs start much sooner
    if (!q.headers.range && /\bbr\b/.test(q.headers['accept-encoding'] || '')) {
      const c = await compressedWasm();
      if (c) {
        const h = headers(q, { 'content-type': TYPES['.wasm'], etag: c.etag, vary: 'accept-encoding' }, 'revalidate');
        if (etagMatches(q.headers['if-none-match'], c.etag)) { s.writeHead(304, h); return s.end(); }
        s.writeHead(200, { ...h, 'content-encoding': 'br', 'content-length': c.body.length });
        if (q.method === 'HEAD') return s.end();
        return sendShared(s, c.body);
      }
    }
    return sendFile(q, s, path.dirname(WASM), WASM, { cache: 'revalidate', extra: { vary: 'accept-encoding' } });
  }
  if (p === '/game.json') return sendFile(q, s, path.dirname(GAME_JSON), GAME_JSON);
  if (p === '/robots.txt') return plain(q, s, 200, 'User-agent: *\nDisallow: /');
  if (p === '/players') {
    // how many play on this server now (the start page's Multiplayer settings): two counts and nothing else, no
    // names, addresses or times; online: in the game's Online mode (logged in, or racing an online race), null
    // with --online off
    const o = online?.info(), players = lan.peers.size;
    const body = JSON.stringify({ players, online: o ? Math.min(players, o.personas + o.racing) : null });
    s.writeHead(200, headers(q, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }));
    return s.end(q.method === 'HEAD' ? undefined : body);
  }
  // test aids (--dev only): the repo's test scripts, and the test pages and source maps from their own
  // folder (web/dist-dev), which the server never looks in without --dev
  if (DEV && p.startsWith('/tests/')) return sendFile(q, s, TESTS, resolveInside(TESTS, p.slice(6)));
  // a second guard, for a web/dist that an older build left test pages or maps in: their names, compared
  // the way a case-insensitive disk does (NFKC folds "ſ" to "s", "K" to "k")
  if (!DEV && devOnly(p)) return notFound(q, s);
  const rel = p.endsWith('/') ? p + 'index.html' : p;
  let root = DIST, found = await locate(DIST, resolveInside(DIST, rel));
  if (!found && DEV) { root = DEV_DIST; found = await locate(DEV_DIST, resolveInside(DEV_DIST, rel)); }
  return sendFile(q, s, root, null, { found, cache: rel.endsWith('.html') ? 'store' : 'revalidate' });
}
const TESTS = path.join(REPO, 'tests');
const devOnly = p => { const n = p.normalize('NFKC').toLowerCase(); return /^\/tests?(\/|$)/.test(n) || n.endsWith('.map'); };

function accessLog(q, s, ip, key) {
  if (!ACCESS_LOG) return;
  const t0 = Date.now();
  // the opt-in that names client addresses; a page loads its game data in thousands of requests: plenty for
  // one client, not a flood
  s.on('finish', () => logLimited('http', 'requests', key, `[http] ${ip || '?'} ${printable(q.method, 8)} ${printable(q.url)} ${s.statusCode} ${Date.now() - t0} ms`, 3000));
}
// The names this server answers for (see the top of this file); a --tls-cert's are read from the certificate.
const hostCheck = makeHostCheck(HOSTS);
/** the request's Host (and an absolute-form URL's host) is one of this server's names */
function ownHost(q) {
  if (!hostCheck(q.headers.host)) return false;
  if (!q.url.startsWith('/')) { try { if (!hostCheck(new URL(q.url).host)) return false; } catch { return false; } }
  return true;
}
// requests in progress per client and site (requestsPerClient, requestsPerSite), of maxConnections in all
const requests = new Budget(LIMITS.requestsPerClient, LIMITS.requestsPerSite, LIMITS.maxConnections, LIMITS.freeShare);
const kQueued = Symbol('queued');
const onReq = (q, s) => {
  // requests on one connection that have no finished answer yet: browsers and proxies send one at a time,
  // and each queued answer may hold an open file and its first buffer (a client that queued thousands made
  // the server hold gigabytes and as many open files): past a few, the connection goes
  const conn = q.socket;
  conn[kQueued] = (conn[kQueued] ?? 0) + 1;
  if (conn[kQueued] > LIMITS.pipelined) return conn.destroy();
  let done = false;
  const finished = () => { if (!done) { done = true; conn[kQueued]--; } };
  s.once('finish', finished); s.once('close', finished);
  // with Cloudflare's proxy in front, the long keep-alive is for the proxies' connections: any other peer
  // gets the usual one (Node arms the keep-alive time when the answer is finished; this runs just after)
  if (trust.cloudflare && !trust(conn.remoteAddress)) {
    // and is told so: Node would advertise the server-wide (Cloudflare) time
    s.setHeader('Keep-Alive', `timeout=${Math.floor(LIMITS.keepAliveTimeout / 1000)}`);
    s.once('finish', () => { if (!conn.destroyed) conn.setTimeout(LIMITS.keepAliveTimeout); });
  }
  const ip = clientIp(q, trust, REAL_IP), key = addressKey(ip), site = siteKey(ip);
  if (!requests.take(key, site)) {
    logLimited('http', 'refused requests', key, `[http] refused a request: ${requests.held(key)} in progress already from that client`, 2);
    return plain(q, s, 429, 'Too many requests', { connection: 'close', 'retry-after': '1' });
  }
  let counted = true;
  const uncount = () => { if (counted) { counted = false; requests.give(key, site); } };
  s.once('finish', uncount); s.once('close', uncount);
  accessLog(q, s, ip, key);
  handler(q, s).catch(e => {
    // the details stay on this console; the client gets a plain 500
    console.error(`[error] ${printable(q.method, 8)} ${printable(q.url, 96)}: ${e?.stack || e}`);
    try { if (!s.headersSent) plain(q, s, 500, 'Server error'); else s.destroy(); } catch { /* gone */ }
  });
};

// ---- /lan ----
const trace = ONLINE_TRACE ? new LobbyTrace(ONLINE_TRACE) : null;
// the lines a client causes in Online mode (logins, games, races, friends) count against that client's share of
// the console, as its joins and refusals do (the Online audit's ONL-8)
const online = ONLINE === 'on' ? new OnlineHost({ tap: trace ? f => trace.frame(f) : null, stateDir: path.join(STATE, 'online'),
  log: (line, key) => key == null ? console.log(line) : logLimited('online', 'Online lines', key, line, 30) }) : null;
// the switch's addresses outlive a restart (by the hashes of their tokens, lan.mjs): the players come back to them
const LAN_STORE = path.join(STATE, 'lan-addresses.json');
const roamHub = ROAM_HUB === 'on' ? new RoamHub() : null;
const lan = new LanSwitch({ maxPeers: MAX_PEERS, impair: DEV ? LAN_IMPAIR : '', online, roam: roamHub, tap: trace ? f => trace.frame(f) : null, store: {
  load: () => JSON.parse(fs.readFileSync(LAN_STORE, 'utf8')),
  save: list => { fs.writeFileSync(LAN_STORE + '.tmp', JSON.stringify(list), { mode: 0o600 }); fs.renameSync(LAN_STORE + '.tmp', LAN_STORE); },
} });
const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.wsMaxPayload, perMessageDeflate: false, clientTracking: false,
  ...LAN_WSS_OPTIONS });
// a handshake the ws library itself refuses (a malformed Sec-WebSocket-Protocol, ...): our answer, not its own
// (which had none of the security headers and named the library)
wss.on('wsClientError', (e, sock) => refuseSocket(sock, 400));
const lanConns = new Budget(LIMITS.wsPerAddress, LIMITS.wsPerSite);
const lanOpens = new Rate(LIMITS.lanOpenBurst, LIMITS.lanOpenRate);
function onUpgrade(q, sock, head) {
  sock.on('error', () => {});
  let u; try { u = new URL(q.url.startsWith('/') ? 'http://x' + q.url : q.url); } catch { return refuseSocket(sock, 400); }
  if (!ownHost(q)) return refuseSocket(sock, 421);
  if (u.pathname !== '/lan') return refuseSocket(sock, 404);
  // a WebSocket handshake, checked here so that every refusal looks the same
  if (q.method !== 'GET' || String(q.headers.upgrade).toLowerCase() !== 'websocket' || q.headers['sec-websocket-version'] !== '13' ||
      !/^[+/0-9A-Za-z]{22}==$/.test(String(q.headers['sec-websocket-key'] ?? ''))) return refuseSocket(sock, 400);
  // only this server's own pages (a page of another site must not join the LAN
  // through a player's browser): the page's origin is the host it asked for,
  // and one of this server's names; clients without an Origin header (tools) may
  let origin = null;
  try { origin = q.headers.origin ? new URL(q.headers.origin).host.toLowerCase() : null; } catch { return refuseSocket(sock, 403); }
  const hosts = [String(q.headers.host ?? '').toLowerCase(), forwardedHost(q, trust)].filter(Boolean);
  if (origin !== null && (!hosts.includes(origin) || !hostCheck(origin))) return refuseSocket(sock, 403);
  const ip = clientIp(q, trust, REAL_IP), key = addressKey(ip), site = siteKey(ip);
  // the console names players by their virtual address and nickname, never by their real address (a VPS's journal
  // keeps it); --access-log is the one opt-in that records addresses
  if (!lanConns.take(key, site)) {
    logLimited('lan', 'refused connections', key, `[lan] refused a connection: ${lanConns.held(key)} already open from that address`, 2);
    return refuseSocket(sock, 429);
  }
  let released = false;
  const release = () => { if (!released) { released = true; lanConns.give(key, site); } };
  sock.once('close', release);
  if (!lanOpens.take(key, site)) {
    logLimited('lan', 'refused connections', key, '[lan] refused a connection: that address opens them too fast', 2);
    return refuseSocket(sock, 429);
  }
  wss.handleUpgrade(q, sock, head, ws => {
    // a reconnecting page says ?resume and sends its old address with the token in its first message
    // (lan.mjs); the group and site ids stand for the client's address without naming it (the shared limits)
    lan.attach(ws, null, { resume: u.searchParams.has('resume'), group: groupId(key), site: site ? groupId('site ' + site) : null,
      onJoin: (vip, resumed) => logLimited('lan', 'joins and leaves', key, `[lan] ${vipStr(vip)} ${resumed ? 'is back' : 'joined'} (${lan.peers.size} on the switch)`, 20),
      onLeave: (vip, name) => logLimited('lan', 'joins and leaves', key, `[lan] ${vipStr(vip)} "${printable(name, 32)}" left (${lan.peers.size} on the switch)`, 20) });
  });
}
const GROUP_KEY = crypto.randomBytes(32);
const groupId = key => crypto.createHmac('sha256', GROUP_KEY).update(key).digest('base64url').slice(0, 22);

// ---- listening ----
// connections at once per client and site, for TCP peers that are not trusted proxies (a proxy carries many
// clients); counted from the first byte, before any TLS, so stalled handshakes count too
const conns = new Budget(LIMITS.connsPerAddress, LIMITS.connsPerSite, LIMITS.maxConnections, LIMITS.freeShare);
function admit(sock) {
  const ip = bareIp(sock.remoteAddress);
  if (!ip) return sock.destroy();
  if (trust(ip)) return;
  const key = addressKey(ip), site = siteKey(ip);
  if (!conns.take(key, site)) return sock.destroy();
  sock.once('close', () => conns.give(key, site));
}
// an error before or instead of an HTTP request.  A request Node could not read (an HPE_ parser error, a
// header or request timeout) gets a short answer with this server's headers, then the connection goes.
// Anything else (a TLS handshake that failed or timed out, a reset) has no HTTP to answer with: the
// connection goes at once.  (Writing an HTTP answer into a TLS socket whose handshake never finished queued
// it there for good, and the socket with it: 1024 such sockets locked the port, the phase-2 deploy review's
// finding 2.)
function onClientError(e, sock) {
  const code = e?.code === 'HPE_HEADER_OVERFLOW' ? 431 : e?.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? 408
    : String(e?.code ?? '').startsWith('HPE_') ? 400 : 0;
  if (!code || !sock.writable) return sock.destroy();
  refuseSocket(sock, code);
}
function harden(srv) {
  srv.keepAliveTimeout = trust.cloudflare ? LIMITS.keepAliveCloudflare : LIMITS.keepAliveTimeout;
  srv.maxConnections = LIMITS.maxConnections;
  srv.setTimeout(LIMITS.socketIdle);
  srv.prependListener('connection', admit);
  srv.on('clientError', onClientError);
  srv.on('upgrade', onUpgrade);
  // Expect: anything but 100-continue (Node would answer 417 itself)
  srv.on('checkExpectation', (q, s) => plain(q, s, 417, 'Expectation failed', { connection: 'close' }));
  return srv;
}
/** listen on port at host; a default "::" falls back to IPv4 alone on a machine without IPv6 */
function listen(srv, port, host, fallback = null) {
  return new Promise(res => {
    srv.once('error', e => {
      if (fallback && ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EINVAL'].includes(e.code)) return res(listen(srv, port, fallback));
      die(`cannot listen: ${e.code === 'EADDRINUSE' ? `port ${port} is in use` : e.message}`);
    });
    srv.listen(port, host, () => {
      srv.removeAllListeners('error');
      srv.on('error', e => die(`server error: ${e.message}`));
      res(host);
    });
  });
}
const serverOptions = { maxHeaderSize: LIMITS.maxHeaderSize, headersTimeout: LIMITS.headersTimeout, requestTimeout: LIMITS.requestTimeout,
  connectionsCheckingInterval: 5_000, requireHostHeader: false };
// A --tls-cert certificate: its names (SAN), for the Host check and the handshake.  The TLS handshake goes
// through only for a server name (SNI) the certificate covers, so a scanner that connects to the bare address,
// or asks for any other name, never sees the certificate or the domain in it (the audit's F4); a certificate
// for an IP address is shown without SNI too (that is how browsers ask for an IP).
function certNames(pem) {
  const x = new crypto.X509Certificate(pem);
  const dns = [], ips = [];
  for (const part of String(x.subjectAltName ?? '').split(/,\s*/)) {
    if (part.startsWith('DNS:')) dns.push(part.slice(4).toLowerCase());
    else if (part.startsWith('IP Address:')) { const ip = bareIp(part.slice(11)); if (ip) ips.push(ip); }
  }
  return { dns, ips };
}
let certCtx = null, certDns = [];
function loadCert() {
  const key = fs.readFileSync(TLS_KEY), cert = fs.readFileSync(TLS_CERT);
  const n = certNames(cert);
  if (!n.dns.length && !n.ips.length) throw new Error(`${TLS_CERT} names no host (no subjectAltName)`);
  certCtx = tls.createSecureContext({ key, cert, minVersion: 'TLSv1.2' });
  certDns = n.dns;
  hostCheck.setCertNames([...n.dns, ...n.ips]);
  return { key, cert, ips: n.ips };
}
const sniMatch = (name, list) => list.some(d => d === name || (d.startsWith('*.') && name.endsWith(d.slice(1)) && !name.slice(0, -(d.length - 1)).includes('.')));
function sniCallback(servername, cb) {
  const n = String(servername ?? '').toLowerCase().replace(/\.$/, '');
  if (certCtx && sniMatch(n, certDns)) return cb(null, certCtx);
  cb(new Error('not a name of this server'));
}
let tlsFiles = null;
if (TLS === 'cert') {
  let first;
  try { first = loadCert(); } catch (e) { die(`the certificate files cannot be used: ${e.message}`); }
  // the default (no SNI) only for a certificate that names an address; otherwise none, and such a handshake fails
  tlsFiles = { SNICallback: sniCallback, ...(first.ips.length ? { key: first.key, cert: first.cert } : {}) };
}
const servers = [];
let boundTo = BIND;
if (tlsFiles) {
  const srv = harden(https.createServer({ ...serverOptions, ...tlsFiles, minVersion: 'TLSv1.2', handshakeTimeout: LIMITS.handshakeTimeout }, onReq));
  boundTo = await listen(srv, HTTPS_PORT, BIND, BIND_SET ? null : '0.0.0.0');
  servers.push(srv);
  // a renewed certificate (certbot, a new Origin CA certificate) is picked up without a restart
  const reload = () => {
    try {
      const c = loadCert();
      if (c.ips.length) srv.setSecureContext({ key: c.key, cert: c.cert, minVersion: 'TLSv1.2' });
      console.log('certificate reloaded');
    } catch (e) { console.error(`certificate not reloaded: ${e.message}`); }
  };
  fs.watchFile(TLS_CERT, { interval: 60_000, persistent: false }, (cur, prev) => { if (cur.mtimeMs !== prev.mtimeMs) reload(); });
  process.on('SIGHUP', reload);
}
if (HTTP_PORT) { const srv = harden(http.createServer(serverOptions, onReq)); await listen(srv, HTTP_PORT, '127.0.0.1'); servers.push(srv); }
await buildManifest();
void compressedWasm();                     // ready before the first player asks

function stop() {
  lan.stop();
  trace?.close();
  for (const srv of servers) { srv.close(); srv.closeAllConnections?.(); }
  setTimeout(() => process.exit(0), 200).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

const here = process.platform === 'darwin' ? 'this Mac' : 'this host';
const lines = [
  'NFSU2 web server',
  `  game data : ${DATA} (${manifest.count} entries of the game's own)`,
  `  game.wasm : ${fs.existsSync(WASM) ? WASM : WASM + '  (missing: run web/build.sh)'}`,
  `  ${here.padEnd(10)}: ${HTTP_PORT ? `http://localhost:${HTTP_PORT}/` : '(no local HTTP port)'}${TLS === 'proxy' ? '  (the proxy forwards here)' : ''}`,
  TLS === 'none' ? '  other PCs : none: they need HTTPS, from --tls-cert/--tls-key or a proxy or tunnel in front (docs/web/VPS.md)' : null,
  TLS === 'cert' ? `  HTTPS     : port ${HTTPS_PORT} on ${boundTo === '::' ? ':: (IPv6 and IPv4)' : boundTo}, certificate ${TLS_CERT}` : null,
  TLS === 'proxy' ? '  TLS       : done by the proxy or tunnel in front (it forwards to the address above, WebSockets included)' : null,
  `  proxies   : this machine${trust.entries.length ? ', ' + trust.entries.join(', ') : ''} (client address from ${REAL_IP})`,
  `  names     : ${[...new Set(['localhost', ...hostCheck.names()])].join(', ')} (other Host names get 421)`,
  `  switch    : at most ${MAX_PEERS} players`,
  `  free roam : ${roamHub ? 'the hub at 10.77.0.253 on the switch links each player to the 7 nearest (--roam-hub off: groups of 8 by broadcast)' : 'no hub (--roam-hub off): players find each other by broadcast, groups of 8'}`,
  `  online    : ${online ? `the game's Online mode at 10.77.0.1 on the switch (any name logs in; race results per persona in ${path.join(STATE, 'online')})` : 'off (--online off)'}`,
  ONLINE_TRACE ? `  trace     : lobby messages (secrets redacted) into ${ONLINE_TRACE}` : null,
  DEV ? `  dev       : test pages (/test/), test scripts (/tests/), source maps${ARTIFACTS ? `, PUT /artifacts/<name>.png into ${ARTIFACTS}` : ''}` : null,
  '  access    : none: whoever reaches this server may play (the firewall decides who that is)',
].filter(Boolean);
console.log(lines.join('\n'));
