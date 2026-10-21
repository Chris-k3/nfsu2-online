//! Cross-checks against the JS itself (js/cross.mjs runs the Node server's own modules): the framing over a corpus,
//! the JS text and number rules, JSON.parse's messages, stats.json written and read (byte for byte), buddies.json
//! read and written, the trace's lines, and scripted sessions of the whole host (every frame out, every console
//! line, info(), the files).  Skipped, with a line, where `node` is missing.

use std::io::Write;
use std::process::{Command, Stdio};

use serde_json::{Value, json};

use crate::aries::{self, FieldMap, FrameReader, V};
use crate::jsx;
use crate::stats::{self, Race, RacePlayer, Stats, StatsOptions};

/// the JS's answer to one request, or None (no node: the test says so and passes)
pub fn node(req: &Value) -> Option<Value> {
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/js/cross.mjs");
    let mut child = match Command::new("node").arg(script).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("cross-check skipped: no node ({e})");
            return None;
        }
    };
    let body = serde_json::to_vec(req).unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let writer = std::thread::spawn(move || stdin.write_all(&body));
    let out = child.wait_with_output().unwrap();
    writer.join().unwrap().unwrap();
    assert!(out.status.success(), "node failed");
    Some(serde_json::from_slice(&out.stdout).expect("the JS's answer"))
}

/// xorshift64*: the corpus is the same every run
pub struct Rng(u64);
impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    pub fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    pub fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[self.below(xs.len())]
    }
    pub fn chance(&mut self, p: f64) -> bool {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64 <= p
    }
}

pub fn hex(b: &[u8]) -> String {
    jsx::hex(b)
}
pub fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}
/// a latin1 string as the JS side takes one (hex of its bytes)
pub fn hs(s: &str) -> String {
    let mut b = Vec::new();
    jsx::latin1_encode(s, &mut b);
    hex(&b)
}

fn latin1_of(b: &[u8]) -> String {
    jsx::latin1_decode(b)
}

/// random bytes from an alphabet weighted to what the rules care about
fn bytes(r: &mut Rng, max: usize, alphabet: &[u8]) -> Vec<u8> {
    let n = r.below(max + 1);
    (0..n).map(|_| *r.pick(alphabet)).collect()
}

#[test]
fn aries_corpus() {
    let mut r = Rng::new(1);
    let mut alpha: Vec<u8> = (0..0x20).collect();
    alpha.extend_from_slice(b"  ==\"\":%%^\x7fabcxyzABC0123456789");
    alpha.extend_from_slice(&[0x80, 0x9b, 0xa0, 0xad, 0xb5, 0xc4, 0xdf, 0xe9, 0xff]);
    let mut values: Vec<Value> = (0..400).map(|_| json!(hex(&bytes(&mut r, 20, &alpha)))).collect();
    for x in [0.1, 1e21, -0.0, 123.0, -5.5, 1e-7, 4294967295.0] {
        values.push(json!(x));
    }
    // bodies: keys (secret ones among them) and values, quoted or not, escapes good and bad, separators
    let keys = [
        "NAME", "pass", "Pass", "PASSWORD", "PASS_1", "PASS-1", "regkey", "LKEY", "lkey", "PSES", "X", "\u{df}", "\u{ff}", "\u{b5}", "A-B",
        "",
    ];
    let vals = ["x", "two words", "%41%4", "%zz", "%e9", "\"quoted value\"", "\"unterminated", "", "a=b", "\u{ff}\u{e9}"];
    let seps = [" ", "\t", "\n", "  ", "\0", " junk "];
    let mut bodies = Vec::new();
    for _ in 0..400 {
        let mut b = String::new();
        for _ in 0..r.below(6) {
            b.push_str(r.pick(&keys));
            if r.chance(0.9) {
                b.push('=');
                b.push_str(r.pick(&vals));
            }
            b.push_str(r.pick(&seps));
        }
        let mut raw = Vec::new();
        jsx::latin1_encode(&b, &mut raw);
        if r.chance(0.3) {
            raw.extend(bytes(&mut r, 10, &alpha));
        }
        bodies.push(json!(hex(&raw)));
    }
    // whole messages: kinds and codes of every length, field names good and bad
    let names = ["NAME", "A-B", "OK_1", "x+y@$~", "", "K".repeat(33).leak() as &str, "\u{e9}", "TEXT"];
    let kinds = ["auth", "+rom", "toolong", "", "\u{ff}\u{ff}\u{ff}\u{ff}", "\u{ff}\u{ff}\u{ff}\u{ff}\u{ff}", "ab"];
    let mut lists = Vec::new();
    for _ in 0..200 {
        let fields: Vec<Value> = (0..r.below(4))
            .map(|_| {
                let v = if r.chance(0.2) { json!(r.below(100000)) } else { json!(hex(&bytes(&mut r, 8, &alpha))) };
                json!([hs(r.pick(&names)), v])
            })
            .collect();
        let code = if r.chance(0.5) { String::new() } else { hs(r.pick(&kinds)) };
        lists.push(json!({ "kind": hs(r.pick(&kinds)), "code": code, "fields": fields }));
    }
    // streams: messages and junk, cut anywhere
    let mut streams = Vec::new();
    for _ in 0..150 {
        let mut all = Vec::new();
        for _ in 0..r.below(5) {
            if r.chance(0.85) {
                let text = hex(&bytes(&mut r, 90, &alpha));
                all.extend(aries::encode_frame_text("mesg", if r.chance(0.5) { "" } else { "imst" }, &latin1_of(&unhex(&text))).unwrap());
            } else {
                all.extend(bytes(&mut r, 16, &[0, 1, 0xff, b'a', 12]));
            }
        }
        let mut chunks = Vec::new();
        let mut at = 0;
        while at < all.len() {
            let n = 1 + r.below(40);
            chunks.push(json!(hex(&all[at..(at + n).min(all.len())])));
            at += n;
        }
        streams.push(json!({ "max": if r.chance(0.3) { 64 } else { 8192 }, "chunks": chunks }));
    }
    // race reports: real ones changed here and there, and strings that are not
    let real = "AwIAAQ+uAAIBAQEVQAADJ0M60exCuGZnQflKqkIogLdAsZmaQU2tD0I5HwoAAAAAAAAAAAAAAAAAAAAAAAAAAAIBFUAAAOhDO6uGQreo9kH44idCKNlYQL3CkEFciThCPgV4AAAAAAAAAAAAAAAAAAAAAAAAAA==";
    let b64 = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/-_= .*\n";
    let mut results = vec![json!(real), json!("undefined"), json!("")];
    for _ in 0..300 {
        let mut s: Vec<u8> = real.bytes().collect();
        for _ in 0..r.below(4) {
            let i = r.below(s.len());
            s[i] = *r.pick(b64);
        }
        if r.chance(0.2) {
            s.truncate(r.below(s.len()));
        }
        results.push(json!(String::from_utf8(s).unwrap()));
    }
    for _ in 0..100 {
        let mut b = vec![3u8, 1 + r.below(8) as u8];
        b.extend(bytes(&mut r, 500, &[0, 1, 2, 3, 0x0c, 0x08, 0xbf, 0x80, 0x42, 0xff, 0x7f]));
        use base64::Engine;
        results.push(json!(base64::engine::general_purpose::STANDARD.encode(&b)));
    }
    let req = json!({ "mode": "aries", "values": values, "bodies": bodies, "fieldLists": lists, "streams": streams, "results": results });
    let Some(js) = node(&req) else { return };

    for (i, v) in req["values"].as_array().unwrap().iter().enumerate() {
        let v = match v {
            Value::Number(n) => V::N(n.as_f64().unwrap()),
            Value::String(s) => V::S(latin1_of(&unhex(s))),
            _ => unreachable!(),
        };
        let mut out = Vec::new();
        aries::encode_value(&v, &mut out);
        assert_eq!(json!(hex(&out)), js["values"][i], "encodeValue {v:?}");
    }
    for (i, b) in req["bodies"].as_array().unwrap().iter().enumerate() {
        let body = unhex(b.as_str().unwrap());
        let mine: Vec<Value> =
            aries::parse_fields(&body, aries::is_secret).into_iter().map(|(k, v)| json!([hs(&k), v.map(|v| hs(&v))])).collect();
        assert_eq!(Value::Array(mine), js["fields"][i], "parseFields {}", latin1_of(&body).escape_debug());
        assert_eq!(json!(hex(aries::redact_body(&body).as_bytes())), js["redact"][i], "redactBody {}", latin1_of(&body).escape_debug());
    }
    for (i, l) in req["fieldLists"].as_array().unwrap().iter().enumerate() {
        let f: aries::Fields = l["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                let k = latin1_of(&unhex(p[0].as_str().unwrap()));
                let v = match &p[1] {
                    Value::Number(n) => V::N(n.as_f64().unwrap()),
                    Value::String(s) => V::S(latin1_of(&unhex(s))),
                    _ => unreachable!(),
                };
                (k.into(), v)
            })
            .collect();
        let kind = latin1_of(&unhex(l["kind"].as_str().unwrap()));
        let code = latin1_of(&unhex(l["code"].as_str().unwrap()));
        let mine = match aries::encode_frame(&kind, &code, &f) {
            Ok(b) => hex(&b),
            Err(e) => format!("ERR {e}"),
        };
        assert_eq!(json!(mine), js["encoded"][i], "encodeFrame {l}");
    }
    for (i, s) in req["streams"].as_array().unwrap().iter().enumerate() {
        let mut rd = FrameReader::new(s["max"].as_u64().unwrap() as usize);
        let mut got = Vec::new();
        for c in s["chunks"].as_array().unwrap() {
            for m in rd.push(&unhex(c.as_str().unwrap())) {
                got.push(json!([hs(&m.kind), hs(&m.code), hex(&m.body)]));
            }
        }
        let mine = json!({ "got": got, "error": rd.error, "pending": rd.pending() });
        assert_eq!(mine, js["streams"][i], "FrameReader {s}");
    }
    for (i, b) in req["results"].as_array().unwrap().iter().enumerate() {
        let mine = stats::decode_result(b.as_str().unwrap()).map(|r| {
            let players: Vec<Value> = r
                .players
                .iter()
                .map(|p| json!({ "index": p.index, "place": p.place, "car": p.car, "time": nfsu2_util::json::num(p.time), "dropped": p.dropped }))
                .collect();
            nfsu2_util::json::stringify(&json!({ "version": 3, "type": r.kind, "reporter": r.reporter, "track": r.track,
                "dir": r.dir, "laps": r.laps, "players": players }))
        });
        // (as values: nfsu2_util's number_to_string breaks a tie of two shortest forms upwards, JS to the even digit,
        // and a float32's time can be one; nothing the host writes or sends is)
        let parse = |s: Option<&str>| s.map(|s| serde_json::from_str::<Value>(s).unwrap());
        assert_eq!(parse(mine.as_deref()), parse(js["results"][i].as_str()), "decodeResult {b}");
    }
}

#[test]
fn text_rules() {
    let mut r = Rng::new(2);
    let mut strings: Vec<&str> = vec![
        " 12 ",
        "0x1F",
        "0X1f",
        "1e3",
        "-0",
        "Infinity",
        "-Infinity",
        "+.5",
        "0b11",
        "0o17",
        "1_0",
        "\u{a0}12\u{a0}",
        "0X",
        "5e",
        "  ",
        "-",
        "1.2.3",
        "007",
        "1e400",
        "-1e400",
        "4294967296",
        "-2147483649",
        "2147483648.7",
        "0x100000000",
        "+0x1",
        ".",
        "e5",
        "5.e3",
        "a@b\nc",
        "x/y@z",
        "@",
        "a\r@b",
        "Bravo@ea.com",
        "Bravo/PC",
        "\u{1}hello\u{7f}  world\u{ad}!\t\n",
        "  spaced   out  ",
        "\u{df}tra\u{df}e",
        "\u{ff}\u{b5}\u{e9}",
        "Abc_-12",
        "ab",
        "abcdefghijklmnop",
        "Fine_Name",
        "x y",
        "\u{9b}x",
        "\u{85}y\u{85}",
        "\u{a0}\u{a0}",
    ];
    let alpha: Vec<u8> = b" \t\n\r0123456789.-+eExXabAB@/_\x00\x01\x7f\x85\xa0\xad\xdf\xff".to_vec();
    let mut owned = Vec::new();
    for _ in 0..300 {
        owned.push(latin1_of(&bytes(&mut r, 14, &alpha)));
    }
    strings.extend(owned.iter().map(String::as_str));
    let times: Vec<f64> = (0..200).map(|_| (r.below(400_000) as f32 / 1000.0 * 1.37) as f64).chain([59.995, 119.999, 0.0, 60.0]).collect();
    let req = json!({ "mode": "text", "strings": strings.iter().map(|s| hs(s)).collect::<Vec<_>>(), "times": times });
    let Some(js) = node(&req) else { return };
    let u16hex = |s: &str| hex(&s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect::<Vec<_>>());
    for (i, s) in strings.iter().enumerate() {
        let n = jsx::to_number(s);
        let mine = json!([nfsu2_util::js::number_to_string(n), jsx::to_int32(n), jsx::to_uint32(n)]);
        assert_eq!(mine, js["numbers"][i], "Number({:?})", s);
        assert_eq!(json!(hs(&jsx::clean_text(s, 12))), js["clean"][i], "cleanText({:?})", s);
        assert_eq!(json!(hs(jsx::strip_at(s))), js["strip"][i], "replace({:?})", s);
        assert_eq!(json!(u16hex(&jsx::lower(s))), js["lower"][i], "toLowerCase({:?})", s);
        assert_eq!(json!(u16hex(&s.to_uppercase())), js["upper"][i], "toUpperCase({:?})", s);
        assert_eq!(json!(jsx::valid_name(s)), js["valid"][i], "validName({:?})", s);
    }
    for (i, t) in times.iter().enumerate() {
        assert_eq!(json!(crate::lobby::fmt_time(*t)), js["times"][i], "fmtTime({t})");
    }
}

#[test]
fn json_parse_messages() {
    let mut texts: Vec<String> = [
        "{not json",
        "",
        "abc",
        "[1,]",
        "{\"a\":1,}",
        "{\"a\":1",
        "[1",
        "tru",
        "nul",
        "nulx",
        "tr1e",
        "tr\"",
        "-",
        "-x",
        "01",
        "-01",
        "1.",
        "1.x",
        "1e",
        "1e+",
        "\"abc",
        "\"a\\x\"",
        "\"\\u12G4\"",
        "\"\\u12\"",
        "\"a\u{1}\"",
        "{\"a\" 1}",
        "{\"a\":1} x",
        "[1 2]",
        "{1:2}",
        "NaN",
        "undefined",
        "[object Object]",
        "Infinity",
        " \n {\"personas\": [}",
        "\u{feff}{}",
        "{\"a\":\"\\ud800\"}",
        "{\n\"a\":\n}",
        "{\r\n\"a\" x}",
        "[\r\r1,]",
        "{\"personas\":[{\"name\":\"Alpha\",\"seen\":\"2026-10\"},]}",
        "{\"v\":1,\"note\":\"NFSU2 online results per persona (public in the game)\",\"personas\":[{\"name\":\"Alpha\" \"seen\"}]}",
        "{\"personas\":[1,2,3]}xyz",
        "[\"\u{e9}\u{1F600}\", x]",
        "{\"a\":[1,2,{\"b\":null}],\"c\":true,\"d\":-0,\"e\":1.5e3,\"f\":\"\\u00e9\\n\"}",
        "{\"a\":1,\"a\":2,\"b\":3}",
        "  [  ]  ",
        "{}",
        "\"\\/\"",
        "[1e21, 123456789012345678901234567890]",
        "[0.1, 5e-324, 1.7976931348623157e308]",
        "{\"x\":\u{0}}",
        "[,1]",
        "{,}",
        "{\"a\":}",
        "[\"a\" \"b\"]",
        "{\"a\":1 \"b\":2}",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    texts.push(format!("{{\"personas\":[{}]}}", "{\"name\":\"Alpha\"},".repeat(5)));
    texts.push("[".repeat(3000) + &"]".repeat(3000));
    texts.push(format!("{{\"a\":\"{}\" x}}", "y".repeat(40)));
    let req = json!({ "mode": "json", "texts": texts });
    let Some(js) = node(&req) else { return };
    for (i, t) in texts.iter().enumerate() {
        let mine = match crate::jsonparse::parse(t) {
            Ok(v) => json!(["ok", nfsu2_util::json::stringify(&v)]),
            Err(e) => json!(["err", e]),
        };
        // a lone surrogate is read as U+FFFD here (jsonparse.rs): both read the file, the string differs
        if t.contains("\\ud800") {
            assert_eq!((mine[0].as_str(), js[i][0].as_str()), (Some("ok"), Some("ok")));
            continue;
        }
        assert_eq!(mine, js[i], "JSON.parse({:?})", t.chars().take(80).collect::<String>());
    }
}

fn quiet() -> crate::LogFn {
    std::rc::Rc::new(|_: &str, _: Option<&str>| {})
}

const T0: f64 = 1_792_411_200_000.0; // Date.UTC(2026, 9, 19, 12)

#[test]
fn stats_json_byte_for_byte() {
    let mut r = Rng::new(3);
    let names =
        ["Alpha", "alpha", "Bravo", "BRAVO", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet", "Kilo", "Lima"];
    let mut ops = Vec::new();
    let mut t = T0;
    for i in 0..400 {
        let mut op = serde_json::Map::new();
        if r.chance(0.1) {
            t += [3_600_000.0, 86_400_000.0, 20.0 * 86_400_000.0, 45.0 * 86_400_000.0][r.below(4)];
            op.insert("at".into(), json!(t));
        }
        if i % 23 == 22 {
            op.insert("ask".into(), json!(r.pick(&names)));
            op.insert("monthly".into(), json!(r.chance(0.5)));
        } else {
            let n = r.below(7);
            let mut pool: Vec<&str> = names.to_vec();
            let players: Vec<Value> = (0..n)
                .map(|k| {
                    let name = pool.remove(r.below(pool.len()));
                    let place = if r.chance(0.15) { 0 } else { k + 1 };
                    let time = if r.chance(0.1) { 0.0 } else { (r.below(300_000) as f32 / 997.0) as f64 };
                    json!({ "name": name, "place": place, "time": time })
                })
                .collect();
            op.insert(
                "race".into(),
                json!({ "type": r.below(7), "ranked": r.chance(0.5), "track": *r.pick(&[1, 7, 4014, 65535, 300]), "players": players }),
            );
        }
        ops.push(Value::Object(op));
    }
    let tmp = tempfile::tempdir().unwrap();
    let (jsdir, rsdir) = (tmp.path().join("js"), tmp.path().join("rs"));
    let req = json!({ "mode": "stats", "dir": jsdir, "t0": T0, "max": 9, "pruneMonths": 2, "ops": ops });
    let Some(js) = node(&req) else { return };

    let clock = std::rc::Rc::new(std::cell::Cell::new(T0));
    let mut o = StatsOptions::new(Some(rsdir.clone()), stats::tests::clocks(clock.clone()), quiet());
    o.save_ms = 1e12;
    o.max = 9;
    o.prune_months = 2;
    let mut st = Stats::new(o);
    let mut asks = Vec::new();
    for op in &ops {
        if let Some(at) = op.get("at") {
            clock.set(at.as_f64().unwrap());
        }
        if let Some(race) = op.get("race") {
            st.add_race(&Race {
                kind: race["type"].as_u64().unwrap() as u32,
                ranked: race["ranked"].as_bool().unwrap(),
                track: race["track"].as_i64().unwrap(),
                players: race["players"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| RacePlayer {
                        name: p["name"].as_str().unwrap().into(),
                        place: p["place"].as_u64().unwrap() as u32,
                        time: p["time"].as_f64().unwrap(),
                    })
                    .collect(),
            });
        }
        if let Some(name) = op.get("ask").and_then(Value::as_str) {
            let monthly = op["monthly"].as_bool().unwrap();
            let boards: Vec<Value> = (0..6)
                .map(|k| {
                    Value::Array(
                        st.board(k, monthly)
                            .iter()
                            .map(|r| {
                                json!([
                                    r.name,
                                    nfsu2_util::json::num(r.points),
                                    nfsu2_util::json::num(r.wins),
                                    nfsu2_util::json::num(r.losses),
                                    nfsu2_util::json::num(r.races)
                                ])
                            })
                            .collect(),
                    )
                })
                .collect();
            let prefix: String = name.to_lowercase().chars().take(2).collect();
            asks.push(json!({ "stat": st.stat_field(Some(name), false), "month": st.stat_field(Some(name), true), "boards": boards,
                "found": st.starting_with(&prefix, 5) }));
        }
    }
    st.stop();
    assert_eq!(Value::Array(asks), js["asks"], "the boards, STAT fields and the search");
    let mine = std::fs::read_to_string(rsdir.join("stats.json")).unwrap();
    let theirs = js["file"].as_str().unwrap();
    assert_eq!(mine, theirs, "stats.json byte for byte");

    // the JS's file read back here and written again: the same bytes
    std::fs::write(rsdir.join("stats.json"), theirs).unwrap();
    let mut o = StatsOptions::new(Some(rsdir.clone()), stats::tests::clocks(clock.clone()), quiet());
    o.max = 9;
    let mut again = Stats::new(o);
    again.force_dirty();
    again.save();
    assert_eq!(std::fs::read_to_string(rsdir.join("stats.json")).unwrap(), theirs, "the JS's file, read and written again");
}

#[test]
fn stats_json_read_leniently() {
    let files: Vec<String> = [
        "{not json",
        "",
        "[]",
        "null",
        "\u{feff}{}",
        "{\"personas\":\"x\"}",
        "{\"personas\":[null,5,{\"name\":5},{\"name\":\"ab\"},{\"name\":\"Okay\",\"all\":\"abc\"},{\"name\":\"Okay2\",\"all\":[{\"races\":2},0,true,\"x\",[1]]}]}",
        "{\"personas\":[{\"name\":\"Dup\",\"seen\":\"2026-01\"},{\"name\":\"dup\",\"seen\":\"2025-12\",\"all\":{\"1\":{\"races\":3,\"rw\":2.5,\"points\":1e400}}}]}",
        "{\"personas\":[{\"name\":\"Best\",\"best\":{\"0:1\":5,\"0:1234567\":5,\"1:2\":-1,\"9:9\":1e400,\"2:3\":\"5\",\"00:1\":3,\"5:12\":0.5,\"3\":4,\"1:20\":7.25}}]}",
        "{\"personas\":[{\"name\":\"Mo\",\"month\":\"x\",\"seen\":\"2026-1\"},{\"name\":\"Nn_\",\"month\":{\"key\":\"2026-13\",\"t\":{\"0\":{\"races\":-0,\"dc\":9e9}}},\"seen\":\"2026-11\"}]}",
        "{\"personas\":[{\"name\":\"Fag\",\"seen\":\"2026-01\"},{\"name\":\"Fine\",\"seen\":\"2026-02\",\"all\":{\"0\":null,\"2\":{},\"6\":{\"races\":1}}}]}",
        "{\"v\":1,\"personas\":[{\"name\":\"Alpha\",\"seen\":\"2026-10\",\"all\":{\"0\":{\"races\":1,\"rw\":1,\"rl\":0,\"uw\":0,\"ul\":0,\"points\":100,\"dc\":0}},\"month\":{\"key\":\"2026-10\",\"t\":{}},\"best\":{}}],\"extra\":[1,2]}",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let tmp = tempfile::tempdir().unwrap();
    let (jsdir, rsdir) = (tmp.path().join("js"), tmp.path().join("rs"));
    let req = json!({ "mode": "stats-load", "dir": jsdir, "t0": T0, "files": files });
    let Some(js) = node(&req) else { return };
    for (i, text) in files.iter().enumerate() {
        let dir = rsdir.join(format!("l{i}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("stats.json"), text).unwrap();
        let lines = std::rc::Rc::new(std::cell::RefCell::new(Vec::<String>::new()));
        let l2 = lines.clone();
        let log: crate::LogFn = std::rc::Rc::new(move |s: &str, _: Option<&str>| {
            let s = match s.find(".bad-") {
                Some(at) => {
                    let end = s[at + 5..].find(|c: char| !c.is_ascii_digit()).map_or(s.len(), |e| at + 5 + e);
                    format!("{}.bad-<t>{}", &s[..at], &s[end..])
                }
                None => s.to_string(),
            };
            l2.borrow_mut().push(s)
        });
        let mut o = StatsOptions::new(Some(dir.clone()), stats::tests::clocks(std::rc::Rc::new(std::cell::Cell::new(T0))), log);
        o.save_ms = 1e12;
        let mut st = Stats::new(o);
        st.force_dirty();
        st.save();
        let out = std::fs::read_to_string(dir.join("stats.json")).ok();
        let js_dir = jsdir.join(format!("l{i}")).display().to_string();
        let theirs_lines: Vec<String> =
            js[i]["lines"].as_array().unwrap().iter().map(|l| l.as_str().unwrap().replace(&js_dir, &dir.display().to_string())).collect();
        assert_eq!(*lines.borrow(), theirs_lines, "the lines for {text:?}");
        assert_eq!(json!(out), js[i]["out"], "the file written again for {text:?}");
    }
}

#[test]
fn buddies_json_read_and_written() {
    let mut big = String::from("{\"personas\":[{\"name\":\"Many\",\"seen\":\"2026-03\",\"B\":[");
    for i in 0..60 {
        big.push_str(&format!("{}\"Friend{i}\"", if i > 0 { "," } else { "" }));
    }
    big.push_str("]}]}");
    let files: Vec<String> = [
        "{not json",
        "",
        "{\"v\":2,\"note\":\"NFSU2 online friends lists (persona names only)\",\"personas\":[{\"name\":\"Alpha\",\"seen\":\"2026-10\",\"B\":[\"Bravo\",\"Charlie\"]}]}",
        "{\"personas\":[{\"name\":\"Alpha\",\"seen\":\"2026-10\",\"B\":[\"Bravo\",\"bravo\",\"x y\",5,null,\"Delta\"],\"I\":[\"Mallory\"]},{\"name\":\"alpha\",\"seen\":\"2026-09\",\"B\":[\"Echo\"]}]}",
        "{\"personas\":[{\"name\":\"NoFriends\",\"seen\":\"2026-10\",\"B\":[]},{\"name\":\"Bad Name\",\"B\":[\"Alpha\"]},{\"name\":\"Old\",\"B\":[\"Alpha\"]},{\"name\":\"Mid\",\"seen\":\"2026-05\",\"B\":[\"Alpha\"]},{\"name\":\"New\",\"seen\":\"2026-12\",\"B\":\"Alpha\"},{\"name\":\"Newer\",\"seen\":\"2027-01\",\"B\":[\"Zed\"]}]}",
        big.as_str(),
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let tmp = tempfile::tempdir().unwrap();
    let (jsdir, rsdir) = (tmp.path().join("js"), tmp.path().join("rs"));
    let req = json!({ "mode": "buddies", "dir": jsdir, "t0": T0, "files": files, "limits": { "lists": 3 } });
    let Some(js) = node(&req) else { return };
    for (i, text) in files.iter().enumerate() {
        let dir = rsdir.join(format!("b{i}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("buddies.json"), text).unwrap();
        let b = crate::buddy::Buddies::new(Some(dir.clone()), crate::buddy::BuddyLimits { lists: 3.0, ..Default::default() });
        assert_eq!(json!(b.serialize()), js[i], "buddies.json read and written again from {text:?}");
    }
}

#[test]
fn trace_lines() {
    use crate::vhost::lan_frame;
    let ip = super::world::ip;
    let (a, b, h) = (ip("10.77.0.2"), ip("10.77.0.3"), crate::VHOST_VIP);
    let msg = |kind: &str, f: aries::Fields, sep: u8| aries::encode_frame_sep(kind, "", &f, sep).unwrap();
    let mut frames: Vec<Vec<u8>> = vec![
        lan_frame(4, a, h, 50000, 20922, 1, 7, &[]),
        lan_frame(4, h, a, 20922, 50000, 2, 7, &[]),
        lan_frame(
            4,
            a,
            h,
            50000,
            20922,
            4,
            7,
            &msg("auth", fields![("NAME", "Bob"), ("PASS", "secret"), ("PASSWORD", "x"), ("REGKEY", "k")], b'\n'),
        ),
        lan_frame(4, h, a, 20922, 50000, 4, 7, &msg("pers", fields![("PERS", "Bob"), ("LKEY", "abcdef")], b'\t')),
        lan_frame(4, a, h, 50000, 20922, 4, 7, &aries::encode_frame_text("mesg", "", "TEXT=hi there").unwrap()),
        lan_frame(4, a, h, 50000, 20922, 4, 7, &aries::encode_frame_text("mesg", "mute", "TEXT=x\u{1}y").unwrap()),
        lan_frame(4, a, h, 50000, 20922, 4, 7, &aries::encode_frame_text("~png", "", "").unwrap()),
        lan_frame(4, a, h, 50000, 20922, 4, 7, &aries::encode_frame_text("+who", "", "NOSEP").unwrap()),
        lan_frame(4, a, h, 50001, 9900, 4, 8, b"part"),
        lan_frame(4, a, h, 50001, 9900, 4, 8, &[0, 0, 0, 0, 0, 0, 0, 3]),
        lan_frame(4, a, h, 50000, 20922, 5, 7, &[]),
        lan_frame(4, h, a, 20922, 50000, 3, 7, &[]),
        lan_frame(4, a, b, 3658, 3658, 4, 1, b"race traffic"),
        lan_frame(3, a, h, 20922, 20922, 0, 0, b"udp"),
        vec![4, 0, 0],
    ];
    let both = [msg("snap", fields![("INDEX", 1)], b' '), msg("+snp", fields![("N", "A")], b'\n')].concat();
    frames.push(lan_frame(4, h, b, 20922, 40000, 4, 9, &both[..20]));
    frames.push(lan_frame(4, h, b, 20922, 40000, 4, 9, &both[20..]));
    let tmp = tempfile::tempdir().unwrap();
    let req = json!({ "mode": "trace", "file": tmp.path().join("t.txt"), "frames": frames.iter().map(|f| hex(f)).collect::<Vec<_>>() });
    let Some(js) = node(&req) else { return };
    let mut st = crate::trace::TraceState::new(Vec::new(), 0);
    for f in &frames {
        st.frame(0, f);
    }
    st.flush();
    let strip = |text: &str| -> Vec<String> { text.lines().map(|l| l.split_once(' ').map_or(l, |x| x.1).to_string()).collect() };
    let theirs = strip(js["text"].as_str().unwrap());
    assert!(theirs[0].starts_with("--- trace started "));
    let mine = strip(&String::from_utf8(st_out(st)).unwrap());
    assert_eq!(mine, theirs[1..], "the trace's lines");
}

fn st_out(st: crate::trace::TraceState<Vec<u8>>) -> Vec<u8> {
    st.into_inner()
}

// ---- scripted sessions of the whole host ----

/// the session's random values masked (SESS, MASK, SKEY, LKEY, AUTH, SEED): a frame as text
fn canon(vip: u32, f: &[u8], refused: bool) -> String {
    let (sport, dport) = (u16::from_be_bytes([f[12], f[13]]), u16::from_be_bytes([f[14], f[15]]));
    let cid = u32::from_le_bytes([f[20], f[21], f[22], f[23]]);
    let mut s = format!("{vip} k{} op{} {sport}>{dport} #{cid}{}", f[0], f[16], if refused { " refused" } else { "" });
    let p = &f[24..];
    if p.is_empty() {
        return s;
    }
    if sport != crate::PORT_HTTP {
        let mut rd = FrameReader::new(1 << 16);
        let msgs = rd.push(p);
        if rd.error.is_none() && rd.pending() == 0 {
            for m in msgs {
                s.push_str(&format!(" | {}/{}", m.kind, m.code));
                for (k, v) in FieldMap::parse_with(&m.body, |_| false).0 {
                    let masked = matches!(k.as_str(), "SESS" | "MASK" | "SKEY" | "LKEY" | "AUTH" | "SEED");
                    s.push_str(&format!(" {k}={}", if masked { "<r>".into() } else { format!("{:?}", v.unwrap_or_default()) }));
                }
            }
            return s;
        }
    }
    s.push_str(" raw ");
    s.push_str(&hex(p));
    s
}

/// a race report for n players, the same as js/cross.mjs `resu`
fn resu(n: usize, seed: u64) -> String {
    let mut b = vec![0u8; 8 + 55 * n];
    b[0] = 3;
    b[1] = n as u8;
    b[2] = (seed % 7) as u8;
    b[4..6].copy_from_slice(&4014u16.to_be_bytes());
    b[7] = 2;
    for i in 0..n {
        let o = 8 + 55 * i;
        b[o] = i as u8;
        b[o + 1] = ((i as u64 + seed) % n as u64) as u8 + 1;
        b[o + 2] = if (seed + i as u64).is_multiple_of(5) { 0x0c } else { 1 };
        let t = (25.0 + i as f64 * 1.5 + (seed % 7) as f64 * 10.25) as f32;
        b[o + 8..o + 12].copy_from_slice(&t.to_be_bytes());
    }
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(b)
}

use super::session::generate;

#[test]
fn sessions_frame_for_frame() {
    // (NFSU2_SESSIONS=<n>: n of them; 8 by default)
    let n: u64 = std::env::var("NFSU2_SESSIONS").ok().and_then(|v| v.parse().ok()).unwrap_or(8);
    for seed in 11..11 + n {
        let s = generate(seed, 900);
        super::session::run_both(&s, seed);
    }
}

/// the same with odd switch frames, streams that reset in the middle of a message, overlapping sessions of one
/// browser, and time passing on the timers' clock (the services' time-outs, the game list's and the populations'
/// once-a-second, held-back presence, the Messenger login tried again, the files' saves)
#[test]
fn sessions_with_timers_frame_for_frame() {
    // (NFSU2_SESSIONS=<n>: n of them; 8 by default)
    let n: u64 = std::env::var("NFSU2_SESSIONS").ok().and_then(|v| v.parse().ok()).unwrap_or(8);
    for seed in 1011..1011 + n {
        let s = super::session::generate_ext(seed, 900);
        super::session::run_both(&s, seed);
    }
}

pub(super) fn canon_frame(vip: u32, f: &[u8], refused: bool) -> String {
    canon(vip, f, refused)
}
pub(super) fn resu_of(n: usize, seed: u64) -> String {
    resu(n, seed)
}
