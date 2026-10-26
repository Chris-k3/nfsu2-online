# Forum bot

A Discord bot for the server's forums. It looks at each new post once its author has stopped adding to it (2 minutes),
and it says something only when it is worth it:

- **in the thread**, a fix it verified in the player's guide, the code or the git history (an error code, a missed
  setting, a browser's limit, a bug fixed in the live version, with when it was fixed and since when it is live); or
  a request for what the report lacks (the log, the browser and device, the controller's model), with how to get it.
  In the poster's language, dates as Discord timestamps (each reader sees their own time zone), web addresses in
  inline code, and every reply ends with a line saying it is an automated AI reply that may be wrong;
- **in the staff channel**, a report the developer should act on, with everything needed to start: what happens,
  device, browser and version, the key log lines, the likely cause, the thread's link and its log files and saves.
  Each report gets a thread: later threads about the same problem (with what they add and their logs) and new logs
  or pictures posted in any of them go there, and the report counts the threads. Only the thread's followers are
  notified. A forum channel works as the staff channel too: each report, spike alert and daily note is a post.

- **when a fix goes live**, in a thread whose problem one of the release's commits fixes: that a fix may have solved
  it, to reload the page, and to post a new log if it still happens. Only when a full look at the thread is sure; at
  most once a thread, at most 10 threads a release, threads of the last 14 days. The report's thread notes it.

- **in the general channels** (text channels named `general…`), sparingly: someone who reports a problem there gets
  one short templated reply in their language, pointing to the forum thread about it or to the bug-reports forum,
  with how to get the log. Nothing for questions or chat, nothing when staff or another member already pointed them
  to the forum; at most once a person a week and 6 an hour a channel. A local word filter picks the candidates (about
  7% of the messages), and one Haiku call sorts each batch, so it costs a few cents a day. Spikes of complaints
  (connection, crashes, controllers, sound, graphics: 8 people or more in 15 minutes, far above the 6 hours before)
  go to the staff channel at once, without a model, and a daily note at 06:00 UTC sums up what the general channels
  kept bringing up.

Otherwise it says nothing. It reads every channel it can see, but posts only in forum threads, those replies in the
general channels, and the staff channel. It
stays out of a thread once staff wrote in it (the server owner, `BOT_STAFF`, anyone who can manage threads), and replies
at most twice in a thread: after it asked for something, the poster's next post gets one more look. Staff can mention
the bot in a thread to have it look anyway. A bump, the poster writing again after the thread was quiet for 12 hours
("any ideas?"), gets a look and a reply too (a fix, a question, or where it stands), also in a thread staff wrote in
before, unless staff answer it first; bumps while the bot was away get theirs at start.

## How it works

- `bot.mjs`: Discord (discord.js). It decides when to look, builds the thread's text, saves attachments, inlines
  pictures (PNG, JPEG, GIF, WebP up to 3.5 MB, 4 a look) and posts.
- `investigate.mjs`: one look. It sends Claude the rules (`system.md`), the maintainer's notes (`knowledge.md`),
  `docs/web/PLAYING.md`, the live version, recent commits and recent threads. Claude reads what it needs through the
  tools, then returns a verdict as JSON: none, ask or answer, and whether to tell the developer. `vet()` drops weak
  answers and replies that paste code.
- `tools.mjs`: what Claude can do. It can search and read the code, read the thread's attachments, look at the git
  history (`LIVE` is the live server's commit), search the forums' threads (to point a duplicate to the earlier one)
  and the archive of recent messages. Everything is read only: no shell, no network, no writing, and nothing outside
  the bot's own copy of the code and the attachments.
- `repo.mjs`: the bot's own clone of the code in `state/repo`, fetched at most every 5 minutes. The rules, the notes
  and the guide are read from that clone, so a pushed change to them applies within minutes, without a new image or a
  restart. The live version comes from the module file, else `https://nfsu2.xyz/game.json`. Each new live version
  goes into `state/releases.json` with its time (the module file's, which `release.sh` writes as the release goes
  out), and every commit the model reads shows when it went live.
- `archive.mjs`: every message of every channel the bot sees, kept 7 days in `state/archive/`. At start the bot reads
  the forums' threads with posts in the last 48 hours, nothing older: it lists them (titles and first posts) in
  `state/threads.json`, and looks at the ones opened in that time that it never looked at, so a restart misses no post.
- `general.mjs`: the general channels: the replies that point to the forums, the spike alerts and the daily note.
- `eval.mjs`: the bot against past threads (below).

`docker compose logs -f` shows each step as it happens: when a post is seen and when its look is due, what the look
reads (each search and file, and how much it found), the verdict, what was posted, and what went to the staff. Each
look also adds one line to `state/verdicts.jsonl`: the verdict with the developer notes, what was posted (or why not),
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
   View Channel there too. For the replies in the general channels, allow it Send Messages in those channels'
   permissions; without that it only counts them for the staff.
2. **Staff channel.** Make a private channel for staff. In its permissions, add the bot with View Channel, Send
   Messages, Attach Files, Read Message History, Create Public Threads and Send Messages in Threads. Turn on Developer Mode (User Settings, Advanced), right-click the
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
docker compose pull && docker compose up -d
docker compose logs -f
```

The bot clones the public repository into its `state` volume, and reads the live version from the game server's module
folder (`/srv/nfsu2/module`, read only): Cloudflare answers the server's own requests for game.json with a check page. If the pull is denied, the image is private on GitHub:
make it public in the package's settings, or log in once with `docker login ghcr.io -u th0mk` and a token with
`read:packages`.

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

## Trying it on past threads

`eval.mjs` runs past threads through the bot, each as a new post, and writes a report next to the cases with the bot's
reply, its staff note, and what staff or members actually answered:

```sh
node --env-file=.env eval.mjs cases.json --staff --limit 20     # 20 threads that staff answered
node --env-file=.env eval.mjs cases.json --only bug-reports/015,suggestions/008
```

`cases.json` is made from a Discord export and stays out of this repository: it holds players' posts and logs. It
stops at `--budget` dollars (default 5); a look costs a few cents.

## Rolling it out

Run it with `BOT_DRY_RUN=1` for a day. Every reply it would have posted goes to the staff channel instead, quoted, and
`state/verdicts.jsonl` has every look. When the replies look right, remove the line and run `docker compose up -d`.

## Settings

| Variable | Default | |
|---|---|---|
| `BOT_STAFF_CHANNEL` | | the staff channel's id; without it, reports for the developer are only in `verdicts.jsonl` |
| `BOT_DRY_RUN` | off | `1`: post nothing in the forums or the general channels; forum replies go to the staff channel, general-channel ones only to the log and the daily note |
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
| `BOT_LIVE_FILE` | `/live/nfsu2.json` | the live module's `nfsu2.json`, for its version (`rev`); `compose.yml` mounts `/srv/nfsu2/module` there |
| `BOT_LIVE_URL` | `https://nfsu2.xyz/game.json` | the live version when there is no such file (Cloudflare may refuse it to a server) |

Server-side fallback (`fallbacks: "default"`) is on: when Claude declines a request, the API runs it on another model
instead of returning nothing.
