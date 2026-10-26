# Forum bot

A Discord bot for the server's forums. It looks at each new post once its author has stopped adding to it (2 minutes),
and it says something only when it is worth it:

- **in the thread**, a fix it verified in the player's guide, the code or the git history (an error code, a missed
  setting, a browser's limit, a bug fixed in the live version); or a request for what the report lacks (the log, the
  browser and device, the controller's model), with how to get it. In the poster's language, and every reply ends
  with a line saying it is an automated AI reply that may be wrong;
- **in the staff channel**, a report the developer should act on, with everything needed to start: what happens,
  device, browser and version, the key log lines, the likely cause, the thread's link and its log files. A later
  report of the same problem is added to that message ("Also reported: ..."), which notifies nobody.

Otherwise it says nothing. It reads every channel it can see, but posts only in forum threads and the staff channel. It
stays out of a thread once staff wrote in it (the server owner, `BOT_STAFF`, anyone who can manage threads), and replies
at most twice in a thread: after it asked for something, the poster's next post gets one more look. Staff can mention
the bot in a thread to have it look anyway.

## How it works

- `bot.mjs`: Discord (discord.js). It decides when to look, builds the thread's text, saves attachments, inlines
  pictures (PNG, JPEG, GIF, WebP up to 3.5 MB, 4 a look) and posts.
- `investigate.mjs`: one look. It sends Claude the rules (`system.md`), the maintainer's notes (`knowledge.md`),
  `docs/web/PLAYING.md`, the live version, recent commits and recent threads. Claude reads what it needs through the
  tools, then returns a verdict as JSON: none, ask or answer, and whether to tell the developer. `vet()` drops weak
  answers and replies that paste code.
- `tools.mjs`: what Claude can do. It can search and read the code, read the thread's attachments, look at the git
  history (`LIVE` is the live server's commit) and search the archive of recent messages. Everything is read only:
  no shell, no network, no writing, and nothing outside the bot's own copy of the code and the attachments.
- `repo.mjs`: the bot's own clone of the code in `state/repo`, fetched at most every 5 minutes. The rules, the notes
  and the guide are read from that clone, so a pushed change to them applies within minutes, without a new image or a
  restart. The live version comes from `https://nfsu2.xyz/game.json`.
- `archive.mjs`: every message of every channel the bot sees, kept 7 days in `state/archive/`.

Each look adds one line to `state/verdicts.jsonl`: the verdict with the developer notes, what was posted (or why not),
the tools used, the tokens and the cost.

## Set up

1. **Discord application.** In https://discord.com/developers/applications, create an application. Under Bot:
   - reset the token and copy it;
   - turn on **Message Content Intent** (no other intent is needed);
   - turn off Public Bot, so only you can invite it.

   Invite it with
   `https://discord.com/oauth2/authorize?client_id=<application id>&scope=bot&permissions=274877973504`.
   That gives it View Channels, Read Message History and Send Messages in Threads, and nothing else. Without Send
   Messages it cannot write in ordinary channels or open posts. If a forum hides itself from @everyone, give the bot
   View Channel there too.
2. **Staff channel.** Make a private channel for staff. In its permissions, add the bot with View Channel, Send
   Messages, Attach Files and Read Message History. Turn on Developer Mode (User Settings, Advanced), right-click the
   channel, Copy Channel ID.
3. **Claude.** Create an API key at https://console.anthropic.com, and set a monthly spend limit there.
4. **`.env`**:

   ```sh
   DISCORD_TOKEN=...
   ANTHROPIC_API_KEY=...
   BOT_STAFF_CHANNEL=...         # the staff channel's id
   BOT_DRY_RUN=1                 # first: replies go to the staff channel, not the forums
   # BOT_FORUMS=123,456          # only these forum channels (default: every forum)
   # BOT_STAFF=789               # more staff: user or role ids
   ```

## In Docker

`.github/workflows/image-bot.yml` builds `ghcr.io/th0mk/nfsu2-web-bot` on every push that changes this folder. On the
server, in a folder of its own (`/srv/nfsu2-bot`, say), put `compose.yml` from here and the `.env` above, then:

```sh
ssh-keygen -t ed25519 -N '' -C nfsu2-bot -f deploy_key   # before the first start: compose would make a folder of it
chown 1000:1000 deploy_key                               # the bot runs as uid 1000
cat deploy_key.pub     # GitHub, th0mk/nfsu2-web, Settings, Deploy keys, Add deploy key: read only
docker compose pull && docker compose up -d
docker compose logs -f
```

The bot clones the repository with that key into its `state` volume. The image is private like the repository: if
the pull is denied, log in once with `docker login ghcr.io -u th0mk` and a token with `read:packages`.

- New code: `docker compose pull && docker compose up -d`. A change to `system.md`, `knowledge.md` or the guide needs
  nothing: the bot reads them from its clone.
- After a change to `.env`: `docker compose up -d`.
- One post without Discord: `docker compose run --rm bot node try.mjs --title "Game crashes" "it crashes in free roam"`.
  With a log: add `-v "$PWD/x.log:/tmp/x.log:ro"` after `--rm` and `/tmp/x.log` at the end.

## Without Docker

Node 22.9 or newer and git, in this folder:

```sh
npm ci && npm start
node --env-file=.env try.mjs --title "Game crashes" "it crashes in free roam on my iphone" nfsu2-2026-10-25_151223.log
```

It clones the checkout this folder is in (its `main` branch, so committed changes only), unless `BOT_REPO` says
otherwise.

## Rolling it out

Run it with `BOT_DRY_RUN=1` for a day. Every reply it would have posted goes to the staff channel instead, quoted, and
`state/verdicts.jsonl` has every look. When the replies look right, remove the line and run `docker compose up -d`.

## Settings

| Variable | Default | |
|---|---|---|
| `BOT_STAFF_CHANNEL` | | the staff channel's id; without it, reports for the developer are only in `verdicts.jsonl` |
| `BOT_DRY_RUN` | off | `1`: post nothing in the forums; the replies go to the staff channel |
| `BOT_FORUMS` | every forum | forum channel ids to answer in |
| `BOT_STAFF` | | user or role ids of staff, besides the owner and anyone who can manage threads |
| `BOT_MODEL` | `claude-sonnet-5-5` | |
| `BOT_EFFORT` | `high` | `low` … `max`: how much the model thinks and reads before it answers |
| `BOT_MIN_CONFIDENCE` | `medium` | answers below this confidence are not posted (questions are) |
| `BOT_WAIT_S` | `120` | quiet time after the poster's last message before the look (at most 10 minutes after the first) |
| `BOT_MAX_REPLIES` | `2` | replies per thread |
| `BOT_MAX_PER_DAY` | `80` | looks per day (each costs money) |
| `BOT_ARCHIVE` | on | `0`: don't keep messages (the model then can't search other channels) |
| `BOT_STATE` | `state` (`/state` in Docker) | where the clone, the archive, the thread list and the verdicts go |
| `BOT_REPO`, `BOT_BRANCH` | this checkout, `main` | where the code comes from (in `compose.yml`: GitHub over SSH) |
| `BOT_LIVE_URL` | `https://nfsu2.xyz/game.json` | the live version (`rev`) |

Server-side fallback (`fallbacks: "default"`) is on: when Claude declines a request, the API runs it on another model
instead of returning nothing.
