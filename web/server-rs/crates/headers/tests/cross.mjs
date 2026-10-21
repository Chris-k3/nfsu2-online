// The node side of node_cross.rs: every function of web/server/headers.mjs over the cases the Rust test wrote.
//   node cross.mjs <web/server/headers.mjs> <cases.json>   -> the answers, as JSON, on stdout
import fs from 'node:fs';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

const [headersPath, casesPath] = process.argv.slice(2);
const H = await import(pathToFileURL(headersPath).href);
const c = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
const req = (r) => ({ socket: { remoteAddress: r.peer, encrypted: r.encrypted }, headers: r.headers });

const out = {
  addresses: c.addresses.map(a => [H.bareIp(a), net.isIP(a), H.addressKey(a), H.siteKey(a)]),
  hosts: c.hosts.map(h => [H.hostName(h), H.isLocalOrIp(h)]),
  hostChecks: c.hostChecks.map(({ names, cert }) => {
    const check = H.makeHostCheck(names);
    if (cert) check.setCertNames(cert);
    return { checks: c.hosts.map(h => check(h)), names: check.names() };
  }),
  encodings: c.encodings.map(({ header, have }) => H.pickEncoding(header, have)),
  etags: c.etags.map(({ header, etag }) => H.etagMatches(header, etag)),
  proxies: c.proxies.map(({ spec, peers }) => {
    let trust;
    try { trust = H.makeProxyTrust(spec); } catch (e) { return { error: e.message }; }
    return { cloudflare: trust.cloudflare, entries: trust.entries, trust: peers.map(p => trust(p)) };
  }),
  requests: c.requests.map(({ spec, reqs }) => {
    const trust = H.makeProxyTrust(spec);
    return reqs.map(r => {
      const q = req(r);
      return [H.clientIp(q, trust), H.clientIp(q, trust, 'cf-connecting-ip'), H.viaHttps(q, trust), H.forwardedHost(q, trust)];
    });
  }),
  visitors: (() => {
    const trust = H.makeProxyTrust('');
    return c.visitors.map(v => H.viaHttps(req({ peer: '127.0.0.1', encrypted: false, headers: { 'cf-visitor': v } }), trust));
  })(),
  statics: {
    security: [[false, true], [true, true], [false, false], [true, false]]
      .map(([hsts, noindex]) => Object.entries(H.securityHeaders({ hsts, noindex }))),
    cache: ['store', 'revalidate', 'immutable'].map(k => Object.entries(H.cacheHeaders(k))),
    cacheDefault: Object.entries(H.cacheHeaders()),
    csp: H.CSP,
    permissions: H.PERMISSIONS_POLICY,
    edgeKeep: H.EDGE_KEEP,
    hsts: H.HSTS,
    cspWith: c.cspWith.map(([scriptHashes, styleHashes]) => H.contentSecurityPolicy({ scriptHashes, styleHashes })),
    sha: c.sha.map(t => H.sha256Source(t)),
    ranges: H.cloudflareRanges(),
    rangesFile: H.cloudflareRanges(c.rangesFile),
  },
};
process.stdout.write(JSON.stringify(out));
