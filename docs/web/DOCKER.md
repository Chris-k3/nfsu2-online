# The game server in Docker

Status: **2026-10-19**.

The server from [VPS.md](VPS.md) as a container image, started with Caddy (or a Cloudflare Tunnel) in front by one
compose file. It replaces the bundle, the systemd unit and installing Node.js and Caddy; it behaves the same.

- **What the image holds:** the server, its one dependency (`ws`) and the page. That is the bundle (`pack.sh`)
  without the game module: about 62 MB, on Node.js 24 (Alpine).
- **What it never holds:** the game, or anything made from it. Those are mounted when it runs:

  | In the container | What | |
  |---|---|---|
  | `/game` | your NFS Underground 2 folder (the one with `SPEED2.EXE`) | read-only |
  | `/module` | the game module, `nfsu2.wasm` and `nfsu2.json`, built on the Mac with `web/build.sh` | read-only |
  | `/state` | the server's keys and the Online mode's records | a volume |

  The image build sees only the server's and the page's sources (`.dockerignore`, checked by
  `web/test/docker.test.mjs`), so a public image cannot carry the game.

> **Who can play** is the same as in [VPS.md](VPS.md): anyone who can reach the server, so the VPS's firewall decides.

## The image

- **From GitHub's registry:** `ghcr.io/th0mk/nfsu2-web` (the name follows the GitHub repository). The workflow
  `.github/workflows/image.yml` builds it for amd64 and arm64:
  - `latest` from the default branch;
  - `sha-<commit>` from every push;
  - `<version>` and `<major>.<minor>` from a `v*` tag.

  A new package on ghcr.io is private: to pull it without logging in, make it public in the package's settings.
  The workflow passes actionlint but has not run yet, because the repository is not on GitHub (**UNVERIFIED**).
- **Built yourself:** `docker build -t nfsu2-web .` in the checkout. It needs BuildKit (the buildx plugin).
- **The module must come from the image's commit.** The page in the image and the module meet at the module's
  imports, and nothing checks that the two come from the same revision. `nfsu2.json`'s `rev` and the image's
  `sha-<commit>` tag (or its label `org.opencontainers.image.revision`) should name the same commit.

## What you need

- **A Linux VPS** sized as in [VPS.md](VPS.md), with Docker Engine and the compose plugin (`docker compose version`).
- **A domain name** with an `A` record (and an `AAAA` record if the VPS has IPv6) pointing at the VPS.
- **Your game folder and the game module**, from the Mac.

## 1. Install

On the VPS:

```sh
mkdir -p /srv/nfsu2 && cd /srv/nfsu2
curl -fsSLO https://raw.githubusercontent.com/th0mk/nfsu2-web/main/web/deploy/compose.yml
echo NFSU2_HOST=game.example.com > .env           # your name
```

From the Mac:

```sh
rsync -a --chmod=D755,F644 "Need for Speed - Underground 2/" root@<vps>:/srv/nfsu2/game/
rsync -a --chmod=F644 out/web/nfsu2.wasm out/web/nfsu2.json root@<vps>:/srv/nfsu2/module/
```

- **Readable by everyone:** the server runs as the container's user `node` (uid 1000). `--chmod` does that.
- **Other folders:** `NFSU2_DATA` and `NFSU2_MODULE` in `.env` point the compose file elsewhere (by default `./game`
  and `./module` next to it). `compose.yml`'s header lists every setting.

## 2. Start

```sh
docker compose up -d
docker compose logs -f server
```

- **Open ports:** 80 and 443 (TCP), and 443/UDP for HTTP/3. Caddy gets the Let's Encrypt certificate and renews it.
- **Check it** as in [VPS.md](VPS.md), "4. Check it". `docker compose ps` shows the server `healthy` once it serves
  the module, and `unhealthy` while `/module` has none.

## How it runs

- **The VPS's own network.** Caddy and the server use the VPS's network (`network_mode: host`), as they would
  without Docker: Caddy on 80 and 443, the server on 127.0.0.1:8080, which nothing outside the VPS can reach.
  Ports published from a Docker network would have two problems:
  - they pass by the VPS's firewall (ufw, nftables), which is what decides who can play here;
  - IPv6 players come in through Docker's proxy and all get the same address. The switch allows 8 connections per
    address, so only 8 of them could play.

  If 8080 is taken on the VPS, set `NFSU2_HTTP_PORT`: Caddy follows it.
- **The server's container** runs as the user `node`, with a read-only root, no capabilities, `no-new-privileges`,
  3 GB of memory without swap and 8192 open files. Those are the systemd unit's limits, as far as a container has
  them. It writes only to `/state`.
- **Keep the state volume.** It holds the ETag key. A new key makes every player's browser download the game data
  again. `docker compose down` keeps the volume; `down -v` deletes it.
- **Caddy's admin API is off.** Nothing reconfigures Caddy while it runs; a changed `.env` takes
  `docker compose up -d`.

## Cloudflare

- **Proxy (orange cloud) in front of Caddy** ([VPS.md](VPS.md), C): add `NFSU2_REAL_IP_HEADER=cf-connecting-ip` to
  `.env`. The rest of C applies: Full (strict), Rocket Loader off, and the firewall open to Cloudflare's ranges only.
  In Docker: **UNVERIFIED**.
- **Tunnel** ([VPS.md](VPS.md), D): `compose.tunnel.yml` puts `cloudflared` where Caddy was. The server shares
  cloudflared's network namespace on a Docker network, so the VPS opens no port for the game.
  1. In Cloudflare's dashboard (Zero Trust, Networks, Tunnels), create a tunnel with the Docker connector and copy
     its token. Give it a public hostname: your name, service `http://127.0.0.1:8080`.
  2. Download `compose.tunnel.yml` next to `compose.yml`, and add to `.env`:

     ```sh
     TUNNEL_TOKEN=<the token>
     COMPOSE_FILE=compose.yml:compose.tunnel.yml
     ```

  3. Run `docker compose up -d`.

  A real tunnel was not opened here (**UNVERIFIED**). The same layout (the server in its front's network namespace,
  on a Docker network) did run with Caddy.

## A proxy you already have

With Caddy or nginx already on the VPS, run the server alone on the VPS's network, and forward to 127.0.0.1:8080
as in [VPS.md](VPS.md) (`deploy/Caddyfile`, or the nginx block):

```sh
docker run -d --name nfsu2-web --restart unless-stopped --network host \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -e NFSU2_HOST=game.example.com \
  -v /srv/nfsu2/game:/game:ro -v /srv/nfsu2/module:/module:ro -v nfsu2-state:/state \
  ghcr.io/th0mk/nfsu2-web
```

The image's command is the server's options, `--behind-proxy` by default. Options with a value can also be set as
`NFSU2_<OPTION>` (`web/server/server.mjs`).

## Updating

1. Copy the module of the new image's commit to `/srv/nfsu2/module/`.
2. Run `docker compose pull && docker compose up -d`.

The players' browsers notice the new module by its ETag and download it once.

## What was tested

On 2026-10-19 with Docker 29.5 (Colima on an Apple Silicon Mac, an arm64 Linux VM), compose 5.6 and Caddy 2.11.7:

- **`node web/tools/deploy-e2e.mjs --mode docker --menu`:** `compose.yml` with the image and Caddy, Caddy with a
  test certificate instead of Let's Encrypt. In Chrome:
  - the headers (HSTS, isolation, no `Server`), a secure and cross-origin isolated page, the start page;
  - Play, then the main menu with the renderer, and no CSP violation.

  Two runs of three reached the main menu, in 71 and 81 s. The third was still at the profile prompt when the test's
  two minutes ran out. The same test without Docker (mode proxy) reached it in 42 s. Here every file goes through
  Colima's VM and its port forwarding: 1.2 ms per request instead of 0.35 ms, and 300 MB/s instead of 1.6 GB/s.
- **By hand:**
  - the `/lan` WebSocket through Caddy, and the client address the server takes from Caddy;
  - the ETag key kept when the server's container is recreated;
  - `docker stop` in 0.07 s;
  - a read-only root, no capabilities, 8192 open files.
- **The amd64 image** built on the arm64 Mac without emulation, and ran.
- **Not tested:** a real VPS, Let's Encrypt, a real domain, more than one player at once (**UNVERIFIED**).
