//! Race lobbies (roam_core.h RC_MSG_LOBBY, RC_MSG_LOBBIES): a host's advert to the hub, and the open lobbies of a
//! room with the world map's answer to a player that takes them.

mod kit;

use std::path::{Path, PathBuf};
use std::process::Command;

use kit::*;
use nfsu2_roam::RoamOptions;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..")
}

/// browser i's address: 10.77.0.2 and on
#[allow(non_snake_case)]
fn W(i: u32) -> u32 {
    0x0A4D_0002 + i
}

/// a datagram's flags set (and its CRC again)
fn with_flags(mut d: Vec<u8>, flags: u16) -> Vec<u8> {
    d[14..16].copy_from_slice(&flags.to_le_bytes());
    let len = d.len();
    let crc = crc32fast::hash(&d[..len - 4]);
    d[len - 4..].copy_from_slice(&crc.to_le_bytes());
    d
}

/// a player of core version 5 in `room`, with the lobby flag or without
fn join(k: &mut Kit, i: u32, room: &str, lobbies: bool) {
    let h = hello_with(100 + i, &HelloOpts { core: 5, room: fnv1a(room), ..Default::default() });
    k.from(W(i), &with_flags(h, if lobbies { 0x0080 } else { 0 }));
}

/// a LOBBY datagram as roam_core.c lays it out (op arg state max, to, lobby, race, x y, t, n, reserved, ids)
#[allow(clippy::too_many_arguments)]
fn lobby(sender: u32, op: u8, to: u32, id: u32, race: u32, x: i16, y: i16, state: u8, max: u8, ids: &[u32]) -> Vec<u8> {
    let mut p = vec![0u8; 24 + 4 * ids.len()];
    p[0] = op;
    p[2] = state;
    p[3] = max;
    p[4..8].copy_from_slice(&to.to_le_bytes());
    p[8..12].copy_from_slice(&id.to_le_bytes());
    p[12..16].copy_from_slice(&race.to_le_bytes());
    p[16..18].copy_from_slice(&x.to_le_bytes());
    p[18..20].copy_from_slice(&y.to_le_bytes());
    p[22] = ids.len() as u8;
    for (i, v) in ids.iter().enumerate() {
        p[24 + 4 * i..28 + 4 * i].copy_from_slice(&v.to_le_bytes());
    }
    dgram(12, sender, &p)
}

/// the LOBBIES datagrams the hub sent since the last clear: (to, req, [(x, y, race, n, max, state)])
type Lobbies = (u32, u16, Vec<(i16, i16, u32, u8, u8, u8)>);
fn lobbies(k: &Kit) -> Vec<Lobbies> {
    k.sent
        .lock()
        .iter()
        .filter(|(_, f)| f[16 + 5] == 13)
        .map(|(vip, f)| {
            let d = &f[16..];
            let n = d[18] as usize;
            let e = (0..n)
                .map(|i| {
                    let o = 19 + 11 * i;
                    let race = u32::from_le_bytes([d[o + 4], d[o + 5], d[o + 6], d[o + 7]]);
                    (i16::from_le_bytes([d[o], d[o + 1]]), i16::from_le_bytes([d[o + 2], d[o + 3]]), race, d[o + 8], d[o + 9], d[o + 10])
                })
                .collect();
            (*vip, u16::from_le_bytes([d[16], d[17]]), e)
        })
        .collect()
}

// the hosts' adverts are kept per player; a player that takes lobbies gets its room's with its world map, nearest
// first; one that does not, or of another room, does not; a closed lobby, a stale advert or a bad one is not listed
#[test]
fn the_world_map_brings_the_rooms_open_lobbies() {
    let mut k = Kit::new(RoamOptions { degree: 1, ..RoamOptions::default() });
    join(&mut k, 0, "", true);
    join(&mut k, 1, "", true);
    join(&mut k, 2, "", true);
    join(&mut k, 3, "", false);
    join(&mut k, 4, "red", true);
    for i in 0..5 {
        k.from(W(i), &snap(100 + i, [i as f64 * 100.0, 0.0, 0.0]));
    }
    // 1 and 2 host (2 nearer to 0), 4 hosts in another room; to a player, not the hub: not kept
    k.from(W(1), &lobby(101, 1, 0, 0xA1, 0x1111, 500, 0, 0, 6, &[101]));
    k.from(W(2), &lobby(102, 1, 0, 0xA2, 0x2222, 50, -20, 1, 4, &[102, 103]));
    k.from(W(4), &lobby(104, 1, 0, 0xA4, 0x4444, 0, 0, 0, 6, &[104]));
    k.from(W(3), &lobby(103, 1, 100, 0xA3, 0x3333, 0, 0, 0, 6, &[103]));
    // a bad one: the same player twice
    k.from(W(3), &lobby(103, 1, 0, 0xA5, 0x5555, 0, 0, 0, 6, &[103, 103]));
    k.hub.tick();
    k.clear();
    k.from(W(0), &mapreq(100, 7));
    assert_eq!(lobbies(&k), [(W(0), 7, vec![(50, -20, 0x2222, 2, 4, 1), (500, 0, 0x1111, 1, 6, 0)])]);
    // without the flag: the map, no lobbies; another room: its own
    k.clear();
    k.from(W(3), &mapreq(103, 1));
    assert!(lobbies(&k).is_empty() && !k.sent.lock().is_empty(), "a player that takes none gets its map only");
    k.clear();
    k.from(W(4), &mapreq(104, 1));
    assert_eq!(lobbies(&k), [(W(4), 1, vec![(0, 0, 0x4444, 1, 6, 0)])]);
    // 1 closes its lobby (another id closes nothing), 2's advert goes stale: none listed
    k.from(W(2), &lobby(102, 5, 0, 0xFF, 0x2222, 50, -20, 1, 4, &[]));
    k.from(W(1), &lobby(101, 5, 0, 0xA1, 0x1111, 500, 0, 0, 6, &[]));
    k.step(1100.0);
    k.clear();
    k.from(W(0), &mapreq(100, 8));
    assert_eq!(lobbies(&k), [(W(0), 8, vec![(50, -20, 0x2222, 2, 4, 1)])], "only 2's, closed with another id");
    k.step(3100.0);
    k.from(W(0), &snap(100, [0.0, 0.0, 0.0]));
    k.clear();
    k.from(W(0), &mapreq(100, 9));
    assert_eq!(lobbies(&k), [(W(0), 9, vec![])], "a stale advert is a lobby gone");
}

// the wire: roam_core's advert is the hub's lobby, and the hub's LOBBIES are roam_core's lobbies
#[test]
fn lobbies_on_the_wire_roam_core_and_the_hub_agree() {
    let deps = repo().join("deps");
    let wasi = std::fs::read_dir(&deps).ok().and_then(|d| {
        let mut v: Vec<PathBuf> =
            d.flatten().filter(|e| e.file_name().to_string_lossy().starts_with("wasi-sdk-")).map(|e| e.path()).collect();
        v.sort();
        v.pop()
    });
    let Some(wasi) = wasi else {
        eprintln!("no wasi-sdk in deps/: skipped");
        return;
    };
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("no node: skipped");
        return;
    }
    let w = Path::new(env!("CARGO_TARGET_TMPDIR")).join("roam_hubwire_lobby.wasm");
    let out = Command::new(wasi.join("bin/clang"))
        .current_dir(repo())
        .args(["--target=wasm32-wasip1-threads", "-pthread", "-O2", "-ffp-contract=off", "-Iruntime", "-o"])
        .arg(&w)
        .args(["web/test/roam_hubwire.c", "runtime/roam_core.c"])
        .arg("-Wl,--import-memory,--export-memory,--shared-memory,--initial-memory=67108864,--max-memory=268435456")
        .output()
        .expect("clang");
    assert!(out.status.success(), "clang: {}", String::from_utf8_lossy(&out.stderr));
    let run = |args: &[String]| -> String {
        let o = Command::new("node").arg(repo().join("web/test/wasi-run.mjs")).arg(&w).args(args).output().expect("node");
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    };
    let unhex = |s: &str| (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect::<Vec<u8>>();
    let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    // the C core's advert, from a player (its HELLO with the flag), and another player's world map: the lobby
    let mut k = Kit::new(RoamOptions { degree: 1, ..RoamOptions::default() });
    let h = hello_with(0x1234ABCD, &HelloOpts { core: 5, ..Default::default() });
    k.from(W(0), &with_flags(h, 0x0080));
    join(&mut k, 1, "", true);
    k.from(W(1), &snap(101, [0.0, 0.0, 0.0]));
    let ad = unhex(&run(&["lobby".to_string()]));
    assert_eq!(ad.len(), 16 + 24 + 8 + 4);
    k.from(W(0), &ad);
    k.clear();
    k.from(W(1), &mapreq(101, 1));
    assert_eq!(lobbies(&k), [(W(1), 1, vec![(-1234, 567, 0x0BADF00D, 2, 6, 0)])]);
    // the hub's datagrams to a C session that asks (req 1): it holds the lobby
    let frames: Vec<String> = k.sent.lock().iter().map(|(_, f)| hex(&f[16..])).collect();
    let mut args = vec!["lobbies".to_string()];
    args.extend(frames);
    let got = run(&args);
    assert_eq!(got.lines().last(), Some(format!("lobbies 1 1 -1234,567,{},2,6,0", 0x0BADF00Du32).as_str()), "{got}");
}
