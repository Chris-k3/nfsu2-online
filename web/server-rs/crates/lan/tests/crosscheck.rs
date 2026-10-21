//! The switch against web/server/lan.mjs itself (node; skipped with a message without it):
//! - `clean_name` against lan.mjs `cleanName` over a corpus (random names with a fixed seed: every kind of space,
//!   control and format character, combining marks, characters NFC composes, emoji, long names);
//! - one scripted session (tests/transcript.mjs) on lan.mjs and on this switch: the same control messages byte for
//!   byte, the same datagrams, the same closes, the same info().

mod harness;

use harness::*;
use serde_json::Value;

/// the corpus's pieces (escapes only: this file stays ASCII)
const POOL: &[&str] = &[
    "a",
    "b",
    "Z",
    "q",
    "0",
    "7",
    "-",
    "_",
    ".",
    " ",
    "  ",
    "\t",
    "\n",
    "\r",
    "\u{B}",
    "\u{C}",
    "\u{A0}",
    "\u{1680}",
    "\u{2000}",
    "\u{2007}",
    "\u{200A}",
    "\u{2028}",
    "\u{2029}",
    "\u{202F}",
    "\u{205F}",
    "\u{3000}",
    "\u{FEFF}",
    "\u{85}",
    "\u{180E}",
    "\u{200B}",
    "\u{200C}",
    "\u{200D}",
    "\u{200E}",
    "\u{2060}",
    "\u{2061}",
    "\u{202A}",
    "\u{202E}",
    "\u{2066}",
    "\u{2069}",
    "\u{AD}",
    "\u{61C}",
    "\u{6DD}",
    "\u{70F}",
    "\u{8E2}",
    "\u{FFF9}",
    "\u{FFFB}",
    "\u{110BD}",
    "\u{1BCA0}",
    "\u{1D173}",
    "\u{E0001}",
    "\u{E0041}",
    "\u{E007F}",
    "\u{13430}",
    "\u{1343F}",
    "\u{0}",
    "\u{1}",
    "\u{7}",
    "\u{1B}",
    "\u{1F}",
    "\u{7F}",
    "\u{80}",
    "\u{9F}",
    "e\u{301}",
    "\u{E9}",
    "A\u{30A}",
    "\u{212B}",
    "\u{1100}\u{1161}",
    "\u{1100}\u{1161}\u{11A8}",
    "\u{AC00}",
    "\u{FB01}",
    "\u{1E9B}\u{323}",
    "\u{3D2}\u{301}",
    "\u{FA6C}",
    "\u{2126}",
    "\u{1F600}",
    "\u{1F1E6}\u{1F1E8}",
    "\u{1F44D}\u{1F3FD}",
    "\u{4E2D}",
    "\u{F1}",
    "\u{301}",
    "\u{20DD}",
    "\u{FE0F}",
    "\u{E000}",
    "\u{F8FF}",
    "\u{FFFD}",
    "\u{10FFFF}",
    "\u{FFFF}",
    "Driver",
    "player",
    "xxxxxxxxxxxxxxxxxxxx",
];

fn corpus() -> Vec<String> {
    let mut x: u32 = 0x2545_F491;
    let mut next = move || {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        x
    };
    let mut out: Vec<String> = ["", " ", "player", "Player", "  Bob  ", &"y".repeat(40), &format!("{}  b", "a".repeat(31))]
        .iter()
        .map(|s| s.to_string())
        .collect();
    for _ in 0..20_000 {
        let n = next() % 48;
        let mut s = String::new();
        for _ in 0..n {
            s.push_str(POOL[next() as usize % POOL.len()]);
        }
        out.push(s);
    }
    out
}

fn run_node(args: &[&str]) -> String {
    let out = std::process::Command::new("node").args(args).current_dir(web_dir()).output().expect("node");
    assert!(out.status.success(), "node {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).expect("UTF-8 from node")
}

// lan.mjs cleanName, over 20,000 names
#[test]
fn clean_name_is_lan_mjs_clean_name() {
    if node().is_none() {
        println!("skipped: no node");
        return;
    }
    clean_names_as_lan_mjs(&corpus());
}

// lan.mjs cleanName, every code point of planes 0-3 and 14 (and every 97th of the rest) after a letter, before a
// combining mark, and between two marks of other classes: Node's ICU is Unicode 16.0, unicode-normalization 0.1.26
// is 18.0 (what came after 16.0 must stay as it is: no decomposition, no reordering)
#[test]
fn clean_name_is_lan_mjs_clean_name_for_every_code_point() {
    if node().is_none() {
        println!("skipped: no node");
        return;
    }
    let mut names = Vec::new();
    for cp in 0..=0x10FFFFu32 {
        let plane = cp >> 16;
        if !(plane <= 3 || plane == 14 || cp % 97 == 0) {
            continue;
        }
        let Some(c) = char::from_u32(cp) else { continue };
        names.push(format!("a{c}b"));
        names.push(format!("{c}\u{301}x"));
        names.push(format!("e\u{301}{c}\u{316}"));
    }
    clean_names_as_lan_mjs(&names);
}

fn clean_names_as_lan_mjs(names: &[String]) {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("names.json");
    std::fs::write(&input, serde_json::to_string(&names).unwrap()).unwrap();
    let script = dir.path().join("clean.mjs");
    let lan = web_dir().join("server/lan.mjs");
    std::fs::write(&script, format!(
        "import fs from 'node:fs';\nimport {{ cleanName }} from {:?};\nconst a = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));\nprocess.stdout.write(JSON.stringify(a.map(cleanName)));\n",
        lan.to_str().unwrap()))
    .unwrap();
    let js: Vec<String> = serde_json::from_str(&run_node(&[script.to_str().unwrap(), input.to_str().unwrap()])).unwrap();
    assert_eq!(js.len(), names.len());
    let mut bad = Vec::new();
    for (i, n) in names.iter().enumerate() {
        let r = nfsu2_lan::clean_name(n);
        if r != js[i] {
            bad.push(format!("{n:?}: rust {r:?}, js {:?}", js[i]));
        }
    }
    println!("cleanName: {} names, {} differ", names.len(), bad.len());
    assert!(bad.is_empty(), "{} differ, e.g.\n{}", bad.len(), bad[..bad.len().min(20)].join("\n"));
}

// tests/transcript.mjs on lan.mjs and on this switch
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_session_on_lan_mjs_and_on_this_switch_is_the_same() {
    let _s = serial().await;
    if node().is_none() {
        println!("skipped: no node");
        return;
    }
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/transcript.mjs");
    let script = script.to_str().unwrap().to_string();
    let s2 = script.clone();
    let js = tokio::task::spawn_blocking(move || run_node(&[&s2, "--js"])).await.unwrap();
    let sw = start(opts()).await;
    let port = sw.port.to_string();
    let rs = tokio::task::spawn_blocking(move || run_node(&[&script, &port])).await.unwrap();
    sw.close().await;
    let js: Value = serde_json::from_str(&js).unwrap();
    let rs: Value = serde_json::from_str(&rs).unwrap();
    let mut diffs = Vec::new();
    for (k, jc) in js["clients"].as_object().unwrap() {
        let rc = &rs["clients"][k];
        for part in ["texts", "dgrams", "close"] {
            if jc[part] != rc[part] {
                diffs.push(format!("{k} {part}:\n  js   {}\n  rust {}", jc[part], rc[part]));
            }
        }
    }
    for part in ["info", "after"] {
        // the same keys in the same order, the same counts
        let (j, r) = (js[part].to_string(), rs[part].to_string());
        if j != r {
            diffs.push(format!("{part}:\n  js   {}\n  rust {}", js[part], rs[part]));
        }
    }
    let texts: usize = js["clients"].as_object().unwrap().values().map(|c| c["texts"].as_array().unwrap().len()).sum();
    let dgrams: usize = js["clients"].as_object().unwrap().values().map(|c| c["dgrams"].as_array().unwrap().len()).sum();
    println!(
        "one session: {} clients, {texts} control messages, {dgrams} datagrams; {} differences",
        js["clients"].as_object().unwrap().len(),
        diffs.len()
    );
    assert!(diffs.is_empty(), "{}", diffs.join("\n"));
}
