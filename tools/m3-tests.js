/* TOW BROS — Milestone 3 suite: a complete job.
 *
 *   .\tools\smoketest.ps1 -Tests tools\m3-tests.js
 *
 * M1 asked whether one ditch produces stories. M2 asked whether two people can share one hook
 * without the game losing track of it. M3 asks a blunter question: is the job over when the car is
 * out of the ditch, or when it is standing in the yard? GDD §7 says the second one — "a flatbed or
 * wheel-lift workflow, physical load securement, short transport route, destination, damage-based
 * payout, and job recap" — so the recovery becomes the FIRST phase of a job rather than the end of
 * one, and there is a whole second machine to get wrong.
 *
 *   S  the world: the graded yard, and the site left exactly as it was
 *   U  the wheel-lift workflow, through geometry and the context key
 *   V  the lift's physics: what it holds, what it transfers, and the two ways to lose a load
 *   W  the job: phases, delivery, and a payout that names its own deductions
 *   X  hygiene — determinism, and the Milestone 1 numbers that must not have moved
 *
 * Everything drives game.step()/skipMs() directly. Headless Chrome in --dump-dom mode delivers
 * one to three rAF callbacks in total (measured; Dev\INDEX.md), so a test that waits for a frame
 * waits forever.
 */

import { CONFIG } from '../src/config.js';
import { EVENTS } from '../src/core/eventBus.js';
import { Input, CREW_BINDINGS } from '../src/core/input.js';
import { Game } from '../src/game.js';
import { CommandLink } from '../src/net/commands.js';
import {
  WORLD, BANDS, ROAD, YARD, yardFrac, baseHeightAt, SURFACES,
} from '../src/data/terrain.js';
import { cornersOnRoad } from '../src/sim/vehicle.js';
import { gripBudgetN } from '../src/sim/tires.js';
import { JOB, cornersInBay, computePayout, stepJob } from '../src/world/scene.js';
import {
  LIFT, createLift, yokePos, axleMid, axleWheelIndices, liftCapacityN, liftTarget,
  extendLift, stowLift, engageLift, releaseLift, strapLoad, describeLift,
} from '../src/recovery/lift.js';
import { validateAuthority } from '../src/crew/authority.js';
import { terrainPpm } from '../src/render/renderer.js';

/* ── reporting (same shape as the other two suites) ──────────────────────── */

const lines = [];
let passes = 0, fails = 0;

function ok(name, cond, detail = '') {
  if (cond) { passes++; lines.push(`PASS  ${name}`); }
  else { fails++; lines.push(`FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
}
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const gt = (n, a, b) => ok(n, a > b, `got ${a}, wanted > ${b}`);
const lt = (n, a, b) => ok(n, a < b, `got ${a}, wanted < ${b}`);
const near = (n, a, b, tol) => ok(n, Math.abs(a - b) <= tol, `got ${a}, want ${b} +/- ${tol}`);
const inRange = (n, a, lo, hi) => ok(n, a >= lo && a <= hi, `got ${a}, wanted ${lo}..${hi}`);
const note = (s) => lines.push(`      ${s}`);

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

/* ── helpers ─────────────────────────────────────────────────────────────── */

/**
 * A fresh game, on a road with nothing else on it.
 *
 * ── WHY THE ROAD IS EMPTY ────────────────────────────────────────────────────────────
 * Milestone 5 put live traffic on that carriageway, and this section measures a hinge to the
 * millimetre. Those two do not belong in the same run: a straight tow down the centre line — which
 * is where this suite poses the truck — met a westbound car head-on at 15 440 N·s and the load came
 * off the yoke after 16.5 m. That is the RIGHT outcome, and it is asserted where it belongs, in
 * section AE of the Milestone 5 suite, along with the fact that the same tow in its own lane
 * delivers the car with the numbers unchanged (3.11 kN peak, 8.8 mm in the cradle, 83.8 m).
 *
 * What must not happen is this suite quietly re-measuring "what a passing car did" and calling it
 * the lift. So: the lift is measured here, traffic is measured there.
 */
function newGame(seed = 4242, attempt = 1) {
  const g = new Game({ seed, seedLabel: 'test' });
  g.attempt = attempt - 1;
  g.job = { traffic: false };
  g.startJob();
  return g;
}

/** A game with one real keyboard behind the command seam, the way the live page runs. */
function drivenGame(seed = 4242) {
  const g = newGame(seed);
  const input = new Input(window, CREW_BINDINGS[0]);
  g.link = new CommandLink(CONFIG.crew.maxCount, null).bindLocal(0, input);
  return { g, input };
}

/**
 * Put the truck's yoke exactly on one of the sedan's axle midpoints.
 *
 * The reach tolerance is 1.15 m, so a test does not have to be exact — but `engageLift` snaps the
 * geometry closed anyway, and a test that measures the constraint should start from the state the
 * player would actually be in rather than from the worst case.
 */
function poseForLift(g, { end = 'front', y = 10, sedanX = 60, sedanAngle = 0 } = {}) {
  const st = g.state;
  const sedan = st.vehicles.sedan, truck = st.vehicles.truck;
  sedan.body.x = sedanX; sedan.body.y = y; sedan.body.angle = sedanAngle;
  sedan.body.vx = 0; sedan.body.vy = 0; sedan.body.omega = 0;
  sedan.parkBrake = false;
  sedan.boggedN = 0; sedan.boggedFactor = 0;

  // Facing east, tail (and yoke) to the west, so driving forward tows the car toward the yard.
  truck.body.angle = 0; truck.body.y = y;
  const a = axleMid(sedan, end);
  const reach = truck.def.lengthM / 2 + CONFIG.lift.reachM + CONFIG.lift.yokeOffsetM;
  truck.body.x = a.x + reach;
  truck.body.vx = 0; truck.body.vy = 0; truck.body.omega = 0;
  truck.parkBrake = true;
  g.skipMs(100);
  return { sedan, truck };
}

/** Extend, engage, and optionally fake N straps on. */
function loadUp(g, straps = 0, end = 'front') {
  const st = g.state;
  extendLift(st, g.bus, st.simTimeMs);
  const t = liftTarget(st);
  const engaged = t ? engageLift(st, g.bus, st.simTimeMs) : false;
  for (let i = 0; i < straps; i++) st.vehicles.truck.lift.straps.push(`fake${i}`);
  return { engaged, target: t };
}

/**
 * Drive east with a load on, optionally swerving, and report what the lift went through.
 *
 * A "swerve" is a TAP and a counter-tap, not a held lock. Ninety steps of full lock at 8 m/s
 * simply drives off the road and into the south fence — which is what the first version of this
 * measured, and it took a while to notice that the "instability" was a wall.
 */
function transport(g, input, { swerve = false, brake = false, untilX = 150, maxSteps = 3000 } = {}) {
  const st = g.state;
  const truck = st.vehicles.truck, sedan = st.vehicles.sedan;
  truck.parkBrake = false;
  truck.occupiedBy = 'crew0';
  const x0 = truck.body.x;
  let peakN = 0, maxOverNs = 0, maxGapM = 0, maxSpeed = 0, dropStep = null, dropWhy = null;
  g.bus.on(EVENTS.LIFT_RELEASED, (e) => { if (dropWhy === null) dropWhy = e.reason; });

  for (let i = 0; i < maxSteps; i++) {
    input.virtualDown('moveUp');
    input.virtualUp('moveRight'); input.virtualUp('moveLeft'); input.virtualUp('moveDown');
    if (swerve) {
      const p = i % 240;
      if (p >= 60 && p < 78) input.virtualDown('moveRight');
      else if (p >= 90 && p < 108) input.virtualDown('moveLeft');
    }
    if (brake && i > 300 && i < 360) { input.virtualUp('moveUp'); input.virtualDown('moveDown'); }
    g.step(STEP, st.simTimeMs + STEP, null);
    input.endStep();
    maxSpeed = Math.max(maxSpeed, truck.body.speed);
    if (truck.lift.state !== LIFT.CARRYING) { dropStep = i; break; }
    peakN = Math.max(peakN, truck.lift.forceN);
    maxOverNs = Math.max(maxOverNs, truck.lift.overNs || 0);
    const y = yokePos(truck), a = axleMid(sedan, truck.lift.end);
    maxGapM = Math.max(maxGapM, Math.hypot(y.x - a.x, y.y - a.y));
    if (truck.body.x > untilX) break;
  }
  input.virtualUp('moveUp'); input.virtualUp('moveRight');
  input.virtualUp('moveLeft'); input.virtualUp('moveDown');
  return {
    peakN, maxOverNs, maxGapM, maxSpeed, dropStep, dropWhy,
    travelledM: truck.body.x - x0,
    capacityN: truck.lift.capacityN,
  };
}

/* ── S. the world: a yard at one end, and the site untouched at the other ── */

function sectionS() {
  lines.push('--- S. the world: a graded yard, and the Milestone 1 site left alone ---');

  gt('S1 the world is long enough to drive somewhere', WORLD.widthM, 150);
  eq('S2 and no taller than it was', WORLD.heightM, 48);
  eq('S3 the road runs the whole length of it', ROAD.x1, WORLD.widthM);
  /* The camera is the only reader of CONFIG.world, and it clamps its centre to it. When CONFIG kept
   * its own copy of the size, widening the world left the camera unable to follow the truck into
   * the yard at all — so this is not a tidiness assertion. */
  eq('S3b CONFIG does not keep a second copy of the world size', CONFIG.world, WORLD);
  eq('S3c so the camera can reach the far end', CONFIG.world.widthM, WORLD.widthM);

  eq('S4 at the recovery site the yard has no influence at all', yardFrac(46), 0);
  eq('S5 nor anywhere west of the blend', yardFrac(YARD.blendX0), 0);
  eq('S6 and full influence across the apron', yardFrac(YARD.x0), 1);
  inRange('S7 with a smooth ramp between', yardFrac((YARD.blendX0 + YARD.blendX1) / 2), 0.3, 0.7);

  /* The profile. The whole point of blending rather than switching is that the ground is
   * continuous everywhere, so a vehicle driven along it behaves the way it looks. */
  const midEmbankment = (BANDS.shoulderS + BANDS.embankmentS) / 2;
  near('S8 the site profile is exactly what Milestone 1 measured',
       baseHeightAt(46, midEmbankment), -0.42 - 4.15 * 0.5, 0.001);
  near('S9 the yard is flat at shoulder level instead', baseHeightAt(140, midEmbankment), -0.42, 0.001);
  near('S10 and stays flat all the way to its south edge', baseHeightAt(140, YARD.y1), -0.42, 0.001);
  eq('S11 the road itself is unchanged out there', baseHeightAt(140, ROAD.centreY) > 0, true);

  // Continuity: no cliffs anywhere along the blend.
  let worstJump = 0, worstAt = 0;
  for (let x = YARD.blendX0 - 4; x < YARD.blendX1 + 4; x += 0.25) {
    for (const y of [18, 22, 26, 30]) {
      const j = Math.abs(baseHeightAt(x + 0.25, y) - baseHeightAt(x, y));
      if (j > worstJump) { worstJump = j; worstAt = x; }
    }
  }
  lt(`S12 nothing along the blend is a cliff (worst 25 cm step is ${(worstJump * 100).toFixed(1)} cm at x=${worstAt.toFixed(0)})`,
     worstJump, 0.14);

  const g = newGame();
  const t = g.state.terrain;
  eq('S13 the apron is paved', t.surfaceAt(140, 25).id, 'pavement');
  eq('S14 the graded ground leading to it is gravel', t.bandSurfaceAt(106, 25).id, 'shoulder');
  eq('S15 and the embankment at the site is still wet grass', t.surfaceAt(46, 22).id, 'wetGrass');
  ok('S16 the bay is inside the apron',
     YARD.bay.x0 > YARD.x0 && YARD.bay.x1 < YARD.x1 && YARD.bay.y1 <= YARD.y1);
  ok('S17 and it is bigger than the car that goes in it',
     (YARD.bay.x1 - YARD.bay.x0) > CONFIG.sedan.lengthM * 2);
  ok('S18 the terrain answers "is this the bay"', t.inBay((YARD.bay.x0 + YARD.bay.x1) / 2, (YARD.bay.y0 + YARD.bay.y1) / 2));
  ok('S19 and says no outside it', !t.inBay(46, 22));
  ok('S20 the bay is NOT on the road, so delivering is not the same as recovering',
     !t.onRoad((YARD.bay.x0 + YARD.bay.x1) / 2, (YARD.bay.y0 + YARD.bay.y1) / 2));

  /* The bake. A wider world at a fixed 20 px/m would have been ~2.7 s of blocked main thread on
   * every reset, so the resolution comes from a pixel budget now. */
  const ppm = terrainPpm(WORLD);
  inRange('S21 the terrain resolution stays sharp enough to read contours', ppm, 13, 20);
  lt('S22 while keeping the bake near where the 92 m site had it',
     WORLD.widthM * ppm * WORLD.heightM * ppm, 2.6e6);
  const smallPpm = terrainPpm({ widthM: 92, heightM: 48 });
  ok('S23 and a small world still gets the maximum', smallPpm >= 20 - 1e-9, String(smallPpm));
  note(`S  ${WORLD.widthM}x${WORLD.heightM} m at ${ppm} px/m = `
     + `${(WORLD.widthM * ppm * WORLD.heightM * ppm / 1e6).toFixed(2)} Mpx`);

  // The site's own furniture stayed at the site.
  ok('S24 every tree is still in the western site', g.state.terrain.trees.every((tr) => tr.x < 92));
  lt('S25 and so is the guardrail', g.state.terrain.rail.x1, 92);
  lt('S26 and the mud', g.state.terrain.mud.x, 92);
  lt('S27 the sedan still comes to rest on the embankment', g.state.vehicles.sedan.body.y, BANDS.embankmentS);
}

/* ── U. the wheel-lift workflow ──────────────────────────────────────────── */

function sectionU() {
  lines.push('--- U. the wheel lift: a workflow made of geometry (GDD §7) ---');

  const g = newGame();
  const st = g.state;
  const truck = st.vehicles.truck, sedan = st.vehicles.sedan;

  eq('U1 the truck arrives with the lift stowed', truck.lift.state, LIFT.STOWED);
  eq('U2 carrying nothing', truck.lift.carryingId, null);
  eq('U3 with nothing strapped to it', truck.lift.straps.length, 0);
  eq('U4 and no reach at all', truck.lift.reachM, 0);
  eq('U5 a stowed lift cannot pick anything up', liftTarget(st), null);

  ok('U6 it swings out', extendLift(st, g.bus, 0));
  eq('U7 which is a state, not a flag', truck.lift.state, LIFT.EXTENDED);
  gt('U8 and gives it reach past the tail', truck.lift.reachM, 0.5);
  ok('U9 extending twice is refused rather than doubling the reach', !extendLift(st, g.bus, 0));
  ok('U10 and it folds back in', stowLift(st, g.bus, 0));
  eq('U11 losing its reach again', truck.lift.reachM, 0);

  // Geometry: the yoke is behind the tail, and the axle midpoints are where the wheels are.
  extendLift(st, g.bus, 0);
  const y = yokePos(truck);
  const tail = truck.body.toWorld(-truck.def.lengthM / 2, 0);
  const nose = truck.body.toWorld(truck.def.lengthM / 2, 0);
  lt('U12 the yoke is behind the tail, not in front of the nose',
     Math.hypot(y.x - tail.x, y.y - tail.y), Math.hypot(y.x - nose.x, y.y - nose.y));
  gt('U13 and it really is outboard of the truck', Math.hypot(y.x - tail.x, y.y - tail.y), 1.0);

  const fa = axleMid(sedan, 'front'), ra = axleMid(sedan, 'rear');
  gt('U14 the front axle is ahead of the rear one',
     (fa.x - sedan.body.x) * Math.cos(sedan.body.angle) + (fa.y - sedan.body.y) * Math.sin(sedan.body.angle),
     (ra.x - sedan.body.x) * Math.cos(sedan.body.angle) + (ra.y - sedan.body.y) * Math.sin(sedan.body.angle));
  eq('U15 each axle has two wheels', axleWheelIndices(sedan, 'front').length, 2);
  eq('U16 and they are different wheels from the other axle',
     axleWheelIndices(sedan, 'front').filter((i) => axleWheelIndices(sedan, 'rear').includes(i)).length, 0);

  // Now actually pick it up.
  const g2 = newGame();
  const { sedan: s2, truck: t2 } = poseForLift(g2);
  extendLift(g2.state, g2.bus, g2.state.simTimeMs);
  const tgt = liftTarget(g2.state);
  ok('U17 with the yoke under an axle, there is something to lift', !!tgt);
  eq('U18 and it is the axle the yoke is under', tgt && tgt.end, 'front');
  lt('U19 within reach', tgt ? tgt.d : 99, CONFIG.lift.engageM);
  ok('U20 it lifts', engageLift(g2.state, g2.bus, g2.state.simTimeMs));
  eq('U21 and the LIFT records what it has, not the car', t2.lift.carryingId, 'sedan');

  /* The snap. `engageM` is a metre of reach tolerance and the constraint is 300 kN/m, so leaving
   * that slack for the spring to resolve was 1.1 MN on the first step and threw the car three
   * metres down the road. A yoke that has picked an axle up has the axle IN it. */
  const gap = Math.hypot(yokePos(t2).x - axleMid(s2, 'front').x, yokePos(t2).y - axleMid(s2, 'front').y);
  lt(`U22 engaging SNAPS the geometry closed (${(gap * 1000).toFixed(1)} mm, not a metre)`, gap, 0.02);
  eq('U23 the lifted axle is off the ground', axleWheelIndices(s2, 'front').every((i) => s2.wheelState[i].airborne), true);
  eq('U24 and the other one is not', axleWheelIndices(s2, 'rear').some((i) => s2.wheelState[i].airborne), false);

  // Alignment: you cannot pick a car up sideways.
  const g3 = newGame();
  poseForLift(g3, { sedanAngle: 1.4 });
  extendLift(g3.state, g3.bus, 0);
  eq('U25 a car lying across the yoke cannot be picked up', liftTarget(g3.state), null);
  ok('U26 so engaging refuses', !engageLift(g3.state, g3.bus, 0));

  // Straps.
  const item = g2.state.gear.find((q) => q.kind === 'strap');
  const cap0 = liftCapacityN(t2.lift);
  ok('U27 a bare cradle holds something on its own', cap0 > 0);
  ok('U28 a strap goes on', strapLoad(g2.state, item, g2.bus, 0));
  gt('U29 and raises what the connection can hold', liftCapacityN(t2.lift), cap0);
  eq('U30 the strap is recorded on the LIFT', t2.lift.straps[0], item.id);
  eq('U31 and is no longer in anybody\'s hands', item.carriedBy, null);
  eq('U32 nor lying loose in the scene', item.attachedTo, 'lift');
  ok('U33 the same strap cannot be used twice', !strapLoad(g2.state, item, g2.bus, 0));
  const chain = g2.state.gear.find((q) => q.kind === 'chain');
  ok('U34 a chain works as well as a strap', strapLoad(g2.state, chain, g2.bus, 0));
  eq('U35 there is a limit to how many go on', t2.lift.straps.length <= CONFIG.lift.maxStraps, true);

  // Setting down.
  ok('U36 it sets down', releaseLift(g2.state, g2.bus, 0, 'player'));
  eq('U37 leaving the lift out and empty', t2.lift.state, LIFT.EXTENDED);
  eq('U38 the wheels are back on the ground', s2.wheelState.some((w) => w.airborne), false);
  eq('U39 the car is carrying its own weight again', s2.groundLoadMul, 1);
  eq('U40 and the truck is not carrying anybody else\'s', t2.extraLoadKg, 0);
  eq('U41 the straps came off with it', t2.lift.straps.length, 0);
  ok('U42 setting down twice is refused', !releaseLift(g2.state, g2.bus, 0, 'player'));
  eq('U43 the authority graph is untouched by any of it', validateAuthority(g2.state).length, 0);

  /* Through the CONTEXT KEY, because a player cannot call engageLift(). */
  const { g: g4, input } = drivenGame();
  const { truck: t4 } = poseForLift(g4);
  const p = g4.state.crew[0];
  const yk = yokePos(t4);
  p.x = yk.x; p.y = yk.y + 0.6; p.vx = 0; p.vy = 0;
  const step = (n = 1) => { for (let i = 0; i < n; i++) { g4.step(STEP, g4.state.simTimeMs + STEP, null); input.endStep(); } };
  const tap = () => { input.virtualTap('context'); step(1); step(2); };
  step(2);
  ok('U44 standing at the tail, the prompt offers the lift',
     !!p.contextHint && /wheel lift/.test(p.contextHint.label), p.contextHint && p.contextHint.label);
  tap();
  eq('U45 one press swings it out', t4.lift.state, LIFT.EXTENDED);
  ok('U46 and now the prompt names the axle it is under',
     !!p.contextHint && /axle/.test(p.contextHint.label), p.contextHint && p.contextHint.label);
  tap();
  eq('U47 the next press lifts the car', t4.lift.state, LIFT.CARRYING);
  ok('U48 the prompt turns into setting it down',
     !!p.contextHint && /set the load down/.test(p.contextHint.label), p.contextHint && p.contextHint.label);
  ok('U49 and warns that nothing is strapping it on',
     !!(p.contextHint && p.contextHint.alt) && /strap/.test(p.contextHint.alt.label));
  tap();
  eq('U50 and one more sets it down', t4.lift.state, LIFT.EXTENDED);
}

/* ── V. the lift's physics ───────────────────────────────────────────────── */

function sectionV() {
  lines.push('--- V. what the lift holds, transfers, and loses (GDD §7) ---');

  const { g, input } = drivenGame();
  const { sedan, truck } = poseForLift(g);
  const gripBefore = { truck: gripBudgetN(truck, g.state.terrain), sedan: gripBudgetN(sedan, g.state.terrain) };
  loadUp(g, 0);

  /* Load transfer. Both halves of one fact: the mass a lifted car takes off its own tyres is the
   * mass the truck's tyres gain. */
  near('V1 the truck picks up its share of the load',
       truck.extraLoadKg, sedan.body.massKg * CONFIG.lift.weightTransfer, 1);
  near('V2 and the car is left with the rest', sedan.groundLoadMul, 1 - CONFIG.lift.weightTransfer, 1e-9);
  const gripAfter = { truck: gripBudgetN(truck, g.state.terrain), sedan: gripBudgetN(sedan, g.state.terrain) };
  gt('V3 so a loaded wrecker has MORE grip, which is most of why the tow works',
     gripAfter.truck, gripBefore.truck);
  lt('V4 and the car has less', gripAfter.sedan, gripBefore.sedan);
  note(`V  truck grip ${kN(gripBefore.truck)} -> ${kN(gripAfter.truck)} kN, `
     + `sedan ${kN(gripBefore.sedan)} -> ${kN(gripAfter.sedan)} kN`);

  // At rest the hinge carries nothing, because a hinge at zero displacement is a hinge.
  for (let i = 0; i < 60; i++) g.step(STEP, g.state.simTimeMs + STEP, null);
  lt('V5 sitting still, the connection is carrying nothing', truck.lift.forceN, 200);

  /* A straight tow. This is the number the whole constraint exists to produce: the force needed to
   * drag 1400 kg along a road, and nothing more. */
  const straight = transport(g, input, { swerve: false });
  inRange(`V6 a straight tow loads the yoke at 2-5 kN (${kN(straight.peakN)} kN)`, straight.peakN, 1500, 5000);
  lt(`V7 with the axle barely moving in the cradle (${(straight.maxGapM * 1000).toFixed(1)} mm)`,
     straight.maxGapM, 0.03);
  eq('V8 and it does not come off', straight.dropStep, null);
  gt('V9 having actually gone somewhere', straight.travelledM, 60);
  inRange(`V10 governed, because a wrecker with a car on the back does not do fifty (${straight.maxSpeed.toFixed(1)} m/s)`,
          straight.maxSpeed, 6, CONFIG.lift.towSpeedMaxMps + 1.5);
  note(`V  straight: ${kN(straight.peakN)} kN peak, ${(straight.maxGapM * 1000).toFixed(1)} mm gap, `
     + `${straight.travelledM.toFixed(0)} m at up to ${straight.maxSpeed.toFixed(1)} m/s`);

  /* SECUREMENT, which is the whole point of the straps. Same drive, same swerves, different number
   * of straps — and one strap is the difference between keeping the car and not. */
  function swerveRun(straps) {
    const { g: gg, input: inp } = drivenGame();
    poseForLift(gg);
    loadUp(gg, straps);
    return transport(gg, inp, { swerve: true });
  }
  const bare = swerveRun(0);
  const one = swerveRun(1);
  const two = swerveRun(2);

  gt('V11 swerving a bare load pushes the cradle past what it can hold',
     bare.peakN, CONFIG.lift.yokeHoldN);
  ok('V12 and the car comes off', bare.dropStep !== null, String(bare.dropStep));
  eq('V13 because it was overloaded, not because the maths gave up', bare.dropWhy, 'overload');
  lt('V14 which happens before it gets anywhere near the yard', bare.travelledM, 60);

  gt('V15 ONE strap raises the capacity', one.capacityN, bare.capacityN);
  eq('V16 and that is the difference between keeping the car and not', one.dropStep, null);
  gt('V17 delivering it the whole way', one.travelledM, 60);
  lt('V18 with the overload barely registering', one.maxOverNs, CONFIG.lift.dropNs * 0.5);

  eq('V19 two straps and the same driving never exceeds capacity at all', two.maxOverNs, 0);
  eq('V20 so of course it stays on', two.dropStep, null);
  note(`V  swerving: bare ${kN(bare.peakN)} kN vs ${kN(bare.capacityN)} kN cap -> ${bare.dropWhy} at `
     + `${bare.travelledM.toFixed(0)} m · 1 strap ${Math.round(one.maxOverNs)} N·s · 2 straps ${Math.round(two.maxOverNs)} N·s`);

  /* Braking hard is not the same as swerving. It should be a near miss on a bare cradle rather
   * than an automatic loss, because stopping is a thing a driver has to be able to do. */
  const { g: gb, input: ib } = drivenGame();
  poseForLift(gb);
  loadUp(gb, 0);
  const braked = transport(gb, ib, { brake: true });
  eq('V21 stamping on the brakes with a bare load does not lose it', braked.dropStep, null);
  gt('V22 though it is felt', braked.peakN, straight.peakN);
  note(`V  hard braking: ${kN(braked.peakN)} kN peak, ${Math.round(braked.maxOverNs)} N·s of excess`);

  /* The second failure mode: travel. No cradle lets an axle move a foot out of it, and this is
   * also the hard bound that keeps a stiff constraint from running away. */
  const { g: gj } = drivenGame();
  const { sedan: sj, truck: tj } = poseForLift(gj);
  loadUp(gj, 0);
  sj.body.x += 0.5;                       // yank the axle straight out of the cradle
  gj.step(STEP, gj.state.simTimeMs + STEP, null);
  eq('V23 an axle dragged clean out of the cradle is not in the cradle', tj.lift.state, LIFT.EXTENDED);
  eq('V24 and the game says which of the two ways it lost it', tj.lift.carryingId, null);
  eq('V25 with the wheels back down', sj.wheelState.some((w) => w.airborne), false);

  // Straps hold the wheels IN, so they raise the travel limit too.
  const { g: gk } = drivenGame();
  const { sedan: sk, truck: tk } = poseForLift(gk);
  loadUp(gk, 3);
  sk.body.x += 0.12;
  gk.step(STEP, gk.state.simTimeMs + STEP, null);
  eq('V26 with three straps on, the same yank does not lose it', tk.lift.state, LIFT.CARRYING);

  // And the describe() surface the HUD and the overlay read.
  const d = describeLift(tk.lift);
  eq('V27 describeLift reports what it is carrying', d.carrying, 'sedan');
  eq('V28 and how many straps are on it', d.straps, 3);
  gt('V29 and its capacity', d.capacityN, CONFIG.lift.yokeHoldN);
}

/* ── W. the job ──────────────────────────────────────────────────────────── */

function sectionW() {
  lines.push('--- W. the job: phases, a destination, and a payout that explains itself ---');

  const g = newGame();
  const st = g.state;
  eq('W1 a job starts in the ditch', st.job.phase, JOB.RECOVER);
  eq('W2 with nothing delivered', st.job.deliveredAtMs, null);
  eq('W3 and no payout yet', st.job.payout, null);
  eq('W4 the Milestone 1 goal is still its own separate fact', st.goal.complete, false);

  /* Phase transitions. The phases describe where the car IS — they are not a checklist. */
  const { g: g2, input } = drivenGame();
  const { sedan, truck } = poseForLift(g2);
  g2.state.goal.complete = true;         // pretend the recovery happened; section V drives the rest
  stepJob(g2.state, g2.bus, g2.state.simTimeMs);
  eq('W5 out of the ditch and on its wheels is a LOAD waiting to be picked up',
     g2.state.job.phase, JOB.LOAD);
  loadUp(g2, 2);
  stepJob(g2.state, g2.bus, g2.state.simTimeMs);
  eq('W6 on the lift, it is in TRANSPORT', g2.state.job.phase, JOB.TRANSPORT);
  releaseLift(g2.state, g2.bus, g2.state.simTimeMs, 'player');
  stepJob(g2.state, g2.bus, g2.state.simTimeMs);
  eq('W7 set down again outside the bay, it is a load again', g2.state.job.phase, JOB.LOAD);

  /* Delivery. Standing in the bay, on its own wheels, settled. */
  const bay = g2.state.terrain.yard.bay;
  sedan.body.x = (bay.x0 + bay.x1) / 2;
  sedan.body.y = (bay.y0 + bay.y1) / 2;
  sedan.body.angle = 0;
  sedan.body.vx = 0; sedan.body.vy = 0; sedan.body.omega = 0;
  sedan.parkBrake = true;
  truck.body.x = 120; truck.body.y = ROAD.centreY; truck.parkBrake = true;
  const inBay = cornersInBay(sedan, g2.state.terrain);
  eq('W8 all four corners are in the bay', inBay.all, true);
  g2.skipMs(CONFIG.job.settleMs + 400);
  eq('W9 which after it settles is DELIVERED', g2.state.job.phase, JOB.DELIVERED);
  ok('W10 at a recorded time', g2.state.job.deliveredAtMs > 0);
  ok('W11 with a payout', !!g2.state.job.payout);
  gt('W12 that paid something', g2.state.job.payout.paid, 0);
  gt('W13 and the job log says so', g2.bus.count(EVENTS.JOB_DELIVERED), 0);
  const before = g2.state.job.phase;
  g2.skipMs(1000);
  eq('W14 delivered is final — it does not flip back', g2.state.job.phase, before);
  eq('W15 delivering it only pays once', g2.bus.count(EVENTS.JOB_DELIVERED), 1);

  /* THE PAYOUT. A payout, not a grade: every deduction names a decision. */
  const g3 = newGame();
  const clean = computePayout(g3.state, g3.bus);
  eq('W16 a spotless job pays the full fee', clean.paid, CONFIG.job.baseFee);
  eq('W17 with nothing deducted', clean.deducted, 0);
  eq('W18 and says so', clean.clean, true);
  eq('W19 with no line items to explain', clean.deductions.length, 0);

  const g4 = newGame();
  g4.state.vehicles.sedan.damage.dents = 3;
  g4.state.vehicles.sedan.damage.parts.bumperFront = 'lost';
  g4.state.vehicles.sedan.damage.parts.axleFront = 'bent';
  g4.state.job.droppedInTransit = 1;
  const messy = computePayout(g4.state, g4.bus);
  lt('W20 a bad day pays less', messy.paid, clean.paid);
  gt('W21 and every deduction is itemised', messy.deductions.length, 3);
  ok('W22 naming the part that came off',
     messy.deductions.some((d) => /bumperFront/.test(d.label)), JSON.stringify(messy.deductions));
  ok('W23 the part that bent', messy.deductions.some((d) => /axleFront/.test(d.label)));
  ok('W24 the dents', messy.deductions.some((d) => /dent/.test(d.label)));
  ok('W25 and the load you dropped', messy.deductions.some((d) => /dropped/.test(d.label)));
  eq('W26 the arithmetic adds up',
     messy.paid, Math.max(CONFIG.job.minimumFee, CONFIG.job.baseFee - messy.deducted));
  note(`W  a bad day: £${clean.paid} -> £${messy.paid} across ${messy.deductions.length} deductions`);

  // The floor. A job that pays nothing teaches nothing.
  const g5 = newGame();
  const s5 = g5.state.vehicles.sedan;
  s5.damage.dents = 40;
  for (const p of ['bumperFront', 'bumperRear', 'axleFront', 'axleRear', 'doorL', 'doorR']) {
    s5.damage.parts[p] = 'lost';
  }
  g5.state.job.droppedInTransit = 6;
  const wrecked = computePayout(g5.state, g5.bus);
  eq('W27 a catastrophe still pays the minimum callout', wrecked.paid, CONFIG.job.minimumFee);
  eq('W28 and admits it hit the floor', wrecked.floored, true);

  /* The recap, which is the north-star answer made mechanical. */
  const r = g2.recap();
  ok('W29 the recap knows the job was delivered', r.summary.delivered);
  eq('W30 and carries the payout with it', r.summary.payout.paid, g2.state.job.payout.paid);
  ok('W31 it counted the straps that went on', r.summary.strapsUsed >= 0);
  ok('W32 and reads the lift back as part of the story',
     r.lines.some(([, text]) => /axle|load/.test(text)), JSON.stringify(r.lines.slice(-4)));
}

/* ── X. hygiene ──────────────────────────────────────────────────────────── */

async function sectionX() {
  lines.push('--- X. hygiene: the numbers that must not have moved ---');

  /* THE MILESTONE 1 RECOVERY, unchanged. A wider world, a graded yard, a new constraint and a
   * different tire-load accounting are all things that could have quietly retuned the recovery,
   * which is the reason to measure it here rather than trust it. */
  const g = newGame(4242, 1);
  const st = g.state;
  st.vehicles.truck.body.x = st.vehicles.sedan.body.x + 11;
  st.vehicles.truck.body.y = BANDS.roadN + 1.4;
  st.vehicles.truck.body.angle = 0;
  st.vehicles.truck.body.vx = 0; st.vehicles.truck.body.vy = 0; st.vehicles.truck.body.omega = 0;
  st.vehicles.truck.parkBrake = true;

  const { findZone } = await import('../src/data/vehicles.js');
  const { attachHook } = await import('../src/recovery/attach.js');
  const { WINCH, cablePath, pathLength } = await import('../src/recovery/cable.js');
  const zone = findZone(st.vehicles.sedan.def, 'towHook');
  const at = st.vehicles.sedan.body.toWorld(zone.local.x, zone.local.y);
  st.winch.hook.x = at.x; st.winch.hook.y = at.y;
  st.winch.state = WINCH.ATTACHED; st.winch.targetId = 'sedan'; st.winch.zoneId = 'towHook';
  const len = pathLength(cablePath(st.winch, st.vehicles.truck, st.vehicles, st.blocksById));
  st.winch.state = WINCH.LOOSE;
  attachHook(st, st.vehicles.sedan, zone, g.bus, st.simTimeMs);
  st.winch.lineM = len;

  let peak = 0;
  for (let t = 0; t < 60000 && !st.goal.complete; t += 250) {
    st.winch.motor = 1;
    g.skipMs(250);
    peak = Math.max(peak, st.winch.tensionN);
  }
  ok('X1 the far-lane recovery still works', st.goal.complete,
     `${cornersOnRoad(st.vehicles.sedan, st.terrain).on}/4 corners`);
  inRange(`X2 in about the time it always took (${(st.goal.completedAtMs / 1000).toFixed(0)} s)`,
          st.goal.completedAtMs / 1000, 25, 50);
  inRange(`X3 at about the tension it always took (${kN(peak)} kN)`, peak, 8000, 20000);
  eq('X4 without parting the cable', g.bus.count(EVENTS.CABLE_SNAPPED), 0);
  eq('X5 and the recovery is still its own phase of the job', st.job.phase, JOB.LOAD);
  note(`X  M1 far-lane recovery: ${(st.goal.completedAtMs / 1000).toFixed(1)} s at ${kN(peak)} kN`);

  /* Determinism, with the new machinery in the loop. */
  function sig(seed) {
    const gg = newGame(seed, 3);
    poseForLift(gg);
    loadUp(gg, 1);
    for (let i = 0; i < 400; i++) {
      gg.state.vehicles.truck.throttle = 1;
      gg.step(STEP, gg.state.simTimeMs + STEP, null);
    }
    const b = gg.state.vehicles.sedan.body, t = gg.state.vehicles.truck.body;
    return [b.x, b.y, b.angle, t.x, t.y, t.angle, gg.state.vehicles.truck.lift.forceN]
      .map((n) => n.toFixed(9)).join(',');
  }
  eq('X6 a loaded tow replays bit-for-bit from the same seed', sig(31337), sig(31337));
  /* Not "a different seed gives a different tow" — poseForLift puts both vehicles at fixed
   * coordinates, so the seed cannot reach them and that comparison is vacuous. The seed reaches
   * the SITE, which is what m1's Hg2 measures and what this confirms still holds with a yard
   * bolted onto the east end of the world. */
  const layout = (seed) => {
    const gg = newGame(seed, 1);
    const t = gg.state.terrain;
    return [t.mud.x, t.mud.y, t.rail.gapX0, gg.state.vehicles.sedan.body.angle]
      .map((n) => n.toFixed(6)).join(',');
  };
  eq('X7 the same seed still lays out the same site', layout(31337), layout(31337));
  ok('X8 and a different seed still moves it', layout(31337) !== layout(999));

  // No new sources of nondeterminism.
  const bad = [];
  for (const f of ['src/recovery/lift.js', 'src/world/scene.js', 'src/data/terrain.js']) {
    const src = await (await fetch(`../${f}`)).text();
    if (/Math\.random/.test(src)) bad.push(`${f}: Math.random`);
    if (/Date\.now|performance\.now/.test(src)) bad.push(`${f}: wall clock`);
  }
  eq('X9 no Math.random or wall clock in the Milestone 3 modules', bad.length, 0, bad.join('; '));

  /* Two bodies joined by the lift must not also collide. Not an optimisation — a contact
   * correction is a teleport, and a stiff constraint reads it as instantaneous deformation. */
  const { g: gc } = drivenGame();
  const { sedan: sc, truck: tc } = poseForLift(gc);
  loadUp(gc, 2);
  const impacts0 = gc.bus.count(EVENTS.IMPACT);
  /* Swing it ABOUT THE YOKE, which is what articulating means. Rotating the body about its own
   * centre instead moves the axle two thirds of a metre out of the cradle, and the lift correctly
   * drops it — a right answer to the wrong question. */
  const pivot = axleMid(sc, tc.lift.end);
  const swing = 0.5;
  const cs = Math.cos(swing), sn = Math.sin(swing);
  const rx = sc.body.x - pivot.x, ry = sc.body.y - pivot.y;
  sc.body.x = pivot.x + rx * cs - ry * sn;
  sc.body.y = pivot.y + rx * sn + ry * cs;
  sc.body.angle += swing;
  for (let i = 0; i < 120; i++) gc.step(STEP, gc.state.simTimeMs + STEP, null);
  eq('X10 an articulated load does not generate contacts against the truck carrying it',
     gc.bus.count(EVENTS.IMPACT), impacts0);

  eq('X10b and is still on the lift', tc.lift.state, LIFT.CARRYING);
  /* The world edge is a fence, not a trampoline. */
  const { g: gw, input: iw } = drivenGame();
  const { truck: tw } = poseForLift(gw, { y: 44 });
  loadUp(gw, 3);
  tw.parkBrake = false; tw.occupiedBy = 'crew0';
  let maxGap = 0;
  for (let i = 0; i < 600; i++) {
    iw.virtualDown('moveUp'); iw.virtualDown('moveRight');
    gw.step(STEP, gw.state.simTimeMs + STEP, null); iw.endStep();
    if (tw.lift.state !== LIFT.CARRYING) break;
    const y = yokePos(tw), a = axleMid(gw.state.vehicles.sedan, tw.lift.end);
    maxGap = Math.max(maxGap, Math.hypot(y.x - a.x, y.y - a.y));
  }
  iw.virtualUp('moveUp'); iw.virtualUp('moveRight');
  lt(`X11 driving a loaded truck into the world edge stays bounded (${(maxGap * 1000).toFixed(0)} mm)`,
     maxGap, 0.5);
  lt('X12 with the truck stopped at the fence rather than through it',
     gw.state.vehicles.truck.body.y, WORLD.heightM);

  // The live page.
  const TB = window.__TB;
  ok('X13 the live game booted', !!TB);
  eq('X14 with a lift on the truck', TB.game.state.vehicles.truck.lift.state, LIFT.STOWED);
  eq('X15 a job in its first phase', TB.game.state.job.phase, JOB.RECOVER);
  eq('X16 and no errors on the crash banner', document.getElementById('err-banner'), null);
  eq('X17 CONFIG is still frozen against runtime retuning', Object.isFrozen(CONFIG), true);
  eq('X18 including the lift block', Object.isFrozen(CONFIG.lift), true);
  eq('X19 and the payout numbers', Object.isFrozen(CONFIG.job), true);
}

/* ── run ─────────────────────────────────────────────────────────────────── */

(async function run() {
  const sections = [['S', sectionS], ['U', sectionU], ['V', sectionV], ['W', sectionW], ['X', sectionX]];
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
