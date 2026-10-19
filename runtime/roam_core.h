/* roam_core.h -- free-roam multiplayer: the portable core.
 *
 * Wire format (version 1), session (peers, handshake, gossip, timeouts, rate
 * limits, address policy), interpolation (clock offset, jitter buffer,
 * Hermite / nlerp, dead reckoning, error blending) and the car-look record.
 *
 * Portable C99 for the Mac port (arm64) and a Windows ASI (i686): no OS
 * headers, no libm, no threads, no allocation.  Every wire field goes
 * through explicit little-endian put/get helpers; no struct is ever copied
 * to or from the wire, so struct layout differences between LP64 and ILP32
 * do not matter.  Floats use only + - * / and sqrt (IEEE correctly rounded),
 * so a build with -ffp-contract=off gives the same bits on both platforms.
 *
 * Threading is the caller's business: every function that takes a session
 * must be called with the caller's session lock held.  Time is passed in as
 * microseconds of a monotonic clock (int64).
 */
#ifndef ROAM_CORE_H
#define ROAM_CORE_H
#include <stdint.h>
#include <stddef.h>

#define RC_PROTO_VER     1          /* header byte 4; a different value is ignored */
#define RC_CORE_VER      1          /* HELLO: implementation revision */
#define RC_MAGIC0        0x4E       /* "N2FR" */
#define RC_MAGIC1        0x32
#define RC_MAGIC2        0x46
#define RC_MAGIC3        0x52
#define RC_DEFAULT_PORT  47210
#define RC_MAX_DGRAM     1200       /* never IP-fragmented (< 1280) */
#define RC_HDR           16
#define RC_CRC           4
#define RC_NAME_MAX      24
#define RC_MAX_PLAYERS   8          /* the mesh: this machine + 7 peers */
#define RC_MAX_PEERS     (RC_MAX_PLAYERS - 1)
#define RC_TABLE         16         /* known addresses (configured, gossiped, heard) */
#define RC_SNAP_STATES   3          /* states per SNAP (newest first): loss redundancy */
#define RC_STATE_BYTES   52
#define RC_BUF_STATES    32         /* jitter buffer per peer */
#define RC_OFFWIN        64         /* clock-offset samples per peer */
#define RC_CFG_MAX       2048       /* car-look record, bytes */
#define RC_CFG_FRAG      1000       /* bytes per CFG fragment */
#define RC_CFG_MAXFRAG   3
#define RC_PART_SLOTS    170        /* RideInfo part slots */
#define RC_CFG_TYPE_NAME 16
#define RC_PERF_BYTES    52         /* car-look record extension 1 */
#define RC_EXT_PERF      1

/* message types (header byte 5) */
enum { RC_MSG_HELLO = 1, RC_MSG_PEERS = 2, RC_MSG_SNAP = 3, RC_MSG_CFG = 4, RC_MSG_CFG_REQ = 5,
       RC_MSG_PING = 6, RC_MSG_PONG = 7, RC_MSG_BYE = 8 };
/* player status (HELLO and SNAP) */
enum { RC_ST_MENUS = 0, RC_ST_LOADING = 1, RC_ST_ROAM = 2, RC_ST_EVENT = 3, RC_ST_SHOP = 4,
       RC_ST_PAUSED = 5, RC_ST__N };
/* platform byte (HELLO) */
enum { RC_PLAT_MAC = 1, RC_PLAT_WIN = 2, RC_PLAT_TOOL = 3 };
/* state bits (SNAP) */
#define RC_BIT_BRAKE     0x01       /* brake lights */
#define RC_BIT_REVERSE   0x02
#define RC_BIT_NOS       0x04
#define RC_BIT_HANDBRAKE 0x08
#define RC_BIT_LIGHTS    0x10
/* decoder results */
enum { RC_OK = 0, RC_E_SHORT = -1, RC_E_MAGIC = -2, RC_E_VERSION = -3, RC_E_LENGTH = -4,
       RC_E_CRC = -5, RC_E_TYPE = -6, RC_E_FIELD = -7, RC_E_TRAIL = -8, RC_E_RANGE = -9 };

/* ---- byte helpers -------------------------------------------------------- */
typedef struct { uint8_t *p; uint32_t n, cap; int err; } rc_w;
typedef struct { const uint8_t *p; uint32_t n, len; int err; } rc_r;
void     rc_w_init(rc_w *w, uint8_t *buf, uint32_t cap);
void     rc_put8(rc_w *w, uint32_t v);
void     rc_put16(rc_w *w, uint32_t v);
void     rc_put32(rc_w *w, uint32_t v);
void     rc_putf(rc_w *w, float f);
void     rc_putb(rc_w *w, const void *src, uint32_t n);
void     rc_r_init(rc_r *r, const uint8_t *buf, uint32_t len);
uint32_t rc_get8(rc_r *r);
uint32_t rc_get16(rc_r *r);
uint32_t rc_get32(rc_r *r);
float    rc_getf(rc_r *r);
void     rc_getb(rc_r *r, void *dst, uint32_t n);
uint32_t rc_crc32(const uint8_t *p, uint32_t n);
uint32_t rc_fnv1a(const char *s);           /* room names -> room hash (0 for "") */
uint32_t rc_fnv1a_bytes(const uint8_t *p, uint32_t n);
uint32_t rc_fbits(float f);
float    rc_bitsf(uint32_t u);
float    rc_sqrtf(float x);
/* printable ASCII, at most RC_NAME_MAX bytes, never empty ("Player") */
void     rc_name_clean(char *dst, const char *src, uint32_t srclen);

/* ---- messages -------------------------------------------------------------- */
typedef struct {
    uint32_t t_us;                 /* sender's sync clock (µs, wraps) */
    float    p[3], v[3];           /* m, m/s */
    float    q[4];                 /* body -> world, x y z w */
    float    w[3];                 /* angular velocity, rad/s (world) */
    float    steer;                /* -1 .. 1 */
    float    throttle, brake;      /* 0 .. 1 */
    float    rpm, speed;           /* rpm, m/s (forward) */
    int8_t   gear;
    uint8_t  bits;                 /* RC_BIT_* */
} rc_state;

typedef struct {
    uint8_t  ver, type;
    uint16_t len;
    uint32_t sender;
    uint16_t seq, flags;
} rc_hdr;

typedef struct {
    rc_hdr h;
    union {
        struct { uint16_t core_ver; uint8_t platform, status; uint16_t listen_port, cfg_rev;
                 uint32_t room; char name[RC_NAME_MAX + 1]; uint8_t n_seen; uint32_t seen[RC_MAX_PEERS]; } hello;
        struct { uint8_t n; struct { uint32_t ip; uint16_t port; uint32_t id; } e[RC_MAX_PEERS]; } peers;
        struct { uint8_t status, epoch; uint16_t cfg_rev; uint8_t n, clock; rc_state s[RC_SNAP_STATES]; } snap;
        struct { uint16_t cfg_rev; uint8_t frag, nfrag; uint16_t total, dlen; const uint8_t *data; } cfg;
        struct { uint16_t cfg_rev; uint8_t have_mask; } cfgreq;
        struct { uint32_t t0, t1, t2; } ping;          /* PING: t0 only */
        struct { uint8_t reason; } bye;
    } u;
} rc_msg;

/* Encode one datagram (header, payload, CRC) into out (at least RC_MAX_DGRAM
 * bytes).  Returns its length, or -1 when m does not fit the format. */
int rc_encode(const rc_msg *m, uint8_t *out, int cap);
/* Decode and validate one datagram.  Returns RC_OK or an RC_E_* code; on
 * RC_OK every field is in range (finite floats, positions within ±20 km
 * horizontally and ±2 km vertically, |v| < 200 m/s, a renormalised quaternion,
 * bounded counts, printable names).  m->u.cfg.data points into buf. */
int rc_decode(const uint8_t *buf, int len, rc_msg *m);

/* ---- car-look record (CFG payload, reassembled) ------------------------------ */
typedef struct {
    uint32_t type_hash;                         /* CarTypeInfo +0xD0 */
    char     type_name[RC_CFG_TYPE_NAME + 1];   /* CarTypeInfo +0, for logs and fallbacks */
    uint8_t  ride_b[4];                         /* RideInfo +4..+7 */
    uint8_t  n_parts;
    struct { uint8_t slot; uint32_t key, owner; } part[RC_PART_SLOTS];
    /* extension 1 (52 bytes): what the game's own LAN car description
     * carries for performance, so the receiver builds a complete physics
     * block: 10 tuning flags (RideInfo +0x318, 10 dwords -> 2 bytes of bits),
     * 68 installed performance parts (+0x340, 68 bytes -> 9 bytes of bits),
     * 41 tuning bytes (+0x398) */
    uint8_t  has_perf;
    uint8_t  perf[RC_PERF_BYTES];
} rc_carcfg;
int rc_carcfg_encode(const rc_carcfg *c, uint8_t *out, int cap);   /* bytes, or -1 */
int rc_carcfg_decode(const uint8_t *p, int len, rc_carcfg *c);     /* RC_OK / RC_E_* */

/* ---- interpolation ---------------------------------------------------------- */
typedef struct {
    float   p[3], q[4], v[3], w[3];
    float   steer, throttle, brake, rpm, speed;
    int8_t  gear;
    uint8_t bits;
    int     mode;                  /* RC_MODE_* */
} rc_pose;
enum { RC_MODE_NONE = 0, RC_MODE_INTERP = 1, RC_MODE_EXTRAP = 2, RC_MODE_HOLD = 3 };

typedef struct {
    int      n;
    int64_t  t[RC_BUF_STATES];     /* unwrapped sender time, µs */
    rc_state s[RC_BUF_STATES];
    int64_t  t_last;  int t_init;  /* unwrapping */
    uint8_t  epoch;   int epoch_init;   /* teleport epoch: a change snaps */
    uint8_t  clock;   int clock_init;   /* sender clock epoch: a change re-syncs, blended */
    uint8_t  status;
    struct { int64_t at, d; } od[RC_OFFWIN];
    int      odn, odh;
    int64_t  off_r;   int off_init;   /* render offset: host_recv - sender time, slewed */
    int      shown;
    int64_t  prev_rt;
    float    prev_p[3], prev_q[4];    /* target pose shown last frame (without error) */
    float    err_p[3], err_q[4];      /* visual correction, decays */
    int      snap_pending;
    /* statistics */
    uint64_t n_eval, n_interp, n_extrap, n_hold, n_dup, n_old, n_snap, n_epoch;
    uint64_t n_stale;                 /* states of an older (clock) epoch, dropped */
    float    err_max;                 /* largest correction seen (m) */
} rc_interp;

void rc_interp_reset(rc_interp *ip);
/* Insert a received state.  recv_us is the host time of arrival (for the
 * clock offset; pass newest = 1 for the newest state of a SNAP only).
 * Epochs and clock epochs only move forward (mod 256): a state of an older
 * one (a datagram reordered across a teleport or a re-anchor) is dropped. */
void rc_interp_insert(rc_interp *ip, const rc_state *s, uint8_t epoch, uint8_t clock, uint8_t status,
                      int64_t recv_us, int newest);
/* Pose for this frame.  now_us = the receiver's render clock (its sync clock,
 * which follows the local world and the host clock), frame_dt_us = world time
 * since the previous call (0 while the local world is paused).  Returns 1 and
 * fills out when there is anything to show. */
int  rc_interp_eval(rc_interp *ip, int64_t now_us, int64_t frame_dt_us, int64_t delay_us,
                    int64_t extrap_cap_us, rc_pose *out);
/* the same, without touching any state (tests, logs) */
int  rc_interp_peek(const rc_interp *ip, int64_t render_t, int64_t extrap_cap_us, rc_pose *out);
/* exp(-x) for x >= 0 from basic operations only (bit-reproducible) */
float rc_expneg(float x);
/* atan2(y, x) in radians (-pi .. pi) from basic operations only
 * (bit-reproducible; within 3e-7 rad of libm); 0 for (0, 0) */
float rc_atan2f(float y, float x);
/* rotation rows (forward, left, up) <-> quaternion */
void rc_m2q(const float *f, const float *l, const float *u, float *q);
void rc_q2m(const float *q, float *f, float *l, float *u);

/* ---- session ------------------------------------------------------------------ */
typedef struct {
    void *user;
    /* unicast datagram to ip:port (host byte order ip, a.b.c.d = a<<24...) */
    void (*send)(void *user, uint32_t ip, uint16_t port, const uint8_t *buf, int len);
    /* LAN discovery beacon (the platform decides where it may go) */
    void (*broadcast)(void *user, uint16_t port, const uint8_t *buf, int len);
    /* joins, leaves and notes for the log (peer = table index or -1) */
    void (*event)(void *user, int ev, int peer, const char *text);
} rc_io;
enum { RC_EV_JOIN = 1, RC_EV_LEAVE = 2, RC_EV_NOTE = 3, RC_EV_CFG = 4, RC_EV_RESTART = 5 };

typedef struct {
    uint32_t self_id;              /* random, nonzero, per start */
    uint16_t port;                 /* our listen port (HELLO) */
    uint32_t room;                 /* rc_fnv1a(room name) */
    char     name[RC_NAME_MAX + 1];
    uint8_t  platform;
    int      discovery;            /* beacon through io.broadcast every 2 s */
    int      test_mode;            /* only 127/8 peers are accepted */
    int      max_players;          /* 2 .. RC_MAX_PLAYERS */
    int      rate_hz;              /* snapshots per second (10 .. 60) */
    /* a free-roam hub (the browser's server, web/server/roam-hub.mjs), or 0:
     * it gets a HELLO every second and a SNAP twice a second, and answers
     * every second with a PEERS list of the players near us.  While it
     * answers, that list is who our peers are: nobody else is taken, a peer
     * it no longer lists goes ("out of range"), and there is no discovery
     * and no gossip.  Silent for 10 s (or from the start): discovery and
     * gossip as without one. */
    uint32_t hub_ip;
    uint16_t hub_port;
} rc_config;

enum { RC_PS_FREE = 0, RC_PS_CANDIDATE = 1, RC_PS_HEARD = 2, RC_PS_EST = 3 };
typedef struct {
    int      state;
    int      configured;           /* from the static list: never forgotten */
    int      gossiped;
    uint32_t ip;  uint16_t port;
    uint32_t id;
    int64_t  added_us, last_rx_us, last_hello_tx, last_ping_tx, last_cfgreq_tx, last_snap_rx;
    int64_t  hub_listed_us;        /* the hub's list named it last (0: never) */
    char     name[RC_NAME_MAX + 1];
    uint8_t  platform, status;
    uint16_t cfg_rev_seen;         /* what the peer announces */
    int      hears_us, lost;
    int      hears_miss;           /* with the hub: one HELLO without our id forgiven (hub mode only) */
    /* rate limit */
    int64_t  rl_t0;  int rl_n, rl_bytes;
    /* statistics; seq_lost counts gaps in the sender's snapshot sequence */
    uint32_t rx, rx_snap, rx_drop, seq_lost;  uint16_t last_seq;  int seq_init;
    int32_t  rtt_us;
    /* car look */
    uint16_t cfg_bad_rev;          /* a record this core cannot read: not asked for again */
    uint16_t cfg_rev;              /* complete record held */
    int      cfg_len;  uint8_t cfg[RC_CFG_MAX];
    uint32_t cfg_gen;              /* +1 for every new complete record */
    uint16_t asm_rev;  uint16_t asm_total;  uint8_t asm_mask, asm_nfrag;  uint8_t asm_buf[RC_CFG_MAX];
    rc_interp mo;                  /* motion: jitter buffer and smoothing */
} rc_peer;

typedef struct {
    rc_config conf;
    rc_io     io;
    rc_peer   peer[RC_TABLE];
    uint16_t  seq;                 /* snapshot sequence: +1 per SNAP, carried by every datagram */
    uint8_t   status, epoch, clock;
    /* local car look */
    uint16_t  cfg_rev;  int cfg_len;  uint8_t cfg[RC_CFG_MAX];
    /* local snapshots */
    rc_state  last[RC_SNAP_STATES];  int nlast;
    int64_t   next_snap_us;
    int64_t   last_beacon, last_peers_tx;  int peers_dirty;
    /* statistics */
    uint32_t  tx, tx_bytes, rx, rx_bad, rx_policy, rx_ratelimit, rx_unknown_full, rx_version;
    uint32_t  rx_room;             /* HELLOs of another room */
    uint32_t  rx_dup_id;           /* a known player's id from a second address: ignored */
    uint32_t  rx_stray;            /* another id from a known address, not a HELLO: ignored */
    int64_t   note_version_us, note_room_us;  int noted_version, noted_room;   /* mismatch notes, every 30 s */
    /* after rc_shutdown nothing more is sent; a player's datagrams that
     * arrive after its BYE (sent before it, or overtaking it) are ignored
     * for 3 s, so it does not join again as a ghost */
    int       closed;
    struct { uint32_t id; int64_t at; } bye[4];  int nbye;
    uint32_t  rx_after_bye;
    /* the hub (conf.hub_ip): the first tick, its last list, our last HELLO
     * and SNAP to it, whether it is the one that decides now (logged when
     * that changes) */
    int64_t   hub_since, hub_heard_us, hub_hello_tx, hub_snap_tx;  int hub_was;
    uint32_t  hub_lists;           /* PEERS lists from the hub */
    uint32_t  rx_unlisted;         /* HELLOs of players the hub does not list for us: ignored */
} rc_session;

void rc_session_init(rc_session *s, const rc_config *cfg, const rc_io *io);
/* a configured peer (static list) or a gossiped one; returns its index or -1 */
int  rc_add_peer(rc_session *s, uint32_t ip, uint16_t port, int configured, int64_t now_us);
int  rc_addr_private(uint32_t ip);       /* RFC 1918, link-local 169.254/16, loopback 127/8 */
void rc_receive(rc_session *s, uint32_t ip, uint16_t port, const uint8_t *buf, int len, int64_t now_us);
void rc_tick(rc_session *s, int64_t now_us);
void rc_set_status(rc_session *s, uint8_t status);
/* the local car-look record; a change bumps cfg_rev and pushes it */
void rc_set_cfg(rc_session *s, const uint8_t *rec, int len, int64_t now_us);
/* the local car state, every frame: a SNAP goes out when one is due
 * (rate_hz, host clock), with the last RC_SNAP_STATES states */
int  rc_push_state(rc_session *s, const rc_state *st, int64_t now_us);
void rc_bump_epoch(rc_session *s);       /* teleport: receivers snap */
void rc_bump_clock(rc_session *s);       /* stamps re-anchored: receivers re-sync, blended */
void rc_shutdown(rc_session *s, uint8_t reason);   /* BYE x3 to every peer, then the session is silent */
int  rc_established(const rc_session *s);
const char *rc_status_name(int st);

#endif
