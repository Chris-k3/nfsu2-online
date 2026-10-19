/* fpscounter.m -- on-screen frame-rate counter.
 *
 *   NFSU2_FPS_COUNTER = off (default) | on | detailed     settings.ini: fps_counter
 *       on        frames per second, mean frame time, a frame-time graph
 *       detailed  also the 1% low and the longest frame of the last second,
 *                 the GPU time per frame, the pacing mode and content rate,
 *                 the render size and MSAA / filtering options in use, and
 *                 "(game N)" when the game simulates more frames than reach
 *                 the display (uncapped, or a rate above the display's)
 *   Cmd-N (app menu "Show Frame Rate") cycles off -> on -> detailed -> off.
 *   NFSU2_FPS_COUNTER_DUMP=1   frame dumps include the counter (default: not)
 *   NFSU2_FPS_COUNTER_LOG=1    log the numbers at every text update (tests)
 *
 * Off, nothing is drawn and nothing is added to the command buffer.  On, the
 * presenter draws one panel (text rendered with AppKit into a small texture
 * twice a second) and the graph (one procedural quad, every frame) into the
 * drawable's top-left corner after the game's frame and after the frame-dump
 * copy, so it is in no game render target, in no harness dump and in no F12
 * screenshot (those never read the presented image).  Its render pass is
 * limited to that corner (renderTargetWidth/Height), so only the corner's
 * tiles are loaded and stored, not the whole drawable.
 *
 * The rate comes from the display: the drawables' presentedTime (Core
 * Animation's time each frame appeared).  When the display shows none (a
 * hidden or occluded window, the display asleep) it falls back to the times
 * the main thread handed the drawables to the display ("submitted").  Both
 * timestamps are kept while the counter is off too (two ring writes per
 * frame), so the first reading after Cmd-N covers the last second instead of
 * an empty or stale window.                                                */
#import <Cocoa/Cocoa.h>
#import <Metal/Metal.h>
#include <os/lock.h>
#include <stdatomic.h>
#include <string.h>
#include <strings.h>
#include <stdlib.h>
#include <math.h>
#include <time.h>
#include "fpscounter.h"
#include "enhance.h"

int  hfr_rate_now(void);              /* framerate.c */
double hfr_sim_ms(void);
int  hfr_mode_rate(void);
int  hfr_mailbox(void);               /* undisplayed frames are replaced */
const char *hfr_mode_label(void);
int  metal_display_hz(void);          /* metal.m */
int  metal_msaa_now(void);
unsigned metal_guest_frames(void);

static id<MTLDevice> g_fd;
static id<MTLRenderPipelineState> g_ptex, g_pgraph;
static _Atomic int g_fmode = -1;          /* 0 off, 1 on, 2 detailed */

static int fc_mode(void){
    int m = atomic_load(&g_fmode);
    if (m < 0){
        const char *e = getenv("NFSU2_FPS_COUNTER");
        m = 0;
        if (e && *e){
            if (!strcasecmp(e, "detailed") || !strcasecmp(e, "full") || !strcmp(e, "2")) m = 2;
            else if (!strcasecmp(e, "on") || !strcmp(e, "1") || !strcasecmp(e, "yes") || !strcasecmp(e, "true")) m = 1;
            else if (strcasecmp(e, "off") && strcmp(e, "0") && strcasecmp(e, "no") && strcasecmp(e, "false"))
                fprintf(stderr, "fps counter: NFSU2_FPS_COUNTER=%s ignored (off|on|detailed)\n", e);
        }
        int un = -1;
        if (!atomic_compare_exchange_strong(&g_fmode, &un, m)) m = atomic_load(&g_fmode);
    }
    return m;
}
int fpscounter_on(void){ return fc_mode(); }
int fpscounter_in_dumps(void){
    static int v = -1;
    if (v < 0){ const char *e = getenv("NFSU2_FPS_COUNTER_DUMP"); v = e && *e == '1'; }
    return v;
}
static double g_last;                     /* last text update (0 = redraw now) */
static int g_fresh = 1;                   /* the counter was just switched on */
void fpscounter_cycle(void){
    int m = (fc_mode() + 1) % 3;
    atomic_store(&g_fmode, m);
    g_last = 0;
    if (m == 1) g_fresh = 1;              /* from off: restart the GPU sums and the game-rate baseline */
    fprintf(stderr, "fps counter: %s\n", m == 2 ? "detailed" : m ? "on" : "off");
}

/* ---- samples (main thread, presented handlers, GPU completion) ---------- */
#define FC_N 2048
typedef struct { double t[FC_N]; unsigned long long n; } Ring;
static Ring g_rc, g_rp;                   /* present calls, presentedTime */
static os_unfair_lock g_lk = OS_UNFAIR_LOCK_INIT;
static double now_s(void){ return (double)clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1e9; }
static void ring_put(Ring *r, double t){
    os_unfair_lock_lock(&g_lk); r->t[r->n++ % FC_N] = t; os_unfair_lock_unlock(&g_lk);
}
/* the newest k timestamps, oldest first; returns how many */
static unsigned ring_get(Ring *r, double *out, unsigned k){
    os_unfair_lock_lock(&g_lk);
    unsigned long long n = r->n;
    unsigned m = n < k ? (unsigned)n : k;
    for (unsigned i = 0; i < m; i++) out[i] = r->t[(n - m + i) % FC_N];
    os_unfair_lock_unlock(&g_lk);
    return m;
}
/* recorded on or off (see the top): a reading right after Cmd-N is current */
void fpscounter_note_present(void){ ring_put(&g_rc, now_s()); }
void fpscounter_note_presented(double t){ if (t > 0) ring_put(&g_rp, t); }
static _Atomic unsigned long long g_gpu_ns, g_gpu_n, g_gpu_max;
void fpscounter_note_gpu(double ms){
    if (!fc_mode() || !(ms > 0)) return;
    unsigned long long ns = (unsigned long long)(ms * 1e6);
    atomic_fetch_add(&g_gpu_ns, ns); atomic_fetch_add(&g_gpu_n, 1ull);
    unsigned long long mx = atomic_load(&g_gpu_max);
    while (ns > mx && !atomic_compare_exchange_weak(&g_gpu_max, &mx, ns)) {}
}

/* ---- statistics ----------------------------------------------------------- */
#define FC_G 160                          /* graph columns = frames shown */
typedef struct {
    int    disp;                          /* 1 = presentedTime, 0 = present calls */
    double fps, mean_ms, max_ms, low1;    /* last second; 1% low over the last 5 s */
    unsigned n;
    float  graph[FC_G]; unsigned gn;      /* intervals (ms), oldest first */
} Stats;
static int cmp_d(const void *a, const void *b){
    double x = *(const double *)a, y = *(const double *)b; return (x > y) - (x < y);
}
static int g_disp;                        /* the source chosen at the last text update */
/* text update (twice a second): rate, mean, max and 1% low; picks the source */
static void stats(Stats *s){
    static double tc[1300], tp[1300], iv[1300];
    memset(s, 0, sizeof *s);
    double now = now_s();
    unsigned nc = ring_get(&g_rc, tc, 1300), np = ring_get(&g_rp, tp, 1300);
    /* present calls in the last second vs drawables the display reported */
    unsigned cc = 0, pc = 0;
    for (unsigned i = 0; i < nc; i++) if (tc[i] > now - 1.0) cc++;
    for (unsigned i = 0; i < np; i++) if (tp[i] > now - 1.25) pc++;
    s->disp = g_disp = np >= 2 && tp[np - 1] > now - 0.25 && pc * 10 >= cc * 8;
    const double *t = s->disp ? tp : tc; unsigned n = s->disp ? np : nc;
    if (n < 2) return;
    double end = t[n - 1], sum = 0, mx = 0; unsigned k = 0, m = 0;
    for (unsigned i = n - 1; i > 0; i--){
        double d = t[i] - t[i - 1];
        if (!(d > 0)) continue;
        if (end - t[i] < 5.0 && m < 1300) iv[m++] = d;
        if (end - t[i] < 1.0){ sum += d; k++; if (d > mx) mx = d; }
    }
    if (k){ s->fps = k / sum; s->mean_ms = sum / k * 1e3; s->max_ms = mx * 1e3; s->n = k; }
    if (m){ qsort(iv, m, sizeof iv[0], cmp_d);
            double p99 = iv[(unsigned)floor(0.99 * (m - 1))]; s->low1 = p99 > 0 ? 1.0 / p99 : 0; }
}
/* every frame: the graph only (the newest FC_G intervals of the chosen source) */
static void graph(Stats *s){
    static double t[FC_G + 1];
    unsigned n = ring_get(g_disp ? &g_rp : &g_rc, t, FC_G + 1), g = 0;
    memset(s->graph, 0, sizeof s->graph);
    for (unsigned i = n > 0 ? n - 1 : 0; i > 0 && g < FC_G; i--){
        double d = t[i] - t[i - 1]; if (!(d > 0)) continue;
        s->graph[FC_G - 1 - g++] = (float)(d * 1e3); }
    s->gn = g;              /* filled from the right; the rest stays 0 (no bar) */
}

/* ---- panel texture (AppKit text) ---------------------------------------- */
static id<MTLTexture> g_tex; static NSUInteger g_tw, g_th;
static CGFloat g_gx, g_gy, g_gw, g_gh;     /* graph rect inside the panel, pixels from top-left */
static void render_panel(NSString *str, double ppp){
    CGFloat fs = 12.0 * ppp, lh = ceil(fs * 1.3), pad = ceil(6 * ppp), gh = ceil(24 * ppp), gap = ceil(4 * ppp);
    NSFont *font = [NSFont monospacedDigitSystemFontOfSize:fs weight:NSFontWeightSemibold];
    NSDictionary *at = @{ NSFontAttributeName: font, NSForegroundColorAttributeName: [NSColor whiteColor] };
    NSArray<NSString *> *lines = [str componentsSeparatedByString:@"\n"];
    CGFloat tw = ceil(150 * ppp);
    for (NSString *l in lines){ NSSize z = [l sizeWithAttributes:at]; if (z.width > tw) tw = ceil(z.width); }
    size_t W = ((size_t)(tw + 2 * pad) + 3) & ~(size_t)3;
    size_t H = (size_t)(pad + lh * lines.count + gap + gh + pad);
    void *buf = calloc(W * H, 4);
    if (!buf) return;
    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    CGContextRef cg = CGBitmapContextCreate(buf, W, H, 8, W * 4, cs,
                                            kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little);
    CGContextSetRGBFillColor(cg, 0, 0, 0, 0.62);
    CGPathRef p = CGPathCreateWithRoundedRect(CGRectMake(0, 0, W, H), 5 * ppp, 5 * ppp, NULL);
    CGContextAddPath(cg, p); CGContextFillPath(cg); CGPathRelease(p);
    /* graph well, slightly darker (CG origin is bottom-left) */
    CGContextSetRGBFillColor(cg, 0, 0, 0, 0.35);
    CGContextFillRect(cg, CGRectMake(pad, pad, W - 2 * pad, gh));
    NSGraphicsContext *gc = [NSGraphicsContext graphicsContextWithCGContext:cg flipped:NO];
    [NSGraphicsContext saveGraphicsState]; [NSGraphicsContext setCurrentContext:gc];
    for (NSUInteger i = 0; i < lines.count; i++)
        [lines[i] drawAtPoint:NSMakePoint(pad, (CGFloat)H - pad - lh * (i + 1) + (lh - fs) * 0.35) withAttributes:at];
    [NSGraphicsContext restoreGraphicsState];
    /* a new texture for every update: frames still on the GPU keep sampling
     * the previous one (the command buffers retain it), so no frame shows a
     * half-written panel */
    MTLTextureDescriptor *td = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
                                                                                   width:W height:H mipmapped:NO];
    td.usage = MTLTextureUsageShaderRead; td.storageMode = MTLStorageModeShared;
    id<MTLTexture> t = [g_fd newTextureWithDescriptor:td];
    if (t){ [t replaceRegion:MTLRegionMake2D(0, 0, W, H) mipmapLevel:0 withBytes:buf bytesPerRow:W * 4];
            g_tex = t; g_tw = W; g_th = H; }
    CGContextRelease(cg); CGColorSpaceRelease(cs); free(buf);
    g_gx = pad; g_gw = W - 2 * pad; g_gh = gh; g_gy = H - pad - gh;
}

/* ---- pipelines ------------------------------------------------------------- */
typedef struct { float rect[4]; float period, scale; uint32_t n, pad; float v[FC_G]; } GraphPar;
static NSString *kSrc = @
"#include <metal_stdlib>\n"
"using namespace metal;\n"
"struct OV { float4 pos [[position]]; float2 uv; };\n"
"vertex OV fc_vs(uint vid [[vertex_id]], constant float4 &R [[buffer(0)]]) {\n"
"  float cx = (vid == 1 || vid == 2 || vid == 4) ? 1.0 : 0.0, cy = (vid == 2 || vid == 4 || vid == 5) ? 1.0 : 0.0;\n"
"  OV o; o.pos = float4(mix(R.x, R.z, cx), mix(R.y, R.w, cy), 0, 1); o.uv = float2(cx, cy); return o; }\n"
"fragment float4 fc_tex(OV i [[stage_in]], texture2d<float> t [[texture(0)]]) {\n"
"  constexpr sampler P(address::clamp_to_edge, filter::nearest); return t.sample(P, i.uv); }\n"
"struct GP { float4 rect; float period; float scale; uint n; uint pad; float v[160]; };\n"
"fragment float4 fc_graph(OV i [[stage_in]], constant GP &g [[buffer(0)]]) {\n"
"  uint c = min(uint(i.uv.x * float(g.n)), g.n - 1u);\n"
"  float v = g.v[c], y = 1.0 - i.uv.y, px = fwidth(y);\n"
"  if (g.period > 0.0 && fabs(y - g.period / g.scale) < 0.6 * px) return float4(0.55, 0.55, 0.55, 0.55);\n"
"  if (v <= 0.0 || y > min(v / g.scale, 1.0)) return float4(0.0);\n"
"  float3 k = (g.period <= 0.0 || v <= g.period * 1.2) ? float3(0.30, 0.85, 0.40)\n"
"           : (v <= g.period * 2.05) ? float3(0.95, 0.78, 0.22) : float3(0.95, 0.30, 0.25);\n"
"  return float4(k * 0.95, 0.95); }\n";
static int pso_init(void){
    if (g_ptex) return 1;
    static int failed;
    if (failed || !g_fd) return 0;
    NSError *e = nil;
    id<MTLLibrary> l = [g_fd newLibraryWithSource:kSrc options:nil error:&e];
    MTLRenderPipelineDescriptor *pd = [MTLRenderPipelineDescriptor new];
    pd.vertexFunction = [l newFunctionWithName:@"fc_vs"];
    pd.colorAttachments[0].pixelFormat = MTLPixelFormatBGRA8Unorm;
    pd.colorAttachments[0].blendingEnabled = YES;              /* premultiplied */
    pd.colorAttachments[0].sourceRGBBlendFactor = MTLBlendFactorOne;
    pd.colorAttachments[0].destinationRGBBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
    pd.colorAttachments[0].sourceAlphaBlendFactor = MTLBlendFactorOne;
    pd.colorAttachments[0].destinationAlphaBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
    if (l){ pd.fragmentFunction = [l newFunctionWithName:@"fc_tex"];
            g_ptex = [g_fd newRenderPipelineStateWithDescriptor:pd error:&e]; }
    if (g_ptex){ pd.fragmentFunction = [l newFunctionWithName:@"fc_graph"];
                 g_pgraph = [g_fd newRenderPipelineStateWithDescriptor:pd error:&e]; }
    if (!g_ptex || !g_pgraph){ failed = 1; g_ptex = nil;
        fprintf(stderr, "fps counter: pipeline: %s\n", e.localizedDescription.UTF8String); return 0; }
    return 1;
}
void fpscounter_init(id<MTLDevice> dev){ g_fd = dev; }

static void pacing_line(char *o, size_t n){
    const char *ml = hfr_mode_label();
    int mr = hfr_mode_rate(), now = hfr_rate_now(), hz = metal_display_hz();
    if (!strcmp(ml, "off")) snprintf(o, n, "pacing off (game limiter)");
    else if (!strcmp(ml, "uncapped") || mr == 0) snprintf(o, n, "pacing uncapped");
    else if (now > 0 && now < mr) snprintf(o, n, "pacing %s %d: %d fps (game cap)", ml, mr, now);
    else if (hz > 0) snprintf(o, n, "pacing %s %d fps, display %d Hz", ml, now > 0 ? now : mr, hz);
    else snprintf(o, n, "pacing %s %d fps", ml, now > 0 ? now : mr);
}

/* main thread: after the game's frame (and the frame-dump copy), before the present */
void fpscounter_draw(id<MTLCommandBuffer> cb, id<MTLTexture> dst, double px_per_pt, unsigned bw, unsigned bh){
    int m = fc_mode();
    if (!m || !pso_init()) return;
    double ppp = px_per_pt > 0.5 ? px_per_pt : 1.0, now = now_s();
    Stats st; memset(&st, 0, sizeof st);
    static int last_m; static double last_ppp; static unsigned last_w, last_h;
    static unsigned last_gf; static double last_gt, on_since;
    if (g_fresh){
        /* just switched on: GPU times and the game's frame count restart here */
        g_fresh = 0; last_gt = 0; on_since = now;
        atomic_store(&g_gpu_n, 0ull); atomic_store(&g_gpu_ns, 0ull); atomic_store(&g_gpu_max, 0ull);
    }
    if (!g_tex || now - g_last >= 0.5 || m != last_m || ppp != last_ppp ||
        dst.width != last_w || dst.height != last_h){
        stats(&st);
        g_last = now; last_m = m; last_ppp = ppp; last_w = (unsigned)dst.width; last_h = (unsigned)dst.height;
        unsigned long long gn = atomic_exchange(&g_gpu_n, 0ull), gs = atomic_exchange(&g_gpu_ns, 0ull),
                           gm = atomic_exchange(&g_gpu_max, 0ull);
        double gpu = gn ? (double)gs / gn / 1e6 : 0.0;
        /* frames the game simulated (metal_present calls): more than reach the
         * display when uncapped or above the display's rate (replaced frames) */
        unsigned gf = metal_guest_frames();
        double gfps = last_gt > 0 && now > last_gt ? (double)(gf - last_gf) / (now - last_gt) : 0;
        last_gf = gf; last_gt = now;
        char s[512], pl[96], gl[48] = ""; pacing_line(pl, sizeof pl);
        if (hfr_mailbox() && gfps > st.fps * 1.05 + 1) snprintf(gl, sizeof gl, " (game %.0f)", gfps);
        int ms = metal_msaa_now();
        /* less than a quarter second of frames measured (the first frames
         * after launch): no number rather than "0 fps" or one interval's
         * rate; look again in a tenth of a second (for the first 2 s) */
        char fr[48];
        int have = st.n && st.n * st.mean_ms >= 250.0, soon = now - on_since < 2.0;
        if (have) snprintf(fr, sizeof fr, "%.0f fps  %.2f ms", st.fps, st.mean_ms);
        else { snprintf(fr, sizeof fr, "-- fps  -- ms"); if (soon) g_last = now - 0.4; }
        if (m == 1) snprintf(s, sizeof s, "%s", fr);
        else {
            char opts[64] = "";
            if (ms > 1) snprintf(opts, sizeof opts, "  MSAA %dx", ms);
            if (enh_aniso()) strlcat(opts, "  AF 16x", sizeof opts);
            char rs[96];
            if (bw && bh && (bw != dst.width || bh != dst.height))
                snprintf(rs, sizeof rs, "render %lux%lu, shown %ux%u", (unsigned long)dst.width,
                         (unsigned long)dst.height, bw, bh);
            else snprintf(rs, sizeof rs, "render %lux%lu", (unsigned long)dst.width, (unsigned long)dst.height);
            char lo[64], gt[48];
            if (have) snprintf(lo, sizeof lo, "1%% low %.0f  max %.1f ms", st.low1, st.max_ms);
            else snprintf(lo, sizeof lo, "1%% low --  max -- ms");
            /* no frame finished on the GPU since the switch yet */
            if (gn) snprintf(gt, sizeof gt, "GPU %.2f ms (max %.1f)", gpu, (double)gm / 1e6);
            else { snprintf(gt, sizeof gt, "GPU -- ms"); if (soon) g_last = now - 0.4; }
            snprintf(s, sizeof s, "%s%s\n%s\n%s\n%s\n%s%s", fr, gl, lo, gt, pl, rs, opts);
        }
        static int lg = -1; if (lg < 0){ const char *e = getenv("NFSU2_FPS_COUNTER_LOG"); lg = e && *e == '1'; }
        if (lg) fprintf(stderr, "[fps] %.2f fps mean %.3f ms max %.2f ms 1%%low %.1f n=%u src=%s gpu %.2f ms "
                                "rate %d (%s) %lux%lu msaa %d sim %.3f game %.1f fps\n",
                        st.fps, st.mean_ms, st.max_ms, st.low1, st.n, st.disp ? "display" : "submitted", gpu,
                        hfr_rate_now(), hfr_mode_label(), (unsigned long)dst.width, (unsigned long)dst.height, ms,
                        hfr_sim_ms() / 1e3, gfps);
        render_panel([NSString stringWithUTF8String:s], ppp);
    }
    if (!g_tex) return;
    double mg = round(10 * ppp);
    if (mg + g_tw > dst.width || mg + g_th > dst.height) return;   /* window too small for it */
    /* the pass covers only the corner up to the panel: W x H from the top-left */
    double W = mg + g_tw, H = mg + g_th;
    float R[4] = { (float)(-1 + 2 * mg / W), (float)(1 - 2 * mg / H),
                   (float)(-1 + 2 * (mg + g_tw) / W), (float)(1 - 2 * (mg + g_th) / H) };
    MTLRenderPassDescriptor *rp = [MTLRenderPassDescriptor renderPassDescriptor];
    rp.colorAttachments[0].texture = dst;
    rp.colorAttachments[0].loadAction = MTLLoadActionLoad;
    rp.colorAttachments[0].storeAction = MTLStoreActionStore;
    rp.renderTargetWidth = (NSUInteger)W; rp.renderTargetHeight = (NSUInteger)H;
    id<MTLRenderCommandEncoder> e = [cb renderCommandEncoderWithDescriptor:rp];
    e.label = @"fps counter";
    [e setViewport:(MTLViewport){ 0, 0, W, H, 0, 1 }];
    graph(&st);
    [e setRenderPipelineState:g_ptex];
    [e setVertexBytes:R length:sizeof R atIndex:0];
    [e setFragmentTexture:g_tex atIndex:0];
    [e drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:6];
    /* graph: the last FC_G frame intervals, newest on the right */
    GraphPar gp; memset(&gp, 0, sizeof gp);
    double x0 = mg + g_gx, y0 = mg + g_gy;
    float G[4] = { (float)(-1 + 2 * x0 / W), (float)(1 - 2 * y0 / H),
                   (float)(-1 + 2 * (x0 + g_gw) / W), (float)(1 - 2 * (y0 + g_gh) / H) };
    int r = hfr_rate_now();
    gp.period = r > 0 ? 1000.f / r : 0.f;
    gp.scale = (float)fmax(2.5 * (r > 0 ? 1000.0 / r : 8.333), 20.0);
    gp.n = FC_G;
    memcpy(gp.v, st.graph, sizeof gp.v);
    [e setRenderPipelineState:g_pgraph];
    [e setVertexBytes:G length:sizeof G atIndex:0];
    [e setFragmentBytes:&gp length:sizeof gp atIndex:0];
    [e drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:6];
    [e endEncoding];
}

/* app menu item: Cmd-N.  Command shortcuts never reach the game, and N is
 * bound to nothing in the game's race or front-end key tables (unlike Shift,
 * Control and Option, which are gear and nitrous keys and reach the game when
 * pressed before Command). */
@interface FpsCounterMenuTarget : NSObject @end
@implementation FpsCounterMenuTarget
- (void)cycle:(id)sender {
    (void)sender;
    /* a held Cmd-N switches once: the key's auto-repeat also reaches the menu */
    NSEvent *ev = [NSApp currentEvent];
    if (ev.type == NSEventTypeKeyDown && ev.isARepeat) return;
    fpscounter_cycle();
}
@end
static FpsCounterMenuTarget *g_target;
void fpscounter_add_menu(NSMenu *m){
    if (!g_target) g_target = [FpsCounterMenuTarget new];
    NSMenuItem *it = [m addItemWithTitle:@"Show Frame Rate" action:@selector(cycle:) keyEquivalent:@"n"];
    [it setKeyEquivalentModifierMask:NSEventModifierFlagCommand];
    [it setTarget:g_target];
}
