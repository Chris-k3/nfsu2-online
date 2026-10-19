# Playing NFS Underground 2 in the browser

The game runs in Google Chrome and in Firefox. One server hosts it: it keeps the game files, serves the game to the
browsers and connects players for free roam. On a Mac it serves that Mac; for other PCs it goes behind HTTPS, usually
on a VPS ([VPS.md](VPS.md)). Nothing is installed on the players' PCs, and no file is picked by hand.

## 1. Start it (on the Mac)

```sh
web/start.sh            # or: cd web && npm start
```

- The first start takes longer: it installs the page's tools and builds what is missing. Later starts go straight
  to the server, unless the code changed.
- It looks for the game in `~/projects/nsfu2/Need for Speed - Underground 2`. If the game is somewhere else, start
  once with `web/start.sh --data "/path/to/the folder with SPEED2.EXE"`. The folder is remembered.
- The game folder is only read, never changed.
- It prints the address to open. `Ctrl-C` stops the server.

| Option | What it does |
|---|---|
| `--open` | Also opens the game in Chrome on this Mac. |
| `--http-port 8080` | Use another port, if this one is taken. |
| `--no-build` | Serve what is there, without checking the build. |

On the Mac itself, open **http://localhost:8080/** and press **Play** (or Enter).

The start page shows the download, then **Ready**. Play is on once the game module has loaded, which takes a second
or two. The page shows a problem only when there is one, with what to do about it.

## 2. Other PCs

The browser runs the game only on a secure page (`https://`, or `localhost` on the machine itself), so friends play
from a server behind HTTPS: a certificate on the server, or a proxy or tunnel in front of it. [VPS.md](VPS.md) has
the ways to set that up. Each player then opens that `https://` address in the latest **Google Chrome** or
**Firefox** and presses **Play**.

The first start on a PC downloads about 7 MB of game code and, while playing, the game data it needs. That PC keeps
the data, so later starts are quick. To download all of it up front (about 3 GB), press **Download all game data**
in Game data on this PC, at the bottom of the start page. After that no loading screen waits on the network, which matters on a slow line
to a remote server.

## 3. Controls

| Key or button | What it does |
|---|---|
| Arrows or W A S D | Throttle, brake and reverse, steer |
| Alt | Nitrous |
| Space | Handbrake |
| Shift, Ctrl | Gear up, gear down (manual gearbox) |
| C, B | Camera, look back |
| R | Back on the road |
| M, Tab | Map, messages |
| Esc or P | Pause; Esc also goes back in menus |
| Enter | Choose (menus) |
| F12 | The game's screenshot, kept with your saves |
| **F8** | Frame-rate counter: off, on, detailed |
| **F9** | The page menu: when the game last saved, full screen, counter, controls, log, **Quit game** |
| **Hold Esc** | Leave full screen (a short press still goes to the game) |

The start page shows these keys under **Controls**, and F9, Controls shows them while you play.

- **Change the keys:** in the game, Options, Controls.
- **Mouse:** works in the menus.
- **Controller:** an Xbox or PlayStation pad works through the browser. The browser shows a pad to the page only
  after a button is pressed on it.
- **Rumble:** a controller that can rumble in Chrome (Xbox, DualSense and others) shakes when you crash, scrape a
  wall or land hard. Settings, Controller, Rumble turns it off. Firefox has no rumble.
- **Sound** starts with the Play click. If the browser still keeps it off, a note says so, and a click on the game or
  a key press turns it on. A controller button cannot: the browser does not count it.
- **Firefox:** Esc leaves full screen at once (Firefox has no keyboard lock); in full screen, pause with P.
- **Quit** from the game's main menu, or with F9, Quit game. Both let the game save and close. If a loading screen
  ignores the request, the same menu item then reads "Close the game now". As a last resort it reads "Stop the
  game". Closing the tab asks first, because a save in progress could be cut short.

## 4. Settings

**Online** (under Saves) and **Settings** on the start page hold this browser's `settings.ini`, the same file and
keys as the Mac app. Each change is saved at once and applies the next time you press Play.

| Group | Settings |
|---|---|
| Online | its own section under Saves: how many play on this server now, free roam with others, your name (in free roam and online), room, the game's Online mode (on by default); more: solid cars and the free-roam network |
| Game | movies, autosave; more: startup movies (skippable, original or off), sound, pause or keep running in the background, sound output latency |
| Display | full screen on Play (off: the game plays in the browser window), resolution scale, frame rate (auto follows the screen: 120 on a 120 Hz display; 60 or 120); more: HUD layout, movie framing, cutscene bars, frame-rate counter |
| Controller | rumble; more: controller on or off, menu buttons, dead zones |

- **More settings:** each group's "More … settings" has the less common ones, and says how many of them you
  changed. **Reset** next to a changed setting puts its default back.
- **Edit the file:** "Edit settings.ini as text" opens the file itself. A line the game would ignore is shown with
  the reason. A line that sets a runtime variable by its own name (`NFSU2_ROAM = 1`) shows on the row it belongs to,
  and every such line is listed under "Other variables in this file". Lines that would name a file of your saves or
  drive the game by itself (`NFSU2_REGFILE`, `NFSU2_INPUT_SCRIPT`, ...) are ignored: only the page sets those.
- **Links:** settings in a page address (`?env=...`) work only on a development server (one started with `--dev`).
  On yours a link cannot change your game; the start page says so when an address carries them.
- **The look:** the game looks as it did originally. Any graphics enhancement will be a separate setting, off
  unless you turn it on.
- **Two tabs:** one browser runs one game at a time. A second tab shows "Open elsewhere" and its Settings are
  read only. It takes over when the first tab closes.

## 5. Saves

- **Where they are:** your profiles and career are saved **in this browser, on this PC** (the site storage for
  the server's address). They are not on the server. Each address keeps its own save store, so stick to one.
- **Autosave:** the game saves your progress by itself after races, purchases and changed options. The game starts
  every profile on Save = Prompt, whose "save?" question opens on No, so Enter through the results skips the save;
  the page sets each profile to Autosave once (the game's Options, Gameplay, Save), at the first Play after the
  profile was saved. Pick Prompt or Off there and it stays. Settings, Game, Autosave off leaves the game's own setting
  alone.
- **When it saved:** "Progress saved" shows over the game each time it saves your profile, F9 shows the last save, and
  after the game closes the start page says when it last saved (or that nothing was saved during that game).
- **Backup:** Saves, Download a backup gives one zip with your profiles, the game's options (`registry.txt`),
  `settings.ini` and F12 screenshots.
- **Restore:** Saves, Restore a backup puts a zip back, on this PC or on another one. It replaces what this browser
  has, after showing what is in the zip, including what its `settings.ini` would change on the network (free roam
  on, the name others see). A very large backup keeps every save and settings file. Only screenshots past 512 MB
  are left out. Restore only backups you made yourself or trust.
- **Backups are your safety net.** The browser may clear a site's storage when the disk runs low; the Saves section
  says so when the browser has not promised to keep it. Firefox asks first, by the address bar: allow it. Make a
  backup now and then.
- **Downloading all game data:** "Download all game data" in Game data on this PC fetches the whole game folder into this browser,
  with its progress and the time left. You can play meanwhile: the download pauses while the game runs and goes on
  when it ends. Stop it whenever you like; what came is kept, and "Download the rest" goes on from there, also after
  a reload. It needs about 3 GB of free disk space. The page says so before it starts when the browser has less room.
- **Downloaded game data:** "Delete the downloaded game data" in Game data on this PC frees disk space on this PC. Your saves stay;
  the data downloads again when needed.

## 6. Free roam with other players

Free roam is shared with **everyone** on the server who turns it on. Use a Room to keep to a group.

1. Each player turns on **Online, Free roam with others** on the start page. **Online, Your name** is
   the name the others see (empty: your profile name).
2. Everyone plays from the same server's address.
3. Each player starts or loads a career and drives in free roam. Players find each other by themselves, and their
   cars appear in your city with their names over them, as in the game's own LAN races.

Good to know:

- **How many:** up to 64 players on a server (its owner can change that). The server pairs each player with the 7
  players nearest to them, and your game shows the 5 nearest cars at once; as you drive, nearer cars take the place
  of farther ones.
- **Solid cars:** you collide with the other players' cars (Online, More online settings,
  Solid cars; off: you drive through them). A car that appears on top of yours, at a garage or after a jump, lets you
  through until you are apart. Each player's own game moves their car: a car you hit is pushed in its owner's game,
  and moves on your screen as it does there.
- **Names over the cars** follow the game's own player-names option, as in its LAN races. A player who paused shows
  as "paused" there.
- **Rooms:** set the same "Room" to see only some of the players' cars. A room is a filter between players, not
  privacy: every browser on the server still sees your name ("Your name", or the profile name), whether you are in
  the menus or driving, and the room, and someone with their own tools could join it. Play on a server only with
  people you would show your name and car to.
- **Who sees what:** with free roam off (the default), the game does not join the server's network at all. With it
  on, everyone on the server sees your name and status, and players in free roam with you see your car and where it
  is. The server reads where your car is, to pick the players near you, and keeps nothing of it. Nobody sees your
  real address: the server gives each player a virtual one (`10.77.0.x`).
- **A tab in the background** (or another window in front) pauses your game. The others see you as paused: your car stays where you stopped, with "paused" after your name, until you come back.
- **Closing the tab:** the others see your car disappear after a few seconds.
- **Messages over the game** say when a player comes online, goes into a race, is back in free roam after it, or
  leaves. The menus and the shops are not announced.
- **The game's own LAN races** (its LAN menu) work between players on the same server too, with free roam on or off.

## 7. The game's Online mode

The game's own **Online** menu works again, against this server instead of EA's long-gone one: everyone who plays
from the same server address can meet there.

1. Main menu, **Online**. You go straight to the Online Main Menu under your name: **Online, Your name** on the
   start page, or your profile name when that is empty. There are no EA accounts, so the game's EA Login screens are
   skipped.
2. **Lobby** shows the games. **Create Game** (race type, track, options; Game Type Unranked), or **Refresh** and
   **Join Game**. In the game room, chat, press **Ready**; the creator presses **Start Race**.

Good to know:

- **Your name online** keeps letters, digits, `-` and `_` (at most 15): `Thom K.` plays as `Thom_K`. A changed name
  applies the next time you press Play.
- **Your name is yours while you are online.** Someone else can use it when you are not; the rankings and your EA
  Messenger friends list follow the name, so whoever plays under it while you are away sees your friends list and
  can change it. If another player is online under it, the game says so and shows its EA Login screens instead
  (below), where you can type another name.
- **No name and no profile:** the game's own EA Login screens come instead. **Use Existing EA Account**, any name
  (3 to 15 letters, digits, `-` or `_`) and any password, **Continue**; **No** to "create a profile"; your persona.
  Nothing is checked and nothing is kept: there are no accounts. Type a password you use nowhere else: the game
  sends it to the server only lightly scrambled (the server never reads it).
- **Kept on the server:** only race results per name (Rankings) and your EA Messenger friends list (names). Never
  a password: the server does not read it. Players you block stay blocked while you are online; the block is not
  kept after that.
- **Others see** your name, your game, your chat and your results, never your real address.
- **Ranked games** need three players at least, and the others see them only with the lobby's **Filter**, Game
  Type set to **Ranked**. Ranked wins give ranking points.
- **A race counts** in Rankings once two of its players' games sent the same result (every game sends its own at
  the results screen), so a race that only one player finished does not count. Each player races from their own
  browser.
- **EA Messenger:** Search finds players on this server; Send Message works. To become friends, both send a
  friend request (the other's request shows the asker in your list: open them, Send Friend Request).
- **Not yet:** game passwords (a password game is joined like an open one); the points table after a ranked race
  stays empty (the race still counts in Rankings).
- **Who is on:** Online on the start page shows how many play on this server now, and how many of them are in Online
  mode (in its menus or racing). Only the two numbers: no names.
- Turning it off: Online, Online mode on the start page (the game then cannot connect).

## 8. When something is wrong

| What you see | What to do |
|---|---|
| "Secure, isolated page" on another PC | Open the server's `https://` address, not `http`. Only `localhost` works without HTTPS. |
| "WebGPU" | Update the browser; look at `chrome://gpu` in Chrome, about:support (Graphics) in Firefox. The game needs WebGPU. Firefox has it on Windows and macOS; where it is off, Chrome plays. |
| "WebGPU" with a note about compressed textures | Nothing to do: the game plays. This GPU (in many phones, Pixels among them) cannot read the game's compressed textures, so the page unpacks them as the game loads: about 200 MB more memory, and loading screens may pause for a moment. |
| "Game download" | The download failed, or the server is not reachable. The page tries again by itself, or press **Retry**. If the module is missing, start the server with `web/start.sh`, which builds it. |
| "Open elsewhere" | The game runs in another tab of this browser. Switch to it, or close it. |
| No sound | Click the game or press a key. Check the sound setting and the output latency (try "Robust"). |
| Stuck on a loading screen | F9, Quit game; then "Close the game now"; then "Stop the game". |
| Anything odd | F9, Download log (or "Download log" on the start page after the game ended) and keep the file. It has the game's own log. Before you post it anywhere: it names your browser, its version and your system, your graphics chip, your time zone, and the names and virtual addresses of the players you met (not the server's address: only whether it was this machine, on the LAN or remote). |
| `Port 8080 is in use` when starting | The server already runs; open its address. Or start on another port: `web/start.sh --http-port 9080`. |
| Full screen | The game plays in the browser window. F9, Full screen goes full screen, and holding Esc leaves it (in Firefox, a press). "Full screen on Play" in Settings starts every game full screen. |
