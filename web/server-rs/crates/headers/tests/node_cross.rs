//! This crate against web/server/headers.mjs itself, under node: thousands of generated cases (a fixed seed) of
//! client addresses (IPv4 and IPv6 forms, brackets, zones, IPv4-mapped in dotted and hex form, garbage) and their
//! keys, Host headers and the Host check, Accept-Encoding, If-None-Match, --trusted-proxies specs (the error
//! messages too) and the trust in peers, forwarding headers, CF-Visitor, and the fixed headers.  Skipped (with a
//! message) where there is no node.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use nfsu2_headers::*;
use serde_json::{Map, Value, json};

/// SplitMix64: the same cases on every run
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
    fn chance(&mut self, num: u64, den: u64) -> bool {
        self.next() % den < num
    }
    fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[self.below(xs.len())]
    }
}

/// a network the generated addresses gather around, so that trust checks hit and miss
#[derive(Copy, Clone, Debug)]
enum Net {
    V4(u32, u32),
    V6(u128, u32),
}

fn parse_net(s: &str) -> Option<Net> {
    let (a, b) = s.split_once('/')?;
    let bits: u32 = b.parse().ok()?;
    Some(match a.parse::<std::net::IpAddr>().ok()? {
        std::net::IpAddr::V4(v) => Net::V4(u32::from(v), bits),
        std::net::IpAddr::V6(v) => Net::V6(u128::from(v), bits),
    })
}

/// an address that shares a prefix with the network, two bits longer or shorter than its own
fn near(r: &mut Rng, net: Net) -> Net {
    let delta = r.below(5) as i64 - 2;
    match net {
        Net::V4(n, p) => {
            let p2 = (p as i64 + delta).clamp(0, 32) as u32;
            let low = if p2 >= 32 { 0 } else { u32::MAX >> p2 };
            Net::V4(n ^ (r.next() as u32 & low), 32)
        }
        Net::V6(n, p) => {
            let p2 = (p as i64 + delta).clamp(0, 128) as u32;
            let low = if p2 >= 128 { 0 } else { u128::MAX >> p2 };
            let random = ((r.next() as u128) << 64) | r.next() as u128;
            Net::V6(n ^ (random & low), 128)
        }
    }
}

fn dotted(v: u32) -> String {
    format!("{}.{}.{}.{}", v >> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255)
}

/// an IPv4 address as a client, a socket or a proxy may write it
fn v4_text(r: &mut Rng, v: u32) -> String {
    let d = dotted(v);
    match r.below(12) {
        0 => format!("::ffff:{d}"),
        1 => format!("::FFFF:{d}"),
        2 => format!("0:0:0:0:0:ffff:{d}"),
        3 => format!("::ffff:{:x}:{:x}", v >> 16, v & 0xffff),
        4 => format!("::{d}"),
        5 => {
            let mut parts: Vec<String> = d.split('.').map(str::to_string).collect();
            let i = r.below(4);
            parts[i] = r.pick(&["0", "00", "01", "256", "999", "1000", "", "-1", "+1", " 1", "0x1"]).to_string();
            parts.join(".")
        }
        _ => d,
    }
}

fn groups_of(v: u128) -> [u16; 8] {
    let mut g = [0u16; 8];
    for (i, x) in g.iter_mut().enumerate() {
        *x = (v >> (112 - 16 * i)) as u16;
    }
    g
}

/// an IPv6 address in one of its many valid forms: any run of zero groups (or none) as "::", leading zeros, either
/// case, a dotted IPv4 tail
fn v6_text(r: &mut Rng, g: [u16; 8]) -> String {
    let dotted_tail = r.chance(1, 5);
    let n = if dotted_tail { 6 } else { 8 };
    let group = |r: &mut Rng, x: u16| {
        let mut s = format!("{x:x}");
        if r.chance(1, 4) {
            while s.len() < 4 && r.chance(2, 3) {
                s.insert(0, '0');
            }
        }
        if r.chance(1, 3) { s.to_uppercase() } else { s }
    };
    let mut runs = Vec::new();
    let mut i = 0;
    while i < n {
        if g[i] == 0 {
            let s = i;
            while i < n && g[i] == 0 {
                i += 1;
            }
            runs.push((s, i));
        } else {
            i += 1;
        }
    }
    let compress = (!runs.is_empty() && r.chance(3, 4)).then(|| {
        let (s, e) = *r.pick(&runs);
        let s2 = s + r.below(e - s);
        (s2, s2 + 1 + r.below(e - s2))
    });
    let tail_v4 = dotted_tail.then(|| format!("{}.{}.{}.{}", g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255));
    match compress {
        None => {
            let mut parts: Vec<String> = (0..n).map(|k| group(r, g[k])).collect();
            parts.extend(tail_v4);
            parts.join(":")
        }
        Some((s, e)) => {
            let head: Vec<String> = (0..s).map(|k| group(r, g[k])).collect();
            let mut tail: Vec<String> = (e..n).map(|k| group(r, g[k])).collect();
            tail.extend(tail_v4);
            format!("{}::{}", head.join(":"), tail.join(":"))
        }
    }
}

fn rand_v4(r: &mut Rng, nets: &[Net]) -> u32 {
    match r.below(8) {
        0 => r.next() as u32,
        1 => 0x7f00_0000 | (r.next() as u32 & 0xff_ffff),
        2 => *r.pick(&[0, u32::MAX, 0x7f00_0001, 0x0a00_0001, 0xc0a8_0001, 0x0102_0304]),
        _ => {
            let v4: Vec<Net> = nets.iter().copied().filter(|n| matches!(n, Net::V4(..))).collect();
            let net = *r.pick(&v4);
            match near(r, net) {
                Net::V4(v, _) => v,
                Net::V6(..) => unreachable!(),
            }
        }
    }
}

fn rand_v6(r: &mut Rng, nets: &[Net]) -> u128 {
    match r.below(9) {
        0 => (0..8).fold(0u128, |a, _| {
            let g = match r.below(5) {
                0 | 1 => 0,
                2 => 1 + r.below(15) as u128,
                _ => r.next() as u16 as u128,
            };
            (a << 16) | g
        }),
        1 => 0xffff_0000_0000 | rand_v4(r, nets) as u128,
        2 => rand_v4(r, nets) as u128,
        3 => *r.pick(&[0, 1, 2, 0x7f00_0001, 0xffff_7f00_0001]),
        4 => (0xfe80u128 << 112) | r.next() as u128,
        5 => (r.next() as u16 as u128) << (16 * r.below(8)),
        _ => {
            let v6: Vec<Net> = nets.iter().copied().filter(|n| matches!(n, Net::V6(..))).collect();
            let net = *r.pick(&v6);
            match near(r, net) {
                Net::V6(v, _) => v,
                Net::V4(..) => unreachable!(),
            }
        }
    }
}

const SPACES: &[&str] = &["", " ", "\t", "\u{a0}", "\u{feff}", "\u{2028}", "\u{85}", "\n", "  ", "\u{3000}", "\u{180e}", "\r\n"];
const ZONES: &[&str] = &["eth0", "25", "", "1", "a-b.c:d", "é", "x%y", "en0 ", "/", "lo"];
const ODD_ADDRESSES: &[&str] = &[
    "",
    "garbage",
    "localhost",
    ":",
    "::",
    ":::",
    "[]",
    "[::1]:80",
    "1.2.3.4:80",
    "%",
    "%eth0",
    "[%1]",
    "::ffff:",
    "::ffff:1.2.3",
    "::ffff:1.2.3.4.5",
    "::ffff:01.2.3.4",
    "::ffff:256.1.1.1",
    "1:2:3:4:5:6:7:8:9",
    "unknown",
    "_hidden",
    "[2001:db8::1]:443",
    "١.٢.٣.٤",
    "1.2.3.4\n",
    "0x7f.1",
    "1e1.2.3.4",
    "[[::1]]",
    "::FFFF:1.2.3.4",
    "::fFfF:7F00:1",
    "1:2:3:4:5:6:7::",
    "::2:3:4:5:6:7:8",
    "1::2:3:4:5:6:7",
    "0000:0000:0000:0000:0000:0000:0000:0001",
    "00000::1",
    "::1%",
    "fe80::1%%1",
];
const ADDRESS_CHARS: &[char] = &[':', ':', '.', '%', '[', ']', '0', '1', '9', 'a', 'f', 'F', 'g', ' ', '-', '/', 'é', '\u{a0}'];

/// one to two random edits: a character in, out, replaced, or a piece repeated
fn mutate(r: &mut Rng, s: &str, chars: &[char]) -> String {
    let mut c: Vec<char> = s.chars().collect();
    for _ in 0..1 + r.below(2) {
        let n = c.len();
        match r.below(4) {
            0 => c.insert(r.below(n + 1), *r.pick(chars)),
            1 if n > 0 => {
                c.remove(r.below(n));
            }
            2 if n > 0 => {
                let i = r.below(n);
                c[i] = *r.pick(chars);
            }
            3 if n > 0 => {
                let i = r.below(n);
                let j = i + 1 + r.below(n - i);
                let piece: Vec<char> = c[i..j].to_vec();
                let at = r.below(n + 1);
                c.splice(at..at, piece);
            }
            _ => {}
        }
    }
    c.into_iter().collect()
}

/// a zone, brackets, white space around
fn wrap(r: &mut Rng, mut s: String) -> String {
    if r.chance(1, 8) {
        s = format!("{s}%{}", r.pick(ZONES));
    }
    match r.below(30) {
        0..=3 => s = format!("[{s}]"),
        4 => s = format!("[{s}"),
        5 => s = format!("{s}]"),
        _ => {}
    }
    if r.chance(1, 10) {
        s = format!("{}{s}{}", r.pick(SPACES), r.pick(SPACES));
    }
    s
}

fn address(r: &mut Rng, nets: &[Net]) -> String {
    let base = match r.below(10) {
        0..=3 => {
            let v = rand_v4(r, nets);
            v4_text(r, v)
        }
        4..=8 => {
            let v = rand_v6(r, nets);
            v6_text(r, groups_of(v))
        }
        _ => r.pick(ODD_ADDRESSES).to_string(),
    };
    let s = if r.chance(1, 6) { mutate(r, &base, ADDRESS_CHARS) } else { base };
    wrap(r, s)
}

/// an address in or near one of these networks, in any form
fn address_near(r: &mut Rng, nets: &[Net]) -> String {
    let net = *r.pick(nets);
    let s = match near(r, net) {
        Net::V4(v, _) => v4_text(r, v),
        Net::V6(v, _) => v6_text(r, groups_of(v)),
    };
    if r.chance(1, 5) { wrap(r, s) } else { s }
}

const KNOWN_HOSTS: &[&str] = &[
    "localhost",
    "LOCALHOST",
    "x.localhost",
    "localhost.",
    "Game.Example.Com",
    "game.example.com",
    "a.zone.test",
    "b.a.zone.test",
    "zone.test",
    ".zone.test",
    "x.cert.example",
    "cert.example",
    "nfsu2.xyz",
    "NFSU2.XYZ",
    "a.b.example.com",
    "\u{212A}.example",
    "k.example",
    "İ.example",
    "127.0.0.1",
    "[::1]",
    "::1",
    "1.2.3.4",
    "5.6.7.8",
    "10.0.0.1",
    "[2001:db8::1]",
    "[2001:db8::2]",
    "[fe80::1]",
    "[::ffff:1.2.3.4]",
    "[::ffff:5.6.7.8]",
    "x.zone.test",
    "[::ffff:102:304]",
    "[0:0:0:0:0:0:0:1]",
    "127.0.0.1.",
    "[::1].",
    "[2001:DB8:0:0::1]",
];
const PORTS: &[&str] = &[":80", ":0", ":65535", ":99999", ":123456", ":", ":8a", "::80", ":+1", ": 80", ":０", ":443", ":8080", ":00000"];
const LABEL_CHARS: &[char] = &['a', 'b', 'c', 'x', 'y', 'z', '0', '1', '9', '_', '-'];
const ODD_LABEL_CHARS: &[char] = &['A', 'Z', 'é', '\u{212A}', 'İ', 'ß', '.', '*', ' ', '%', '@', '/', '\u{0}', ':', '[', ']', 'ǅ', 'Σ'];
const HOST_CHARS: &[char] = &['.', ':', '[', ']', 'a', 'Z', '0', '-', '_', ' ', '%', 'é', '\u{212A}'];

fn label(r: &mut Rng) -> String {
    let len = if r.chance(1, 10) { 61 + r.below(5) } else { 1 + r.below(6) };
    (0..len).map(|_| if r.chance(1, 25) { *r.pick(ODD_LABEL_CHARS) } else { *r.pick(LABEL_CHARS) }).collect()
}

fn host(r: &mut Rng, nets: &[Net]) -> String {
    let mut s = match r.below(12) {
        0 => dotted(rand_v4(r, nets)),
        1 => {
            let v = rand_v6(r, nets);
            format!("[{}]", v6_text(r, groups_of(v)))
        }
        2 => {
            let v = rand_v6(r, nets);
            v6_text(r, groups_of(v))
        }
        3 | 4 => r.pick(KNOWN_HOSTS).to_string(),
        5 => format!("{}.{}", label(r), r.pick(KNOWN_HOSTS)),
        _ => (0..1 + r.below(4)).map(|_| label(r)).collect::<Vec<_>>().join("."),
    };
    if r.chance(1, 6) {
        s.push('.');
    }
    if r.chance(1, 3) {
        s.push_str(r.pick(PORTS));
    }
    if r.chance(1, 6) {
        s = s.to_uppercase();
    }
    if r.chance(1, 8) {
        s = mutate(r, &s, HOST_CHARS);
    }
    if r.chance(1, 10) {
        s = format!("{}{s}{}", r.pick(SPACES), r.pick(SPACES));
    }
    s
}

const ENCODING_NAMES: &[&str] = &[
    "gzip",
    "br",
    "zstd",
    "deflate",
    "identity",
    "*",
    "GZIP",
    "Br",
    "ZSTD",
    "x-gzip",
    "",
    "\u{212A}",
    "k",
    " gzip ",
    "gzip\u{a0}",
    "\u{feff}br",
    "zst d",
];
const Q_PARAMS: &[&str] = &[
    "q=0",
    "q=0.0",
    "q=0.000",
    "q=0.0000",
    "q = 0",
    "q=0.",
    "q=1",
    "q=0.5",
    "Q=0",
    "q=00",
    "q=0.001",
    "level=1",
    "",
    " q=0 ",
    "q=\t0",
    "q\u{a0}=0",
    "q=0\u{2028}",
    "q=0.0 0",
    "q==0",
    "q=-0",
    "q=0e0",
    "q=\u{85}0",
    "q=0.\u{feff}00",
    "q=0.0000 ",
];
const HAVES: &[&[&str]] =
    &[&["zstd", "br", "gzip"], &["br", "gzip"], &["gzip"], &[], &["identity", "*"], &["k", ""], &["deflate", "gzip", "zstd"]];

fn accept_encoding(r: &mut Rng) -> Option<String> {
    if r.chance(1, 20) {
        return None;
    }
    let parts: Vec<String> = (0..r.below(5))
        .map(|_| {
            let mut p = r.pick(ENCODING_NAMES).to_string();
            for _ in 0..r.below(3) {
                p.push_str(r.pick(&[";", "; ", " ;", " ; "]));
                p.push_str(r.pick(Q_PARAMS));
            }
            if r.chance(1, 8) {
                p = format!("{}{p}{}", r.pick(SPACES), r.pick(SPACES));
            }
            p
        })
        .collect();
    let sep = *r.pick(&[",", ", ", " , ", ",,"]);
    Some(parts.join(sep))
}

const INM_ITEMS: &[&str] = &[
    "\"abc\"",
    "W/\"abc\"",
    " \"abc\" ",
    "*",
    " * ",
    "\"x\"",
    "w/\"abc\"",
    "W/W/\"abc\"",
    "abc",
    "",
    " W/\"abc\"",
    "\"abc\" ",
    "\u{a0}\"abc\"",
    "W/abc",
    "**",
    "\"abc",
    "W/\"x\"",
    "\u{2028}*",
];
const ETAGS: &[&str] = &["\"abc\"", "W/\"abc\"", "abc", "\"x\"", "", "W/", "*", "W/W/\"abc\""];

fn if_none_match(r: &mut Rng) -> Option<String> {
    if r.chance(1, 10) {
        return None;
    }
    let items: Vec<&str> = (0..1 + r.below(4)).map(|_| *r.pick(INM_ITEMS)).collect();
    let sep = *r.pick(&[",", ", ", " ,"]);
    Some(items.join(sep))
}

const FIXED_SPECS: &[&str] = &[
    "",
    "loopback",
    "none",
    "cloudflare",
    "10.0.0.0/8",
    "10.0.0.1",
    "2001:db8::/32",
    "[2001:db8::1]",
    "::ffff:a00:0/104",
    "0.0.0.0/0",
    "::/0",
    "::/96",
    "::ffff:0:0/96",
    "1.2.3.4/32, 5.6.7.0/24",
    "cloudflare,cloudflare",
    "fe80::1%eth0",
    "::ffff:10.0.0.1",
    " 10.0.0.0/8 , , 192.168.0.0/16 ",
    "1.2.3.4/024",
    "1.2.3.4 /24",
    "2001:db8::/0",
    "1.2.3.4/0",
    "[1.2.3.4]/8",
    "[::1]/64",
    "fe80::1%eth0/10",
    "foo",
    "1.2.3.4/33",
    "1.2.3.4/",
    "1.2.3.4/24/1",
    "::1/129",
    "1.2.3.4/+1",
    "1.2.3.4/ 24",
    "/24",
    "Cloudflare",
    "::ffff:1.2.3.4/120",
    "10.0.0.0/8,bad",
    "1.2.3.4/1234",
    "1.2.3.4/-1",
    "LOOPBACK",
    "1.2.3.4/２4",
    "01.2.3.4",
    "1.2.3.4/32/",
    "::ffff:102:304/120",
    "::ffff:1.2.3.4/32",
    "\u{a0}10.0.0.1\u{feff}",
    "none,cloudflare,10.0.0.0/8",
    "1.2.3.4/1e1",
    "::/128",
    "::/00128",
    "2001:db8::/032",
];

/// a --trusted-proxies entry, and the network it stands for where it is one
fn spec_entry(r: &mut Rng, nets: &[Net]) -> (String, Option<Net>) {
    match r.below(10) {
        0..=2 => {
            let v = rand_v4(r, nets);
            let bits = r.chance(2, 3).then(|| r.below(41) as u32);
            let text = if r.chance(1, 4) { v4_text(r, v) } else { dotted(v) };
            let text = bits.map_or(text.clone(), |b| format!("{text}/{b}"));
            (text, Some(Net::V4(v, bits.unwrap_or(32).min(32))))
        }
        3..=5 => {
            let v = rand_v6(r, nets);
            let bits = r.chance(2, 3).then(|| r.below(136) as u32);
            let text = v6_text(r, groups_of(v));
            let text = bits.map_or(text.clone(), |b| format!("{text}/{b}"));
            (text, Some(Net::V6(v, bits.unwrap_or(128).min(128))))
        }
        6 => {
            let v = rand_v4(r, nets);
            let bits = 96 + r.below(34) as u32;
            (format!("::ffff:{:x}:{:x}/{bits}", v >> 16, v & 0xffff), Some(Net::V6(0xffff_0000_0000 | v as u128, bits.min(128))))
        }
        7 => (r.pick(&["cloudflare", "loopback", "none", "Cloudflare", "", " "]).to_string(), None),
        _ => {
            let base = *r.pick(FIXED_SPECS);
            (mutate(r, base, &['/', '.', ':', ',', '1', '2', '0', 'f', ' ', '[', ']', '%']), None)
        }
    }
}

const PEERS: &[&str] = &[
    "127.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "10.1.2.3",
    "::ffff:10.1.2.3",
    "203.0.113.9",
    "2001:db8::5",
    "173.245.48.5",
    "::ffff:173.245.48.5",
    "2606:4700::6",
    "",
    "garbage",
    "[::1]",
    "fe80::1%eth0",
    "::ffff:7f00:1",
    "0:0:0:0:0:0:0:1",
    "::ffff:adf5:3005",
    "::ffff:a01:203",
];
const XFF_ODD: &[&str] = &["unknown", "", " ", "_hidden", "1.2.3.4:5678", "[2001:db8::1]:443", "127.0.0.1", "10.0.0.7", "173.245.48.9"];
const PROTOS: &[&str] = &[
    "https",
    "HTTPS",
    "http",
    "https, http",
    " https ",
    "",
    ",https",
    "wss",
    "http, https",
    "Https",
    "https\u{a0}",
    "\u{feff}https",
    "ftp",
    " , https",
    "\u{2028}https",
];

fn visitor_bases() -> Vec<String> {
    let mut v: Vec<String> = [
        r#"{"scheme":"https"}"#,
        r#"{"scheme":"http"}"#,
        r#"{"scheme":"https","scheme":"http"}"#,
        r#"{"scheme":"http","scheme":"https"}"#,
        r#"{"scheme":"https"}"#,
        "null",
        r#""https""#,
        "[]",
        "{",
        "",
        r#" {"scheme":"https"} "#,
        r#"{"scheme":"https"}x"#,
        r#"{"scheme":"https","x":"\ud800"}"#,
        r#"{"scheme":"https","n":1e400}"#,
        r#"{"scheme":"https",}"#,
        "{'scheme':'https'}",
        r#"{"scheme":["https"]}"#,
        r#"{"scheme":"https\u0000"}"#,
        r#"{"scheme" : "https" }"#,
        "\u{a0}{\"scheme\":\"https\"}",
        r#"{"a":{"scheme":"https"}}"#,
        r#"{"scheme":"https", "a": -0.5e-3}"#,
        r#"{"a":01,"scheme":"https"}"#,
        "{\"scheme\":\"https\",\"a\":\"\t\"}",
        r#"{"__proto__":{"scheme":"https"}}"#,
        r#"{"scheme":"https","a":[1,2.5e3,{"b":null,"c":true,"d":false}],"e":"\"\\\/\b\f\n\r\t"}"#,
        "{\"scheme\":\"https\"}\u{2028}",
        "{\"scheme\":\"https\",\"é\":\"\u{2028}\"}",
        r#"{"scheme":"HTTPS"}"#,
        r#"{"scheme":"https","scheme":1}"#,
        "true",
        "1",
        "-",
        "{\"scheme\":\"https\"}\n",
        "{\"\":\"\",\"scheme\":\"https\"}",
        r#"{"scheme":"https"}"#,
        r#"{"scheme":"https😀"}"#,
        r#"{"scheme":"\uD83D"}"#,
        r#"{"scheme":"https","a":{}}"#,
        r#"{"a":[],"scheme":"https"}"#,
        r#"{"scheme":"https","a":[[[]]]}"#,
        "{\"scheme\":\"https\"}\u{feff}",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    v.push(format!(r#"{{"scheme":"https","d":{}0{}}}"#, "[".repeat(300), "]".repeat(300)));
    v.push(format!(r#"{{"d":{}1{},"scheme":"https"}}"#, "{\"a\":".repeat(200), "}".repeat(200)));
    v
}
const JSON_CHARS: &[char] = &[
    '{', '}', '[', ']', '"', '"', ',', ':', '\\', ' ', 'u', '0', '1', '9', 'a', 'e', 'E', 'f', 'F', '.', '-', '+', 't', 'n', 'r', 'l', 's',
    '\t', '\n', '\r', 'é', '\u{a0}', '\u{1}', '/', 'b', 'h', 'p',
];

fn request(r: &mut Rng, nets: &[Net], visitors: &[String]) -> Value {
    let peer = match r.below(3) {
        0 => r.pick(PEERS).to_string(),
        1 => address_near(r, nets),
        _ => address(r, nets),
    };
    let mut h = Map::new();
    if r.chance(7, 10) {
        let items: Vec<String> = (0..r.below(5))
            .map(|_| match r.below(3) {
                0 => r.pick(XFF_ODD).to_string(),
                1 => address_near(r, nets),
                _ => address(r, nets),
            })
            .collect();
        let sep = *r.pick(&[",", ", ", " ,", ",,"]);
        h.insert("x-forwarded-for".into(), items.join(sep).into());
    }
    if r.chance(1, 2) {
        let cf = if r.chance(1, 4) { format!("{}, {}", address(r, nets), address(r, nets)) } else { address(r, nets) };
        h.insert("cf-connecting-ip".into(), cf.into());
    }
    if r.chance(1, 2) {
        h.insert("x-forwarded-proto".into(), r.pick(PROTOS).to_string().into());
    }
    if r.chance(1, 2) {
        let v = r.pick(visitors).clone();
        h.insert("cf-visitor".into(), v.into());
    }
    if r.chance(1, 2) {
        let fh = match r.below(4) {
            0 => format!("{}, {}", host(r, nets), host(r, nets)),
            1 => r.pick(&["", " ", ",", " , x", "\u{a0}"]).to_string(),
            _ => host(r, nets),
        };
        h.insert("x-forwarded-host".into(), fh.into());
    }
    json!({ "peer": peer, "encrypted": r.chance(1, 5), "headers": h })
}

struct FakeReq {
    peer: String,
    encrypted: bool,
    headers: HashMap<String, String>,
}

impl Req for FakeReq {
    fn peer(&self) -> &str {
        &self.peer
    }
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
    fn encrypted(&self) -> bool {
        self.encrypted
    }
}

fn fake(v: &Value) -> FakeReq {
    FakeReq {
        peer: v["peer"].as_str().unwrap().to_string(),
        encrypted: v["encrypted"].as_bool().unwrap(),
        headers: v["headers"].as_object().unwrap().iter().map(|(k, x)| (k.clone(), x.as_str().unwrap().to_string())).collect(),
    }
}

/// the file cloudflareRanges(file) reads: CRLF, comments, a BOM, a lone CR, U+2028/9, bytes that are no UTF-8
const RANGES_FILE: &[u8] = b"\xEF\xBB\xBF4.4.4.0/24\r\n# c\r\n1.2.3.0/24 # x\r\n\r\n  \xEF\xBB\xBF5.6.7.0/24\n#only\n9.9.9.9#a\rb#c\n\
\xE2\x80\xA8x#y\xE2\x80\xA9z\n\xff\xfe1.1.1.1\n\xC3\x28 2.2.2.2\n\t\x0b\x0c3.3.3.3\xc2\xa0\nlast\r";

/// node's answers to n cases: all of them, or the zips below would compare fewer
fn arr(v: &Value, n: usize) -> &Vec<Value> {
    let a = v.as_array().expect("an array of answers");
    assert_eq!(a.len(), n, "node answered {} cases of {n}", a.len());
    a
}

fn json_ws(r: &mut Rng, out: &mut String) {
    for _ in 0..r.below(3) {
        if r.chance(1, 3) {
            out.push(*r.pick(&[' ', '\t', '\n', '\r']));
        }
    }
}

fn json_string(r: &mut Rng, out: &mut String) {
    out.push('"');
    for _ in 0..r.below(6) {
        match r.below(8) {
            0 => out.push_str(r.pick(&["\\\"", "\\\\", "\\/", "\\b", "\\f", "\\n", "\\r", "\\t"])),
            // any code unit, lone surrogates too
            1 => {
                let u = r.next() as u16;
                out.push_str(&if r.chance(1, 2) { format!("\\u{u:04x}") } else { format!("\\u{u:04X}") });
            }
            2 => out.push(*r.pick(&['é', '\u{2028}', '\u{1F600}', '\u{7f}', '\u{a0}'])),
            _ => out.push(*r.pick(&['a', 's', 'c', 'h', 'e', 'm', 't', 'p', ' '])),
        }
    }
    out.push('"');
}

/// a JSON value JSON.parse takes, of every kind, with "scheme" members here and there
fn json_value(r: &mut Rng, depth: u32, out: &mut String) {
    match r.below(if depth > 3 { 5 } else { 7 }) {
        0 | 3 | 4 => json_string(r, out),
        1 => out.push_str(r.pick(&[
            "0",
            "-0",
            "1",
            "-12.5e+3",
            "1E2",
            "0.000",
            "123456789012345678901234567890",
            "1e400",
            "-1e-400",
            "5e-324",
            "1e-7",
        ])),
        2 => out.push_str(r.pick(&["true", "false", "null"])),
        5 => {
            out.push('[');
            for i in 0..r.below(4) {
                if i > 0 {
                    out.push(',');
                }
                json_ws(r, out);
                json_value(r, depth + 1, out);
                json_ws(r, out);
            }
            out.push(']');
        }
        _ => json_object(r, depth + 1, out),
    }
}

fn json_object(r: &mut Rng, depth: u32, out: &mut String) {
    out.push('{');
    for i in 0..r.below(5) {
        if i > 0 {
            out.push(',');
        }
        json_ws(r, out);
        if r.chance(1, 3) {
            out.push_str(r.pick(&[
                "\"scheme\"",
                "\"sch\\u0065me\"",
                "\"\\u0073\\u0063\\u0068\\u0065\\u006D\\u0065\"",
                "\"Scheme\"",
                "\"scheme \"",
            ]));
        } else {
            json_string(r, out);
        }
        json_ws(r, out);
        out.push(':');
        json_ws(r, out);
        if r.chance(1, 3) {
            out.push_str(r.pick(&[
                "\"https\"",
                "\"http\"",
                "\"\\u0068ttps\"",
                "\"HTTPS\"",
                "\"https\\u0000\"",
                "\"htt\\u0070s\"",
                "1",
                "null",
                "[\"https\"]",
                "{\"scheme\":\"https\"}",
                "\"https\"",
            ]));
        } else {
            json_value(r, depth, out);
        }
        json_ws(r, out);
    }
    out.push('}');
}

fn visitor_json(r: &mut Rng) -> String {
    let mut s = String::new();
    json_ws(r, &mut s);
    if r.chance(9, 10) {
        json_object(r, 0, &mut s);
    } else {
        json_value(r, 0, &mut s);
    }
    json_ws(r, &mut s);
    s
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect()
}

fn opt_str(v: Option<&str>) -> Value {
    v.map_or(Value::Null, |s| s.into())
}

#[test]
fn as_headers_mjs_answers() {
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("node is not installed: the cross-check against headers.mjs is skipped");
        return;
    }
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let headers_mjs = crate_dir.join("../../../server/headers.mjs");
    let script = crate_dir.join("tests/cross.mjs");
    let mut r = Rng(0x6e66_7375_3268_6472);

    // the networks the addresses gather around: Cloudflare's, this machine, a few private and documentation ones
    let mut nets: Vec<Net> = cloudflare_ranges(None).unwrap().iter().filter_map(|s| parse_net(s)).collect();
    for s in ["127.0.0.0/8", "10.0.0.0/8", "1.2.3.0/24", "5.6.7.0/24", "192.168.0.0/16", "0.0.0.0/0"] {
        nets.push(parse_net(s).unwrap());
    }
    for s in ["::1/128", "2001:db8::/32", "::ffff:0:0/96", "fe80::/10", "::/0", "::/96"] {
        nets.push(parse_net(s).unwrap());
    }

    let mut addresses: Vec<String> = ODD_ADDRESSES.iter().chain(PEERS).map(|s| s.to_string()).collect();
    for _ in 0..8000 {
        let a = if r.chance(1, 3) { address_near(&mut r, &nets) } else { address(&mut r, &nets) };
        addresses.push(a);
    }
    let mut hosts: Vec<Option<String>> = vec![None];
    hosts.extend(KNOWN_HOSTS.iter().map(|s| Some(s.to_string())));
    for _ in 0..5000 {
        hosts.push(Some(host(&mut r, &nets)));
    }
    let names = [
        "game.example.com",
        "*.zone.test",
        "NFSU2.XYZ",
        "1.2.3.4",
        "::1",
        "2001:DB8::1",
        "[2001:db8::2]",
        "*.",
        "bad name",
        "*.*.x",
        "fe80::1%eth0",
        "\u{212A}.example",
        "127.0.0.1:8080",
        "[::ffff:1.2.3.4]:443",
        "game.example.com",
    ];
    let cert = ["*.cert.example", "Cert.Example", "10.0.0.1", "FE80::1", "::ffff:5.6.7.8", "*.Zone.Test", "*.cert.example"];
    let host_checks =
        [(names.to_vec(), None), (names.to_vec(), Some(cert.to_vec())), (vec![], Some(vec!["*.example.com", "a.b"])), (vec![], None)];
    let encodings: Vec<(Option<String>, &[&str])> = (0..3000).map(|_| (accept_encoding(&mut r), *r.pick(HAVES))).collect();
    let etags: Vec<(Option<String>, &str)> = (0..2000).map(|_| (if_none_match(&mut r), *r.pick(ETAGS))).collect();
    let mut proxies: Vec<(String, Vec<String>)> = Vec::new();
    // the fixed specs, then 400 generated ones
    for fixed in FIXED_SPECS.iter().map(Some).chain(std::iter::repeat_n(None, 400)) {
        let (spec, spec_nets) = if let Some(fixed) = fixed {
            (fixed.to_string(), Vec::new())
        } else {
            let entries: Vec<(String, Option<Net>)> = (0..1 + r.below(3)).map(|_| spec_entry(&mut r, &nets)).collect();
            let sep = *r.pick(&[",", ", "]);
            (entries.iter().map(|e| e.0.as_str()).collect::<Vec<_>>().join(sep), entries.iter().filter_map(|e| e.1).collect())
        };
        let peers = (0..50)
            .map(|k| match k % 3 {
                0 if !spec_nets.is_empty() => address_near(&mut r, &spec_nets),
                1 => address_near(&mut r, &nets),
                _ => address(&mut r, &nets),
            })
            .collect();
        proxies.push((spec, peers));
    }
    let bases = visitor_bases();
    let mut visitors = bases.clone();
    for _ in 0..3000 {
        let base = r.pick(&bases).clone();
        visitors.push(mutate(&mut r, &base, JSON_CHARS));
    }
    for _ in 0..3000 {
        let v = visitor_json(&mut r);
        visitors.push(if r.chance(1, 3) { mutate(&mut r, &v, JSON_CHARS) } else { v });
    }
    let request_specs = ["", "10.0.0.0/8,2001:db8::/32", "cloudflare", "0.0.0.0/0", "::/0", "::ffff:0:0/96"];
    let requests: Vec<(&str, Vec<Value>)> =
        request_specs.iter().map(|&spec| (spec, (0..600).map(|_| request(&mut r, &nets, &visitors)).collect())).collect();
    let csp_with: Vec<(Vec<&str>, Vec<&str>)> =
        vec![(vec![], vec![]), (vec!["sha256-abc"], vec![]), (vec![], vec!["sha256-x", "sha256-y"]), (vec!["a b", "'"], vec!["é"])];
    let sha = ["", "x", "é", "console.log('hi')", "\u{1F600}", "a\nb"];

    let tmp = std::env::temp_dir().join(format!("nfsu2-headers-cross-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let ranges_file = tmp.join("ranges.txt");
    std::fs::write(&ranges_file, RANGES_FILE).unwrap();
    let cases = json!({
        "addresses": addresses,
        "hosts": hosts,
        "hostChecks": host_checks.iter().map(|(n, c)| json!({ "names": n, "cert": c })).collect::<Vec<_>>(),
        "encodings": encodings.iter().map(|(h, have)| json!({ "header": h, "have": have })).collect::<Vec<_>>(),
        "etags": etags.iter().map(|(h, e)| json!({ "header": h, "etag": e })).collect::<Vec<_>>(),
        "proxies": proxies.iter().map(|(s, p)| json!({ "spec": s, "peers": p })).collect::<Vec<_>>(),
        "requests": requests.iter().map(|(s, q)| json!({ "spec": s, "reqs": q })).collect::<Vec<_>>(),
        "visitors": visitors,
        "cspWith": csp_with,
        "sha": sha,
        "rangesFile": ranges_file.to_str().unwrap(),
    });
    let cases_file: PathBuf = tmp.join("cases.json");
    std::fs::write(&cases_file, serde_json::to_vec(&cases).unwrap()).unwrap();
    let run = Command::new("node").arg(&script).arg(&headers_mjs).arg(&cases_file).output().expect("node runs");
    assert!(run.status.success(), "node: {}", String::from_utf8_lossy(&run.stderr));
    let js: Value = serde_json::from_slice(&run.stdout).expect("node's answers are JSON");

    let mut bad: Vec<String> = Vec::new();
    let mut checked = 0usize;
    let mut same = |what: &dyn Fn() -> String, js: &Value, rs: Value| {
        checked += 1;
        if *js != rs {
            bad.push(format!("{}: JS {js}, Rust {rs}", what()));
        }
    };

    for (a, j) in addresses.iter().zip(arr(&js["addresses"], addresses.len())) {
        same(&|| format!("bareIp({a:?})"), &j[0], bare_ip(a).into());
        same(&|| format!("isIP({a:?})"), &j[1], is_ip(a).into());
        same(&|| format!("addressKey({a:?})"), &j[2], address_key(a).into());
        same(&|| format!("siteKey({a:?})"), &j[3], site_key(a).into());
        // isIP is isIPv4, then isIPv6
        let j_ip = j[1].as_u64().unwrap();
        same(&|| format!("isIPv4({a:?})"), &(j_ip == 4).into(), is_ipv4(a).into());
        same(&|| format!("isIPv6({a:?})"), &(j_ip == 6).into(), is_ipv6(a).into());
    }
    for (h, j) in hosts.iter().zip(arr(&js["hosts"], hosts.len())) {
        same(&|| format!("hostName({h:?})"), &j[0], host_name(h.as_deref().unwrap_or("")).into());
        same(&|| format!("isLocalOrIp({h:?})"), &j[1], is_local_or_ip(h.as_deref()).into());
    }
    for ((n, c), j) in host_checks.iter().zip(arr(&js["hostChecks"], host_checks.len())) {
        let check = HostCheck::new(&n.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        if let Some(c) = c {
            check.set_cert_names(&c.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        }
        for (h, jc) in hosts.iter().zip(arr(&j["checks"], hosts.len())) {
            same(&|| format!("makeHostCheck({n:?}, cert {c:?})({h:?})"), jc, check.check(h.as_deref()).into());
        }
        same(&|| format!("makeHostCheck({n:?}, cert {c:?}).names()"), &j["names"], check.names().into());
    }
    for ((h, have), j) in encodings.iter().zip(arr(&js["encodings"], encodings.len())) {
        same(&|| format!("pickEncoding({h:?}, {have:?})"), j, opt_str(pick_encoding(h.as_deref(), have)));
    }
    for ((h, e), j) in etags.iter().zip(arr(&js["etags"], etags.len())) {
        same(&|| format!("etagMatches({h:?}, {e:?})"), j, etag_matches(h.as_deref(), e).into());
    }
    for ((spec, peers), j) in proxies.iter().zip(arr(&js["proxies"], proxies.len())) {
        match ProxyTrust::parse(spec) {
            Err(e) => same(&|| format!("makeProxyTrust({spec:?})"), j, json!({ "error": e })),
            Ok(t) => {
                if j.get("error").is_some() {
                    same(&|| format!("makeProxyTrust({spec:?})"), j, json!({ "cloudflare": t.cloudflare, "entries": t.entries }));
                    continue;
                }
                same(&|| format!("makeProxyTrust({spec:?}).cloudflare"), &j["cloudflare"], t.cloudflare.into());
                same(&|| format!("makeProxyTrust({spec:?}).entries"), &j["entries"], t.entries.clone().into());
                for (p, jt) in peers.iter().zip(arr(&j["trust"], peers.len())) {
                    same(&|| format!("makeProxyTrust({spec:?})({p:?})"), jt, t.trusts(p).into());
                }
            }
        }
    }
    for ((spec, reqs), j) in requests.iter().zip(arr(&js["requests"], requests.len())) {
        let t = ProxyTrust::parse(spec).unwrap();
        for (q, jq) in reqs.iter().zip(arr(j, reqs.len())) {
            let f = fake(q);
            same(&|| format!("clientIp({q}) with {spec:?}"), &jq[0], client_ip(&f, &t, "x-forwarded-for").into());
            same(&|| format!("clientIp({q}, cf-connecting-ip) with {spec:?}"), &jq[1], client_ip(&f, &t, "cf-connecting-ip").into());
            same(&|| format!("viaHttps({q}) with {spec:?}"), &jq[2], via_https(&f, &t).into());
            same(&|| format!("forwardedHost({q}) with {spec:?}"), &jq[3], opt_str(forwarded_host(&f, &t).as_deref()));
        }
    }
    let local = ProxyTrust::parse("").unwrap();
    for (v, j) in visitors.iter().zip(arr(&js["visitors"], visitors.len())) {
        let f =
            FakeReq { peer: "127.0.0.1".into(), encrypted: false, headers: [("cf-visitor".to_string(), v.clone())].into_iter().collect() };
        same(&|| format!("viaHttps(cf-visitor {v:?})"), j, via_https(&f, &local).into());
    }

    let st = &js["statics"];
    let combos = [(false, true), (true, true), (false, false), (true, false)];
    for ((hsts, noindex), j) in combos.iter().zip(arr(&st["security"], combos.len())) {
        let rs: Vec<Value> = security_headers(*hsts, *noindex).into_iter().map(|(k, v)| json!([k, v])).collect();
        same(&|| format!("securityHeaders({{ hsts: {hsts}, noindex: {noindex} }})"), j, rs.into());
    }
    let pairs = |h: Vec<(&str, &str)>| -> Value { h.into_iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>().into() };
    for (kind, j) in [Cache::Store, Cache::Revalidate, Cache::Immutable].iter().zip(arr(&st["cache"], 3)) {
        same(&|| format!("cacheHeaders({kind:?})"), j, pairs(cache_headers(*kind)));
    }
    same(&|| "cacheHeaders()".into(), &st["cacheDefault"], pairs(cache_headers(Cache::Store)));
    same(&|| "CSP".into(), &st["csp"], CSP.into());
    same(&|| "PERMISSIONS_POLICY".into(), &st["permissions"], permissions_policy().into());
    same(&|| "EDGE_KEEP".into(), &st["edgeKeep"], EDGE_KEEP.into());
    same(&|| "HSTS".into(), &st["hsts"], HSTS.into());
    for ((s, st_), j) in csp_with.iter().zip(arr(&st["cspWith"], csp_with.len())) {
        same(&|| format!("contentSecurityPolicy({s:?}, {st_:?})"), j, content_security_policy(s, st_).into());
    }
    for (t, j) in sha.iter().zip(arr(&st["sha"], sha.len())) {
        same(&|| format!("sha256Source({t:?})"), j, sha256_source(t).into());
    }
    same(&|| "cloudflareRanges()".into(), &st["ranges"], cloudflare_ranges(None).unwrap().into());
    same(&|| "cloudflareRanges(file)".into(), &st["rangesFile"], cloudflare_ranges(Some(&ranges_file)).unwrap().into());
    assert_eq!(strs(&st["ranges"]).len(), cloudflare_ranges(None).unwrap().len());

    let _ = std::fs::remove_dir_all(&tmp);
    // how the answers fall: each kind of case must hit both ways for the comparison to mean much
    let count = |v: &Value, f: &dyn Fn(&Value) -> bool| v.as_array().unwrap().iter().filter(|x| f(x)).count();
    eprintln!(
        "addresses: {} of {} are IPv4, {} IPv6; hosts: {} of {} have a name; host checks: {} of {} pass",
        count(&js["addresses"], &|x| x[1] == 4),
        addresses.len(),
        count(&js["addresses"], &|x| x[1] == 6),
        count(&js["hosts"], &|x| x[0] != ""),
        hosts.len(),
        js["hostChecks"].as_array().unwrap().iter().map(|c| count(&c["checks"], &|x| x == true)).sum::<usize>(),
        hosts.len() * host_checks.len(),
    );
    eprintln!(
        "encodings: {} of {} picked; etags: {} of {} match; specs: {} of {} refused; trust: {} of {} peers trusted",
        count(&js["encodings"], &|x| !x.is_null()),
        encodings.len(),
        count(&js["etags"], &|x| x == true),
        etags.len(),
        count(&js["proxies"], &|x| x.get("error").is_some()),
        proxies.len(),
        js["proxies"].as_array().unwrap().iter().filter_map(|p| p.get("trust")).map(|t| count(t, &|x| x == true)).sum::<usize>(),
        js["proxies"].as_array().unwrap().iter().filter_map(|p| p.get("trust")).map(|t| t.as_array().unwrap().len()).sum::<usize>(),
    );
    let reqs: Vec<&Value> = js["requests"].as_array().unwrap().iter().flat_map(|s| s.as_array().unwrap()).collect();
    eprintln!(
        "requests: {} of {} not the peer (xff), {} (cf), {} https, {} forwarded host; cf-visitor: {} of {} https",
        reqs.iter()
            .zip(requests.iter().flat_map(|(_, q)| q))
            .filter(|(j, q)| j[0] != bare_ip(q["peer"].as_str().unwrap()).as_str())
            .count(),
        reqs.len(),
        reqs.iter()
            .zip(requests.iter().flat_map(|(_, q)| q))
            .filter(|(j, q)| j[1] != bare_ip(q["peer"].as_str().unwrap()).as_str())
            .count(),
        reqs.iter().filter(|j| j[2] == true).count(),
        reqs.iter().filter(|j| !j[3].is_null()).count(),
        count(&js["visitors"], &|x| x == true),
        visitors.len(),
    );
    eprintln!("{checked} answers compared with headers.mjs, {} differ", bad.len());
    for b in bad.iter().take(60) {
        eprintln!("  {b}");
    }
    assert!(bad.is_empty(), "{} answers differ from headers.mjs (the first above)", bad.len());
}
