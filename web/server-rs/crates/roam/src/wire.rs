//! The free-roam wire format (runtime/roam_core.h): a 16-byte header ("N2FR", version 1, type, length, sender id,
//! sequence, flags; little-endian), the payload, then the CRC-32 (zlib's) of everything before it.  And the switch's
//! frame around a datagram (nfsu2-lan): `[0]` kind, `[4..8]` source vip, `[8..12]` destination vip, `[12..16]` ports.

use crate::{PeerEntry, RoamMsg};

/// the switch's frame kinds (nfsu2-lan): a UDP datagram
pub(crate) const KIND_UDP: u8 = 1;
/// the switch's header in front of a datagram
pub(crate) const F_DATA: usize = 16;
pub(crate) const MSG_HELLO: u8 = 1;
pub(crate) const MSG_PEERS: u8 = 2;
pub(crate) const MSG_SNAP: u8 = 3;
pub(crate) const MSG_BYE: u8 = 8;
pub(crate) const MSG_MAPREQ: u8 = 10;
pub(crate) const MSG_MAP: u8 = 11;
/// a MAP entry: x, y (i16 LE, m), heading (u8, 256 a turn); at most MAP_PER of them a datagram (roam_core.h)
pub(crate) const MAP_ENTRY: usize = 5;
pub(crate) const MAP_PER: usize = 230;
pub(crate) const HDR: usize = 16;
pub(crate) const CRC: usize = 4;

/// What the hub reads of a datagram, the name borrowed (a HELLO comes every second from every player: its name is
/// compared, not copied).
#[derive(Clone, Copy)]
pub(crate) enum Msg<'a> {
    Hello {
        sender: u32,
        core: u16,
        status: u8,
        room: u32,
        name: &'a [u8],
    },
    /// v: the newest state's velocity, 0 where roam_core's decoder would not take it (not finite, 200 m/s or more);
    /// heading: where its car points, 256 a turn (the game's atan2 of the forward row, roam_game.c)
    Snap {
        sender: u32,
        status: u8,
        p: [f64; 3],
        v: [f64; 3],
        heading: u8,
    },
    /// the world map's question (roam_core.h RC_MSG_MAPREQ): req is echoed in the answer
    MapReq {
        req: u16,
    },
    Bye,
    Other,
}

fn u16_le(d: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([d[o], d[o + 1]])
}

fn u32_le(d: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([d[o], d[o + 1], d[o + 2], d[o + 3]])
}

fn f32_le(d: &[u8], o: usize) -> f64 {
    f32::from_le_bytes([d[o], d[o + 1], d[o + 2], d[o + 3]]) as f64
}

/// a state's velocity as roam_core.c's get_state takes it (in float: finite, |v|^2 at most 200^2), else 0
fn velocity(d: &[u8], o: usize) -> [f64; 3] {
    let v = [0, 4, 8].map(|k| f32::from_le_bytes([d[o + k], d[o + k + 1], d[o + k + 2], d[o + k + 3]]));
    if v.iter().all(|x| x.is_finite()) && v[0] * v[0] + v[1] * v[1] + v[2] * v[2] <= 200.0 * 200.0 { v.map(f64::from) } else { [0.0; 3] }
}

/// where a state's car points, 256 a turn: the forward row of its quaternion (i16 x y z w at o, roam_core.c rc_q2m),
/// atan2(f[1], f[0]) as roam_game.c turns it into the car's heading; 0 for a quaternion of almost nothing
fn heading(d: &[u8], o: usize) -> u8 {
    let q = [0, 2, 4, 6].map(|k| i16::from_le_bytes([d[o + k], d[o + k + 1]]) as f64 / 32767.0);
    let (f0, f1) = (1.0 - 2.0 * (q[1] * q[1] + q[2] * q[2]), 2.0 * (q[0] * q[1] + q[2] * q[3]));
    if q.iter().map(|x| x * x).sum::<f64>() < 0.25 {
        return 0;
    }
    ((f1.atan2(f0) * 128.0 / std::f64::consts::PI + 0.5).floor() as i64 & 255) as u8
}

/// One free-roam datagram, or None: the fields the hub needs (HELLO, SNAP, BYE), checked as roam_core.c's decoder
/// does.  Every index is behind a length check above it.
pub(crate) fn decode(d: &[u8]) -> Option<(u8, u32, Msg<'_>)> {
    if d.len() < HDR + CRC || d.len() > 1200 || &d[..4] != b"N2FR" || d[4] != 1 {
        return None;
    }
    let end = d.len() - CRC;
    if u16_le(d, 6) as usize != d.len() || crc32fast::hash(&d[..end]) != u32_le(d, end) {
        return None;
    }
    let (kind, sender) = (d[5], u32_le(d, 8));
    if sender == 0 {
        return None;
    }
    let m = match kind {
        MSG_HELLO => {
            if end < 29 {
                return None;
            }
            let (core, status, room, nl) = (u16_le(d, 16), d[19], u32_le(d, 24), d[28] as usize);
            if nl > 24 || end < 29 + nl + 1 || status > 5 {
                return None;
            }
            let name = &d[29..29 + nl];
            // /^[\x20-\x7e]*$/
            if !name.iter().all(|c| (0x20..=0x7e).contains(c)) {
                return None;
            }
            Msg::Hello { sender, core, status, room, name }
        }
        MSG_SNAP => {
            if end < 22 + 52 {
                return None;
            }
            let (status, n) = (d[16], d[20] as usize);
            if !(1..=3).contains(&n) || status > 5 || end != 22 + 52 * n {
                return None;
            }
            // the newest state's position
            let p = [f32_le(d, 26), f32_le(d, 30), f32_le(d, 34)];
            if !p.iter().all(|x| x.is_finite()) || p[0].abs() > 20000.0 || p[1].abs() > 20000.0 || p[2].abs() > 2000.0 {
                return None;
            }
            Msg::Snap { sender, status, p, v: velocity(d, 38), heading: heading(d, 50) }
        }
        MSG_MAPREQ if end == HDR + 2 => Msg::MapReq { req: u16_le(d, 16) },
        MSG_BYE => Msg::Bye,
        _ => Msg::Other,
    };
    Some((kind, sender, m))
}

/// One free-roam datagram, or None: what `decode` reads of it, the name its own
pub fn decode_roam(d: &[u8]) -> Option<RoamMsg> {
    let (kind, sender, m) = decode(d)?;
    Some(match m {
        // the name is printable ASCII (checked): latin1 is the bytes as they are
        Msg::Hello { sender, core, status, room, name } => {
            RoamMsg::Hello { sender, core, status, room, name: name.iter().map(|&c| c as char).collect() }
        }
        Msg::Snap { sender, status, p, .. } => RoamMsg::Snap { sender, status, p },
        Msg::Bye => RoamMsg::Bye { sender },
        Msg::MapReq { .. } | Msg::Other => RoamMsg::Other { kind, sender },
    })
}

/// the length of a PEERS datagram of n entries
pub(crate) fn peers_len(n: usize) -> usize {
    HDR + 1 + 10 * n + CRC
}

/// Writes a PEERS datagram into `b` (exactly `peers_len(n)` bytes long): list = [{ vip, port, id }] (at most 32:
/// roam_core's RC_MAX_PEERS; 7 for a core of version 1).
pub(crate) fn write_peers(b: &mut [u8], sender: u32, seq: u16, list: impl ExactSizeIterator<Item = PeerEntry>) {
    let len = b.len();
    b[..4].copy_from_slice(b"N2FR");
    b[4] = 1;
    b[5] = MSG_PEERS;
    b[6..8].copy_from_slice(&(len as u16).to_le_bytes());
    b[8..12].copy_from_slice(&sender.to_le_bytes());
    b[12..14].copy_from_slice(&seq.to_le_bytes());
    b[14..16].copy_from_slice(&[0, 0]);
    // the count's low byte: one byte holds every count roam_core reads (RC_MAX_PEERS at most, as above)
    b[16] = list.len() as u8;
    for (i, e) in list.enumerate() {
        let o = 17 + 10 * i;
        b[o..o + 4].copy_from_slice(&e.vip.to_be_bytes());
        b[o + 4..o + 6].copy_from_slice(&e.port.to_le_bytes());
        b[o + 6..o + 10].copy_from_slice(&e.id.to_le_bytes());
    }
    let crc = crc32fast::hash(&b[..len - CRC]);
    b[len - CRC..].copy_from_slice(&crc.to_le_bytes());
}

/// A PEERS datagram: `write_peers` into a buffer of its own
pub fn encode_peers(sender: u32, seq: u16, list: &[PeerEntry]) -> Vec<u8> {
    let mut b = vec![0u8; peers_len(list.len())];
    write_peers(&mut b, sender, seq, list.iter().copied());
    b
}

/// the length of a MAP datagram of n entries
pub(crate) fn map_len(n: usize) -> usize {
    HDR + 7 + MAP_ENTRY * n + CRC
}

/// One MAP datagram, part `part` of `nparts` of the answer to question `req` (roam_core.h RC_MSG_MAP) into `b`
/// (exactly `map_len(n)` bytes long): `total` players past the asker and its peers, these n of them (x, y, heading).
#[allow(clippy::too_many_arguments)]
pub(crate) fn write_map(b: &mut [u8], sender: u32, seq: u16, req: u16, part: u8, nparts: u8, total: u16, list: &[(i16, i16, u8)]) {
    let len = b.len();
    b[..4].copy_from_slice(b"N2FR");
    b[4] = 1;
    b[5] = MSG_MAP;
    b[6..8].copy_from_slice(&(len as u16).to_le_bytes());
    b[8..12].copy_from_slice(&sender.to_le_bytes());
    b[12..14].copy_from_slice(&seq.to_le_bytes());
    b[14..16].copy_from_slice(&[0, 0]);
    b[16..18].copy_from_slice(&req.to_le_bytes());
    b[18] = part;
    b[19] = nparts;
    b[20..22].copy_from_slice(&total.to_le_bytes());
    b[22] = list.len() as u8;
    for (i, &(x, y, h)) in list.iter().enumerate() {
        let o = 23 + MAP_ENTRY * i;
        b[o..o + 2].copy_from_slice(&x.to_le_bytes());
        b[o + 2..o + 4].copy_from_slice(&y.to_le_bytes());
        b[o + 4] = h;
    }
    let crc = crc32fast::hash(&b[..len - CRC]);
    b[len - CRC..].copy_from_slice(&crc.to_le_bytes());
}
