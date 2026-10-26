# Forum bot

A Discord bot for the server's forums. It looks at each new post once its author has stopped adding to it (2 minutes).
It replies only when it has something worth saying:

- a fix it verified in the player's guide, the code or the git history (an error code, a missed setting, a browser's
  limit, a bug fixed in the live version);
- or a request for what the report lacks (the log, the browser and device, the controller's model), with how to get it.

Otherwise it says nothing. It replies in the poster's language, and every reply ends with a line saying it is an
automated AI reply that may be wrong.

It reads every channel it can see, but posts only in forum threads. It stays out of a thread once staff wrote in it
(the server owner, `BOT_STAFF`, anyone who can manage threads). It replies at most twice in a thread: after it asked for
something, the poster's next post gets one more look. Staff can mention the bot in a thread to have it look anyway.

## How it works

- `bot.mjs`: Discord (discord.js). It decides when to look, builds the thread's text, saves attachments, inlines
  pictures and posts.
- `investigate.mjs`: one look. It sends Claude `system.md` (the rules), `knowledge.md` (the maintainer's notes),
  `docs/web/PLAYING.md`, the live version, recent commits and recent threads. Claude reads what it needs through the
  tools, then returns a verdict as JSON (none, ask or answer). `vet()` drops weak answers and replies that paste code.
- `tools.mjs`: what Claude can do. It can search and read the code, read the thread's attachments, look at the git
  history (`LIVE` is the live server's commit) and search the archive of recent messages. Everything is read only:
  no shell, no network, no writing, and nothing outside the bot's own copy of the code and the attachments.
- `repo.mjs`: the bot's own clone of the code in `state/repo`, fetched at most every 5 minutes. The live version comes
  from `https://nfsu2.xyz/game.json`.
- `archive.mjs`: every message of every channel the bot sees, kept 7 days in `state/archive/`.

Each look adds one line to `state/verdicts.jsonl`: the verdict with the developer notes, what was posted (or why not),
the tools used, the tokens and the cost.

## Set up

1. **Discord.** In https://discord.com/developers/applications, create an application. Under Bot:
   - reset the token and copy it;
   - turn on **Message Content Intent** (no other intent is needed).

   Invite the bot with
   `https://discord.com/oauth2/authorize?client_id=<application id>&scope=bot&permissions=274877973504`.
   That gives it View Channels, Read Message History and Send Messages in Threads, and nothing else. Without Send
   Messages it cannot write in ordinary channels or open posts, whatever the code does.
2. **Claude.** Create an API key at https://console.anthropic.com and set a monthly spend limit there.
3. **`.env`** in this folder:

   ```sh
   DISCORD_TOKEN=...
   ANTHROPIC_API_KEY=...
   BOT_DRY_RUN=1                 # first: look and log, post nothing
   # BOT_FORUMS=123,456          # only these forum channels (default: every forum)
   # BOT_STAFF=789               # more staff: user or role ids
   ```

4. **Run** it (Node 22.9 or newer, and git):

   ```sh
   cd discord-bot && npm ci && npm start
   ```

   The first start clones the code into `state/repo`. By default it clones the checkout this folder is in. On another
   machine, set `BOT_REPO` to `git@github.com:th0mk/nfsu2-web.git`, with a deploy key that can read it.

Run it with `BOT_DRY_RUN=1` for a day first, and read `state/verdicts.jsonl`: `post` is what it would have written.
When that looks right, remove the line and restart.

To try one post without Discord:

```sh
node --env-file=.env try.mjs --title "Game crashes" "it crashes in free roam on my iphone" nfsu2-2026-10-25_151223.log
```

## Settings

| Variable | Default | |
|---|---|---|
| `BOT_DRY_RUN` | off | `1`: look and log, post nothing |
| `BOT_FORUMS` | every forum | forum channel ids to answer in |
| `BOT_STAFF` | | user or role ids of staff, besides the owner and anyone who can manage threads |
| `BOT_MODEL` | `claude-sonnet-5-5` | |
| `BOT_EFFORT` | `high` | `low` … `max`: how much the model thinks and reads before it answers |
| `BOT_MIN_CONFIDENCE` | `medium` | answers below this confidence are not posted (questions are) |
| `BOT_WAIT_S` | `120` | quiet time after the poster's last message before the look (at most 10 minutes after the first) |
| `BOT_MAX_REPLIES` | `2` | replies per thread |
| `BOT_MAX_PER_DAY` | `80` | looks per day (each costs money) |
| `BOT_ARCHIVE` | on | `0`: don't keep messages (the model then can't search other channels) |
| `BOT_STATE` | `state` | where the clone, the archive, the thread list and the verdicts go |
| `BOT_REPO`, `BOT_BRANCH` | this checkout, `main` | where the code comes from |
| `BOT_LIVE_URL` | `https://nfsu2.xyz/game.json` | the live version (`rev`) |

Server-side fallback (`fallbacks: "default"`) is on: when Claude declines a request, the API runs it on another model
instead of returning nothing.
