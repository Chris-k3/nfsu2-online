// What every response of the server carries, and who the client is.
//
//   securityHeaders()  cross-origin isolation (COOP/COEP/CORP, which the game
//                      needs for SharedArrayBuffer), a Content-Security-Policy,
//                      nosniff, no referrer, no framing, a Permissions-Policy
//                      with only what the game uses, noindex, and HSTS when
//                      the server asks for it (see server.mjs)
//   pickEncoding()     the Content-Encoding for an Accept-Encoding header
//   cacheHeaders()     no shared cache (a reverse proxy, Cloudflare's edge)
//                      ever keeps a response; the browser keeps only what it
//                      revalidates (the game module, the page's scripts)
//   makeProxyTrust()   which TCP peers are proxies whose CF-Connecting-IP /
//                      X-Forwarded-* headers are believed (only those)
//   clientIp(), viaHttps(), forwardedHost(), addressKey(), siteKey()
//   makeHostCheck()    the names the server answers for (Host, Origin)
//
// There is no access control here on purpose: whoever can reach the server
// may play, and the firewall in front of it decides who that is.  The client
// address is used for the server's own console and its per-address limits only.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- Content-Security-Policy ---------------------------------------------------
// Everything comes from this origin.  WebAssembly needs 'wasm-unsafe-eval'
// (compiling the module, in the page and in its workers, whose scripts carry
// this header too).  'self' covers the module workers, the audio worklet and
// the /lan WebSocket (CSP 3: ws: and wss: to this host).  Images: the favicon
// is a data: URL; screenshots in the Saves panel may be blob: URLs.  No inline
// script or style, except where a page lists the hashes of its own.
export function contentSecurityPolicy({ scriptHashes = [], styleHashes = [] } = {}) {
  const h = a => a.map(x => ` '${x}'`).join('');
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval'${h(scriptHashes)}`,
    "worker-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data: blob:",
    `style-src 'self'${h(styleHashes)}`,
    "font-src 'self'",
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
export const sha256Source = text => 'sha256-' + crypto.createHash('sha256').update(text, 'utf8').digest('base64');

// Only what the game uses: game controllers, full screen, the keyboard layout
// (key names in the settings; Keyboard Lock itself has no policy and needs
// full screen), and sound without a click first.  The rest is switched off for
// this page and anything it could embed.
export const PERMISSIONS_POLICY = [
  'gamepad=(self)', 'fullscreen=(self)', 'keyboard-map=(self)', 'autoplay=(self)', 'cross-origin-isolated=(self)',
  'accelerometer=()', 'bluetooth=()', 'browsing-topics=()', 'camera=()', 'clipboard-read=()', 'display-capture=()',
  'encrypted-media=()', 'geolocation=()', 'gyroscope=()', 'hid=()', 'idle-detection=()', 'local-fonts=()',
  'magnetometer=()', 'microphone=()', 'midi=()', 'payment=()', 'publickey-credentials-get=()', 'screen-wake-lock=()',
  'serial=()', 'usb=()', 'window-management=()', 'xr-spatial-tracking=()',
].join(', ');

export const ISOLATION = Object.freeze({
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
});

export const CSP = contentSecurityPolicy();
export const HSTS = 'max-age=31536000';
/** The headers every response carries. */
export function securityHeaders({ hsts = false, csp = CSP, noindex = true } = {}) {
  return {
    ...ISOLATION,
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'permissions-policy': PERMISSIONS_POLICY,
    'x-robots-tag': noindex ? 'noindex, nofollow' : 'index, follow',
    ...(hsts ? { 'strict-transport-security': HSTS } : {}),
  };
}

// ---- caching -------------------------------------------------------------------
// Shared caches keep nothing: 'private' says so to every cache, and
// CDN-Cache-Control / Cloudflare-CDN-Cache-Control speak to the CDN alone.
// Two exceptions: a run of the game data whose address names the file's
// version may stay at the CDN for good (server.mjs sendBlocks, EDGE_KEEP),
// and so may the module at the address that names its content ('immutable').
// no-transform: a proxy hands the bytes on as they are (the brotli module, the
// byte ranges of the game files).  The browser keeps nothing ('store'), or
// keeps a copy it must revalidate each time ('revalidate': the page's scripts,
// which 25 workers load).  'immutable': an address that names its content (the
// game module's /game.wasm?v=<hash>), which every cache, the CDN's too, keeps
// for good: a start reads the 65 MB module and Chrome's compiled code for it
// from the disk cache without asking, and a new build is a new address.
export const EDGE_KEEP = 'public, max-age=31536000, immutable';
export function cacheHeaders(kind = 'store') {
  if (kind === 'immutable') return { 'cache-control': EDGE_KEEP + ', no-transform', 'cdn-cache-control': EDGE_KEEP, 'cloudflare-cdn-cache-control': EDGE_KEEP };
  return {
    'cache-control': kind === 'revalidate' ? 'private, no-cache, no-transform' : 'private, no-store, no-transform',
    'cdn-cache-control': 'no-store',
    'cloudflare-cdn-cache-control': 'no-store',
  };
}

/** Of the encodings the server has (in its order of preference), the first that an Accept-Encoding header takes
 *  (a q=0 refuses one; "*" is not read as taking any), or null. */
export function pickEncoding(header, have) {
  const ok = new Set();
  for (const part of String(header ?? '').toLowerCase().split(',')) {
    const [name, ...params] = part.split(';').map(x => x.trim());
    if (!params.some(x => /^q=0(\.0{0,3})?$/.test(x.replace(/\s+/g, '')))) ok.add(name);
  }
  return have.find(e => ok.has(e)) ?? null;
}

/** If-None-Match against an ETag, as a browser or a proxy (which may make it weak) sends it */
export function etagMatches(header, etag) {
  if (!header) return false;
  const bare = etag.replace(/^W\//, '');
  return String(header).split(',').some(t => { t = t.trim(); return t === '*' || t.replace(/^W\//, '') === bare; });
}

// ---- proxies -------------------------------------------------------------------
/** Cloudflare's published ranges (cloudflare-ips.txt next to this file) */
export function cloudflareRanges(file = path.join(HERE, 'cloudflare-ips.txt')) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map(l => l.replace(/#.*/, '').trim()).filter(Boolean);
}
const LOOPBACK = ['127.0.0.0/8', '::1/128'];

/** "::ffff:1.2.3.4" -> "1.2.3.4", "[::1]" -> "::1", "fe80::1%en0" -> "fe80::1"; '' if not an address */
export function bareIp(a) {
  let s = String(a ?? '').trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const pct = s.indexOf('%'); if (pct > 0) s = s.slice(0, pct);
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (m) s = m[1];
  return net.isIP(s) ? s.toLowerCase() : '';
}
const family = ip => (net.isIPv4(ip) ? 'ipv4' : 'ipv6');

/** an IPv6 address's first four groups (64 bits) as numbers */
function head64(a) {
  const [head, tail] = a.includes('::') ? a.split('::') : [a, null];
  const hs = head ? head.split(':') : [];
  const ts = tail ? tail.split(':') : [];
  // a dotted IPv4 tail counts as two groups
  const width = g => (g.includes('.') ? 2 : 1);
  const used = [...hs, ...ts].reduce((n, g) => n + width(g), 0);
  const groups = tail === null ? hs : [...hs, ...Array(8 - used).fill('0'), ...ts];
  return groups.slice(0, 4).map(x => parseInt(x, 16) || 0);
}
/**
 * What the per-address limits count by: an IPv4 address, or an IPv6 address's
 * /56 (a home or a VPS gets a /64 at least and often a /56, so counting single
 * IPv6 addresses, or /64s, would give one client 2^64, or 256, budgets).
 */
export function addressKey(ip) {
  const a = bareIp(ip);
  if (!net.isIPv6(a)) return a;
  const g = head64(a);
  g[3] &= 0xff00;
  return g.map(x => x.toString(16)).join(':') + '::/56';
}
/**
 * The wider group the limits also count by: an IPv6 address's /48 (one site,
 * or one free tunnel-broker allocation: 256 /56s, which would otherwise be 256
 * budgets for one client); '' for IPv4 (an address is its own group).
 */
export function siteKey(ip) {
  const a = bareIp(ip);
  if (!net.isIPv6(a)) return '';
  return head64(a).slice(0, 3).map(x => x.toString(16)).join(':') + '::/48';
}

// ---- the server's own names ------------------------------------------------------
const canon6 = s => { try { return new URL(`http://[${s}]/`).hostname.slice(1, -1); } catch { return ''; } };
/**
 * The host of a Host header or an Origin ("name", "name:port", "[v6]:port",
 * an IPv4 literal): lower case, without the port, brackets or a trailing dot;
 * '' when it is none of these.
 */
export function hostName(h) {
  let s = String(h ?? '').trim().toLowerCase();
  if (!s) return '';
  if (s.startsWith('[')) {
    const e = s.indexOf(']');
    if (e < 0 || !/^(:\d{1,5})?$/.test(s.slice(e + 1))) return '';
    return net.isIPv6(s.slice(1, e)) ? canon6(s.slice(1, e)) : '';
  }
  if (net.isIPv6(s)) return canon6(s);
  const m = /^([^:]+)(?::\d{1,5})?$/.exec(s);
  if (!m) return '';
  s = m[1].replace(/\.$/, '');
  if (net.isIPv4(s)) return s;
  return /^[a-z0-9_]([a-z0-9_-]{0,62})(\.[a-z0-9_]([a-z0-9_-]{0,62}))*$/.test(s) ? s : '';
}
const isLoopbackName = n => n === 'localhost' || n === '::1' || (net.isIPv4(n) && n.startsWith('127.'));
/**
 * check(hostHeader) -> the host is one of the server's own names: this machine
 * (localhost, 127.0.0.0/8, ::1) always, the given names (exact, or "*.zone"
 * for one label under zone), and the names of its certificate
 * (check.setCertNames(list), replaced when the certificate is).
 */
export function makeHostCheck(names = []) {
  let exact = new Set(), wild = [];
  const fixed = names.map(n => String(n).toLowerCase());
  const build = (cert) => {
    exact = new Set(); wild = [];
    for (const n of [...fixed, ...cert]) {
      if (n.startsWith('*.')) wild.push(n.slice(1));             // ".zone"
      else { const h = hostName(n.includes(':') && !n.startsWith('[') && net.isIPv6(n) ? `[${n}]` : n); if (h) exact.add(h); }
    }
  };
  build([]);
  const check = h => {
    const n = hostName(h);
    if (!n) return false;
    if (isLoopbackName(n) || exact.has(n)) return true;
    return wild.some(w => n.endsWith(w) && n.length > w.length && !n.slice(0, -w.length).includes('.'));
  };
  check.setCertNames = list => build(list.map(n => String(n).toLowerCase()));
  check.names = () => [...exact, ...wild.map(w => '*' + w)];
  return check;
}

/**
 * spec: a comma list of 'cloudflare' (Cloudflare's edge ranges, for a server
 * that Cloudflare's proxy reaches directly), IP addresses and CIDR ranges.
 * This machine (loopback: a proxy or tunnel here, such as Caddy, nginx or
 * cloudflared) is always trusted.  Returns trust(peer) -> boolean, with
 * .cloudflare (the Cloudflare ranges are in) and .entries (what was given).
 */
export function makeProxyTrust(spec) {
  const list = new net.BlockList();
  const entries = [];
  let cloudflare = false;
  const add = (it, from) => {
    const [addr, bits, more] = it.split('/');
    const ip = bareIp(addr);
    const max = ip && net.isIPv4(ip) ? 32 : 128;
    if (!ip || more !== undefined || (bits !== undefined && (!/^\d{1,3}$/.test(bits) || +bits > max)))
      throw new Error(`--trusted-proxies: "${from}" is not an address, a CIDR range or "cloudflare"`);
    if (bits === undefined) list.addAddress(ip, family(ip)); else list.addSubnet(ip, +bits, family(ip));
  };
  for (const it of LOOPBACK) add(it, it);
  for (const raw of String(spec || '').split(',').map(s => s.trim()).filter(Boolean)) {
    if (raw === 'loopback' || raw === 'none') continue;
    if (raw === 'cloudflare') { for (const r of cloudflareRanges()) add(r, r); cloudflare = true; entries.push(raw); continue; }
    add(raw, raw); entries.push(raw);
  }
  const trust = peer => { const ip = bareIp(peer); return !!ip && list.check(ip, family(ip)); };
  trust.cloudflare = cloudflare;
  trust.entries = entries;
  return trust;
}

/**
 * The client's address: the TCP peer's, unless the peer is a trusted proxy.
 * Then the address it reports: header 'cf-connecting-ip' (Cloudflare's proxy
 * and cloudflared set it and replace what a client sent), else the right-most
 * X-Forwarded-For entry that is not itself a trusted proxy.  A header from a
 * peer that is not trusted is never read.
 */
export function clientIp(q, trust, header = 'x-forwarded-for') {
  const peer = bareIp(q.socket?.remoteAddress);
  if (!trust(peer)) return peer;
  if (header === 'cf-connecting-ip') {
    const cf = bareIp(String(q.headers['cf-connecting-ip'] ?? '').split(',')[0]);
    if (cf) return cf;
  }
  const xff = String(q.headers['x-forwarded-for'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
  for (let i = xff.length - 1; i >= 0; i--) {
    const ip = bareIp(xff[i]);
    if (!ip) break;
    if (!trust(ip)) return ip;
  }
  return peer;
}

/** The browser reached us over https: directly, or through a trusted proxy that says so. */
export function viaHttps(q, trust) {
  if (q.socket?.encrypted) return true;
  if (!trust(q.socket?.remoteAddress)) return false;
  const proto = String(q.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
  if (proto) return proto === 'https';
  try { return JSON.parse(String(q.headers['cf-visitor'] ?? '{}')).scheme === 'https'; } catch { return false; }
}

/** The host the browser asked for, when a trusted proxy rewrote Host (X-Forwarded-Host). */
export function forwardedHost(q, trust) {
  if (!trust(q.socket?.remoteAddress)) return null;
  const h = String(q.headers['x-forwarded-host'] ?? '').split(',')[0].trim().toLowerCase();
  return h || null;
}

/** localhost or an IP literal (with or without a port): HSTS means nothing (or harm) there */
export function isLocalOrIp(hostHeader) {
  let h = String(hostHeader ?? '').trim().toLowerCase();
  if (h.startsWith('[')) return true;                       // [v6]:port
  h = h.replace(/:\d+$/, '').replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || net.isIP(h) !== 0;
}
