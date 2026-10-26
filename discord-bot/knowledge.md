# Maintainer's notes

The player's guide (below these notes) is the reference for what the page and the game do. These notes add what the
guide does not say: how the project runs, and what a useful report needs.

## The project

- Players open https://nfsu2.xyz in Chrome or Firefox (Safari on iOS 26 / iPadOS 26 and macOS works too, less tested)
  and press Play. The server has the game files: players need no copy of their own and install nothing. Saves stay in
  the browser, or also on the server with cloud saves (a keyphrase only the player has).
- The page updates itself: before a game it loads the new version by itself; during a game it shows "A new version of
  the game is on the server", and Reload or Play loads it. A tab left open runs the old version until then. When a fix
  is live, "reload the page" is the whole answer.
- Multiplayer: free roam with everyone on the server (Online, Free roam with others), the game's Online mode (a name,
  no EA account) and LAN-style races up to 6 players. Crews, rooms, ghost mode, quick chat, horn (N).
- The game runs in 15 languages; the page too. Touch controls on phones and tablets; pads, wheels, 8BitDo and PS2
  adapters through the browser.
- Self-hosting (the README: own copy of SPEED2.EXE v1.2 NA, Docker) is for people running their own server, not for
  players of nfsu2.xyz.

## Getting the log

The log is the most useful thing in a bug report. Say exactly how:

- During the game: F9, Download log. On a controller: Home, or both sticks pressed in. On a touch screen: the ☰ button.
- After the game ended, crashed or was quit: "Download log" on the start page.
- iPhone or iPad, the game suddenly gone and the page loaded again: the start page says so, and Download log starts
  with that last game's log. Download it before playing again: only the last game's copy is kept.
- After a "The game was stopped" (GPU-LOST) or a new version: download the log before pressing Play or Reload, the
  reload clears it.
- Attach the .log file to the post (drag it into Discord, or the + button). Not a photo of the screen, not pasted text.
- What it contains, if they ask: browser and system, graphics chip, time zone, and the names of players they met. No
  passwords, no keyphrase, no address of theirs.

## What a report needs, by problem

- Crash, freeze, black screen, stuck loading, car or world glitch: the log, what they were doing (career, free roam,
  race type, menu), and whether it happens again.
- The page shows a problem: the code it shows (`GPU-ADAPTER-WIN`, `MODULE-LOAD`, ...) or a screenshot of it. Most codes
  are in the guide's section 8 with what to do.
- Graphics or speed: browser and version, device or graphics chip, the F8 frame-rate counter's numbers, where it
  happens (free roam with many cars, races, menus). The log has all but the last.
- Controller or wheel: the model, browser, system, wired or Bluetooth, and which button or axis does what wrong.
  Controls, Controller in the page menu shows what the page sees.
- Phone or tablet: the model, Android or iOS version, browser, Home Screen app or tab.
- Online, LAN race or free roam with others: the log after the race (F9, Download log), who created the game, how many
  players, what went wrong (cars jumping, results missing, disconnect).
- Saves and cloud saves: what happened, which browsers, whether cloud saves are on. Never ask for the keyphrase.
- Sound: browser and system, the output latency setting (Settings, Game, more), what is wrong (none, late, crackling).

## Limits players hit (true as of these notes; check the guide and the code)

- No WebGPU, no game: Firefox for Android (play in Chrome), Samsung TV browsers, Samsung Xclipse graphics (some Galaxy
  phones), Windows PCs without Direct3D 12 (Intel HD 4000 and older). Chrome on Linux needs the Vulkan driver.
- iPhone: a web page cannot go full screen. Adding the page to the Home Screen (Share menu) opens it without the
  browser's bars. That copy has its own saves: cloud saves bring them over.
- Phones with little memory can lose the tab in crowded free roam: Online, More online settings, Players' cars shown
  (phones start at 16).
- Wheels: no force feedback in any browser; the clutch does nothing (the game has none).
- Stuttering cars in Online or LAN races: all updates go through the player who created the game, so the one with the
  steadiest connection should create it, and keep the game's tab in front.
- One game per browser: a second tab shows "Open elsewhere".

## What changes and what doesn't

The game plays as the original did. Additions and improvements around it are welcome: multiplayer features, quality of
life, controls, the page, languages, optional graphics settings (off by default: the original look stays the default),
fixes of the original game's crashes and glitches. Changing its core gameplay mechanics is not done: handling and physics, car
performance and tuning, AI and traffic, the career's progression, races and rewards, the economy.

- A suggestion of an addition or improvement: none (the developer reads them).
- A suggestion that would change a core mechanic: you may answer, briefly and kindly, that the project keeps the
  original game's mechanics as they are, so it won't change that. Only when it clearly is one; otherwise none.
- A "bug" that is how the original game behaves: say so when the code or the guide shows it (for example, a feature
  the guide describes as the game's own behavior); otherwise none.

## Don't

- Don't tell players to edit settings.ini variables (`NFSU2_...`) or use `?env=` links: those work only on a
  development server.
- Don't suggest mods, trainers, cheats, other builds or other sites.
- Don't answer questions about moderation, bans, kicks, names, donations, server load or the server's setup: the
  developer answers those (none).
- Don't guess at release plans or say what the developer will do.
