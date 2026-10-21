# The server in Rust

A port of the Node server (`web/server/*.mjs`) to Rust, side by side with it, to be measured against it and to take
its place.  It takes the same options and environment (`NFSU2_*`), prints the same lines, keeps the same files in the
state folder (`etag.key`, `lan-addresses.json`, `online/stats.json`, `online/buddies.json`, byte for byte, so either
server can take over the other's folder) and answers the same way, rule for rule: the reasoning behind each rule is
in the `.mjs` files and the audits they name, and the Rust says which JS it ports.

Why: Node runs everything on one thread.  On nfsu2.xyz (2026-10-20/21: 850-1075 players, 690-880 of them in free
roam) that thread was at 85-100 % while the 16-core VPS was mostly idle, and the hub had to give free-roam players
12-24 links instead of 32.  This server spreads the switch over the cores.

## Build and run

    web/server-rs/build.sh            # -> out/web/server-rs/nfsu2-server (and nfsu2-roamload, the load generator)
    web/server-rs/build.sh --test     # and the workspace's own tests
    out/web/server-rs/nfsu2-server --data "<NFSU2 folder>" --http-port 8081 --state /tmp/state-rs

It needs Rust (https://rustup.rs) and a C compiler (zstd and mimalloc are C).  Both servers can run at once on
different ports; give each its own `--state`.  Knobs for measurements, from the environment:

| | |
|---|---|
| `NFSU2_THREADS` | the runtime's workers (default half the cores, 2 to 8: more did the same work for more CPU) |
| `NFSU2_BUNDLE_MS` | a fixed tick for the bundle clock (default: it follows the crowd, below; 0: no clock, each datagram wakes its writer at once) |
| `NFSU2_BUNDLE_MAX_MS`, `NFSU2_BUNDLE_BUDGET` | the adaptive tick's longest (25 ms) and its aim (125,000 bundles a second in all) |
| `NFSU2_LAN_SNDBUF` | SO_SNDBUF of /lan connections (default the kernel's own) |
| `NFSU2_REPO` | where the defaults are (web/dist, out/web/nfsu2.wasm, the state in out/web/server): the repo it was built from |

## The container image

`web/server-rs/Dockerfile` (its own `.dockerignore` next to it) makes the Node image's equal in every way a VPS
sees: the page, the mounts (`/game`, `/module`, `/state`), the user (uid 1000, so the Node image's state volume stays
writable), the options, the environment and the health check, with one static binary (musl, cross-compiled with
cargo-zigbuild, so arm64 needs no emulation; 22 MB in all; it took no more CPU than the native build for 500 players in
free roam).  `.github/workflows/image-rs.yml` publishes it as
`ghcr.io/<owner>/<repo>-rs` with the Node image's tags (`latest`, `sha-<commit>`, versions).  A VPS switches with one
line in its `.env` (web/deploy/compose.yml; docs/web/VPS.md, "The server in Rust"), and back with the old one:

    NFSU2_IMAGE=ghcr.io/th0mk/nfsu2-web-rs:sha-<commit>

## The JS tests and tools against it

`NFSU2_SERVER=rust` makes the tests and tools below start this binary where they started web/server/server.mjs
(`web/tools/server-cmd.mjs`; `NFSU2_SERVER_BIN` for another binary; unset, they start Node as they always did):

    NFSU2_SERVER=rust node --test --test-concurrency=1 web/test/deploy.test.mjs
    NFSU2_SERVER=rust node --test web/test/audit.test.mjs web/test/players.test.mjs web/test/module.test.mjs web/test/data-blocks.test.mjs
    NFSU2_SERVER=rust node --test --test-name-pattern server.mjs web/test/lan.test.mjs
    NFSU2_SERVER=rust node web/tools/online-pair.mjs ...      # and lan-pair, roam-pair, online-load

They pass against it as they pass against Node (data-blocks' "past the 128 compressors" fails on both on a machine
whose loopback buffers hold a whole answer).  Real games: online-pair (two games log in, race, the result recorded)
and roam-pair (a friend's car shown at 0.10 m from where it is) pass against it.  (offline-test, predownload-test
and deploy-e2e start Node whatever NFSU2_SERVER says.)

`web/tools/server-compare.mjs` runs the same load against both, one after the other, and compares them.  Its `crowd`
load is `nfsu2-roamload`: up to 2000 simulated free-roam players (each a /lan WebSocket that takes bundles, a HELLO
and SNAPs to the hub, 20 snapshots a second to every friend the hub gives it), light enough to leave the cores to the
server, which measures what players feel: friends per player, snapshots lost, a snapshot's delay from player to
player, their pings, the messages each way.  `mix` is free roam and Online clients at once, as nfsu2.xyz has them.

    unshare -rn bash -c 'ip link set lo up; node web/tools/server-compare.mjs --load crowd,mix --n 2000 --seconds 60 \
        --server-cpus 0-11 --gen-cpus 12-23 --gen-threads 12'

On WSL run it inside a network namespace of its own (`unshare -rn`): with mirrored networking 127.0.0.1 goes through
Hyper-V's virtual NIC and netfilter, which cost more than the server (the VPS's tunnel reaches the server over a plain
loopback).  `--server-cpus`/`--gen-cpus` keep the server and the load on cores of their own, as two machines would.

## Measured (2026-10-21, 91e270c, Ryzen 9 5900X, WSL, the server on 6 cores, the load on the other 6)

| 2000 players in free roam | Node | Rust |
|---|---|---|
| players on the switch | 1339 (still joining) | 1999 (the ping probe is the 2000th: full) |
| friends per player | 8 (the hub's busy cap) | 32 |
| snapshot deliveries a second | 286,000 | 1,342,000 (all of them) |
| snapshots lost | 2.7 % | 0 |
| a snapshot's delay, player to player, p50 / p99 | 190 ms / 1.9 s | 11 / 22 ms |
| the switch's ping p50 / p99 | 40 / 526 ms | 0.7 / 6.8 ms |
| messages to the players a second | 14,000 | 131,000 |
| server CPU | 1.1 cores (its one thread full) | 4.0 cores |
| memory | 457 MB | 220 MB |

| 1800 in free roam and 200 in Online mode | Node | Rust |
|---|---|---|
| friends per player | 8 | 32 |
| a snapshot's delay p50 / p99 | 210 ms / 1.2 s | 10 / 22 ms |
| Online login p50 / p95 | 225 / 534 ms | 12 / 30 ms |
| Online chat p50 / p95 | 50 / 258 ms | 2.5 / 8.2 ms |
| races started in 60 s | 375 | 627 |

What a crowd costs is its messages, not its bytes: three quarters of the server's CPU is the kernel's TCP for each
WebSocket message (and the tunnel in front, cloudflared, pays for each again).  The bundle clock's tick decided it
(2000 players, 32 friends each): 4 ms sent 374,000 messages a second for 8.5 cores and did not keep up; 16 ms,
132,000 messages for 4.2 cores, everything.  So the tick follows the crowd: 4 ms up to 500 players taking bundles,
then as long as it takes to send about 125,000 bundles a second in all, 25 ms at most (free roam draws friends' cars
100 ms in the past).  And the worker count: 2.9 cores on 4 workers, 3.8 on 8, 4.3 on 12, the same latency up to 8.

## How the work is shared out

- **HTTP** (nfsu2-http): the server's own HTTP/1.1 and TLS (rustls), a task per connection on a tokio runtime of
  several workers.  Not hyper: the audits' rules need answers of the server's own to requests a library refuses by
  itself, the pipelining cut, a keep-alive time per connection, and the connection budget before any TLS.
- **The switch** (nfsu2-lan): each connection's reader routes the frames it reads itself, on whatever worker it runs.
  Who is on the switch changes under one lock; frames find their receivers without it (a table of the 2000
  addresses, a copy-on-write list of everyone).  Each receiver's writer takes everything queued into one write, and
  makes bundles of a page's datagrams on the bundle clock.  Counters every frame touches are sharded.
- **The Online host and the free-roam hub** (nfsu2-online, nfsu2-roam): single-threaded as in Node, each on a thread
  of its own; the switch posts them their frames in order.  Past 4096 frames waiting at the Online host, a reader
  that feeds it waits (TCP backpressure, as Node's busy thread gave); the hub's busy cap reads the runtime's workers'
  busy time (Node read its one thread's event-loop use).
- **Compression** of the game data's runs on a pool of its own at a lower priority, so a burst of downloads never
  queues in front of the switch (Cloudflare serves the runs on nfsu2.xyz: this is the origin's cold start).

## The crates

| crate | ports | |
|---|---|---|
| nfsu2-util | (shared) | JS-compatible text and numbers (`\s`, `trim`, `Number#toString`, `toFixed`, `JSON.stringify`), token buckets and budgets, sharded counters, clocks, the busy measures, the switch's host interface |
| nfsu2-names | names.mjs | a name that reads as a slur |
| nfsu2-headers | headers.mjs | the headers every answer carries, who the client is, the server's own names |
| nfsu2-http | Node's http/https + server.mjs's limits | the HTTP/1.1 engine and TLS |
| nfsu2-ws | the ws library | the WebSocket handshake and frames |
| nfsu2-lan | lan.mjs | the switch |
| nfsu2-roam | roam-hub.mjs | the free-roam hub |
| nfsu2-online | online/*.mjs | the game's Online mode |
| nfsu2-server (src/) | server.mjs | the routes, the rules, the wiring, the start-up |
| nfsu2-roamload | (roam-crowd.mjs) | 2000 simulated free-roam players |

Each crate ports its JS unit tests case for case, and what must match exactly is checked against the JS itself, which
the tests run in node over large inputs: names (1.1 million), the headers' functions, the hub's links (20,000 PEERS
lists, rooms of up to 2100), cleanName (every code point of planes 0-3 and 14), number printing (half a million
doubles), stats.json and buddies.json, the lobby protocol, a scripted switch session byte for byte.
`web/server-rs/tests/` puts the switch, the hub and the Online host together as the server wires them, fuzzes the
binary, and runs it beside Node's server on one scenario, comparing start-up lines, /players, console and files.

## Porting rules (for changes to either server)

A change to `web/server` needs the same change here, or the two drift: the JS is the specification, and the tests of
both (NFSU2_SERVER=rust) check them against each other.  The same bytes on the wire and on disk (`nfsu2_util::json`
for what JSON.stringify wrote, `nfsu2_util::js` for JS's text and number semantics, Unicode tables held at Node's
ICU version, Unicode 16), nothing a client sends may panic or hold resources past their end, and nothing shared by
every frame (no lock or atomic all frames touch, no allocation a `Bytes` slice spares).

## Known differences

- Compressed bytes (gzip and br) differ from Node's zlib; the decoded content is the same.
- Bundles are made on the bundle clock (above), not per turn of an event loop; between different kinds of message
  only the order differs.
- The Online host's sends are charged to a sender's budgets on the host's thread, a moment after the frame was routed
  (lan.mjs did it synchronously).
- The hub's busy cap reads the workers' busy time; `[roam] the server's thread was N % busy` keeps its words.
- JSON a client sends: a lone surrogate escape reads as U+FFFD; a number beyond the doubles or nesting deeper than
  128 makes the switch ignore that message, where JS took it.
- Pipelined requests are answered one after the other (Node ran their handlers at once and wrote the answers in
  order); what a client sees is the same.  The engine's other edge cases are in `crates/http/src/lib.rs`.
