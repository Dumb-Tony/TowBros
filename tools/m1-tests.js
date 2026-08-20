/* Milestone 1 suite — "One Vehicle, One Ditch, One Recovery".
 *
 * The GDD lists nine completion criteria for this milestone (§4 "Completion criteria").
 * Section H below tests them, one at a time, by driving whole recoveries headlessly through
 * the real Game object. Everything above H is the machinery those recoveries depend on,
 * tested numerically so that when a recovery misbehaves the failure names its own cause.
 *
 * MEASURED and recorded in Dev\INDEX.md: headless Chrome in --dump-dom mode delivers 1-3
 * requestAnimationFrame callbacks in TOTAL. So nothing here waits for frames — every live
 * test drives game.skipMs(), which runs the same fixed step the browser runs. A test that
 * waits for a frame count waits forever.
 *
 * Verify with numbers, not vibes: where a value is asserted, the expected number and its
 * derivation are in the assertion text.
 */

import { CONFIG } from '../src/config.js';
import { GameClock } from '../src/core/clock.js';
import { EventBus, EVENTS } from '../src/core/eventBus.js';
import { Input, DEFAULT_BINDINGS } from '../src/core/input.js';
import { mulberry32, Rng, hashStr } from '../src/core/rng.js';
import { rot, unrot, cross, capMag, smoothstep } from '../src/core/vec.js';
import { Game, MODES } from '../src/game.js';
import { createTerrain, baseHeightAt, BANDS, ROAD, SURFACES, WORLD } from '../src/data/terrain.js';
import { SEDAN_DEF, TRUCK_DEF, boxInertia, nearestZone, findZone } from '../src/data/vehicles.js';
import { Body } from '../src/sim/body.js';
import { resistanceCap, gripBudgetN, downslopeN } from '../src/sim/tires.js';
import { obbOverlap, closestOnBox } from '../src/sim/collision.js';
import { createVehicle, cornersOnRoad } from '../src/sim/vehicle.js';
import {
  WINCH, fairleadPos, hookPos, cablePath, pathLength, describeWinch,
} from '../src/recovery/cable.js';
import { attachHook, detachHook, rigZone, zoneCapacityN } from '../src/recovery/attach.js';
import { placeGear, mountBlock, routeThroughBlock, pumpJack, nearestGear } from '../src/recovery/gear.js';
import { GEAR, STARTER_PILE } from '../src/data/equipment.js';

/* ── harness ─────────────────────────────────────────────────────────────── */
const lines = [];
let passes = 0, fails = 0;

function ok(name, cond, detail = '') {
  if (cond) { passes++; lines.push(`PASS  ${name}`); }
  else { fails++; lines.push(`FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
}
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const near = (n, a, b, tol) => ok(n, Math.abs(a - b) <= tol, `got ${a}, want ${b} +/- ${tol}`);
const gt = (n, a, b) => ok(n, a > b, `got ${a}, wanted > ${b}`);
const lt = (n, a, b) => ok(n, a < b, `got ${a}, wanted < ${b}`);
const inRange = (n, a, lo, hi) => ok(n, a >= lo && a <= hi, `got ${a}, wanted ${lo}..${hi}`);
const note = (s) => lines.push(`      ${s}`);

/* Emit after EVERY section, not just at the end: the harness greps the dumped DOM, so a suite
 * that throws half way must still report how far it got. A silent page teaches nothing. */
let _pre = null;
function emit(status) {
  if (!_pre) {
    _pre = document.createElement('pre');
    _pre.id = 'test-out';
    _pre.style.cssText = 'position:fixed;inset:0;z-index:99999;overflow:auto;background:#06080c;'
      + 'color:#cfe;font:11px ui-monospace,Consolas,monospace;padding:12px;white-space:pre';
    document.body.appendChild(_pre);
  }
  const tail = status || (fails === 0
    ? `ALL-PASS  ${passes} assertions`
    : `FAILURES  ${fails} of ${passes + fails}`);
  _pre.textContent = '==TBTEST-BEGIN==\n' + lines.join('\n') + '\n\n' + tail + '\n==TBTEST-END==';
}

const STEP = CONFIG.sim.stepMs;
const kN = (n) => (n / 1000).toFixed(1);

/* ── live-recovery helpers ───────────────────────────────────────────────── */

/** A fresh game on a fixed attempt, in play, with no title screen. */
function newGame(seed = 4242, attempt = 1) {
  const g = new Game({ seed, seedLabel: 'test' });
  g.attempt = attempt - 1;
  g.startJob();               // reset(reroll:true) -> attempt becomes `attempt`
  return g;
}

/** Put the truck somewhere, as if the player had driven it there. */
function park(g, x, y, angle, parkBrake = true) {
  const b = g.state.vehicles.truck.body;
  b.x = x; b.y = y; b.angle = angle;
  b.vx = 0; b.vy = 0; b.omega = 0;
  g.state.vehicles.truck.parkBrake = parkBrake;
}

/**
 * The park an operator would actually choose: wrecker on the pavement, facing along the road,
 * TAIL toward the casualty so the line leaves the drum without crossing its own truck, and far
 * enough along that the car comes up through the gap the car itself made in the guardrail.
 *
 * Every number here is geometry, and getting it wrong is instructive rather than fatal:
 *   - facing east (angle 0) puts the fairlead 3.05 m WEST of the truck centre, so the sedan
 *     has to be west of the truck or the cable would run through the cab
 *   - y = 6.6 is the FAR lane. It looks like the wrong side of the road and it is the right
 *     side of the road: the sedan comes to rest about 2.5 m short of the fairlead along the
 *     pull line, so every metre the drum sits further north is a metre of car that ends up on
 *     pavement instead of hanging over the shoulder. Parking in the near lane leaves two
 *     corners off, and the fix for that is to drive forward and drag it clear.
 *   - 11 m east is the measured sweet spot. Closer and the pull is so steep it loads the line to
 *     the breaking point against the bogged car; further and the sedan tracks along the contour
 *     instead of up it, and drags itself into the guardrail east of the gap. Swept over dx =
 *     6,8,10,11,12,14,16 on four seeds: 8-12 completes in 33-52 s at 13-26 kN peak, 14+ ends in
 *     the rail, 6 snaps the cable.
 */
function operatorPark(g, dxEast = 11, y = 6.6) {
  const s = g.state.vehicles.sedan.body;
  park(g, s.x + dxEast, y, 0);
  return fairleadPos(g.state.vehicles.truck);
}

/**
 * Rig the line to a zone the way a player would: walk the hook out (free spool pays cable to
 * match the distance), then hook on. Without matching lineM to the distance first, the spring
 * would be stretched 20 m on the first step and part instantly.
 */
function rigTo(g, vehId, zoneId, { rig = null, block = null } = {}) {
  const st = g.state;
  const veh = st.vehicles[vehId];
  const zone = findZone(veh.def, zoneId);
  if (rig) rigZone(veh, zoneId, rig, g.bus, st.simTimeMs);
  if (block) {
    st.winch.blockId = block;
  }
  const p = veh.body.toWorld(zone.local.x, zone.local.y);
  st.winch.hook.x = p.x; st.winch.hook.y = p.y;
  st.winch.state = WINCH.ATTACHED;
  st.winch.targetId = vehId;
  st.winch.zoneId = zoneId;
  const len = pathLength(cablePath(st.winch, st.vehicles.truck, st.vehicles, st.blocksById));
  st.winch.state = WINCH.LOOSE;      // let attachHook do the real transition and event
  attachHook(st, veh, zone, g.bus, st.simTimeMs);
  // Exactly the path length: zero stretch, zero tension, and takeUp() below can then ask for a
  // load in metres of stretch and get it. (This carried +0.04 m of slack at first, which
  // silently ate every take-up smaller than 4 cm — and at 520 kN/m, 4 cm is 21 kN.)
  st.winch.lineM = len;
  return { zone, capacityN: zoneCapacityN(veh, zone, st.winch.rig) };
}

/**
 * Load the line to a given stretch, measured from where the bodies are RIGHT NOW.
 * Re-anchoring to the live path length each time is what makes a second overload land: after
 * the first one the car has moved, so a blind `lineM -= x` may be pulling on slack.
 * At the bare-hook rate of 520 kN/m: 2 cm ~ 10 kN, 5 cm ~ 26 kN, 8 cm ~ 42 kN (the cable's limit).
 */
function takeUp(g, metres) {
  const st = g.state;
  const len = pathLength(cablePath(st.winch, st.vehicles.truck, st.vehicles, st.blocksById));
  st.winch.lineM = len - metres;
  return st.winch.lineM;
}

/** Put a gear item of a kind at a world point, pumped/mounted as asked. */
function stage(g, kind, x, y, angle = 0) {
  const item = g.state.gear.find((q) => q.kind === kind && !q.placed && !q.carriedBy)
            || g.state.gear.find((q) => q.kind === kind);
  placeGear(g.state, item, x, y, angle, g.bus, g.state.simTimeMs);
  return item;
}

/** Reel in for up to `ms` of simulation, stopping early when `stop` says so.
 *  Records the peak tension and the peak gear effect SEEN DURING the pull — measuring either
 *  after the fact reads zero, because by then the car has been dragged away from its cribbing. */
let peakTensionN = 0, peakChocks = 0, minDragMul = 1;
function reel(g, ms, stop = null) {
  g.state.winch.motor = 1;
  peakTensionN = 0; peakChocks = 0; minDragMul = 1;
  const chunk = 250;
  let spent = 0;
  while (spent < ms) {
    g.skipMs(chunk);
    spent += chunk;
    peakTensionN = Math.max(peakTensionN, g.state.winch.tensionN);
    peakChocks = Math.max(peakChocks, g.state.vehicles.truck.chockAids.length);
    minDragMul = Math.min(minDragMul, g.state.vehicles.sedan.dragMul);
    if (stop && stop(g)) break;
  }
  g.state.winch.motor = 0;
  return spent;
}

/** Drive the truck as if someone were in the cab holding the throttle. */
function drive(g, throttle, ms) {
  const t = g.state.vehicles.truck;
  t.occupied = true;
  t.parkBrake = false;
  t.throttle = throttle;
  const chunk = 250;
  for (let spent = 0; spent < ms; spent += chunk) {
    t.throttle = throttle;       // stepPlayer would set this every step from the axis
    g.skipMs(chunk);
  }
  t.throttle = 0;
  t.occupied = false;
  return ms;
}

const done = (g) => g.state.goal.complete;

/* ══ A. the copied core ══════════════════════════════════════════════════ */
function sectionA() {
lines.push('--- A. copied core modules (Dev\\INDEX.md reuse) ---');
{
  const a = mulberry32(12345), b = mulberry32(12345), c = mulberry32(12346);
  const sa = [], sb = [], sc = [];
  for (let i = 0; i < 8; i++) { sa.push(a()); sb.push(b()); sc.push(c()); }
  ok('A1 mulberry32 same seed gives an identical stream', sa.join() === sb.join());
  ok('A2 different seed diverges', sa.join() !== sc.join());
  const r = new Rng(999);
  const first = [r.float(), r.float(), r.float()];
  r.reset();
  ok('A3 Rng.reset restores the exact stream', [r.float(), r.float(), r.float()].join() === first.join());
  const sp = new Rng(7);
  let inb = true;
  for (let i = 0; i < 500; i++) { const v = sp.spread(2.5); if (v < -2.5 || v > 2.5) inb = false; }
  ok('A4 Rng.spread stays inside +/-m over 500 draws', inb);
  eq('A5 hashStr is stable', hashStr('ditch_one'), hashStr('ditch_one'));

  const clk = new GameClock({ stepMs: STEP, maxFrameMs: 250 });
  let steps = 0;
  for (let i = 0; i < 60; i++) steps += clk.advance(1000 / 60, () => {});
  eq('A6 one real second is exactly 60 fixed steps', steps, 60);
  near('A7 simTime tracks the steps taken', clk.simTimeMs, 1000, 1e-6);
  clk.setPaused(true);
  eq('A8 paused advance runs zero steps', clk.advance(5000, () => {}), 0);
  clk.setPaused(false);
  const clk2 = new GameClock({ stepMs: STEP, maxFrameMs: 250 });
  ok('A9 a 5 s frame gap is clamped, not caught up', clk2.advance(5000, () => {}) <= 15);
  eq('A10 skipMs runs the steps a real second would', new GameClock({ stepMs: STEP }).skipMs(1000, () => {}), 60);

  const bus = new EventBus({ logSize: 4 });
  for (let i = 0; i < 9; i++) bus.emit('X', { i }, i);
  eq('A11 the event log is bounded', bus.log.length, 4);
  eq('A12 emitted counts everything, logged or not', bus.emitted, 9);
  eq('A13 bus.count survives log eviction (9 emitted, 4 still logged)', bus.count('X'), 9);
  eq('A14 the ring really did evict', bus.log.length, 4);

  const inp = new Input(window, DEFAULT_BINDINGS);
  inp._debugPress('KeyW'); inp._debugPress('KeyD');
  const ax = inp.moveAxis();
  near('A15 diagonal walk is normalised', Math.hypot(ax.x, ax.y), 1, 1e-9);
  const da = inp.driveAxis();
  ok('A16 driveAxis is NOT normalised (full throttle + full lock)', da.steer === 1 && da.throttle === 1);
  inp.virtualDown('winchIn');
  ok('A17 an on-screen button reads as a held action', inp.isDown('winchIn'));
  inp.virtualUp('winchIn');
  ok('A18 releasing it clears the hold', !inp.isDown('winchIn'));
  inp.endStep();
  ok('A19 endStep consumes the edge', !inp.wasPressed('winchIn'));
}
}

/* ══ B. the ground ══════════════════════════════════════════════════════ */
function sectionB() {
lines.push('--- B. terrain: the height field IS the slope (GDD pillar 2) ---');
{
  const t = createTerrain(new Rng(1234, 'world'));
  const d = t.describe();

  near('B1 road surface is the datum, h=0', baseHeightAt(46, ROAD.centreY), 0.05, 0.06);
  lt('B2 the embankment is below the road', t.heightAt(46, 24), -3.0);
  inRange('B3 total drop road->ditch is 4.4-5.2 m (authored 4.57)', d.dropM, 4.4, 5.4);
  inRange('B4 steepest gradient is 0.50-0.60 (config comment says ~0.546)', d.maxGradient, 0.50, 0.60);
  inRange('B5 that is 26-31 degrees (config comment says 28.6)', d.maxAngleDeg, 26, 31);
  inRange('B6 the steep part is on the embankment', d.atY, BANDS.shoulderS, BANDS.embankmentS);

  eq('B7 pavement is pavement', t.surfaceAt(46, ROAD.centreY).id, 'pavement');
  eq('B8 just south of the road is shoulder', t.surfaceAt(46, BANDS.roadS + 0.6).id, 'shoulder');
  eq('B9 the embankment is wet grass', t.surfaceAt(46, 21).id, 'wetGrass');
  eq('B10 the low point is mud', t.surfaceAt(t.mud.x, t.mud.y).id, 'mud');
  eq('B11 mud stops at its own rim', t.surfaceAt(t.mud.x + t.mud.rx + 1, t.mud.y).id, 'wetGrass');

  // Slope direction: on the embankment the ground must fall SOUTH, away from the road.
  const s = t.slopeAt(46, 21);
  gt('B12 the embankment falls southward (dh/dy < 0)', -s.gy, 0.2);
  lt('B13 and does not fall sideways', Math.abs(s.gx), 0.05);
  near('B14 normalFrac is cos(atan(grad))', s.normalFrac, Math.cos(Math.atan(s.mag)), 1e-9);
  near('B15 the road is flat enough to park on', t.slopeAt(46, ROAD.centreY).mag, 0, 0.03);
  gt('B16 the north cut bank rises', t.heightAt(46, 0.5), t.heightAt(46, ROAD.centreY));

  // The force budget in config.js opens with "1400 kg on 27 degrees ~= 6.2 kN". Check it.
  const fake = new Body({ massKg: CONFIG.sedan.massKg, inertia: 1, x: 46, y: 21 });
  const dn = downslopeN(fake, t);
  inRange(`B17 downslope pull on the sedan is 5-7 kN (config says 6.2, got ${kN(dn)})`, dn, 5000, 7000);

  // Grip budget claims from the same block.
  const onRoad = createVehicle(TRUCK_DEF, { x: 46, y: ROAD.centreY, angle: 0 }, {});
  const onGrass = createVehicle(TRUCK_DEF, { x: 46, y: 20, angle: 0 }, {});
  const gR = gripBudgetN(onRoad, t), gG = gripBudgetN(onGrass, t);
  inRange(`B18 truck grip on pavement is ~63 kN (got ${kN(gR)})`, gR, 58000, 68000);
  inRange(`B19 truck grip on the wet slope is ~14-23 kN (got ${kN(gG)})`, gG, 12000, 24000);
  gt('B20 pavement gives at least 2.5x the grip of the wet slope', gR / gG, 2.5);

  ok('B21 clampToWorld keeps a body on site', (() => {
    const c = t.clampToWorld(-5, 999, 1);
    return c.clamped && c.x >= 1 && c.y <= WORLD.heightM - 1;
  })());
  eq('B22 onRoad agrees with surfaceAt', t.onRoad(46, ROAD.centreY), t.surfaceAt(46, ROAD.centreY).id === 'pavement');

  // Variation, criterion 9: two attempts must differ, same attempt must not.
  const a = createTerrain(new Rng(11, 'w')), b = createTerrain(new Rng(11, 'w')), c = createTerrain(new Rng(12, 'w'));
  ok('B23 same seed lays out the identical site', a.mud.x === b.mud.x && a.anchors.sedan.angle === b.anchors.sedan.angle);
  ok('B24 a different seed moves the mud and the sedan', a.mud.x !== c.mud.x || a.anchors.sedan.angle !== c.anchors.sedan.angle);
  gt('B25 the guardrail has a gap in it', t.rail.gapX1 - t.rail.gapX0, 4);
  gt('B26 there are trees to anchor to', t.trees.length, 2);
  ok('B27 one tree is at the foot of the slope, for a side pull',
     t.trees.some((q) => q.y > BANDS.shoulderS && q.y < BANDS.embankmentS + 6));
}
}

/* ══ C. rigid bodies ════════════════════════════════════════════════════ */
function sectionC() {
lines.push('--- C. rigid body: force at an offset MUST make torque (GDD §4) ---');
{
  const b = new Body({ id: 'b', x: 0, y: 0, angle: 0, massKg: 100, inertia: 50, halfL: 2, halfW: 1 });

  b.applyForce(100, 0);
  eq('C1 force through the centre makes no torque', b.torque, 0);
  b.clearForces();

  // The whole reason this is a rigid body and not a circle.
  b.applyForceAt(0, 1000, 2, 0);
  gt('C2 force at the nose, sideways, makes positive torque', b.torque, 0);
  near('C3 torque is r x F', b.torque, 2 * 1000, 1e-9);
  b.clearForces();
  b.applyForceAt(0, 1000, -2, 0);
  lt('C4 the same force at the tail makes the opposite torque', b.torque, 0);
  b.clearForces();

  near('C5 rot/unrot round-trip', unrot(...Object.values(rot(3, -1, 0.7)), 0.7).x, 3, 1e-9);
  near('C6 cross sign convention: +x cross +y is positive', cross(1, 0, 0, 1), 1, 1e-12);

  b.angle = Math.PI / 2;
  const w = b.toWorld(1, 0);
  near('C7 at 90 degrees the nose points south (+y)', w.y, 1, 1e-9);
  near('C8 and not east', w.x, 0, 1e-9);
  const l = b.toLocal(w.x, w.y);
  near('C9 toLocal inverts toWorld', l.x, 1, 1e-9);

  b.angle = 0; b.vx = 0; b.vy = 0; b.omega = 1;
  const v = b.velocityAt(1, 0);
  near('C10 spin makes the nose move sideways at omega*r', v.y, 1, 1e-9);

  const cs = b.corners();
  eq('C11 four corners', cs.length, 4);
  near('C12 corners are at the half-extents', Math.abs(cs[0].x), 2, 1e-9);
  ok('C13 containsPoint is true inside, false outside', b.containsPoint(1.5, 0.5) && !b.containsPoint(3, 0));

  const cap = capMag(300, 400, 250);
  near('C14 capMag preserves direction', cap.x / cap.y, 300 / 400, 1e-9);
  near('C15 capMag clamps magnitude', Math.hypot(cap.x, cap.y), 250, 1e-9);

  near('C16 box inertia matches m(l^2+w^2)/12', boxInertia(1400, 4.55, 1.8),
       1400 * (4.55 * 4.55 + 1.8 * 1.8) / 12, 1e-6);

  // Integration and the clamps.
  const c2 = new Body({ id: 'c', massKg: 10, inertia: 5, halfL: 1, halfW: 1 });
  c2.applyForce(100, 0);
  c2.integrate(1 / 60);
  near('C17 semi-implicit: v = F/m*dt', c2.vx, 100 / 10 / 60, 1e-3);
  gt('C18 position moved with the NEW velocity', c2.x, 0);
  eq('C19 forces are cleared by integrate', c2.fx, 0);
  c2.omega = 99; c2.integrate(1 / 60);
  ok('C20 spin is clamped', Math.abs(c2.omega) <= CONFIG.sim.maxSpin + 1e-6);

  // Collision geometry.
  const A = new Body({ id: 'A', x: 0, y: 0, massKg: 1, inertia: 1, halfL: 2, halfW: 1 });
  const B = new Body({ id: 'B', x: 3, y: 0, massKg: 1, inertia: 1, halfL: 2, halfW: 1 });
  ok('C21 overlapping boxes are detected', !!obbOverlap(A, B));
  B.x = 5.0;
  ok('C22 separated boxes are not', obbOverlap(A, B) === null);
  B.x = 3;
  const hit = obbOverlap(A, B);
  gt('C23 the contact normal points from a toward b', hit.nx, 0.5);
  near('C24 penetration depth is the overlap', hit.depth, 1, 1e-6);
  const cp = closestOnBox(A, 4, 0);
  near('C25 closestOnBox clamps to the face', cp.x, 2, 1e-9);
  ok('C26 and reports outside as outside', !cp.inside);
}
}

/* ══ D. the tire model ══════════════════════════════════════════════════ */
function sectionD() {
lines.push('--- D. tires: static friction is the drama (see src/sim/tires.js) ---');
{
  const dt = 1 / 60;
  // At rest, under an 8 kN push, the cap must be big enough to CANCEL that push. This single
  // property is the difference between "the sedan holds and the line goes tight" and "the
  // sedan creeps out under any load at all".
  const atRest = resistanceCap(1400, 0, 8000, dt);
  near('D1 at rest the cap is exactly enough to cancel the incoming force', atRest.cap, 8000, 1e-9);
  eq('D2 and resists in the direction of that force', atRest.dir, 1);

  const moving = resistanceCap(1400, 0.5, 0, dt);
  near('D3 while moving the cap is enough to stop it this step', moving.cap, 1400 * 0.5 / dt, 1e-6);
  eq('D4 opposing the direction of travel', moving.dir, 1);
  eq('D5 negative velocity flips the direction', resistanceCap(100, -1, 0, dt).dir, -1);

  const backwards = resistanceCap(1400, 0, -8000, dt);
  eq('D6 a push the other way is resisted the other way', backwards.dir, -1);
  near('D7 and still exactly covered', backwards.cap, 8000, 1e-9);

  // A load BELOW the resistance must produce no net motion; ABOVE it must.
  const t = createTerrain(new Rng(5, 'w'));
  function creepTest(pullN) {
    const v = createVehicle(SEDAN_DEF, { x: 46, y: ROAD.centreY, angle: 0 }, { lockedWheels: ['wheelRL', 'wheelRR', 'wheelFL', 'wheelFR'] });
    v.parkBrake = true;
    for (let i = 0; i < 240; i++) {
      v.body.applyForce(pullN, 0);
      // slope on the road is ~0, so this isolates the brake/friction behaviour
      const { stepVehicle } = window.__TB_SIM;
      stepVehicle(v, t, 1 / 60, window.__TB.game.bus, 0);
    }
    return v.body.x - 46;
  }
  const smallPull = creepTest(4000);
  const bigPull = creepTest(20000);
  lt(`D8 a 4 kN pull on locked wheels moves it < 3 cm in 4 s (got ${smallPull.toFixed(3)} m)`, Math.abs(smallPull), 0.03);
  gt(`D9 a 20 kN pull does move it (got ${bigPull.toFixed(2)} m)`, bigPull, 0.25);

  // Grip must fall with slope, and it must fall for the arithmetic reason, not a special case.
  const flat = createVehicle(SEDAN_DEF, { x: 46, y: ROAD.centreY, angle: 0 }, {});
  const steep = createVehicle(SEDAN_DEF, { x: 46, y: 21, angle: 0 }, {});
  lt('D10 grip on the steep wet slope is below grip on the flat road', gripBudgetN(steep, t), gripBudgetN(flat, t));
  const surfRatio = SURFACES.wetGrass.mu / SURFACES.pavement.mu;
  lt('D11 and by more than the surface change alone, because of the slope cosine',
     gripBudgetN(steep, t) / gripBudgetN(flat, t), surfRatio + 1e-6);

  // Mud is the worst of both: poor grip AND heavy drag. They are separate numbers on purpose.
  lt('D12 mud grips worse than wet grass', SURFACES.mud.mu, SURFACES.wetGrass.mu);
  gt('D13 and drags far more', SURFACES.mud.crr / SURFACES.wetGrass.crr, 2);
}
}

/* ══ E. the winch line ══════════════════════════════════════════════════ */
function sectionE() {
lines.push('--- E. the cable: equal and opposite, at offsets (GDD pillar 2) ---');
{
  const g = newGame(777, 1);
  const st = g.state;
  const fl = operatorPark(g);
  near('E1 the fairlead is at the back of the truck', fl.x, st.vehicles.truck.body.x - 3.05, 0.02);

  eq('E2 a stowed line carries no tension', st.winch.tensionN, 0);
  const r = rigTo(g, 'sedan', 'towHook');
  eq('E3 hooking on always succeeds', st.winch.state, WINCH.ATTACHED);
  eq('E4 and records the zone', st.winch.zoneId, 'towHook');
  near('E5 a freshly walked-out line is not stretched', st.winch.tensionN, 0, 1e-6);

  // Take up 2 cm of line and read the tension. Two centimetres, not thirty: at 520 kN/m a bare
  // hook reaches its 42 kN breaking load in 8 cm of stretch, which is 0.4% strain over a 20 m
  // rig — about right for wire rope, and a reminder that this cable is nearly inextensible.
  takeUp(g, 0.02);
  g.step(STEP, st.simTimeMs + STEP, null);
  inRange('E6 2 cm of take-up is ~10 kN of tension', st.winch.tensionN, 6000, 14000);

  // Re-read the forces on a clean step so we can compare the two ends.
  const truckB = st.vehicles.truck.body, sedanB = st.vehicles.sedan.body;
  truckB.clearForces(); sedanB.clearForces();
  const { stepCable } = window.__TB_SIM;
  const T = stepCable(st, STEP / 1000, g.bus, st.simTimeMs);
  const fT = Math.hypot(truckB.fx, truckB.fy);
  const fS = Math.hypot(sedanB.fx, sedanB.fy);
  near('E7 both ends feel the same magnitude', fT, fS, Math.max(1, fT * 0.001));
  const dot = (truckB.fx * sedanB.fx + truckB.fy * sedanB.fy) / (fT * fS);
  near('E8 in exactly opposite directions', dot, -1, 1e-6);
  gt('E9 and the load end gets torque, not just force', Math.abs(sedanB.torque), 1);

  // The tow hook must outlast the cable — GDD's attachment table says so explicitly.
  gt(`E10 the tow hook (${kN(r.capacityN)} kN) outlasts the cable (${kN(CONFIG.winch.cableBreakN)} kN)`,
     r.capacityN, CONFIG.winch.cableBreakN);

  // Breaking: pull the line far past its rating and it must part, drop the hook, and continue.
  const g2 = newGame(778, 1);
  operatorPark(g2);
  rigTo(g2, 'sedan', 'towHook');
  takeUp(g2, 3.0);   // a 3 m stretch: far past anything survivable
  g2.step(STEP, STEP, null);
  eq('E11 an overloaded cable parts', g2.bus.count(EVENTS.CABLE_SNAPPED), 1);
  eq('E12 the hook ends up on the ground, not gone', g2.state.winch.state, WINCH.LOOSE);
  eq('E13 nothing about the job ends', g2.state.goal.complete, false);
  eq('E14 and the sedan is still there to try again', !!g2.state.vehicles.sedan, true);

  // Reel behaviour and the stall.
  const g3 = newGame(779, 1);
  const s3 = g3.state;
  operatorPark(g3);
  rigTo(g3, 'sedan', 'towHook');
  const line0 = s3.winch.lineM;
  s3.winch.motor = 1;
  g3.skipMs(1000);
  lt('E15 reeling in shortens the line', s3.winch.lineM, line0);
  near('E16 at roughly the rated no-load speed', line0 - s3.winch.lineM, CONFIG.winch.reelInMps, 0.30);
  s3.winch.motor = -1;
  const line1 = s3.winch.lineM;
  g3.skipMs(500);
  gt('E17 paying out lengthens it', s3.winch.lineM, line1);
  s3.winch.motor = 0;
  lt('E18 the drum never gives more than it has', s3.winch.lineM, CONFIG.winch.spoolLengthM + 1e-6);
  gt('E19 and never reels the hook into itself', s3.winch.lineM, CONFIG.winch.minLineM - 1e-9);

  // Snatch block: the path must bend, and the length must be the sum of the legs.
  const g4 = newGame(780, 1);
  const s4 = g4.state;
  operatorPark(g4);
  const tree = s4.terrain.trees.find((q) => q.y > BANDS.shoulderS) || s4.terrain.trees[0];
  const blk = g4.state.gear.find((q) => q.kind === 'snatchBlock');
  placeGear(s4, blk, tree.x + tree.r + 0.2, tree.y, 0, g4.bus, 0);
  const anchored = mountBlock(s4, blk, s4.terrain, g4.bus, 0);
  ok('E20 a snatch block mounts to a tree', !!anchored);
  routeThroughBlock(s4, blk, g4.bus, 0);
  // blocksById is DERIVED state, rebuilt by stepGearEffects from what is lying where — that is
  // what makes a block stop working when it gets knocked over. So it is empty until a step runs,
  // and cablePath would still report a straight two-point line.
  window.__TB_SIM.stepGearEffects(s4, s4.terrain, STEP / 1000, g4.bus, 0);
  eq('E21 the line can be routed through it', s4.winch.blockId, blk.id);
  rigTo(g4, 'sedan', 'frameFront');
  const path = cablePath(s4.winch, s4.vehicles.truck, s4.vehicles, s4.blocksById);
  eq('E22 the cable path has three points once routed', path.length, 3);
  const direct = Math.hypot(path[2].x - path[0].x, path[2].y - path[0].y);
  gt('E23 going round the block is longer than going straight', pathLength(path), direct);

  // The redirect must actually change the direction of pull on the truck.
  s4.vehicles.truck.body.clearForces();
  s4.vehicles.sedan.body.clearForces();
  takeUp(g4, 0.03);
  stepCable(s4, STEP / 1000, g4.bus, s4.simTimeMs);
  const tb = s4.vehicles.truck.body;
  const toBlock = Math.atan2(path[1].y - path[0].y, path[1].x - path[0].x);
  const toCar = Math.atan2(path[2].y - path[0].y, path[2].x - path[0].x);
  const forceDir = Math.atan2(tb.fy, tb.fx);
  const off = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  near('E24 the truck is pulled toward the BLOCK', off(forceDir, toBlock), 0, 0.08);
  gt('E25 which is a different direction from the car', off(toBlock, toCar), 0.25);

  const w = describeWinch(s4.winch);
  eq('E26 describeWinch reports the routing', w.throughBlock, true);
  inRange('E27 and a tension level the HUD can colour', ['ok', 'warn', 'danger'].indexOf(w.level), 0, 2);
}
}

/* ══ F. attachment and consequence ══════════════════════════════════════ */
function sectionF() {
lines.push('--- F. attachments: forgiving until strength runs out (GDD §4) ---');
{
  const g = newGame(881, 1);
  const sedan = g.state.vehicles.sedan;

  // The GDD's attachment table, as an ordering.
  const cap = (z, r = 'bare') => zoneCapacityN(sedan, findZone(SEDAN_DEF, z), r);
  gt('F1 tow hook > axle', cap('towHook'), cap('axleFront'));
  gt('F2 axle > wheel', cap('axleFront'), cap('wheelFL'));
  gt('F3 wheel > bumper', cap('wheelFL'), cap('bumperFront'));
  gt('F4 bumper > door', cap('bumperFront'), cap('doorL'));
  near('F5 a strap adds 40%', cap('bumperFront', 'strap') / cap('bumperFront'), 1.40, 1e-9);
  near('F6 a chain adds 75%', cap('bumperFront', 'chain') / cap('bumperFront'), 1.75, 1e-9);
  lt('F7 a bare bumper cannot survive a bogged up-slope recovery (~15 kN)', cap('bumperFront'), 15000);
  gt('F8 a chained bumper might', cap('bumperFront', 'chain'), 15000);

  // Every zone accepts the hook. Nothing is rejected — that is the design.
  let attached = 0;
  for (const z of SEDAN_DEF.zones) {
    const gg = newGame(882, 1);
    rigTo(gg, 'sedan', z.id);
    if (gg.state.winch.state === WINCH.ATTACHED) attached++;
  }
  eq(`F9 all ${SEDAN_DEF.zones.length} zones accept the hook`, attached, SEDAN_DEF.zones.length);

  // A weak zone tears, becomes a physical object, and the job continues.
  const g2 = newGame(883, 1);
  const s2 = g2.state;
  operatorPark(g2);
  rigTo(g2, 'sedan', 'bumperFront');
  takeUp(g2, 0.05);   // ~26 kN: past a 9 kN bumper, well short of the 42 kN cable
  g2.step(STEP, STEP, null);
  gt('F10 an overloaded bumper fails', g2.bus.count(EVENTS.ZONE_FAILED), 0);
  eq('F11 it leaves the car', s2.vehicles.sedan.damage.parts.bumperFront, 'lost');
  gt('F12 as a physical object in the scene', s2.debris.length, 0);
  eq('F13 and the hook is back on the ground, not deleted', s2.winch.state, WINCH.LOOSE);
  eq('F14 there is nothing left to hook there', s2.vehicles.sedan.zoneMod.bumperFront, 0);
  eq('F15 the job is not over', s2.goal.complete, false);

  // An axle BENDS first, then lets go: two consequences from one repeated mistake.
  const g3 = newGame(884, 1);
  const s3 = g3.state;
  operatorPark(g3);
  rigTo(g3, 'sedan', 'axleFront');
  takeUp(g3, 0.06);   // ~31 kN: past a 26 kN axle, still short of the cable
  g3.step(STEP, STEP, null);
  eq('F16 an overloaded axle bends rather than tearing off', s3.vehicles.sedan.damage.parts.axleFront, 'bent');
  eq('F17 and the hook is still on it', s3.winch.state, WINCH.ATTACHED);
  near('F18 but it is 30% weaker now', s3.vehicles.sedan.zoneMod.axleFront, 0.70, 1e-9);
  const frontWheel = s3.vehicles.sedan.wheelState.find((w) => w.id === 'wheelFL');
  gt('F19 a bent axle permanently drags its wheels', frontWheel.dragMul, 1.0);
  takeUp(g3, 0.06);   // again, against the 18 kN a bent axle is now worth
  g3.step(STEP, s3.simTimeMs + STEP, null);
  eq('F20 overload it again and it lets go', s3.vehicles.sedan.damage.parts.axleFront, 'lost');

  // A lost wheel changes later behaviour — GDD criterion "damage results from force and
  // changes later behaviour".
  const g4 = newGame(885, 1);
  const s4 = g4.state;
  operatorPark(g4);
  rigTo(g4, 'sedan', 'wheelFL');
  takeUp(g4, 0.04);   // ~21 kN: past a 14 kN wheel hub
  g4.step(STEP, STEP, null);
  eq('F21 an overloaded wheel detaches', s4.vehicles.sedan.damage.parts.wheelFL, 'lost');
  const ws = s4.vehicles.sedan.wheelState.find((w) => w.id === 'wheelFL');
  eq('F22 that corner has no tire on it', ws.attached, false);
  near('F23 and now ploughs', ws.dragMul, CONFIG.damage.wheelLostDragMul, 1e-9);

  // The frame and the tow hook must survive anything the starter cable can do.
  for (const z of ['towHook', 'frameFront']) {
    const g5 = newGame(886, 1);
    const s5 = g5.state;
    operatorPark(g5);
    rigTo(g5, 'sedan', z);
    takeUp(g5, 3.0);
    g5.step(STEP, STEP, null);
    eq(`F24 ${z}: the cable parts before the attachment does`, g5.bus.count(EVENTS.CABLE_SNAPPED), 1);
    ok(`F25 ${z}: nothing came off the car`,
       Object.keys(s5.vehicles.sedan.damage.parts).length === 0);
  }
}
}

/* ══ G. the boring equipment ════════════════════════════════════════════ */
function sectionG() {
lines.push('--- G. gear: geometry, not a checklist (GDD pillar 7) ---');
{
  eq('G1 the pile is exactly what the GDD lists', STARTER_PILE.length, 10);
  eq('G2 two chocks', STARTER_PILE.filter((k) => k === 'chock').length, 2);
  eq('G3 four cribbing blocks', STARTER_PILE.filter((k) => k === 'cribbing').length, 4);
  ok('G4 strap, chain, jack and snatch block',
     ['strap', 'chain', 'jack', 'snatchBlock'].every((k) => STARTER_PILE.includes(k)));

  const g = newGame(991, 1);
  const st = g.state;
  const sedan = st.vehicles.sedan;
  const { stepGearEffects } = window.__TB_SIM;

  stepGearEffects(st, st.terrain, 1 / 60, g.bus, 0);
  near('G5 with nothing placed, no multiplier is touched', sedan.dragMul, 1, 1e-9);

  // Cribbing under the sedan.
  const b = sedan.body;
  stage(g, 'cribbing', b.x + 0.5, b.y + 0.5);
  stage(g, 'cribbing', b.x - 0.5, b.y + 0.5);
  stepGearEffects(st, st.terrain, 1 / 60, g.bus, 0);
  lt('G6 two cribbing blocks cut ground drag', sedan.dragMul, 0.75);
  lt('G7 and help it out of its own hole', sedan.boggedMul, 0.75);
  gt('G8 and resist it pivoting away', sedan.spinResistN, 0);

  // Cribbing dropped 20 m away does nothing. There is no "used the right item" check anywhere.
  const g2 = newGame(992, 1);
  stage(g2, 'cribbing', 5, 5);
  stage(g2, 'cribbing', 6, 5);
  stepGearEffects(g2.state, g2.state.terrain, 1 / 60, g2.bus, 0);
  near('G9 cribbing left in the wrong place does nothing at all', g2.state.vehicles.sedan.dragMul, 1, 1e-9);

  // The jack.
  const g3 = newGame(993, 1);
  const s3 = g3.state;
  const sb = s3.vehicles.sedan.body;
  const jack = stage(g3, 'jack', sb.x + 1.2, sb.y + 0.4);
  stepGearEffects(s3, s3.terrain, 1 / 60, g3.bus, 0);
  near('G10 an unpumped jack does nothing', s3.vehicles.sedan.dragMul, 1, 1e-9);
  for (let i = 0; i < CONFIG.gear.jack.liftSteps; i++) {
    jack.pumpMs = CONFIG.gear.jack.pumpMs;
    pumpJack(s3, jack, 0.001, g3.bus, 0);
  }
  eq('G11 four pumps wind it fully out', jack.liftStep, CONFIG.gear.jack.liftSteps);
  stepGearEffects(s3, s3.terrain, 1 / 60, g3.bus, 0);
  near('G12 a lifted chassis drags far less', s3.vehicles.sedan.dragMul, CONFIG.gear.jack.liftDragMul, 0.02);
  near('G13 and is much less dug in', s3.vehicles.sedan.boggedMul, CONFIG.gear.jack.liftBoggedMul, 0.02);
  ok('G14 the nearest corner is off the ground', s3.vehicles.sedan.wheelState.some((w) => w.lifted));

  // A jack under sideways load falls over. Consequence, not a warning label.
  s3.vehicles.sedan.body.clearForces();
  const right = s3.vehicles.sedan.body.right;
  s3.vehicles.sedan.body.applyForce(right.x * 9000, right.y * 9000);
  stepGearEffects(s3, s3.terrain, 1 / 60, g3.bus, 0);
  eq('G15 sideways load knocks the jack out', jack.liftStep, 0);
  gt('G16 and says so', g3.bus.count(EVENTS.GEAR_SCATTERED), 0);

  // Chocks: a wedge only resists rolling INTO it. This is the whole of "poor placement has
  // little effect", and it is judged by geometry.
  const g4 = newGame(994, 1);
  const s4 = g4.state;
  const truck = s4.vehicles.truck;
  truck.body.angle = 0;                      // facing east, so fore/aft is along x
  const wheel = truck.body.toWorld(TRUCK_DEF.wheels[3].local.x, TRUCK_DEF.wheels[3].local.y);
  stage(g4, 'chock', wheel.x - 0.55, wheel.y);   // behind the wheel, along its rolling axis
  stepGearEffects(s4, s4.terrain, 1 / 60, g4.bus, 0);
  gt('G17 a chock placed fore/aft of a wheel is an anchor', truck.chockAids.length, 0);

  const g5 = newGame(995, 1);
  const s5 = g5.state;
  s5.vehicles.truck.body.angle = 0;
  const wheel5 = s5.vehicles.truck.body.toWorld(TRUCK_DEF.wheels[3].local.x, TRUCK_DEF.wheels[3].local.y);
  stage(g5, 'chock', wheel5.x, wheel5.y + 0.9);  // alongside the tire: useless, correctly
  stepGearEffects(s5, s5.terrain, 1 / 60, g5.bus, 0);
  eq('G18 a chock alongside a tire does nothing', s5.vehicles.truck.chockAids.length, 0);

  // A snatch block needs a real anchor. A block in the middle of a field is a paperweight.
  const g6 = newGame(996, 1);
  const blk = g6.state.gear.find((q) => q.kind === 'snatchBlock');
  placeGear(g6.state, blk, 46, 40, 0, g6.bus, 0);
  eq('G19 a snatch block nowhere near a tree will not mount', mountBlock(g6.state, blk, g6.state.terrain, g6.bus, 0), null);
  stepGearEffects(g6.state, g6.state.terrain, 1 / 60, g6.bus, 0);
  eq('G20 and so cannot redirect anything', Object.keys(g6.state.blocksById).length, 0);
}
}

/* ══ H. THE GDD COMPLETION CRITERIA ════════════════════════════════════ */
function sectionH() {
lines.push('--- H. GDD §4 completion criteria, driven as whole recoveries ---');

const approaches = [];

/* H-a. Direct pull from the pavement, tow hook, wrecker parked with its tail to the job. */
{
  const g = newGame(2001, 1);
  const st = g.state;
  const s = st.vehicles.sedan.body;
  // Angled park: tail toward the casualty, body along the road. What an operator does, and the
  // geometry that lets the car finish ON the pavement rather than across the shoulder.
  operatorPark(g);
  const r = rigTo(g, 'sedan', 'towHook');
  reel(g, 90000, done);
  const on = cornersOnRoad(st.vehicles.sedan, st.terrain);
  ok(`Ha1 direct tow-hook pull from pavement recovers the sedan (${on.on}/4 corners, ${(st.simTimeMs / 1000).toFixed(1)}s)`, done(g));
  eq('Ha2 nothing on the car had to break for it', Object.keys(st.vehicles.sedan.damage.parts).length, 0);
  eq('Ha3 the cable survived', g.bus.count(EVENTS.CABLE_SNAPPED), 0);
  lt('Ha4 the truck stayed on the pavement', st.vehicles.truck.body.y, BANDS.roadS);
  if (done(g)) approaches.push('direct tow-hook pull');
  lt(`Ha5 the line never came close to parting (peak ${kN(peakTensionN)} of 42 kN)`, peakTensionN, CONFIG.winch.cableBreakN);
  note(`Ha  peak line ${kN(peakTensionN)} kN against a ${kN(r.capacityN)} kN attachment`);
}
emit('running H...');

/* H-b. The same pull off a bumper. It must fail, physically, and leave the job playable. */
{
  const g = newGame(2001, 1);
  const st = g.state;
  const s = st.vehicles.sedan.body;
  operatorPark(g);
  rigTo(g, 'sedan', 'bumperFront');
  reel(g, 30000, (gg) => gg.bus.count(EVENTS.ZONE_FAILED) > 0);
  gt('Hb1 a bumper pull tears the bumper off', g.bus.count(EVENTS.ZONE_FAILED), 0);
  eq('Hb2 it is lying in the scene as an object', st.vehicles.sedan.damage.parts.bumperFront, 'lost');
  gt('Hb3 and it is a real body', st.debris.length, 0);
  eq('Hb4 the recovery is still possible', st.goal.complete, false);
  eq('Hb5 nothing forced a reset', st.mode, MODES.PLAYING);
  // ...and the player can carry on from there: re-rig to the frame and finish the job.
  rigTo(g, 'sedan', 'frameFront', { rig: 'chain' });
  reel(g, 90000, done);
  ok('Hb6 after a torn bumper, a chained frame pull still finishes it', done(g));
  if (done(g)) approaches.push('brute force then re-rig');
}
emit('running H...');

/* H-c. Side pull through a tree-mounted snatch block: force redirected along the contour. */
{
  const g = newGame(2002, 1);
  const st = g.state;
  const s = st.vehicles.sedan.body;
  const tree = st.terrain.trees
    .filter((q) => q.y > BANDS.roadS)
    .sort((a, b) => Math.hypot(a.x - s.x, a.y - s.y) - Math.hypot(b.x - s.x, b.y - s.y))[0];
  operatorPark(g);
  const blk = st.gear.find((q) => q.kind === 'snatchBlock');
  placeGear(st, blk, tree.x + tree.r + 0.2, tree.y, 0, g.bus, 0);
  const anchor = mountBlock(st, blk, st.terrain, g.bus, 0);
  ok('Hc1 the block goes on a tree at the foot of the slope', !!anchor);
  routeThroughBlock(st, blk, g.bus, 0);
  window.__TB_SIM.stepGearEffects(st, st.terrain, STEP / 1000, g.bus, 0);
  rigTo(g, 'sedan', 'frameFront', { rig: 'strap' });
  const before = { x: s.x, y: s.y, a: s.angle };
  reel(g, 14000);
  const moved = Math.hypot(s.x - before.x, s.y - before.y);
  const turned = Math.abs(s.angle - before.a);
  gt(`Hc2 a side pull through the block moves the sedan (${moved.toFixed(2)} m)`, moved, 0.5);
  gt(`Hc3 and rotates it (${(turned * 57.3).toFixed(0)} deg)`, turned, 0.08);
  eq('Hc4 the line really was routed through the block', describeWinch(st.winch).throughBlock, true);
  // Two-stage: the block turned the car, now take the line out of it, re-park to suit where the
  // car ended up, and pull it straight up through the gap.
  st.winch.blockId = null;
  detachHook(st, g.bus, st.simTimeMs, 'player');
  operatorPark(g);
  rigTo(g, 'sedan', 'towHook');
  reel(g, 90000, done);
  ok('Hc5 rotate through the block, re-park, then pull straight, and it comes up', done(g));
  if (done(g)) approaches.push('side pull through a snatch block');
}
emit('running H...');

/* H-d. The careful recovery: jack, cribbing, chocks. It must need LESS force than bare. */
{
  function peakTension(prep) {
    const g = newGame(2003, 1);
    const st = g.state;
    const s = st.vehicles.sedan.body;
    operatorPark(g);
    if (prep) {
      stage(g, 'cribbing', s.x + 0.6, s.y + 0.6);
      stage(g, 'cribbing', s.x - 0.6, s.y + 0.6);
      const jack = stage(g, 'jack', s.x + 1.4, s.y + 0.5);
      for (let i = 0; i < CONFIG.gear.jack.liftSteps; i++) {
        jack.pumpMs = CONFIG.gear.jack.pumpMs;
        pumpJack(st, jack, 0.001, g.bus, 0);
      }
      const tb = st.vehicles.truck.body;
      for (const wi of [2, 3]) {
        const w = tb.toWorld(TRUCK_DEF.wheels[wi].local.x, TRUCK_DEF.wheels[wi].local.y);
        const back = tb.dirToWorld(-1, 0);
        stage(g, 'chock', w.x + back.x * 0.6, w.y + back.y * 0.6);
      }
    }
    rigTo(g, 'sedan', 'towHook');
    reel(g, 60000, done);
    return { peak: peakTensionN, complete: done(g), g, dragMul: minDragMul, chocks: peakChocks };
  }
  const bare = peakTension(false);
  const prepped = peakTension(true);
  ok('Hd1 the careful, jacked-and-cribbed recovery works', prepped.complete);
  lt(`Hd2 and needs less line tension than the bare pull (${kN(prepped.peak)} vs ${kN(bare.peak)} kN)`,
     prepped.peak, bare.peak);
  lt(`Hd3 because the gear really did cut the drag (x${prepped.dragMul.toFixed(2)})`, prepped.dragMul, 0.8);
  gt('Hd4 the truck was chocked', prepped.chocks, 0);
  near('Hd5 and the bare run had no gear helping it', bare.dragMul, 1, 1e-9);
  if (prepped.complete) approaches.push('prepared recovery with jack, cribbing and chocks');
}
emit('running H...');

/* H-e. Escalation: park the wrecker on the wet slope and it loses the argument. GDD §4 lists
 * this as a SUPPORTED approach, not a failure state. */
{
  const g = newGame(2004, 1);
  const st = g.state;
  const s = st.vehicles.sedan.body;
  // The same rig as Ha, moved 12 m south: down the bank, on wet grass, tail still to the job.
  park(g, s.x + 6.0, BANDS.shoulderS + 3.8, 0);
  const t0 = { x: st.vehicles.truck.body.x, y: st.vehicles.truck.body.y };
  const s0 = { x: s.x, y: s.y };
  rigTo(g, 'sedan', 'towHook');
  reel(g, 20000);
  const truckMoved = Math.hypot(st.vehicles.truck.body.x - t0.x, st.vehicles.truck.body.y - t0.y);
  const sedanMoved = Math.hypot(s.x - s0.x, s.y - s0.y);
  eq('He1 the truck was on wet grass, not pavement', st.terrain.surfaceAt(t0.x, t0.y).id, 'wetGrass');
  gt(`He2 a truck parked on the bank slides instead of winning (${truckMoved.toFixed(2)} m)`, truckMoved, 0.6);
  gt('He3 the game notices and says so', g.bus.count(EVENTS.TRUCK_SLIPPING), 0);
  ok(`He4 the scene got worse, not failed (sedan moved ${sedanMoved.toFixed(2)} m, truck ${truckMoved.toFixed(2)} m)`,
     st.mode === MODES.PLAYING && !st.goal.complete);
  note('He  same rig, same winch, different parking spot: the whole outcome inverted');
}
emit('running H...');

/* H-f. Truck position, surface, attachment and equipment all change outcomes. */
{
  ok(`Hf1 at least three meaningfully different approaches work (${approaches.length}: ${approaches.join(', ')})`,
     approaches.length >= 3);
}

/* H-g. Determinism, and then deliberate variation. Criteria: reproducible AND not identical. */
{
  function run(seed, attempt) {
    const g = newGame(seed, attempt);
    const st = g.state;
    const s = st.vehicles.sedan.body;
    operatorPark(g);
    rigTo(g, 'sedan', 'towHook');
    reel(g, 20000);
    return JSON.stringify(g.describe().sedan) + '|' + JSON.stringify(g.describe().truck);
  }
  const a1 = run(3001, 1), a2 = run(3001, 1);
  eq('Hg1 the same seed and attempt replay bit-for-bit', a1, a2);
  const b1 = run(3001, 2);
  ok('Hg2 the next attempt is not the same scene', a1 !== b1);

  const layouts = new Set();
  for (let i = 1; i <= 6; i++) {
    const g = newGame(3002, i);
    const t = g.state.terrain;
    layouts.add([
      t.mud.x.toFixed(2), t.anchors.sedan.angle.toFixed(3),
      t.rail.gapX0.toFixed(2), g.state.vehicles.sedan.boggedN.toFixed(0),
      g.state.vehicles.sedan.wheelState.filter((w) => w.locked).length,
    ].join(','));
  }
  eq('Hg3 six attempts produce six different layouts', layouts.size, 6);
}

/* H-h. Damage changes later behaviour, measurably.
 *
 * The metric is PROGRESS UP THE SLOPE, not distance travelled. Distance travelled was the first
 * attempt and it said the opposite of the truth: a car with one wheel missing slews instead of
 * tracking (measured: 60 degrees of yaw against 43), so it covers MORE ground while climbing
 * less of the bank. Path length is not progress. */
{
  function pull(loseWheel, ms) {
    const g = newGame(3100, 1);
    const st = g.state;
    const sedan = st.vehicles.sedan;
    if (loseWheel) {
      const ws = sedan.wheelState.find((w) => w.id === 'wheelFL');
      ws.attached = false;
      ws.dragMul = CONFIG.damage.wheelLostDragMul;
      sedan.damage.parts.wheelFL = 'lost';
    }
    operatorPark(g);
    rigTo(g, 'sedan', 'towHook');
    const y0 = sedan.body.y;
    reel(g, ms, done);
    return { climbed: y0 - sedan.body.y, path: sedan.travelledM, peak: peakTensionN, done: done(g) };
  }
  const whole = pull(false, 12000);
  const broken = pull(true, 12000);
  lt(`Hh1 a sedan missing a wheel climbs less in 12 s (${broken.climbed.toFixed(2)} m vs ${whole.climbed.toFixed(2)} m)`,
     broken.climbed, whole.climbed);
  gt('Hh2 but it still moves — damage is a cost, not a wall', broken.climbed, 0.05);
  gt(`Hh3 while covering MORE ground, because it slews (${broken.path.toFixed(2)} m vs ${whole.path.toFixed(2)} m)`,
     broken.path, whole.path);

  const wholeDone = pull(false, 120000);
  const brokenDone = pull(true, 120000);
  ok('Hh4 a damaged car can still be recovered', brokenDone.done && wholeDone.done);
  gt(`Hh5 but it costs more line to do it (${kN(brokenDone.peak)} vs ${kN(wholeDone.peak)} kN)`,
     brokenDone.peak, wholeDone.peak);
}

/* H-i. Tension is visible on BOTH vehicles, which is pillar 2 as an observable. */
{
  const g = newGame(3200, 1);
  const st = g.state;
  const s = st.vehicles.sedan.body;
  operatorPark(g);   // handbrake released two lines down: the truck is free to be dragged
  st.vehicles.truck.parkBrake = false;
  rigTo(g, 'sedan', 'towHook');
  const t0 = { x: st.vehicles.truck.body.x, y: st.vehicles.truck.body.y };
  const s0 = { x: s.x, y: s.y };
  reel(g, 8000);
  const dT = Math.hypot(st.vehicles.truck.body.x - t0.x, st.vehicles.truck.body.y - t0.y);
  const dS = Math.hypot(s.x - s0.x, s.y - s0.y);
  gt('Hi1 the load end moves under tension', dS, 0.05);
  gt('Hi2 and so does the truck — the cable pulls both ends', dT, 0.02);
  note(`Hi  truck moved ${dT.toFixed(3)} m, sedan ${dS.toFixed(3)} m under the same line`);
}

/* H-j. The recap can read the job back. GDD §9. */
{
  const g = newGame(3300, 1);
  const st = g.state;
  const s = st.vehicles.sedan.body;
  operatorPark(g);
  // A strap round a door pillar: 4.5 kN rated, 6.3 kN as strapped, against a pull that has to
  // beat a bogged car. It is going to tear, and that is the point — the recap has to be able to
  // say what was tried, what it cost, and what finished the job.
  rigTo(g, 'sedan', 'doorL', { rig: 'strap' });
  reel(g, 45000, (gg) => gg.bus.count(EVENTS.ZONE_FAILED) > 0);
  rigTo(g, 'sedan', 'towHook');
  reel(g, 90000, done);
  const r = g.recap();
  gt('Hj1 the recap has lines in it', r.lines.length, 3);
  ok('Hj2 it mentions the rigging that was chosen', r.lines.some(([, t]) => /strap/.test(t)));
  ok('Hj3 and what that choice cost', r.lines.some(([, t]) => /tore|came off/.test(t)));
  eq('Hj4 and the outcome', r.summary.complete, done(g));
  gt('Hj5 it counted the attachments', r.summary.attachments, 1);
}
}

/* ══ I. hygiene ═════════════════════════════════════════════════════════ */
async function sectionI() {
lines.push('--- I. project hygiene ---');
{
  const files = [
    'config.js', 'game.js', 'main.js',
    'core/clock.js', 'core/eventBus.js', 'core/input.js', 'core/rng.js', 'core/vec.js',
    'data/terrain.js', 'data/vehicles.js', 'data/equipment.js',
    'sim/body.js', 'sim/tires.js', 'sim/vehicle.js', 'sim/collision.js',
    'recovery/cable.js', 'recovery/attach.js', 'recovery/gear.js',
    'world/scene.js', 'player/player.js',
    'render/camera.js', 'render/renderer.js', 'render/audio.js',
    'ui/hud.js', 'dev/debugOverlay.js',
  ];
  let randoms = [], dates = [], missing = [];
  for (const f of files) {
    try {
      const res = await fetch(`../src/${f}`, { cache: 'no-store' });
      if (!res.ok) { missing.push(f); continue; }
      // Strip comments before grepping. Half the modules in src/ contain the sentence "no
      // gameplay system may call Math.random()", which a naive grep reports as the very
      // violation the sentence forbids. Ask about the CODE.
      const src = (await res.text())
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      if (/Math\.random\s*\(/.test(src)) randoms.push(f);
      // Simulation must not read wall-clock time; presentation may, so main/render/ui/dev are
      // exempt, and clock.js is the one module whose whole job is to be handed real time.
      if (!/^(main|render\/|ui\/|dev\/|core\/clock)/.test(f)
          && /(Date\.now|performance\.now)\s*\(/.test(src)) dates.push(f);
    } catch (e) { missing.push(f); }
  }
  eq(`I1 no Math.random anywhere in src/ (${randoms.join(', ') || 'clean'})`, randoms.length, 0);
  eq(`I2 no wall-clock time in the simulation (${dates.join(', ') || 'clean'})`, dates.length, 0);
  eq(`I3 every module fetched (${missing.join(', ') || 'all present'})`, missing.length, 0);

  ok('I4 CONFIG is frozen against runtime retuning', Object.isFrozen(CONFIG) && Object.isFrozen(CONFIG.winch));
  ok('I5 the live game booted and published its handle', !!(window.__TB && window.__TB.game));
  eq('I6 and it starts on the title screen, not mid-job', window.__TB.game.state.mode, MODES.TITLE);
  eq('I7 with the clock paused behind it', window.__TB.game.clock.paused, true);
  eq('I8 no errors reached the crash banner', document.getElementById('err-banner'), null);
}
}

/* ── run ─────────────────────────────────────────────────────────────────── */
(async function run() {
  // The live sections need a few internals the harness drives directly. Importing them here
  // rather than reaching into module scope keeps the test honest about the public surface.
  window.__TB_SIM = {
    stepVehicle: (await import('../src/sim/vehicle.js')).stepVehicle,
    stepCable: (await import('../src/recovery/cable.js')).stepCable,
    stepGearEffects: (await import('../src/recovery/gear.js')).stepGearEffects,
  };

  const sections = [
    ['A', sectionA], ['B', sectionB], ['C', sectionC], ['D', sectionD],
    ['E', sectionE], ['F', sectionF], ['G', sectionG], ['H', sectionH], ['I', sectionI],
  ];
  for (const [name, fn] of sections) {
    try { await fn(); }
    catch (e) {
      fails++;
      lines.push(`FAIL  section ${name} threw: ${e && e.message}`);
      lines.push(`      ${(e && e.stack || '').split('\n').slice(1, 4).join('\n      ')}`);
    }
    emit(`... through section ${name}`);
  }
  emit();
})();
