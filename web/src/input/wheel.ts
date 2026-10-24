// Steering wheels (Logitech G29 and the like) through the Gamepad API, for the game's virtual pad (gamepad.ts):
// the wheel becomes the left stick's x, the gas and brake pedals the right and left triggers, the D-pad and buttons
// the pad's, and the game is offered a driving device for it (runtime/dinput_pad.c), whose steering follows the
// wheel's position as the PC game's own wheel support did.
//
// No browser maps a wheel: Chrome, Firefox and Safari give it mapping "", its axes and buttons as its HID report
// descriptor has them, and each browser places those axes in Gamepad.axes its own way (Placement).  So for the
// models whose descriptor is known (ModelAxes: Logitech's G29, G920 and G923, G25, G27, Driving Force GT) the page
// takes the wheel and each pedal from it, placed as the browser does; for any other wheel, or where the wheel shows
// a number of axes its descriptor does not explain or its axes do not sit where it puts them (a driver's settings,
// G HUB's combined pedals), it guesses from where the axes sit when the wheel shows up.  A pedal rests at one end
// of its axis (+1 on Logitech's, which report a released pedal as 255), so read as a stick it held the stick down:
// the bug this file fixed first.  The player can teach the page the right layout (WheelLearn, in the Controls
// sheet: turn the wheel, press each pedal), kept in this browser per model.

import { PAD_A, PAD_B, PAD_BACK, PAD_DDOWN, PAD_DLEFT, PAD_DRIGHT, PAD_DUP, PAD_HOME, PAD_LB, PAD_LS, PAD_RB, PAD_RS,
  PAD_START, PAD_X, PAD_Y } from './proto';

/** a pedal: its axis, its value let go and pressed to the floor (gas and brake on one axis: the two halves) */
export interface Pedal { axis: number; rest: number; full: number }
/** how a wheel's axes and buttons make the pad */
export interface WheelMap {
  steer: number;                 // the wheel's axis
  centre: number;                // its value straight ahead
  lock: number;                  // how far from the centre is full lock to the right (negative: the axis runs the other way)
  gas: Pedal | null;
  brake: Pedal | null;
  buttons: number[];             // buttons[i]: the PAD_* button i is (-1: none)
  dpad?: [number, number];       // a hat switch read as two axes, x and y (Linux), where known
  placed?: Placement;            // from the model's descriptor, its axes placed so; absent: guessed
  learned?: boolean;             // set up by the player (WheelLearn), not guessed
}

/** a HID axis by its usage on the Generic Desktop page ('hat': the hat switch, the D-pad) */
export type Usage = 'x' | 'y' | 'z' | 'rx' | 'ry' | 'rz' | 'slider' | 'hat';
/** a model's axes: those of its HID report descriptor, in the descriptor's order where that is known (listed), and
 *  which is the wheel and which each pedal */
export interface ModelAxes { axes: Usage[]; listed: boolean; steer: Usage; gas: Usage; brake: Usage; clutch?: Usage }

/**
 * Where a browser puts a wheel's axes in Gamepad.axes (Chromium device/gamepad, Firefox dom/gamepad, WebKit
 * platform/gamepad/mac):
 *   usage   Chrome on Windows and macOS, Firefox on Windows: at its usage less X's: X 0, Y 1, Z 2, Rx 3, Ry 4, Rz 5,
 *           Slider 6, the hat switch 9 (one axis: hatDirs)
 *   kernel  Chrome and Firefox on Linux (joydev, evdev): the axes Linux made of them one after another in the order
 *           of its codes (ABS_X, Y, Z, RX, RY, RZ, THROTTLE the slider), the hat switch two (ABS_HAT0X and HAT0Y)
 *   listed  Firefox on macOS: in the descriptor's order, X to Rz and the hat switch (one axis)
 *   tree    Safari: in the descriptor's order, X to Rz; no hat switch, so no D-pad
 * A known model's axes are placed the one way that gives as many axes as the wheel shows.
 */
export type Placement = 'usage' | 'kernel' | 'listed' | 'tree';
const PLACEMENTS: Placement[] = ['usage', 'kernel', 'listed', 'tree'];
const USAGE_AT: Record<Usage, number> = { x: 0, y: 1, z: 2, rx: 3, ry: 4, rz: 5, slider: 6, hat: 9 };
const KERNEL_CODE: Record<Usage, number> = { x: 0, y: 1, z: 2, rx: 3, ry: 4, rz: 5, slider: 6, hat: 16 };

/** each of the model's axes' index when placed so (a hat switch read as two: its x, y after it), and how many axes
 *  the browser shows then; null for a placement in the descriptor's order where that order is not known */
export function placeAxes(m: ModelAxes, p: Placement): { at: Partial<Record<Usage, number>>; length: number } | null {
  const at: Partial<Record<Usage, number>> = {};
  let length = 0;
  if (p === 'usage') for (const u of m.axes) { at[u] = USAGE_AT[u]; length = Math.max(length, USAGE_AT[u] + 1); }
  else if (p === 'kernel') {
    for (const u of [...m.axes].sort((a, b) => KERNEL_CODE[a] - KERNEL_CODE[b])) { at[u] = length; length += u === 'hat' ? 2 : 1; }
  } else if (!m.listed) return null;
  else for (const u of m.axes) if (u !== 'slider' && (u !== 'hat' || p === 'listed')) at[u] = length++;
  return { at, length };
}

// The descriptors known.  The G29's, the G923's for PlayStation, the G27's and the G25's: the hat switch, X the
// wheel, then one input of three bytes, the gas, brake and clutch pedals, as Z, Rz and Y (sonik-br/lgff_wheel_adapter
// usb_descriptors.h; Linux's hid-lg4ff and SDL's lg4ff driver read those bytes as gas, brake, clutch).
const ZRY: ModelAxes = { axes: ['hat', 'x', 'z', 'rz', 'y'], listed: true, steer: 'x', gas: 'z', brake: 'rz', clutch: 'y' };
// The G920's and the G923's for Xbox: X the wheel, Y the gas, Z the brake, Rz the clutch (Wine's winebus.sys,
// bus_sdl.c g920_absolute_usages, as Windows shows it); the order its descriptor lists them in is not known.
const YZR: ModelAxes = { axes: ['x', 'y', 'z', 'rz', 'hat'], listed: false, steer: 'x', gas: 'y', brake: 'z', clutch: 'rz' };
// The Driving Force GT's: the hat switch, X the wheel, Y the gas, Z the brake.
const DFGT: ModelAxes = { axes: ['hat', 'x', 'y', 'z'], listed: true, steer: 'x', gas: 'y', brake: 'z' };

/** a wheel model: its USB ids, its buttons' layout (G29 family: PlayStation, G920 family: Xbox), its rotation, and
 *  its axes where its descriptor is known */
export interface WheelInfo { vendor: string; product: string; layout: 'ps' | 'xbox' | 'generic'; degrees: number; axes?: ModelAxes }

/** the game's full lock, in degrees of a wheel turned from lock to lock, where the model's rotation is known: an
 *  arcade game's steering is quick, and a G29 turned half of its 900 degrees for full lock is a chore */
export const DEFAULT_LOCK_DEGREES = 270;

// the wheels SDL knows (src/joystick/SDL_joystick.c, initial_wheel_devices): vendor:product -> layout, rotation, axes
const LOGI_PS = { layout: 'ps', degrees: 900 } as const, LOGI_XB = { layout: 'xbox', degrees: 900 } as const;
const KNOWN: Record<string, Omit<WheelInfo, 'vendor' | 'product'>> = {
  '046d:c24f': { ...LOGI_PS, axes: ZRY }, '046d:c260': LOGI_PS,         // G29 (PS3 mode, PS4 mode)
  '046d:c266': { ...LOGI_PS, axes: ZRY }, '046d:c267': { ...LOGI_PS, axes: ZRY },   // G923 for PlayStation and PC
  '046d:c268': { layout: 'ps', degrees: 1080 }, '046d:c269': { layout: 'ps', degrees: 1080 },   // PRO Racing Wheel
  '046d:c261': LOGI_XB, '046d:c262': { ...LOGI_XB, axes: YZR },         // G920 (Xbox mode, then the PC's)
  '046d:c26d': LOGI_XB, '046d:c26e': { ...LOGI_XB, axes: YZR },         // G923 for Xbox
  '046d:c272': { layout: 'xbox', degrees: 1080 },                      // PRO Racing Wheel for Xbox
  '046d:c294': { layout: 'generic', degrees: 0 },                      // a Logitech wheel before its driver switched it
  '046d:c295': { layout: 'generic', degrees: 0 }, '046d:ca03': { layout: 'generic', degrees: 0 },   // MOMO
  '046d:c298': { layout: 'generic', degrees: 900 },                    // Driving Force Pro
  '046d:c299': { layout: 'generic', degrees: 900, axes: ZRY },         // G25
  '046d:c29b': { layout: 'generic', degrees: 900, axes: ZRY },         // G27
  '046d:c29a': { layout: 'generic', degrees: 900, axes: DFGT },        // Driving Force GT
};
// whole vendors that make wheels and little else: Thrustmaster's wheel bases, Fanatec, Simagic, Simucube, Moza ...
const WHEEL_IDS = new Set(['044f:b65d', '044f:b65e', '044f:b664', '044f:b669', '044f:b66d', '044f:b66e', '044f:b66f',
  '044f:b677', '044f:b67f', '044f:b691', '044f:b692', '044f:b696', '045e:02a2', '0483:0522', '0483:a355', '0079:1864',
  '11ff:0511', '1209:ffb0', '3416:0301', '3416:0302']);
const WHEEL_VENDORS = new Set(['0eb7', '16d0', '2433', '346e']);

/** the USB vendor and product from Gamepad.id: Chrome writes "Name (... Vendor: 046d Product: c24f)", Firefox
 *  "046d-c24f-Name" */
export function usbIds(id: string): { vendor: string; product: string } | null {
  const c = /Vendor:\s*([0-9a-f]{4})\s*Product:\s*([0-9a-f]{4})/i.exec(id) ?? /^([0-9a-f]{1,4})-([0-9a-f]{1,4})-/i.exec(id);
  return c ? { vendor: c[1].toLowerCase().padStart(4, '0'), product: c[2].toLowerCase().padStart(4, '0') } : null;
}

/** whether Gamepad.id is a steering wheel's, and which (asked every frame: kept per id) */
const seenIds = new Map<string, WheelInfo | null>();
export function wheelOf(id: string): WheelInfo | null {
  let w = seenIds.get(id);
  if (w !== undefined) return w;
  const u = usbIds(id), key = u ? `${u.vendor}:${u.product}` : '';
  const k = KNOWN[key];
  w = k ? { vendor: u!.vendor, product: u!.product, ...k }
    : (u && (WHEEL_IDS.has(key) || WHEEL_VENDORS.has(u.vendor))) || /\bwheel\b|driving force|steering/i.test(id)
    ? { vendor: u?.vendor ?? '', product: u?.product ?? '', layout: 'generic', degrees: 0 } : null;
  if (seenIds.size < 64) seenIds.set(id, w);
  return w;
}

// the buttons in the order the G29 and G923 (PlayStation) report them (lgff_wheel_adapter reports.h g29_report_t,
// as SDL's lg4ff driver reads them; every browser keeps a wheel's buttons in their usages' order): Cross, Square,
// Circle, Triangle, the right and left paddles (R1, L1), R2, L2, Share, Options, R3, L3, the shifter's six gears and
// reverse, plus, minus, the red dial clockwise and back, its Enter, PS.  The G920 and G923 (Xbox): A, B, X, Y, the
// right and left paddles, Menu, View, the right and left stick buttons, Xbox.  Plus and minus shift too, the dial
// and Enter work the menus.
const PS_BUTTONS = [PAD_A, PAD_X, PAD_B, PAD_Y, PAD_RB, PAD_LB, -1, -1, PAD_BACK, PAD_START, PAD_RS, PAD_LS,
  -1, -1, -1, -1, -1, -1, -1, PAD_RB, PAD_LB, PAD_DDOWN, PAD_DUP, PAD_A, PAD_HOME];
const XBOX_BUTTONS = [PAD_A, PAD_B, PAD_X, PAD_Y, PAD_RB, PAD_LB, PAD_START, PAD_BACK, PAD_RS, PAD_LS, PAD_HOME];
// any other wheel: as the standard mapping's order (gamepad.ts BUTTON_OF), its triggers' places left out
const GENERIC_BUTTONS = [PAD_A, PAD_B, PAD_X, PAD_Y, PAD_LB, PAD_RB, -1, -1, PAD_BACK, PAD_START, PAD_LS, PAD_RS,
  PAD_DUP, PAD_DDOWN, PAD_DLEFT, PAD_DRIGHT, PAD_HOME];

/** whether an axis value is a hat switch read as one axis, let go (it reads outside -1..1 then) */
const hatRest = (v: number) => Math.abs(v) > 1.05;

/**
 * The layout of a wheel nobody set up: axes0 is where its axes sat when it showed up (the browser shows a controller
 * after a button press, so the pedals are let go then).  Full lock is DEFAULT_LOCK_DEGREES of its rotation, or all
 * of it where that is unknown.  A known model's wheel and pedals come from its descriptor, placed as the browser
 * does: the placement that gives as many axes as the wheel shows, with its wheel off the ends and its gas and brake
 * at one, or every axis 0 (Chrome on macOS before the wheel's first report: the pedals rest at +1 then).  Any other
 * wheel's are guessed: the wheel is the first axis that is neither a hat switch let go nor at an end (X, axis 0,
 * where the browser has no hat switch before it); pedals are the axes resting at an end, the first the gas, the
 * brake Rz (axis 5 where axes are placed by usage) or else the last; without one at an end, combined pedals on the
 * axis after the wheel, gas up, brake down.
 */
export function guessMap(info: WheelInfo, axes0: readonly number[], nbuttons: number): WheelMap {
  const table = info.layout === 'ps' ? PS_BUTTONS : info.layout === 'xbox' ? XBOX_BUTTONS : GENERIC_BUTTONS;
  const base = {
    centre: 0, lock: info.degrees > DEFAULT_LOCK_DEGREES ? DEFAULT_LOCK_DEGREES / info.degrees : 1,
    buttons: Array.from({ length: nbuttons }, (_, i) => table[i] ?? -1),
  };
  const atEnd = (v: number | undefined) => typeof v === 'number' && !hatRest(v) && Math.abs(v) >= 0.9;
  const pedal = (i: number): Pedal => { const r = atEnd(axes0[i]) ? Math.sign(axes0[i]) : 1; return { axis: i, rest: r, full: -r }; };
  const m = info.axes, unread = axes0.every(v => v === 0);
  for (const p of m ? PLACEMENTS : []) {
    const a = placeAxes(m!, p);
    if (!a || a.length !== axes0.length) continue;
    const steer = a.at[m!.steer]!, gas = a.at[m!.gas]!, brake = a.at[m!.brake]!, hat = a.at.hat;
    if (!unread && (hatRest(axes0[steer]) || atEnd(axes0[steer]) || !atEnd(axes0[gas]) || !atEnd(axes0[brake]))) continue;
    return { ...base, steer, gas: pedal(gas), brake: pedal(brake),
      ...(p === 'kernel' && hat !== undefined ? { dpad: [hat, hat + 1] as [number, number] } : {}), placed: p };
  }
  const steer = Math.max(0, axes0.findIndex(v => !hatRest(v) && !atEnd(v)));
  const ends: number[] = [];
  axes0.forEach((v, i) => { if (i !== steer && atEnd(v)) ends.push(i); });
  let gas: Pedal | null = null, brake: Pedal | null = null;
  if (ends.length >= 2) {
    const b = ends.includes(5) && ends[0] !== 5 ? 5 : ends[ends.length - 1];
    gas = pedal(ends[0]); brake = pedal(b);
  } else if (ends.length === 1) gas = pedal(ends[0]);
  else {
    const c = axes0.findIndex((v, i) => i > steer && !hatRest(v));
    if (c >= 0) { gas = { axis: c, rest: 0, full: -1 }; brake = { axis: c, rest: 0, full: 1 }; }
  }
  return { ...base, steer, gas, brake };
}

/** a hat switch read as one axis (Chrome, Firefox on Windows and macOS) as PAD_D* bits: positions 0 (up) to 7
 *  (up-left) at 2/7 apart from -1; anything else (let go, or 0 before the first report) is none */
export function hatDirs(v: number): number {
  if (!(v >= -1.01 && v <= 1.01)) return 0;
  const pos = Math.round((v + 1) * 3.5);
  if (Math.abs(v - (pos / 3.5 - 1)) > 0.05) return 0;
  const U = 1 << PAD_DUP, D = 1 << PAD_DDOWN, L = 1 << PAD_DLEFT, R = 1 << PAD_DRIGHT;
  return [U, U | R, R, D | R, D, D | L, L, U | L][pos];
}

/** a hat switch read as two axes (Linux: x -1 left to 1 right, y -1 up to 1 down) as PAD_D* bits */
export function dpadDirs(x: number, y: number): number {
  return (x < -0.5 ? 1 << PAD_DLEFT : x > 0.5 ? 1 << PAD_DRIGHT : 0) | (y < -0.5 ? 1 << PAD_DUP : y > 0.5 ? 1 << PAD_DDOWN : 0);
}

const clamp = (v: number, lo: number, hi: number) => v < lo ? lo : v > hi ? hi : v;
/** a pedal's travel, 0 let go to 1 on the floor */
export function pedalValue(p: Pedal | null, axes: readonly number[]): number {
  const v = p ? axes[p.axis] : undefined;
  if (p === null || typeof v !== 'number' || !isFinite(v) || p.full === p.rest) return 0;
  return clamp((v - p.rest) / (p.full - p.rest), 0, 1);
}

/** a wheel's state as the pad's: buttons (1 << PAD_*), and axes LX (the wheel, -1 .. 1 at full lock), LY, RX, RY
 *  (0), LT (the brake), RT (the gas).  hat: the axis the browser put the hat switch on, as one (-1: none seen) */
export function readWheel(axes: readonly number[], pressed: readonly boolean[], m: WheelMap, hat: number): { buttons: number; axes: number[] } {
  let buttons = 0;
  for (let i = 0; i < pressed.length && i < m.buttons.length; i++) if (pressed[i] && m.buttons[i] >= 0) buttons |= 1 << m.buttons[i];
  if (hat >= 0 && hat !== m.steer) buttons |= hatDirs(axes[hat]);
  if (m.dpad) buttons |= dpadDirs(axes[m.dpad[0]], axes[m.dpad[1]]);
  const w = axes[m.steer];
  const lx = typeof w === 'number' && isFinite(w) && m.lock ? clamp((w - m.centre) / m.lock, -1, 1) : 0;
  return { buttons, axes: [lx, 0, 0, 0, pedalValue(m.brake, axes), pedalValue(m.gas, axes)] };
}

/** the axis carrying a hat switch read as one: one that reads outside -1..1 (let go), or -1 */
export function findHat(axes: readonly number[]): number {
  return axes.findIndex(hatRest);
}

/** a short line for the log: what drives what */
export function describeMap(m: WheelMap, hat: number): string {
  const p = (x: Pedal | null) => x ? `axis ${x.axis} (${x.rest.toFixed(2)} to ${x.full.toFixed(2)})` : 'none';
  return `wheel axis ${m.steer} (centre ${m.centre.toFixed(2)}, full lock ${m.lock >= 0 ? '+' : ''}${m.lock.toFixed(2)}), ` +
    `gas ${p(m.gas)}, brake ${p(m.brake)}, D-pad ${m.dpad ? `axes ${m.dpad.join(' and ')}` : hat >= 0 ? `axis ${hat}` : 'none seen'}, ` +
    (m.learned ? 'set up by the player' : m.placed ? `the model's own (axes placed by ${m.placed})` : 'guessed');
}

// ---- the player's set-up, kept in this browser per model ------------------------------------------------------
const KEY = 'nfsu2.wheel.';
/** the key a wheel's set-up is kept under: its USB ids, or its name where the browser gives none */
export function wheelKey(id: string): string {
  const u = usbIds(id);
  return KEY + (u ? `${u.vendor}:${u.product}` : id.slice(0, 80));
}
export function loadMap(id: string): WheelMap | null {
  try {
    const m = JSON.parse(localStorage.getItem(wheelKey(id)) ?? 'null') as WheelMap | null;
    const ok = (p: Pedal | null) => p === null || (Number.isInteger(p.axis) && isFinite(p.rest) && isFinite(p.full));
    return m && Number.isInteger(m.steer) && isFinite(m.centre) && isFinite(m.lock) && m.lock !== 0 && ok(m.gas) && ok(m.brake) &&
      Array.isArray(m.buttons) ? m : null;
  } catch { return null; }
}
/** keep the player's set-up (null: back to the guess); gamepad.ts reads it again on the event */
export function saveMap(id: string, m: WheelMap | null) {
  try { if (m) localStorage.setItem(wheelKey(id), JSON.stringify(m)); else localStorage.removeItem(wheelKey(id)); }
  catch { /* storage off: the guess stays */ }
  dispatchEvent(new Event(WHEEL_MAP_EVENT));
}
export const WHEEL_MAP_EVENT = 'nfsu2-wheel-map';

// ---- teaching the page the wheel's axes -------------------------------------------------------------------------
export type LearnStep = 'rest' | 'steer' | 'gas' | 'brake' | 'done';
/** how long (ms) a control has to be held still where it is for its step to take it */
const HOLD_MS = 700;

/**
 * The set-up's steps, fed the wheel's axes every frame (feed): let go of everything (rest: where every axis sits),
 * turn the wheel right to where full lock should be (steer: the axis that moved most, its centre and the lock, held
 * there HOLD_MS), press the gas pedal down (gas: the axis that moved most but the wheel's), the brake (brake: the
 * same, or the gas's axis the other way: combined pedals).  Each step takes a control once it has moved far enough
 * and held still; then map() is the wheel's set-up, with base's buttons.
 */
export class WheelLearn {
  step: LearnStep = 'rest';
  /** 0..1: how far the step is (the hold) */
  progress = 0;
  private rest: number[] = [];
  private last: number[] = [];
  private still = 0;
  private steer = -1;
  private centre = 0;
  private lock = 0;
  private gas: Pedal | null = null;
  private brake: Pedal | null = null;

  constructor(private base: WheelMap) {}

  /** the axes now, at time now (ms); true when the step changed */
  feed(axes: readonly number[], now: number): boolean {
    const moved = this.last.length !== axes.length || axes.some((v, i) => Math.abs(v - this.last[i]) > 0.01);
    if (moved) this.still = now;
    this.last = axes.slice();
    const held = Math.min(1, (now - this.still) / HOLD_MS);
    const before = this.step;
    switch (this.step) {
      case 'rest':
        this.progress = held;
        if (held >= 1) { this.rest = axes.slice(); this.step = 'steer'; }
        break;
      case 'steer': {
        const i = this.most(axes, [], 0.08);
        this.progress = i < 0 ? 0 : held;
        if (i >= 0 && held >= 1) { this.steer = i; this.centre = this.rest[i]; this.lock = axes[i] - this.rest[i]; this.step = 'gas'; }
        break;
      }
      case 'gas': {
        const i = this.most(axes, [this.steer], 0.3);
        this.progress = i < 0 ? 0 : held;
        if (i >= 0 && held >= 1) { this.gas = { axis: i, rest: this.rest[i], full: axes[i] }; this.step = 'brake'; }
        break;
      }
      case 'brake': {
        const g = this.gas!;
        // the gas's axis only the other way from its rest (combined pedals)
        const i = this.most(axes, [this.steer], 0.3, j => j !== g.axis || Math.sign(axes[j] - g.rest) === -Math.sign(g.full - g.rest));
        this.progress = i < 0 ? 0 : held;
        if (i >= 0 && held >= 1) { this.brake = { axis: i, rest: this.rest[i], full: axes[i] }; this.step = 'done'; }
        break;
      }
    }
    if (this.step !== before) { this.progress = 0; this.still = now; }
    return this.step !== before;
  }

  /** the axis furthest from its rest (at least min, a hat switch's never), not one of skip, or -1 */
  private most(axes: readonly number[], skip: number[], min: number, ok: (i: number) => boolean = () => true): number {
    let best = -1, far = min;
    axes.forEach((v, i) => {
      const r = this.rest[i];
      if (skip.includes(i) || hatRest(v) || hatRest(r ?? 0) || typeof r !== 'number' || !ok(i)) return;
      const d = Math.abs(v - r);
      if (d >= far) { far = d; best = i; }
    });
    return best;
  }

  /** the set-up, once done */
  map(): WheelMap | null {
    if (this.step !== 'done') return null;
    return { ...this.base, steer: this.steer, centre: this.centre, lock: this.lock, gas: this.gas, brake: this.brake,
      placed: undefined, learned: true };
  }
}
