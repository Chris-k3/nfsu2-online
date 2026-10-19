# NFS Underground 2 in the browser: the server bundle

This folder runs the game's web server on a Linux VPS, with HTTPS in front, so
friends can play with you in Chrome. The full guide, with the TLS and Cloudflare
options, is `docs/web/VPS.md` in the repository; this is the short version.

It holds the server, the page and the game module. **It does not hold the game.**
You copy your own NFS Underground 2 folder to the VPS yourself.

1. **Node.js.** Install the current Node.js LTS (20 or newer): your distribution's
   package, NodeSource, or nodejs.org.
2. **The bundle.**
   `sudo mkdir -p /opt && sudo tar -C /opt -xzf nfsu2-web-<rev>.tar.gz`
   This gives `/opt/nfsu2-web`.
3. **The game folder.** This is the one with `SPEED2.EXE`. From your own computer, inside that folder, copy
   only the game's own files (the server serves nothing else), then make them readable on the VPS:
   `rsync -rlt SPEED2.EXE server.dll server.cfg CARS CREDITS FRONTEND GLOBAL LANGUAGES memcard MOVIES NIS pfdata SOUND speech SUBTITLES TRACKS root@<vps>:/srv/nfsu2/game/`
   `ssh root@<vps> chmod -R u=rwX,go=rX /srv/nfsu2/game`
4. **TLS**, in one of these ways:
   - Caddy in front: `deploy/Caddyfile`. Simplest: a Let's Encrypt certificate,
     renewed by Caddy.
   - The server itself on port 443 with a certificate: `deploy/nfsu2-web.service`,
     variant B.
   - A Cloudflare Tunnel: `deploy/cloudflared.yml`, and the service's variant D.
5. **The service.**
   `sudo cp /opt/nfsu2-web/deploy/nfsu2-web.service /etc/systemd/system/`
   Pick its `ExecStart` line (A, D or B) and put your name in `--host`, then run:
   `sudo systemctl daemon-reload && sudo systemctl enable --now nfsu2-web`
   Its log: `journalctl -u nfsu2-web -f`.
6. **Play.** Open `https://<your name>/` in Chrome.

**Who can play:** the server has no accounts or passwords. Anyone who can reach
it can play, and can download the game files from it. Your firewall decides who
that is. Behind Cloudflare, let only Cloudflare's addresses reach 80 and 443.
