// Drift mode in free roam (runtime/drift.c): X in the game turns the game's own drift-event handling, drift camera
// and drift scoring on and off.  The free-roam HUD has no place for the score (the drift event's panel is HUD_Drift's),
// so while drift mode is on the page shows that panel -- Best, the multiplier with the points its next level needs,
// Total -- under the game's Bank panel and as wide, the drift event's DRIFT popup with the points of each drift banked,
// where free roam's HUD shows its own popups (the drift event's place, the middle, is free roam's arrow's), and a note
// at each X: on, off, or that it is for free roam.  Not over a dialog of the page's.  It reads the game's status (runtime/web/status_web.c), as the pause hint does:
// drift (1 chosen, 2 on now, 4 the last X was elsewhere), drift_key (X presses), drift_x, drift_gain, drift_total,
// drift_best.
import type { GameSession } from './game';
import { t } from './i18n';
import { pageDialog } from './padnav';

/** the game's Bank panel, in HUD units (640x480 in the middle of the picture; hud = wide moves its side out by up to
 *  109): its right edge 299 right of the middle, its bottom 167 above it; the panel goes 4 under it, as wide (176) */
const RIGHT_U = 299, TOP_U = -163, WIDE_U = 176;
/** free roam's style popups (a jump's HANG TIME): right-aligned 295 right of the middle, from 15 above it */
const POP_RIGHT_U = 295, POP_TOP_U = -15;

export class DriftPanel {
  private root: HTMLElement;
  private best: HTMLElement;
  private mult: HTMLElement;
  private gain: HTMLElement;
  private total: HTMLElement;
  private pop: HTMLElement;
  private session: GameSession | null = null;
  private raf = 0;
  private readAt = 0;
  private keys = -1;
  private on = false;
  private shown = false;
  private filled = '';
  private banked = -1;

  constructor(stage: HTMLElement, private deps: { toast(msg: string, ms: number): void; wide(): boolean; log(s: string): void }) {
    const p = this.root = document.createElement('div');
    p.className = 'drift-panel'; p.hidden = true; p.dataset.nfsu2Ui = '';
    p.innerHTML = '<div><span></span><b class="drift-best"></b></div>'
      + '<div><i class="drift-x"></i><span class="drift-gain"><span></span><b></b></span></div>'
      + '<div class="drift-total"><span></span><b></b></div>';
    this.best = p.querySelector('.drift-best')!;
    this.mult = p.querySelector('.drift-x')!;
    this.gain = p.querySelector('.drift-gain')!;
    this.total = p.querySelector('.drift-total')!;
    const q = this.pop = document.createElement('div');
    q.className = 'drift-pop'; q.hidden = true; q.dataset.nfsu2Ui = '';
    q.innerHTML = '<span></span><b></b>';
    q.addEventListener('animationend', () => { q.hidden = true; });
    stage.append(p, q);
  }

  /** a game started: the panel follows its drift mode until stop() */
  start(s: GameSession) {
    this.session = s; this.keys = -1; this.on = false; this.filled = ''; this.banked = -1;
    const tick = () => { this.update(); this.raf = requestAnimationFrame(tick); };
    this.raf = requestAnimationFrame(tick);
  }

  /** the game ended */
  stop() {
    cancelAnimationFrame(this.raf);
    this.session = null;
    this.show(false);
    this.pop.hidden = true;
  }

  private update() {
    const s = this.session;
    if (!s) return;
    const now = performance.now();
    if (now - this.readAt > 100) {
      this.readAt = now;
      const st = s.status?.read();                // null while the game writes it: the last state stands
      if (st && st.has('drift')) {
        const d = st.get('drift')!, k = st.get('drift_key') ?? 0;
        if (this.keys >= 0 && k !== this.keys) {
          this.deps.toast(d & 4 ? t('Drift mode only works in free roam') : d & 1 ? t('Drift mode: on') : t('Drift mode: off'), 2500);
          this.deps.log(`[app] drift mode: X ${d & 4 ? 'outside free roam' : d & 1 ? 'on' : 'off'}`);
        }
        this.keys = k;
        this.on = (d & 2) !== 0;
        const total = st.get('drift_total') ?? 0;
        if (this.banked >= 0 && total > this.banked && this.on && !pageDialog()) this.popup(total - this.banked, s);
        this.banked = total;
        this.fill(st.get('drift_best') ?? 0, st.get('drift_x') ?? 1, st.get('drift_gain') ?? 0, total);
      }
    }
    this.show(this.on && !pageDialog());
    if (this.shown) this.place(s);
    if (!this.shown) this.pop.hidden = true;
  }

  /** a drift banked: DRIFT and its points, fading out (the animation's end hides it) */
  private popup(points: number, s: GameSession) {
    const q = this.pop;
    q.firstElementChild!.textContent = t('DRIFT');
    q.lastElementChild!.textContent = `+${points}`;
    q.hidden = true; void q.offsetWidth; q.hidden = false;     // the animation from its start
    this.place(s);
  }

  private show(on: boolean) {
    if (on === this.shown) return;
    this.shown = on;
    this.root.hidden = !on;
  }

  /** the numbers, and the labels in the page's language */
  private fill(best: number, x: number, gain: number, total: number) {
    const key = `${best} ${x} ${gain} ${total} ${t('Total')}`;
    if (key === this.filled) return;
    this.filled = key;
    this.best.previousElementSibling!.textContent = t('Best:');
    this.best.textContent = String(best);
    this.mult.textContent = `X${x}`;
    this.gain.hidden = x >= 5 || gain <= 0;
    this.gain.firstElementChild!.textContent = t('Gain {n}X with:', { n: x + 1 });
    this.gain.lastElementChild!.textContent = String(gain);
    this.total.firstElementChild!.textContent = t('Total');
    this.total.lastElementChild!.textContent = String(total);
  }

  /** under the game's Bank panel, its right edge on the Bank panel's */
  private place(s: GameSession) {
    const v = s.viewRect();
    if (!v.w || !v.h) return;
    const u = Math.min(v.w / 640, v.h / 480), e169 = 320 * (16 / 9 * 0.75 - 1);
    const out = this.deps.wide() ? Math.min(Math.max(320 * (v.w / v.h * 0.75 - 1), 0), e169) * 109 / e169 : 0;
    const st = this.root.style, ps = this.pop.style;
    st.left = `${v.x + v.w / 2 + (RIGHT_U + out - WIDE_U) * u}px`;
    st.top = `${v.y + v.h / 2 + TOP_U * u}px`;
    st.setProperty('--u', `${u}px`);
    ps.left = `${v.x + v.w / 2 + (POP_RIGHT_U + out) * u}px`;           // its right edge (the style's translate)
    ps.top = `${v.y + v.h / 2 + POP_TOP_U * u}px`;
    ps.setProperty('--u', `${u}px`);
  }
}
