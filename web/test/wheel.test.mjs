// Steering wheels through the Gamepad API (web/src/input/wheel.ts, gamepad.ts): which controllers are wheels, a known
// model's layout as each browser places its axes, the layout guessed from where a wheel's axes sat when it showed
// up, the pad they make, and the set-up's steps.
//   node --test web/test/wheel.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = async (f) => import('data:text/javascript;base64,' + Buffer.from((await esbuild.build({
  entryPoints: [path.join(ROOT, f)], bundle: true, format: 'esm', write: false })).outputFiles[0].text).toString('base64'));
const W = await load('web/src/input/wheel.ts');
const P = await load('web/src/input/proto.ts');
const G = await load('web/src/input/gamepad.ts');
const bit = (...b) => b.reduce((m, x) => m | 1 << x, 0);

const G29 = 'G29 Driving Force Racing Wheel (Vendor: 046d Product: c24f)';
const G920 = 'Logitech G920 Driving Force Racing Wheel (Vendor: 046d Product: c262)';
const H = 9 / 7;                                                // a hat switch let go, read as one axis
// a G29 under Chrome on Windows and macOS (axes at their usage): X the wheel, Y the clutch, Z the gas, Rz the brake
// (the pedals let go at +1), the hat switch let go on axis 9
const G29_REST = [0.002, 1, 1, 0, 0, 1, 0, 0, 0, H];

test('wheels by their USB ids, in Chrome\'s and Firefox\'s ids, and by name', () => {
  assert.equal(W.wheelOf(G29).layout, 'ps');
  assert.equal(W.wheelOf(G29).degrees, 900);
  assert.deepEqual(W.wheelOf(G29).axes.axes, ['hat', 'x', 'z', 'rz', 'y']);
  assert.equal(W.wheelOf('046d-c24f-G29 Driving Force Racing Wheel').layout, 'ps');
  assert.equal(W.wheelOf('46d-c262-Logitech G920 Driving Force Racing Wheel').layout, 'xbox');
  assert.equal(W.wheelOf('Thrustmaster T300RS Racing wheel (Vendor: 044f Product: b66e)').layout, 'generic');
  assert.equal(W.wheelOf('Thrustmaster T300RS Racing wheel (Vendor: 044f Product: b66e)').axes, undefined);
  assert.equal(W.wheelOf('FANATEC CSL Elite Wheel Base (Vendor: 0eb7 Product: 0e03)').degrees, 0);
  assert.equal(W.wheelOf('Some USB Wheel (Vendor: 1234 Product: 5678)').layout, 'generic');
  assert.equal(W.wheelOf('Logitech Gamepad F310 (STANDARD GAMEPAD Vendor: 046d Product: c216)'), null);
  assert.equal(W.wheelOf('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'), null);
  assert.equal(W.wheelOf('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'), null);
});

test('a G29 let go makes a pad at rest: no stick held down (the report: "down" pressed all the time)', () => {
  const m = W.guessMap(W.wheelOf(G29), G29_REST, 25);
  const hat = W.findHat(G29_REST);
  assert.equal(hat, 9);
  const r = W.readWheel(G29_REST, Array(25).fill(false), m, hat);
  assert.equal(r.buttons, 0);
  assert.deepEqual(r.axes.map(v => +v.toFixed(3)), [0.007, 0, 0, 0, 0, 0]);
});

test('the G29\'s layout from its descriptor: the wheel, Z the gas, Rz the brake, its buttons', () => {
  const m = W.guessMap(W.wheelOf(G29), G29_REST, 25);
  assert.equal(m.placed, 'usage');
  assert.equal(m.steer, 0);
  assert.equal(+m.lock.toFixed(3), 0.3);                      // 270 of its 900 degrees
  assert.deepEqual(m.gas, { axis: 2, rest: 1, full: -1 });
  assert.deepEqual(m.brake, { axis: 5, rest: 1, full: -1 });
  assert.equal(m.dpad, undefined);
  assert.match(W.describeMap(m, 9), /gas axis 2 .* brake axis 5 .* D-pad axis 9, the model's own \(axes placed by usage\)$/);
  const press = (...i) => W.readWheel(G29_REST, Array.from({ length: 25 }, (_, j) => i.includes(j)), m, 9).buttons;
  assert.equal(press(0), bit(P.PAD_A));                       // Cross
  assert.equal(press(1), bit(P.PAD_X));                       // Square
  assert.equal(press(2), bit(P.PAD_B));                       // Circle
  assert.equal(press(3), bit(P.PAD_Y));                       // Triangle
  assert.equal(press(4, 5), bit(P.PAD_RB, P.PAD_LB));         // the paddles
  assert.equal(press(8, 9), bit(P.PAD_BACK, P.PAD_START));    // Share, Options
  assert.equal(press(10, 11), bit(P.PAD_RS, P.PAD_LS));       // R3, L3
  assert.equal(press(12, 13, 18), 0);                         // the shifter
  assert.equal(press(21), bit(P.PAD_DDOWN));                  // the dial
  assert.equal(press(23), bit(P.PAD_A));                      // Enter
  assert.equal(press(24), bit(P.PAD_HOME));                   // PS: the page's menu
});

test('the wheel, the pedals and the D-pad as the pad', () => {
  const m = W.guessMap(W.wheelOf(G29), G29_REST, 25);
  const at = (over) => { const a = G29_REST.slice(); for (const [i, v] of Object.entries(over)) a[+i] = v; return W.readWheel(a, [], m, 9); };
  assert.equal(+at({ 0: 0.15 }).axes[0].toFixed(3), 0.5);       // half lock: 67.5 degrees right
  assert.equal(at({ 0: -0.45 }).axes[0], -1);                   // past full lock left
  assert.equal(at({ 2: -1 }).axes[5], 1);                       // gas floored
  assert.equal(at({ 2: 0 }).axes[5], 0.5);                      // half
  assert.equal(at({ 5: -1 }).axes[4], 1);                       // brake floored
  assert.equal(at({ 1: -1 }).axes.slice(4).join(), '0,0');      // the clutch: nothing (the issue: it was the gas)
  const dirs = [-1, -5 / 7, -3 / 7, -1 / 7, 1 / 7, 3 / 7, 5 / 7, 1].map(v => at({ 9: v }).buttons);
  const U = bit(P.PAD_DUP), D = bit(P.PAD_DDOWN), L = bit(P.PAD_DLEFT), R = bit(P.PAD_DRIGHT);
  assert.deepEqual(dirs, [U, U | R, R, D | R, D, D | L, L, U | L]);
  assert.equal(at({ 9: 0 }).buttons, 0);                        // no report yet
  assert.equal(at({ 9: 3.2857 }).buttons, 0);                   // let go (another hat's range)
});

test('a known wheel\'s axes as each browser places them', () => {
  const U = bit(P.PAD_DUP), D = bit(P.PAD_DDOWN), L = bit(P.PAD_DLEFT);
  const pick = (m) => [m.placed, m.steer, m.gas?.axis, m.brake?.axis];
  // Linux (joydev, evdev): X, Y the clutch, Z the gas, Rz the brake, the hat switch's x and y
  const l = W.guessMap(W.wheelOf(G29), [0, 1, 1, 1, 0, 0], 25);
  assert.deepEqual([...pick(l), l.dpad], ['kernel', 0, 2, 3, [4, 5]]);
  assert.equal(W.readWheel([0, 1, 1, 1, -1, 0], [], l, -1).buttons, L);
  assert.equal(W.readWheel([0, 1, 1, 1, 0, 1], [], l, -1).buttons, D);
  assert.equal(W.readWheel([0, -1, 1, 1, 0, 0], [], l, -1).axes.slice(4).join(), '0,0');  // the clutch
  assert.equal(W.readWheel([0, 1, -1, 1, 0, 0], [], l, -1).axes.slice(4).join(), '0,1');  // the gas
  // Firefox on macOS: the descriptor's order, the hat switch first
  const f = W.guessMap(W.wheelOf('46d-c24f-G29 Driving Force Racing Wheel'), [H, 0, 1, 1, 1], 25);
  assert.deepEqual(pick(f), ['listed', 1, 2, 3]);
  assert.equal(W.readWheel([-1, 0, 1, 1, 1], [], f, W.findHat([H, 0, 1, 1, 1])).buttons, U);
  // Safari: the descriptor's order without the hat switch
  assert.deepEqual(pick(W.guessMap(W.wheelOf('46d-c24f-G29 Driving Force Racing Wheel'), [0, 1, 1, 1], 25)), ['tree', 0, 1, 2]);
  // Chrome on macOS before the wheel's first report: every axis 0, the pedals taken to rest at +1
  const z = W.guessMap(W.wheelOf(G29), Array(10).fill(0), 25);
  assert.deepEqual([...pick(z), z.gas.rest, z.brake.full], ['usage', 0, 2, 5, 1, -1]);
  // the G920: Y the gas, Z the brake, Rz the clutch
  assert.deepEqual(pick(W.guessMap(W.wheelOf(G920), [0, 1, 1, 0, 0, 1, 0, 0, 0, H], 11)), ['usage', 0, 1, 2]);
  const g = W.guessMap(W.wheelOf(G920), [0, 1, 1, 1, 0, 0], 11);
  assert.deepEqual([...pick(g), g.dpad], ['kernel', 0, 1, 2, [4, 5]]);
  // the Driving Force GT: Y the gas, Z the brake
  assert.deepEqual(pick(W.guessMap(W.wheelOf('Driving Force GT (Vendor: 046d Product: c29a)'), [0, 1, 1, 0, 0, 0, 0, 0, 0, H], 21)),
    ['usage', 0, 1, 2]);
});

test('guessed layouts: other wheels, and known ones the descriptor does not explain', () => {
  // G HUB's combined pedals: nothing rests at an end, Y in the middle, the gas pulls it up, the brake down
  const c = W.guessMap(W.wheelOf(G29), [0, 0, 0, 0, 0, 0, 0, 0, 0, H], 25);
  assert.equal(c.placed, undefined);
  assert.deepEqual([c.gas, c.brake], [{ axis: 1, rest: 0, full: -1 }, { axis: 1, rest: 0, full: 1 }]);
  assert.deepEqual(W.readWheel([0, -0.6], [], c, -1).axes.slice(4), [0, 0.6]);
  assert.deepEqual(W.readWheel([0, 0.8], [], c, -1).axes.slice(4), [0.8, 0]);
  assert.match(W.describeMap(c, 9), /, guessed$/);
  // a G920 where the browser lists its axes in the descriptor's order, which is not known here
  const n = W.guessMap(W.wheelOf(G920), [0, 1, 1, 1, H], 11);
  assert.deepEqual([n.placed, n.steer, n.gas.axis, n.brake.axis], [undefined, 0, 1, 3]);
  assert.deepEqual(n.buttons.slice(0, 8), [P.PAD_A, P.PAD_B, P.PAD_X, P.PAD_Y, P.PAD_RB, P.PAD_LB, P.PAD_START, P.PAD_BACK]);
  // a listing whose wheel axis reads as a hat switch: not the descriptor's order after all
  const x = W.guessMap(W.wheelOf('46d-c24f-G29 Driving Force Racing Wheel'), [0, H, 1, 1, 1], 25);
  assert.deepEqual([x.placed, x.steer, x.gas.axis, x.brake.axis], [undefined, 0, 2, 4]);
  // another wheel: pedals resting at -1; one with its hat switch first
  const o = W.guessMap(W.wheelOf('Some USB Wheel'), [0, -1, -1], 12);
  assert.deepEqual([o.steer, o.gas, o.brake], [0, { axis: 1, rest: -1, full: 1 }, { axis: 2, rest: -1, full: 1 }]);
  const h = W.guessMap(W.wheelOf('Some USB Wheel'), [H, 0.01, 1, 1], 12);
  assert.deepEqual([h.steer, h.gas.axis, h.brake.axis], [1, 2, 3]);
  // a wheel of unknown rotation: all of it is full lock
  assert.equal(W.guessMap(W.wheelOf('Some USB Wheel'), [0, 1, 1], 12).lock, 1);
});

test('the set-up: let go, turn right to full lock, the gas, the brake', () => {
  const base = W.guessMap(W.wheelOf(G29), G29_REST, 25);
  const L = new W.WheelLearn(base);
  let t = 0;
  const hold = (axes, ms = 800) => { for (let e = 0; e <= ms; e += 16) L.feed(axes, t += 16); };
  const a = (over) => { const x = [-0.01, 1, 1, 0, 0, 1, 0, 0, 0, H]; for (const [i, v] of Object.entries(over)) x[+i] = v; return x; };
  hold(a({}));
  assert.equal(L.step, 'steer');
  hold(a({ 9: -1 }));                                           // the D-pad is no wheel
  assert.equal(L.step, 'steer');
  for (let v = 0; v <= 0.2; v += 0.02) L.feed(a({ 0: v }), t += 16);   // turning: not held yet
  assert.equal(L.step, 'steer');
  hold(a({ 0: 0.19 }));
  assert.equal(L.step, 'gas');
  hold(a({ 0: 0.19, 1: -1 }));                                  // the clutch, pressed first, is taken as the gas
  assert.equal(L.step, 'brake');
  const L2 = new W.WheelLearn(base);
  t = 0;
  const hold2 = (axes) => { for (let e = 0; e <= 800; e += 16) L2.feed(axes, t += 16); };
  hold2(a({})); hold2(a({ 0: -0.21 })); hold2(a({ 2: -1 })); hold2(a({ 5: -0.98 }));
  assert.equal(L2.step, 'done');
  const m = L2.map();
  assert.equal(m.steer, 0);
  assert.equal(+m.centre.toFixed(2), -0.01);
  assert.equal(+m.lock.toFixed(2), -0.2);                       // this wheel's axis runs the other way
  assert.deepEqual(m.gas, { axis: 2, rest: 1, full: -1 });
  assert.deepEqual(m.brake, { axis: 5, rest: 1, full: -0.98 });
  assert.equal(m.learned, true);
  assert.equal(m.placed, undefined);
  assert.deepEqual(m.buttons, base.buttons);
  assert.equal(W.readWheel(a({ 0: -0.21 }), [], m, 9).axes[0], 1);   // right, as turned in the set-up
});

test('the set-up with combined pedals: the brake is the gas\'s axis the other way', () => {
  const L = new W.WheelLearn(W.guessMap(W.wheelOf(G29), [0, 0], 25));
  let t = 0;
  const hold = (axes) => { for (let e = 0; e <= 800; e += 16) L.feed(axes, t += 16); };
  hold([0, 0]); hold([0.3, 0]); hold([0, -1]);
  assert.equal(L.step, 'brake');
  hold([0, -1]);                                                // still the gas: no brake
  assert.equal(L.step, 'brake');
  hold([0, 0.9]);
  assert.deepEqual([L.map().gas, L.map().brake], [{ axis: 1, rest: 0, full: -1 }, { axis: 1, rest: 0, full: 0.9 }]);
});

test('controller families from Chrome\'s and Firefox\'s ids, a wheel\'s from its buttons', () => {
  assert.deepEqual(G.familyOf('54c-ce6-DualSense Wireless Controller'), { family: P.PADF_PLAYSTATION, name: 'DualSense Wireless Controller' });
  assert.deepEqual(G.familyOf('054c-0ce6-DualSense Wireless Controller'), { family: P.PADF_PLAYSTATION, name: 'DualSense Wireless Controller' });
  assert.deepEqual(G.familyOf(G29), { family: P.PADF_PLAYSTATION, name: 'G29 Driving Force Racing Wheel' });
  assert.equal(G.familyOf('46d-c262-G920 Driving Force Racing Wheel').family, P.PADF_XBOX);
  assert.equal(G.familyOf('Xbox 360 Controller (XInput STANDARD GAMEPAD)').family, P.PADF_XBOX);
});

test('a controller without the standard mapping: an axis that rested at an end is no stick', () => {
  const g = { id: 'Generic USB Joystick (Vendor: 0079 Product: 0006)', index: 0, mapping: '', axes: [0, 1, 0, -1],
    buttons: Array.from({ length: 12 }, () => ({ pressed: false, value: 0 })) };
  const s = G.mapStandard(g, new Set([1, 3]));
  assert.deepEqual(s.axes, [0, 0, 0, 0, 0, 0]);
  assert.equal(s.buttons, 0);
  assert.deepEqual(G.mapStandard(g).axes.slice(0, 4), [0, 1, 0, -1]);    // as before, without
});
