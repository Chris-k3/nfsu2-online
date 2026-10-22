// The page side of runtime/web/net_proto.h: the net mailboxes in shared wasm
// memory (free roam: HostKind.Net, LAN play: HostKind.Lan; one layout) and the
// frames on the server's virtual-LAN switch.  Same numbers
// as the C header (web/test/net-proto.test.mjs checks them).  Plain constants
// only, so Node can load this file as it is.

export const NET_MAGIC = 0x314e544e;          // "NTN1"
export const NET_VERSION = 4;                 // 2: peer_bits, the LAN mailbox; 3: want, peer_bits for a /22; 4: for a /21
export const NET_HDR_BYTES = 512;
export const NET_SLOT_BYTES = 1536;
export const NET_SLOT_HDR = 32;
export const NET_MAX_PAYLOAD = 1472;
export const NET_TX_SLOTS = 128;
export const NET_RX_SLOTS = 256;
export const NET_MAILBOX_BYTES = NET_HDR_BYTES + (NET_TX_SLOTS + NET_RX_SLOTS) * NET_SLOT_BYTES;
// a module of before (version 2): a 256-byte header, no want (it always wants the switch), 8 words of peer bits
// by the address's last byte.  This page still serves it, so the page and the module need not change at once.
export const NET_V2_HDR_BYTES = 256;
export const NET_V2_MAILBOX_BYTES = NET_V2_HDR_BYTES + (NET_TX_SLOTS + NET_RX_SLOTS) * NET_SLOT_BYTES;
// a module of version 3: this layout with peer bits for a /22 (32 words); a host past them it asks itself
export const NET_V3_PEER_BITS = 1024;

// frame kinds (byte 0 of a binary frame on the switch)
export const NET_KIND_UDP = 1;                // a UDP datagram between virtual addresses
export const NET_KIND_UDP_LOOP = 2;           // test harness: the emulated loopback (always to the broadcast address)
export const NET_KIND_LAN_UDP = 3;            // LAN play (Winsock): a UDP datagram
export const NET_KIND_LAN_TCP = 4;            // LAN play: a TCP segment of the virtual LAN's stream protocol
export const NET_KIND_LAN_ICMP = 5;           // LAN play: an ICMP message
export const NET_KIND_NOTICE = 16;            // TX ring only, never sent: a line of text the page shows over the game, a friend's name first, ended by 0x1F
export const NET_KIND_LOBBY = 17;             // TX ring only, never sent: the free-roam race lobby's panel, its state as JSON ("{}": none)
export const NET_KIND_BUNDLE = 32;            // page and switch only (nfsu2-lan): several frames in one message
export const NET_BUNDLE_MAX = 32 << 10;       // bytes in one bundle the page sends at most (the switch takes 64 KB)
export const NET_BROADCAST = 0xffffffff;
export const NET_ROAM_HUB = 0x0a4d00fd;       // 10.77.0.253: the server's free-roam hub (web/server-rs/crates/roam)

// LAN header: the first NET_LAN_HDR bytes of a NET_KIND_LAN_* payload
//   [0] op  [1] ttl  [2..3] 0  [4..7] connection id (TCP, little-endian)
export const NET_LAN_HDR = 8;
export const NET_LAN_TCP_SYN = 1;
export const NET_LAN_TCP_RST = 3;
export const NET_LAN_TCP_GONE = 6;            // from the page: the source address left the switch

// mode (written by C)
export const NET_MODE_CLOSED = 0;
export const NET_MODE_VLAN = 1;
export const NET_MODE_LOOP = 2;
export const NET_MODE_LAN = 3;

// page_state (written by the page)
export const NET_PAGE_NONE = 0;
export const NET_PAGE_CONNECTING = 1;
export const NET_PAGE_ONLINE = 2;
export const NET_PAGE_OFFLINE = 3;
export const NET_PAGE_IDLE = 4;               // nothing wanted the switch for a while: the page let it go

export const NET_PEER_BITS = 2048;            // peer_bits: one bit per host of the switch's network (at most a /21)

// header words: u32 index = byte offset / 4
export const W_MAGIC = 0, W_VERSION = 1, W_HDR_BYTES = 2, W_SLOT_BYTES = 3;
export const W_TX_SLOTS = 4, W_RX_SLOTS = 5, W_TX_OFF = 6, W_RX_OFF = 7;
export const W_MODE = 8, W_PORT = 9, W_TX_HEAD = 10, W_TX_BELL = 11;          // C -> page
export const W_RX_TAIL = 12, W_C_ALIVE = 13, W_WANT = 14;
export const W_PAGE_STATE = 16, W_VIP = 17, W_NETMASK = 18, W_GENERATION = 19;   // page -> C
export const W_TX_TAIL = 20, W_RX_HEAD = 21, W_RX_BELL = 22, W_RX_FULL_DROP = 23;
export const W_TX_OFFLINE_DROP = 24, W_RX_OVERSIZE = 25, W_SWITCH_PEERS = 26;
export const W_TX_WAIT_N = 34;
export const W_PEER_BITS = 36;                // NET_PEER_BITS / 32 words: bit h = host h of our network is on the switch
// header doubles: f64 index = byte offset / 8
export const D_SWITCH_RTT_MS = 14, D_TX_WAIT_MS_SUM = 15, D_TX_WAIT_MS_MAX = 16;

// slot fields (byte offsets inside a slot; little-endian)
export const S_LEN = 0, S_KIND = 4, S_SRC_IP = 8, S_DST_IP = 12, S_SRC_PORT = 16, S_DST_PORT = 18, S_T_MS = 24, S_DATA = 32;

// a UDP frame on the switch (big-endian; web/server-rs/crates/lan)
//   [0] kind  [1..3] 0  [4..7] source vip (the switch writes it)  [8..11] destination vip
//   [12..13] source port  [14..15] destination port  [16..] the datagram
export const F_KIND = 0, F_SRC = 4, F_DST = 8, F_SPORT = 12, F_DPORT = 14, F_DATA = 16;

export function ipStr(v: number): string {
  return `${v >>> 24}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`;
}
export function ipNum(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  const b = m.slice(1).map(Number);
  if (b.some(x => x > 255)) return null;
  return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
}
