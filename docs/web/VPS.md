# The game server on a VPS

Status: **2026-10-19** (with the fixes of a security and privacy review).

Use a VPS when other PCs should play: on the Mac at home the server serves only that Mac (`http://localhost`). The
VPS runs the same server (`web/server/server.mjs`) with HTTPS in front, so friends anywhere open
`https://<your name>/` in Chrome and play from there.

With Docker instead (the server's image and Caddy from one compose file): [DOCKER.md](DOCKER.md).

- **Nothing changes in how it behaves.** Only TLS differs: a certificate or a proxy provides HTTPS.
- **What it serves:** the page, the game module, the game's own files from your game folder (read-only) and the
  multiplayer switch. Of the game folder it serves only `SPEED2.EXE`, `server.dll`, `server.cfg` and the game's data
  folders (`CARS`, `CREDITS`, `FRONTEND`, `GLOBAL`, `LANGUAGES`, `memcard`, `MOVIES`, `NIS`, `pfdata`, `SOUND`,
  `speech`, `SUBTITLES`, `TRACKS`), compared without case; never an installer's log (`unins000.dat` names the PC,
  the Windows account and the install time), a `SAVE` folder, mod plugins and their settings, or anything else you
  keep there.
- **What it never shows:** anything about the VPS or the other players (`web/test/deploy.test.mjs` checks what is
  and is not exposed).

> **Who can play.** The server has no accounts, passwords or allowlist. Anyone who can reach it can play and
> download the game files from it, so your firewall decides who that is. Behind Cloudflare's proxy the VPS only
> sees Cloudflare's addresses.
>
> **What players see of each other:** the names they chose and, with free roam on, their status, car and position;
> never another player's real address. The server answers only for its own name (`--host`, or the certificate's):
> a page of another site whose name points at the VPS gets nothing, and a scanner that connects to the VPS's bare
> address gets no certificate and no page.

## What you need

- **A Linux VPS.** A small one is enough for friends; for up to 250 players at once, 2–4 vCPU, 4 GB of memory,
  40 GB of disk and a 1 Gbit/s port with a few TB of traffic a month:
  - the server relays and serves files; it used about 110 MB of memory here, plus up to 8 MB queued towards each
    player who falls behind;
  - the game folder takes about 3 GB of disk;
  - each new player downloads the 7 MB module and then the game data they play (about 70 MB for a quick race, up
    to the whole 3 GB over a career), once: the browser keeps it;
  - free roam is about 25 KB/s each way per player in a full group of 8, so 250 players roaming at once are about
    50 Mbit/s each way through the VPS. More than a handful of players at once is **UNVERIFIED**.
- **A domain name** (or a subdomain) pointing at the VPS. Cloudflare can provide it (see below).
- **Node.js 20 or newer.** The current LTS is 24. The server was tested on 24.22.0 (LTS) and 23.9.0.
- **Your own NFS Underground 2 folder** (the one with `SPEED2.EXE`).
- **The bundle**, built on the Mac:

  ```sh
  web/build.sh            # the game module, if out/web/nfsu2.wasm is not there yet
  web/deploy/pack.sh      # -> out/web/deploy/nfsu2-web-<rev>.tar.gz (about 11 MB)
  ```

  - **What is in it:** the server and its one dependency (`ws`), the page without its test pages, the game module,
    a systemd unit, example Caddy and cloudflared configurations, and a short README.
  - **What is never in it: the game.** `pack.sh` refuses to build the bundle if any file in it has a game file's
    name, or the name and size of a file in your game folder. It also refuses if a file names this Mac (host name,
    home folder).

## 1. Install

```sh
# on the VPS, as root
node --version                                    # 20 or newer
mkdir -p /opt /srv/nfsu2
tar -C /opt -xzf nfsu2-web-<rev>.tar.gz           # -> /opt/nfsu2-web
```

From the Mac, copy the bundle and the game's own files from inside the game folder:

```sh
scp out/web/deploy/nfsu2-web-<rev>.tar.gz root@<vps>:
cd "Need for Speed - Underground 2"
rsync -rlt SPEED2.EXE server.dll server.cfg CARS CREDITS FRONTEND GLOBAL LANGUAGES memcard MOVIES NIS pfdata \
  SOUND speech SUBTITLES TRACKS root@<vps>:/srv/nfsu2/game/
ssh root@<vps> chmod -R u=rwX,go=rX /srv/nfsu2/game
```

- **Only the game.** The list is what the server serves; nothing else of the folder needs to be on the VPS (an
  installer's log, saves, mod settings). `pack.sh` lists what your folder holds besides these. On a folder whose
  names differ in case (`Sound`), use the names it has.
- **Owned by root, readable by everyone on the VPS.** `-rlt` copies the files, folders and their times, not their
  owner, group or modes: on the VPS they belong to root (`rsync -a` as root would keep your Mac's uid 501, which
  another account may get one day). The service runs as a throwaway user (systemd `DynamicUser`), so the game
  folder must be world-readable: the `chmod` does that (folders 755, files 644). Run both lines again after every
  copy: new files arrive with the Mac's modes.
- **Not `--chmod`.** The Mac's own `rsync` (openrsync) applies `--chmod` only to the files named on its command line,
  not to what is inside the folders (`TRACKS/` stayed 700, its files 600), and it refuses `D755,F644`. Checked:
  the lines above from the Mac's openrsync to rsync 3.5.0 on Debian, and with rsync 3.5.0 on both ends.
- **Copyright.** The game folder is EA's copyrighted content, and the server hands it to anyone who can reach it.
  That is one more reason to keep the firewall tight.

## 2. TLS: pick one

Chrome runs the game only on a secure page, so TLS is required. Each choice below sets the server's command line in
`/opt/nfsu2-web/deploy/nfsu2-web.service`.

| | TLS done by | Server command line | Open on the VPS |
|---|---|---|---|
| **A** | Caddy, with Let's Encrypt (recommended) | `--behind-proxy --http-port 8080 --host game.example.com` (plus `--real-ip-header cf-connecting-ip` with Cloudflare's proxy in front, C) | 80, 443 |
| **B** | the server itself, with Let's Encrypt or a Cloudflare Origin CA certificate | `--port 443 --http-port 0 --tls-cert … --tls-key …` | 443 (and 80 while certbot renews) |
| **C** | Cloudflare's proxy (orange cloud), then A or B on the VPS | as A or B, plus a Cloudflare option (below) | 80 and 443, from Cloudflare's addresses only |
| **D** | a Cloudflare Tunnel (`cloudflared` on the VPS) | `--behind-proxy --http-port 8080 --host game.example.com --real-ip-header cf-connecting-ip` | none |

`--host` is the name players open (a comma list for more; `*.example.com` for one label under it). Behind a proxy
the server cannot know it and refuses to start without it. It then answers only for that name and for `localhost`,
so a web page of another site whose name points at the VPS (DNS rebinding) gets nothing. With a certificate (B) the
names come from the certificate.

In every mode the server:

- answers only `GET` and `HEAD`, and only for its own names (any other `Host` gets 421);
- with a certificate (B), completes a TLS handshake only for a name in it: a connection to the bare address without
  a name (an internet-wide scanner) or with another name gets no certificate, so the VPS's address is not tied to
  your domain that way (a certificate for an IP address is shown without a name too);
- sends HSTS when the page arrived over https;
- keeps proxies and CDNs from storing anything (`Cache-Control: private`, `CDN-Cache-Control: no-store`);
- limits what one client can make it hold (`web/test/deploy.test.mjs`, `web/test/audit.test.mjs`). A client is an
  IPv4 address or an IPv6 /56; all clients of one IPv6 /48 (a site) together get twice one client's share:
  - 64 connections at once per client and 128 per site, for TCP peers that are not a trusted proxy (a proxy carries
    many clients);
  - 64 requests in progress per client and 128 per site, also when they come through a proxy or tunnel (more get
    429; the page waits and tries again);
  - the last quarter of its connections and requests only for clients that hold none yet, so the others can never
    lock a newcomer out;
  - a response must move at least 64 KB every 20 s (a client that stopped reading, or reads a trickle, is let go)
    and may take 15 minutes at most;
  - 15 s for a TLS handshake and for the request headers, a few queued requests per connection, WebSocket pings
    answered at most 10 a second;
- writes at most a few console lines a minute for what one client causes (refused requests and connections, joins
  and leaves), then one line saying how many it left out, so one client cannot flood the journal.

**IPv4 and IPv6.** With the server doing TLS itself (B), it listens on IPv6 and IPv4 (`::`), so an `A` and an
`AAAA` record both work; on a VPS without IPv6 it falls back to IPv4 by itself, and then only an `A` record belongs
in DNS. `--bind 0.0.0.0` keeps it to IPv4. With Caddy (A) or a Tunnel (D), the server listens on 127.0.0.1 only and
Caddy or cloudflared take both address families.

### A: Caddy (Let's Encrypt)

1. Install Caddy (caddyserver.com, "Install").
2. Copy `deploy/Caddyfile` to `/etc/caddy/Caddyfile` and replace `game.example.com` with your name everywhere in it
   (and in the unit's `--host`).
3. Run `systemctl reload caddy`.

What Caddy then does:

- gets and renews the certificate;
- redirects http to https;
- passes WebSockets (the multiplayer switch) and the client's address (`X-Forwarded-For`) on;
- the server trusts those headers only from this machine;
- names no software: no `Server` or `Via` header, also not on its redirects and errors (a 502 while the server
  restarts);
- closes, without an answer, a connection that asks for another name (the bare address, a scanner's made-up name),
  on 80 and on 443;
- opens at most 1900 connections to the server (one per request in progress; with `--max-peers 250` the server
  takes 2000).

Tested locally with Caddy 2.11.7: the Caddyfile's site block, in front of the server, passed the page, isolation
and policy checks in Chrome; both variants of this Caddyfile also ran in front of the unit under systemd, in a container.

### B: the server does TLS itself

**Let's Encrypt:**

1. Get the certificate with certbot, and let it restart the server after each renewal:

   ```sh
   certbot certonly --standalone -d game.example.com --deploy-hook "systemctl restart nfsu2-web"
   ```

2. In the unit, use variant B. systemd hands the certificate files to the service (`LoadCredential`), so they stay
   readable by root only. `AmbientCapabilities=CAP_NET_BIND_SERVICE` lets the server bind port 443.

**Cloudflare Origin CA certificate** (only with the orange cloud, C): create one under SSL/TLS, Origin Server.
Save the certificate and the key on the VPS and point `LoadCredential` at them.

Outside systemd credentials, the server also reloads its certificate:

- on `SIGHUP`;
- by itself within a minute of the file changing.

### C: Cloudflare's proxy (orange cloud)

1. **DNS:** a proxied (orange) `A` record for your name, pointing at the VPS, and an `AAAA` record if the VPS has
   IPv6 (Cloudflare may connect to either: see "IPv4 and IPv6" above).
2. **Firewall:** let only Cloudflare's addresses (`web/server/cloudflare-ips.txt`, or
   https://www.cloudflare.com/ips/) reach 443 and 80. Otherwise anyone who finds the VPS's address bypasses
   Cloudflare.
3. **SSL/TLS mode: Full (strict).** Cloudflare connects to the VPS over TLS and checks the certificate:
   - with Caddy (A): Caddy's own Let's Encrypt certificate, or the Origin CA certificate. The `Caddyfile`'s
     Cloudflare variant shows how, with its global block at the top: Caddy then believes `CF-Connecting-IP` only
     from Cloudflare's addresses and overwrites it otherwise, so a client that reaches the VPS directly cannot
     choose the address the server logs and limits by. The server needs `--real-ip-header cf-connecting-ip`.
   - with the server itself (B): the Origin CA certificate, plus `--trusted-proxies cloudflare`. Then only
     connections from Cloudflare's published ranges (`web/server/cloudflare-ips.txt`) may say who the client is.
4. **Turn off what rewrites pages:**
   - **Rocket Loader** (Speed, Optimization);
   - **Email Obfuscation** (Scrape Shield);
   - anything else that injects scripts, such as Web Analytics' automatic setup or Zaraz.

   The page's Content-Security-Policy blocks injected scripts, and Rocket Loader would also rewrite the page's own
   module scripts.
5. **Caching:** add a Cache Rule "Bypass cache" for your hostname. The server's headers already say `no-store` to
   Cloudflare (`Cloudflare-CDN-Cache-Control`); the rule makes it explicit.
6. **WebSockets** are on by default on every plan. The server pings each connection every 25 s, well inside
   Cloudflare's idle limit.

### D: a Cloudflare Tunnel

`cloudflared` on the VPS connects out to Cloudflare, so the VPS needs no open port for the game at all.

1. Set up the tunnel:

   ```sh
   cloudflared tunnel login
   cloudflared tunnel create nfsu2
   cloudflared tunnel route dns nfsu2 game.example.com
   ```

2. Copy `deploy/cloudflared.yml` to `/etc/cloudflared/config.yml` and fill in the tunnel id.
3. Run `cloudflared service install`.

What follows from this setup:

- **Server command line:** `--behind-proxy --http-port 8080 --host game.example.com --real-ip-header cf-connecting-ip`
  (the unit's variant D).
- **The client's address** comes from Cloudflare's `CF-Connecting-IP`, and only from `cloudflared` on this machine.
  `cloudflared` opens a connection to the server for each request in progress and has no limit of its own per
  client: the server's own limits per client address hold.
- **Settings and terms:** the same as for C.

`cloudflared tunnel ingress validate` accepts the example (cloudflared 2026.9.3). A real tunnel was **not** opened
from the dev machine, so the tunnel itself is **UNVERIFIED**.

### nginx instead of Caddy

The server (with `--host game.example.com`) needs four things from nginx:

- `Host` kept;
- WebSocket upgrades passed on;
- `X-Forwarded-For` and `X-Forwarded-Proto` set;
- a read timeout above the 25 s ping interval.

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
server {
    listen 443 ssl; server_name game.example.com;   # + ssl_certificate / ssl_certificate_key
    server_tokens off;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
        proxy_buffering off;
    }
}
```

This configuration was not run here (**UNVERIFIED**).

## 3. Start the service

```sh
cp /opt/nfsu2-web/deploy/nfsu2-web.service /etc/systemd/system/
# pick the ExecStart for your TLS choice (A as shipped; D or B: the commented lines), and put your name in --host
systemctl daemon-reload && systemctl enable --now nfsu2-web
journalctl -u nfsu2-web -f
```

**What the log keeps.** The journal gets the server's console: start-up, players joining and leaving by virtual
address (`10.77.0.x`) and nickname, refused connections, and errors (method, path and the server's own stack, never
the client's details). No player's real IP address is written, and the page sends the server nothing about the
player but the nickname. `--access-log` adds a line per request with the client's IP address and the URL: off by
default, for debugging only, and then the journal holds your friends' addresses for as long as it keeps logs. One
client can cause only a few lines a minute of each kind (refusals, joins and leaves; 3000 access-log lines), then
one line saying how many were left out, and the unit caps the service at 2000 lines per 30 s
(`LogRateLimitBurst`), so the journal keeps the rest of the VPS's logs whatever a client does.

The unit runs the server as a fresh unprivileged user:

- the system, `/opt/nfsu2-web` and the game folder are read-only to it;
- it may write only in its state folder `/var/lib/nfsu2-web`;
- it has no capabilities, except `CAP_NET_BIND_SERVICE` in variant B, for port 443;
- it may use at most 3 GB of memory (`MemoryMax`, reclaimed from above 2 GB; it uses about 110-250 MB, plus what
  queues towards players who fall behind), so whatever a client does, the rest of the VPS keeps its memory: at the
  limit the kernel stops the server and systemd starts it again.

The unit was run under systemd 257 (Debian trixie, Node 20) in a container, variants A, D and B: it starts, stays
up (no restarts) and serves. `LoadCredential` could not be exercised in a container (**UNVERIFIED**; B ran with the
certificate by path).

The console names paths and addresses: it is yours. Without `--tls-cert` or `--behind-proxy` the server listens on
127.0.0.1 only and says so on start: nothing outside the VPS can reach it.

## 4. Check it

```sh
curl -sI https://game.example.com/ | grep -iE 'strict-transport|content-security|cdn-cache'
curl -s -o /dev/null -w '%{http_code}\n' https://game.example.com/game.json   # 200: the game module is there
```

Then open the address in Chrome. The start page says it is ready, and Play starts the game.

## 5. Updating

1. Build a new bundle on the Mac.
2. Unpack it over `/opt/nfsu2-web`.
3. Run `systemctl restart nfsu2-web`.

The players' browsers notice the new module by its ETag and download it once.

## Multiplayer over the internet

The server's switch relays every packet: player → VPS → player. The delay between two players is the sum of both
paths to the VPS, so pick a VPS location between you.

- **Free roam** draws a friend's car `roam_delay` milliseconds (100 by default) behind its newest snapshot. That
  delay hides the 50 ms between snapshots, jitter and the odd lost snapshot. Network delay comes on top of it.
  - **Measured with impairment on a local switch:** 100 ± 10 ms one way and 5 % loss.
    98.1 % of frames were interpolated, 1.9 % extrapolated, and none were held.
  - **For 50–150 ms round trips, the default is enough.** If friends' cars stutter (Wi-Fi or mobile jitter), set
    `roam_delay = 150` in Settings (settings.ini). It only adds display delay.
  - **There is no automatic raise from the measured ping.** The runtime reads `roam_delay` once at start; making it
    follow the ping is a runtime change for the net track.
  - **Over the real internet:** **UNVERIFIED**.
- **Traffic:** free roam measured about 153 bytes per snapshot at 20 per second, so about 3 KB/s per friend in each
  direction. That is two browsers through the Cloudflare stand-in on this Mac.
- **Keepalive:** the switch pings every connection every 25 s. Proxies and Cloudflare then never cut a quiet player,
  and the switch finds players whose connection died.
- **Limits:**
  - 250 players on the switch with the shipped unit (`--max-peers 250`; the server's own default is 16, and 250 is
    the most its virtual network has addresses for);
  - 8 connections at once per client address and 16 per IPv6 /48; opening them is rate limited per client
    address (a burst of 20, then one a second), so a client that opens and closes connections as fast as it can
    gets 429;
  - frames up to 8 KB; 1000 frames and 256 KB a second per connection, 2000 and 512 KB for all of one client
    address's connections together, 4000 and 1 MB for all of one IPv6 /48 (a 3-player LAN race's host sent at
    most 100 frames and 8 KB a second; free roam
    is 3.6 KB a second per friend). A broadcast counts once for every player it reaches;
  - datagrams to a player whose connection is 256 KB behind are dropped, as a full link would. LAN-race stream data
    is never dropped: a player with more than 2 MB of it waiting is disconnected if it stopped reading, and
    otherwise the client that queued the most for it is, all its connections (so a flood does not get a player who
    reads cut; only many clients that together outrun that player's link for a long time could). Only a player
    that stops reading altogether (8 MB behind) is disconnected for that;
  - a player who drops gets the same address back when it reconnects: the switch keeps the address a minute for
    that player alone (a token only that browser has), also across a restart of the server, and never gives it to
    anyone else. At most 8 such addresses are kept per client address (16 per /48; past that its own oldest goes).
    When every address is held or kept, a newcomer gets "LAN full" until one frees.
- **LAN races** (the game's own LAN mode, from the LAN-play track) use the same switch. Over the internet they are
  **UNVERIFIED**.
- **The game's Online mode** is served by the server itself, at the switch's reserved address 10.77.0.1 (on by
  default; `--online off` turns it off, and the game then cannot connect). Any name logs in; there are no accounts.
  - **Kept in the state folder:** `online/stats.json` (race results per persona) and `online/buddies.json` (EA
    Messenger friends lists, persona names only), written atomically. Nothing else: no passwords (the server never
    reads them), CD keys, addresses or chat.
  - **The console** names online players by persona and virtual address (10.77.0.x) only, and shows at most 30
    Online lines a minute caused by one client address (then one line saying how many were left out).
  - **Who plays now:** `/players` answers anyone who reaches the server with two numbers for the start page:
    `{"players":3,"online":1}`, the games on the switch and how many of them are in Online mode (`null` with
    `--online off`). Nothing else: no names, addresses or times, never cached. The game's own lobby shows its
    players to anyone who logs in anyway.
  - **Limits:** 300 lobby sessions, 3 per browser, 8 per client address, 32 per IPv6 /48, and the last quarter
    only for a client that holds none; 100 games of at most 4, 2 open and 2 started per browser (4 and 8 per client
    address), one browser one player of a race; 20 lobby messages a second per session (a flood ends the session),
    games created, joined and car descriptions published a few a second; chat 1 a second with a burst of 5 (then
    10 s muted), 255 characters; a silent session goes after 120 s; a race whose players' browsers left the switch
    ends after 2 minutes. EA Messenger: 10 messages a second per connection (a flood closes it), the lists and the
    search 1 a second, a presence at most once a second; 50 friends each, 5000 friends lists (the least recently
    seen go), 20 new ones an hour per client address. Results: 100,000 personas (the least recently seen go), a
    race counts once two of its players in different browsers sent the same result.
  - **What one client costs the others:** what the online host sends because of a client's message (its answer,
    and what the others hear of it: room chat, a game's players) comes out of that client's switch budget; over
    it, that client's connection to the online host closes. A game's record goes only to players looking at the
    game list, at most once a second; a room's population at most once a second. A player too far behind (1 MB
    queued) loses its online connection, not its place on the switch.
  - **Measured on this Mac** (`web/tools/online-load.mjs`): 200 simulated players logging in, chatting and racing
    in groups of four for 90 s took the server to 230 MB and 14.7 s of CPU; chat arrived in 1.1 ms (p50).
  - Race traffic goes from browser to browser through the switch, as LAN races do (**UNVERIFIED** over the
    internet).
