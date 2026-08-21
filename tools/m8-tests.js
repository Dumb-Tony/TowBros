/* TOW BROS — Milestone 8 suite: what the machine can actually lift.
 *
 *   .\tools\smoketest.ps1 -Tests tools\m8-tests.js -Quiet
 *
 * GDD §7 Milestone 8, authored after Milestone 7 shipped and drawn from the README's own Known
 * limitations rather than from the roadmap — which had run out. Three places where a machine in
 * this game did less than the machine it is modelled on:
 *
 *   AT the load chart: a boom that lifts, and a capacity worked out from where the load IS
 *   AU the heavy underlift: a seven-tonner carried rather than dragged, and chained rather than strapped
 *   AQ traffic that sees traffic: a queue behind an unclosed scene
 *   AK3 hygiene — seven milestones of numbers that must not have moved
 */

import { CONFIG } from '../src/config.js';
import { EVENTS } from '../src/core/eventBus.js';
import { Game } from '../src/game.js';
import { BANDS, ROAD } from '../src/data/terrain.js';
import { findZone, boxInertia } from '../src/data/vehicles.js';
import { Body } from '../src/sim/body.js';
import { laneY, EAST, WEST } from '../src/world/traffic.js';
import { attachHook } from '../src/recovery/attach.js';
import {
  LIFT, axleMid, extendLift, liftTarget, engageLift, strapLoad, liftCapacityN,
  liftSpec, liftGearNoun, liftGearVerb, towSpeedMaxMps,
} from '../src/recovery/lift.js';
import { Input, CREW_BINDINGS } from '../src/core/input.js';
import { CommandLink } from '../src/net/commands.js';
import { WINCH, cablePath, pathLength, drumsOf } from '../src/recovery/cable.js';
import {
  boomChart, tipLeverM, boomHeadPos, loadGeometry, describeRig, toggleOutriggers, lowerLoad,
} from '../src/recovery/rig.js';

/* ── reporting ───────────────────────────────────────────────────────────── */

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
const G = CONFIG.sim.gravity;

/* ── helpers ─────────────────────────────────────────────────────────────── */

function job(extra = {}) {
  const g = new Game({ seed: 4242, seedLabel: 'm8' });
  g.job = { siteId: 'bend', weatherId: 'dry', mods: {}, traffic: false,
            truckId: 'heavy', casualtyId: 'sedan', ...extra };
  g.startJob({ reroll: false, attempt: 1 });
  return g;
}

/**
 * The pick, staged so that the ONLY variables are what is on the hook and whether the legs are
 * down. Both vehicles on the flat tarmac, in line, nose to tail — no slope, no mud, no bogging,
 * because none of those are what the chart is about.
 */
function stage(casualtyId, legsDown) {
  const g = job({ casualtyId });
  const st = g.state, truck = st.vehicles.truck, cas = st.vehicles.sedan;
  truck.body.x = 60; truck.body.y = BANDS.roadN + 2.2; truck.body.angle = 0;
  truck.body.vx = 0; truck.body.vy = 0; truck.body.omega = 0;
  truck.parkBrake = true;
  const gap = (truck.def.lengthM + cas.def.lengthM) / 2 + 1.4;
  cas.body.x = truck.body.x - gap; cas.body.y = truck.body.y;
  cas.body.angle = 0; cas.body.vx = 0; cas.body.vy = 0; cas.body.omega = 0;
  cas.boggedN0 = 0; cas.boggedFactor = 0; cas.parkBrake = false;
  if (legsDown) { truck.outriggers.down = true; g.skipMs(3200); }

  const zone = findZone(cas.def, 'towHook') || findZone(cas.def, 'frameFront');
  const w = drumsOf(st)[0];
  const p = cas.body.toWorld(zone.local.x, zone.local.y);
  w.hook.x = p.x; w.hook.y = p.y;
  w.state = WINCH.ATTACHED; w.targetId = 'sedan'; w.zoneId = zone.id;
  const len = pathLength(cablePath(w, truck, st.vehicles, st.blocksById));
  w.state = WINCH.LOOSE;
  attachHook(st, cas, zone, g.bus, st.simTimeMs, w);
  w.lineM = len;
  return { g, st, truck, cas, w, t0: st.simTimeMs };
}

/** Reel until it is off the ground or the time runs out. Returns whether it came up. */
function reelUntilUp(s, maxSec = 30) {
  for (let t = 0; t < maxSec * 1000 && !s.cas.suspended; t += 250) {
    s.w.motor = 1;
    s.g.skipMs(250);
  }
  s.w.motor = 0;
  return !!s.cas.suspended;
}

/* ══ AT. the load chart ═══════════════════════════════════════════════════ */

function sectionAT() {
  lines.push('--- AT. a boom that lifts, and a chart worked out from where the load is ---');
  const H = CONFIG.heavy;

  /* The geometry the chart is made of, before anything is hanging off it. */
  {
    const g = job();
    const st = g.state, truck = st.vehicles.truck;
    ok('AT1 the heavy has a hoist on it', !!truck.hoist);
    eq('AT2 with nothing up', truck.hoist.carryingId, null);
    const light = job({ truckId: 'truck' });
    ok('AT3 and a light wrecker has no boom to hoist from', !light.state.vehicles.truck.hoist);

    truck.outriggers.frac = 0;
    const tyresRear = tipLeverM(truck, 0), tyresSide = tipLeverM(truck, Math.PI / 2);
    truck.outriggers.frac = 1;
    const legsRear = tipLeverM(truck, 0), legsSide = tipLeverM(truck, Math.PI / 2);
    near('AT4 on its tyres it tips about its own wheelbase', tyresRear, H.tipLeverTyresRearM, 0.01);
    near('AT5 and about its own track, which is narrower', tyresSide, H.tipLeverTyresSideM, 0.01);
    gt('AT6 legs down, the footprint is longer', legsRear, tyresRear);
    gt('AT7 and wider', legsSide, tyresSide);
    lt('AT8 but a machine is always narrower than it is long, whichever it is standing on',
       legsSide, legsRear);
    /* The ellipse, not the larger of the two: a machine must not be able to pick up sideways what
     * it can only pick up over the tail. */
    const at45 = tipLeverM(truck, Math.PI / 4);
    lt('AT9 halfway round, the lever is less than over the tail', at45, legsRear);
    gt('AT10 and more than over the side', at45, legsSide);
    truck.outriggers.frac = 0.5;
    const half = tipLeverM(truck, 0);
    inRange('AT11 legs halfway down are worth halfway', half, tyresRear + 0.01, legsRear - 0.01);
    note(`AT  levers: tyres ${tyresRear.toFixed(2)}/${tyresSide.toFixed(2)} m, `
      + `legs ${legsRear.toFixed(2)}/${legsSide.toFixed(2)} m (rear/side)`);
  }

  /* Capacity is moment over reach, and reach is a real distance to a real point. */
  {
    const g = job();
    const st = g.state, truck = st.vehicles.truck;
    truck.outriggers.frac = 1;
    const b = truck.body;
    const at = (dBehind) => boomChart(truck, b.x - dBehind, b.y);
    const near5 = at(5), far = at(9);
    gt('AT12 the same machine holds more in close', near5.capacityN, far.capacityN);
    gt('AT13 because the reach is what changed', far.reachM, near5.reachM);
    near('AT14 and reach is the distance PAST the tipping edge',
         far.reachM, 9 - far.leverM, 0.01);
    near('AT15 the moment is the machine standing on its lever',
         far.momentNm, truck.body.massKg * G * far.leverM, 1);
    near('AT16 and the capacity is that moment shared over the reach',
         far.capacityN, far.momentNm / far.reachM, 1);
    const inside = at(1.0);
    eq('AT17 a load inside the footprint cannot overturn anything, so the boom is the limit',
       inside.capacityN, H.boomMaxLoadN);
    lt('AT18 which the chart never promises more than', near5.capacityN, H.boomMaxLoadN + 1);
    truck.outriggers.frac = 0;
    const onTyres = at(9);
    lt('AT19 the same reach on its tyres is worth far less', onTyres.capacityN, far.capacityN * 0.6);
    note(`AT  chart at 9 m behind: ${kN(far.capacityN)} kN on the legs, `
      + `${kN(onTyres.capacityN)} kN on the tyres`);
  }

  /* THE PICK. Three casualties, two machine states, and the answer is different in three of
   * the six — which is the clause. */
  {
    const got = {};
    for (const casualtyId of ['sedan', 'van', 'boxTruck']) {
      for (const legs of [false, true]) {
        const s = stage(casualtyId, legs);
        let refused = null;
        s.g.bus.on(EVENTS.BOOM_OVERLOAD, (e) => { if (e.refused && !refused) refused = e; });
        const up = reelUntilUp(s);
        got[`${casualtyId}:${legs}`] = { up, refused, s };
      }
    }
    ok('AT20 a car comes up on the tyres', got['sedan:false'].up);
    ok('AT21 and on the legs', got['sedan:true'].up);
    ok('AT22 a van comes up on the legs', got['van:true'].up);
    ok('AT23 but on the tyres the chart refuses it at arm\'s length first',
       !!got['van:false'].refused);
    gt('AT24 by a real margin, in newtons, at a stated reach',
       got['van:false'].refused.demandN, got['van:false'].refused.capacityN);
    ok('AT25 — and then it comes up anyway once it has been dragged in close', got['van:false'].up);
    ok('AT26 a seven-tonner is refused on the tyres', !got['boxTruck:false'].up);
    ok('AT27 AND on the legs: you do not hang one off a boom by its nose', !got['boxTruck:true'].up);
    ok('AT28 which it says in newtons rather than by doing nothing', !!got['boxTruck:true'].refused);
    const bx = got['boxTruck:true'].refused;
    note(`AT  refusals: van on tyres ${kN(got['van:false'].refused.demandN)} vs `
      + `${kN(got['van:false'].refused.capacityN)} kN at ${got['van:false'].refused.reachM} m · `
      + `box truck on legs ${kN(bx.demandN)} vs ${kN(bx.capacityN)} kN at ${bx.reachM} m`);
  }

  /* What being off the ground actually means. */
  {
    const s = stage('sedan', true);
    const y0 = s.cas.body.y;
    ok('AT29 the car comes up', reelUntilUp(s));
    eq('AT30 and the machine knows what it is holding', s.truck.hoist.carryingId, 'sedan');
    const r = describeRig(s.truck, s.st);
    near('AT31 which weighs what it weighs', r.demandN, s.cas.def.massKg * G, 1);
    gt('AT32 against a chart that has room for it', r.chart.capacityN, r.demandN);

    /* The whole point: no ground. Park it over the mud and it does not care. */
    const st = s.st;
    st.terrain.gripMul = 0.001;                      // the ground stops mattering entirely
    const before = { x: s.cas.body.x, y: s.cas.body.y };
    s.g.skipMs(2000);
    lt('AT33 a suspended car does not slide down anything', Math.hypot(
      s.cas.body.x - before.x, s.cas.body.y - before.y), 0.6);
    ok('AT34 and is still up', s.cas.suspended);
    /* And it is not working itself free while it hangs, which is what travelledM would do. */
    const travelled = s.cas.travelledM;
    s.g.skipMs(2000);
    near('AT35 nor working itself loose in the air', s.cas.travelledM, travelled, 0.001);
    note(`AT  hanging: moved ${Math.hypot(s.cas.body.x - before.x, s.cas.body.y - before.y).toFixed(2)} m `
      + `in 2 s with the grip turned off, from y ${y0.toFixed(1)}`);
  }

  /* Setting it down again, and losing it. */
  {
    const s = stage('sedan', true);
    reelUntilUp(s);
    let lowered = null;
    s.g.bus.on(EVENTS.LOAD_LOWERED, (e) => { lowered = e; });
    for (let t = 0; t < 6000 && s.cas.suspended; t += 250) { s.w.motor = -1; s.g.skipMs(250); }
    s.w.motor = 0;
    ok('AT36 pay the line out and it goes back down', !s.cas.suspended);
    eq('AT37 which the log calls setting it down', lowered && lowered.reason, 'lowered');
    eq('AT38 and the machine is carrying nothing again', s.truck.hoist.carryingId, null);
  }
  {
    const s = stage('sedan', true);
    reelUntilUp(s);
    let lowered = null;
    s.g.bus.on(EVENTS.LOAD_LOWERED, (e) => { lowered = e; });
    s.w.state = WINCH.STOWED; s.w.targetId = null;   // the line lets go, however it happened
    s.g.step(STEP, s.st.simTimeMs + STEP, null);
    ok('AT39 a line that lets go drops what it was holding', !s.cas.suspended);
    eq('AT40 and that is a different word in the log', lowered && lowered.reason, 'lost');
  }

  /* AND WHAT ACTUALLY TIPS A MACHINE: the chart changing under a load already in the air. */
  {
    const s = stage('van', true);
    ok('AT41 the van is up, on the legs', reelUntilUp(s));
    const chartUp = describeRig(s.truck, s.st).chart.capacityN;
    let tipped = false, tipAt = null;
    s.g.bus.on(EVENTS.ROLLED_OVER, (e) => {
      if (e.vehicle === 'truck' && tipAt === null) { tipped = true; tipAt = s.st.simTimeMs; }
    });
    const tLift = s.st.simTimeMs;
    toggleOutriggers(s.truck, s.g.bus, s.st.simTimeMs);
    for (let t = 0; t < 25000 && !tipped; t += 250) s.g.skipMs(250);
    ok('AT42 raise the legs with it in the air and the machine goes over', tipped);
    inRange(`AT43 not instantly — ${((tipAt - tLift) / 1000).toFixed(1)} s of accumulating first`,
            (tipAt - tLift) / 1000, 3, 20);
    ok('AT44 and the load comes down with it', !s.cas.suspended);
    ok('AT45 the machine is on its side', s.truck.rolled);
    const chartDown = describeRig(s.truck, s.st).chart.capacityN;
    lt('AT46 because the chart collapsed under it', chartDown, chartUp);
    note(`AT  van up at ${kN(chartUp)} kN of chart; legs raised, ${kN(chartDown)} kN, `
      + `over at ${((tipAt - tLift) / 1000).toFixed(1)} s`);
    /* And it must not then pick it straight back up — the tip is an event, not a loop. */
    s.g.skipMs(3000);
    ok('AT47 a machine on its side picks nothing up', !s.cas.suspended);
  }

  /* The warning arrives before the machine does. */
  {
    const s = stage('van', true);
    reelUntilUp(s);
    let warnedAt = null, tipAt = null;
    s.g.bus.on(EVENTS.BOOM_OVERLOAD, (e) => {
      if (!e.refused && warnedAt === null) warnedAt = s.st.simTimeMs;
    });
    s.g.bus.on(EVENTS.ROLLED_OVER, () => { if (tipAt === null) tipAt = s.st.simTimeMs; });
    toggleOutriggers(s.truck, s.g.bus, s.st.simTimeMs);
    for (let t = 0; t < 25000 && tipAt === null; t += 250) s.g.skipMs(250);
    ok('AT48 it says it is past the chart', warnedAt !== null);
    gt('AT49 with time left to do something about it', (tipAt - warnedAt) / 1000, 2);
    note(`AT  warned at ${(warnedAt / 1000).toFixed(1)} s, over at ${(tipAt / 1000).toFixed(1)} s`);
  }

  /* Getting back under the chart saves it, because the overload decays. */
  {
    const s = stage('van', true);
    reelUntilUp(s);
    let tipped = false;
    s.g.bus.on(EVENTS.ROLLED_OVER, () => { tipped = true; });
    toggleOutriggers(s.truck, s.g.bus, s.st.simTimeMs);       // legs going up: bad idea
    s.g.skipMs(4000);
    const peak = s.truck.hoist.overNms;
    gt('AT50 it has been accumulating', peak, 0);
    toggleOutriggers(s.truck, s.g.bus, s.st.simTimeMs);       // and back down again
    s.g.skipMs(6000);
    lt('AT51 put them back down and it bleeds off', s.truck.hoist.overNms, peak);
    ok('AT52 and the machine is still on its wheels', !tipped && !s.truck.rolled);
    ok('AT53 with the van still in the air', s.cas.suspended);
    note(`AT  changed its mind: ${Math.round(peak)} N·m·s built up, `
      + `${Math.round(s.truck.hoist.overNms)} left six seconds after the legs went back down`);
  }
}



/* ══ AU. the heavy underlift, and chains instead of straps ════════════════ */

/** A machine and a casualty, posed with the yoke exactly on an axle, ready to pick up. */
function poseUnderlift({ truckId = 'heavy', casualtyId = 'boxTruck', end = 'front', y = 10 } = {}) {
  const g = job({ truckId, casualtyId, traffic: false });
  const input = new Input(window, CREW_BINDINGS[0]);
  g.link = new CommandLink(CONFIG.crew.maxCount, null).bindLocal(0, input);
  const st = g.state;
  const cas = st.vehicles.sedan, truck = st.vehicles.truck;
  cas.body.x = 60; cas.body.y = y; cas.body.angle = 0;
  cas.body.vx = 0; cas.body.vy = 0; cas.body.omega = 0;
  cas.parkBrake = false; cas.boggedN = 0; cas.boggedN0 = 0; cas.boggedFactor = 0;

  truck.body.angle = 0; truck.body.y = y;
  const L = liftSpec(truck);
  const a = axleMid(cas, end);
  truck.body.x = a.x + truck.def.lengthM / 2 + L.reachM + L.yokeOffsetM;
  truck.body.vx = 0; truck.body.vy = 0; truck.body.omega = 0;
  truck.parkBrake = true;
  g.skipMs(100);
  return { g, input, st, cas, truck, L };
}

/** Extend, engage, and put N pieces of gear across it. */
function chainDown(p, n = 0) {
  const st = p.st;
  extendLift(st, p.g.bus, st.simTimeMs);
  const t = liftTarget(st);
  const engaged = t ? engageLift(st, p.g.bus, st.simTimeMs) : false;
  for (let i = 0; i < n; i++) st.vehicles.truck.lift.straps.push(`fake${i}`);
  return engaged;
}

/**
 * Drive east with the load on, optionally swerving. Milestone 3's own manoeuvre, unchanged, at
 * seven tonnes — a TAP and a counter-tap rather than a held lock, because a held lock just drives
 * off the road (which is what m3's first version of this measured).
 */
function tow(p, { swerve = false, hold = 18, untilX = 150, maxSteps = 3000 } = {}) {
  const st = p.st, truck = p.truck, cas = p.cas, input = p.input;
  truck.parkBrake = false;
  truck.occupiedBy = 'crew0';
  const x0 = truck.body.x;
  let peakN = 0, maxOverNs = 0, maxSpeed = 0, dropWhy = null;
  p.g.bus.on(EVENTS.LIFT_RELEASED, (e) => { if (dropWhy === null) dropWhy = e.reason; });
  for (let i = 0; i < maxSteps; i++) {
    input.virtualDown('moveUp');
    input.virtualUp('moveRight'); input.virtualUp('moveLeft'); input.virtualUp('moveDown');
    if (swerve) {
      const q = i % 240;
      if (q >= 60 && q < 60 + hold) input.virtualDown('moveRight');
      else if (q >= 72 + hold && q < 72 + 2 * hold) input.virtualDown('moveLeft');
    }
    p.g.step(STEP, st.simTimeMs + STEP, null);
    input.endStep();
    maxSpeed = Math.max(maxSpeed, truck.body.speed);
    /* SAMPLE BEFORE THE BREAK. m3's own version of this helper checks the state first and only
     * then records the force, so on the step the load is actually lost — the largest force of the
     * whole run, by definition — nothing is recorded. It reported a bare underlift peaking at
     * 41.5 kN against a 46.0 kN cradle while the release reason said "overload", which is two
     * measurements of the same step disagreeing with each other. */
    peakN = Math.max(peakN, truck.lift.forceN);
    maxOverNs = Math.max(maxOverNs, truck.lift.overNs || 0);
    if (truck.lift.state !== LIFT.CARRYING) break;
    if (truck.body.x > untilX) break;
  }
  input.virtualUp('moveUp'); input.virtualUp('moveRight');
  input.virtualUp('moveLeft'); input.virtualUp('moveDown');
  return {
    peakN, maxOverNs, maxSpeed, dropWhy,
    kept: truck.lift.state === LIFT.CARRYING,
    travelledM: truck.body.x - x0,
    capacityN: truck.lift.capacityN,
    cas,
  };
}

/** Pose, engage, chain down N times, and tow. The engage is not optional: a `tow` on a machine
 *  with an empty cradle exits on step one and reports a peak of zero, which reads exactly like a
 *  constraint that is not working. */
function runTow(n, opts) {
  const p = poseUnderlift();
  chainDown(p, n);
  return tow(p, opts);
}

function sectionAU() {
  lines.push('--- AU. an underlift rated in tonnes, and chains rather than straps ---');

  /* Two machines, two specs, and the light one must not have moved a decimal. */
  {
    const heavy = job({ truckId: 'heavy' }).state.vehicles.truck;
    const light = job({ truckId: 'truck' }).state.vehicles.truck;
    const H = liftSpec(heavy), Y = liftSpec(light);
    ok('AU1 the heavy has an underlift', !!heavy.def.underlift);
    ok('AU2 and the light wrecker has a car yoke', !light.def.underlift);
    eq('AU3 the yoke is exactly the numbers four suites measure',
       Y.yokeHoldN, CONFIG.lift.yokeHoldN);
    eq('AU4 with three straps', Y.maxStraps, CONFIG.lift.maxStraps);
    eq('AU5 the underlift holds what CONFIG says it holds', H.yokeHoldN, CONFIG.lift.heavy.yokeHoldN);
    gt('AU6 which is several times the cradle on a car yoke', H.yokeHoldN, Y.yokeHoldN * 3);
    eq('AU7 and it is chained, not strapped, at two points', H.maxStraps, 2);
    eq('AU8 which is the word the player is given', liftGearNoun(heavy, 2), 'chains');
    eq('AU9 and the light one is not', liftGearNoun(light, 2), 'straps');
    eq('AU10 nor in the gerund', liftGearVerb(heavy), 'chaining');
    gt('AU11 the arm reaches further, because it goes under a longer overhang', H.reachM, Y.reachM);
    /* The stiffness is DERIVED from the hold, not authored twice — a 46 kN cradle at the yoke's
     * 300 kN/m rates at 153 mm of travel, past the 90 mm the axle is allowed to move, so it could
     * never be overloaded at all. */
    gt('AU12 and it is stiffer in the proportion it is stronger', H.springK, Y.springK * 3);
    lt('AU13 so its rating is reached inside the travel the cradle allows',
       H.yokeHoldN / H.springK, H.maxGapM);
    lt('AU14 as is the yoke\'s', Y.yokeHoldN / Y.springK, Y.maxGapM);
    note(`AU  cradles: yoke ${kN(Y.yokeHoldN)} kN at ${Math.round(Y.springK / 1000)} kN/m, `
      + `underlift ${kN(H.yokeHoldN)} kN at ${Math.round(H.springK / 1000)} kN/m — `
      + `both rate at ${((H.yokeHoldN / H.springK) * 1000).toFixed(1)} mm of travel`);
  }

  /* What is actually being picked up. */
  {
    const p = poseUnderlift();
    const axleN = (p.cas.def.massKg * G) / 2;
    ok('AU15 the heavy gets a seven-tonner onto its underlift', chainDown(p, 0));
    inRange(`AU16 whose front axle is ${kN(axleN)} kN on its own`, axleN, 30000, 40000);
    gt('AU17 which is more than three times what a car yoke holds', axleN, CONFIG.lift.yokeHoldN * 3);
    lt('AU18 and inside what the underlift holds', axleN, p.L.yokeHoldN);
    const cap0 = liftCapacityN(p.truck.lift);
    p.st.vehicles.truck.lift.straps.push('c1');
    const cap1 = liftCapacityN(p.truck.lift);
    p.st.vehicles.truck.lift.straps.push('c2');
    const cap2 = liftCapacityN(p.truck.lift);
    near('AU19 bare, the cradle is worth its own rating', cap0, p.L.yokeHoldN, 1);
    near('AU20 a chain adds what a chain is worth', cap1 - cap0, p.L.strapHoldN, 1);
    near('AU21 and the second one adds the same again', cap2 - cap1, p.L.strapHoldN, 1);
    note(`AU  underlift: ${kN(cap0)} / ${kN(cap1)} / ${kN(cap2)} kN bare, one chain, two`);
  }

  /* And the light wrecker is refused nothing — it simply loses it. That contrast is the reason
   * the heavy machine needed its own cradle rather than a bigger number on the old one. */
  {
    const heavyStraight = runTow(2, {});
    ok('AU22 a chained seven-tonner tows home behind the heavy', heavyStraight.kept);
    gt('AU23 the whole way', heavyStraight.travelledM, 60);
    lt('AU24 without troubling the cradle', heavyStraight.maxOverNs, 1);
    note(`AU  straight tow: peak ${kN(heavyStraight.peakN)} kN against `
      + `${kN(heavyStraight.capacityN)} kN, ${heavyStraight.travelledM.toFixed(0)} m`);
  }

  /* THE DECISION, which is Milestone 3's decision at seven tonnes: the same swerve, bare and
   * chained, and one of them arrives. */
  {
    const bare = runTow(0, { swerve: true });
    const one = runTow(1, { swerve: true });
    const two = runTow(2, { swerve: true });
    ok('AU25 a bare underlift loses a seven-tonner to one swerve', !bare.kept);
    ok('AU26 and says which way it went', bare.dropWhy !== null);
    ok('AU27 one chain takes the same swerve and arrives', one.kept);
    gt('AU28 the whole way', one.travelledM, 60);
    ok('AU29 two chains likewise', two.kept && two.travelledM > 60);
    eq('AU30 to the cradle being overloaded, which is the thing a chain raises', bare.dropWhy, 'overload');
    /* The peak QUOTED here is the last step before the release, not the step that caused it:
     * `releaseLift` zeroes `forceN` and `overNs` on its way out, so the largest force of the run
     * and the accumulator that tripped on it are both unreadable from outside by the time the step
     * returns. What is readable is that a bare cradle spends the swerve at the very top of its
     * rating and a chained one does not come near its own. */
    gt('AU31 with a bare cradle worked to the top of its rating', bare.peakN, bare.capacityN * 0.85);
    lt('AU32 while one chain leaves the same swerve well inside it', one.peakN, one.capacityN * 0.85);
    note(`AU  the same swerve at 7.2 t: bare reached ${kN(bare.peakN)} kN against `
      + `${kN(bare.capacityN)} kN of cradle and was lost at ${bare.travelledM.toFixed(0)} m · `
      + `one chain reached ${kN(one.peakN)} against ${kN(one.capacityN)} and came home in `
      + `${one.travelledM.toFixed(0)} m`);
    /* And the machine is not being driven like a maniac to produce it: this is the governed
     * seven-tonne tow speed, which is slower than the light wrecker's. */
    lt('AU33 all of it inside the speed the machine governs itself to',
       bare.maxSpeed, CONFIG.lift.towSpeedMaxMps);
  }

  /* The governor is per machine now, and the tire model reads it from there. */
  {
    const heavy = job({ truckId: 'heavy' }).state.vehicles.truck;
    const light = job({ truckId: 'truck' }).state.vehicles.truck;
    eq('AU34 a loaded heavy is governed slower', towSpeedMaxMps(heavy), CONFIG.lift.heavy.towSpeedMaxMps);
    eq('AU35 than a loaded light wrecker', towSpeedMaxMps(light), CONFIG.lift.towSpeedMaxMps);
    lt('AU36 which is the direction that makes sense', towSpeedMaxMps(heavy), towSpeedMaxMps(light));
  }

  /* And it says "chain" everywhere it used to say "strap" — but only on the machine that has one. */
  {
    const p = poseUnderlift();
    chainDown(p, 1);
    let noun = null;
    p.g.bus.on(EVENTS.LOAD_SECURED, (e) => { noun = e.noun; });
    strapLoad(p.st, { id: 'g1', kind: 'chain' }, p.g.bus, p.st.simTimeMs);
    eq('AU37 securing it on the heavy is chaining it', noun, 'chain');
    const q = poseUnderlift({ truckId: 'truck', casualtyId: 'sedan' });
    chainDown(q, 0);
    let noun2 = null;
    q.g.bus.on(EVENTS.LOAD_SECURED, (e) => { noun2 = e.noun; });
    strapLoad(q.st, { id: 'g2', kind: 'strap' }, q.g.bus, q.st.simTimeMs);
    eq('AU38 and on the light wrecker it is still strapping it', noun2, 'strap');
  }
}

/* ══ AQ. traffic that sees traffic ════════════════════════════════════════ */

const T8 = CONFIG.traffic;
let fabId = 900;

/** A road job on the light wrecker: this section is about the carriageway, not the machine. */
const roadJob = () => job({ truckId: 'truck', casualtyId: 'sedan', traffic: true });

/* A car placed where the test wants it, built the way spawnCar builds one. The road's own spawner
 * is seeded and random in direction, so waiting for two same-direction cars to line themselves up
 * measures the RNG rather than the following rule. */
function putCar(s, dir, x, wantMps, y = null) {
  const id = `traffic_${fabId++}`;
  const body = new Body({
    id, x, y: y === null ? laneY(s.terrain, dir) : y,
    angle: dir === EAST ? 0 : Math.PI,
    halfL: T8.lengthM / 2, halfW: T8.widthM / 2,
    massKg: T8.massKg, inertia: boxInertia(T8.massKg, T8.lengthM, T8.widthM),
  });
  body.vx = dir * wantMps;
  const car = {
    id, body, dir, wantMps, tint: T8.tints[0],
    braking: false, onOtherSide: false, stuckMs: 0,
    creepUntilX: null, creepAwayFromY: 0, honkedAtMs: -9999,
  };
  s.traffic.cars.push(car);
  return car;
}
function clearTheRoad(s) {
  const tb = s.vehicles.truck.body;
  tb.y = BANDS.shoulderS + 0.5; tb.angle = 0; tb.vx = 0; tb.vy = 0; tb.omega = 0;
  s.vehicles.truck.parkBrake = true;
  for (const p of s.crew) { p.y = BANDS.shoulderS + 1.0; p.vx = 0; p.vy = 0; }
}
const noSpawns = (s) => { s.traffic.nextInMs = 1e9; };
const c2c = (a, b) => Math.abs(b.body.x - a.body.x);

function sectionAQ() {
  lines.push('--- AQ. a driver brakes for the car in front ---');

  /* THE GAP, and the fact that it is made of speed. queueGapM standing still, plus
   * queueHeadwaySec of your own travel: the whole rule is visible in this one table. */
  const settled = {};
  for (const v of [0, 12, 22]) {
    const gg = roadJob(); const s = gg.state;
    clearTheRoad(s); noSpawns(s);
    const lead = putCar(s, EAST, v === 0 ? 90 : 60, v);
    /* The approach speed is 26 except onto a STOPPED leader, where it is 12 — and that is a fact
     * about the road rather than a convenience. Sight is 46 m and a firm stop from 26 m/s takes
     * 52; a driver who first sees something stationary at road speed physically cannot stop for
     * it, which is the m5 suite's AE14 ("a truck left across the road gets hit") and the entire
     * reason the cones exist. What this row measures is where a car SETTLES, so it approaches at
     * a speed it could have stopped from. */
    const back = putCar(s, EAST, v === 0 ? 40 : 18, v === 0 ? 12 : 26);
    let touched = 0;
    gg.bus.on(EVENTS.TRAFFIC_HIT, () => { touched++; });
    for (let i = 0; i < 60 * (v === 0 ? 40 : 60); i++) {
      lead.wantMps = v;
      if (v === 0) { lead.creepUntilX = null; lead.stuckMs = 0; }
      back.creepUntilX = null; back.stuckMs = 0;   // measure the GAP, not the creep-round
      if (lead.body.x > 150) { lead.body.x -= 130; back.body.x -= 130; }
      gg.step(STEP, s.simTimeMs + STEP, null);
    }
    settled[v] = { gap: c2c(back, lead), v: Math.abs(back.body.vx), touched };
    near(`AQ1_${v} a driver settles at the speed of the car in front`, settled[v].v, v, 0.6);
    near(`AQ2_${v} at queueGapM + queueHeadwaySec of travel (${settled[v].gap.toFixed(1)} m)`,
         settled[v].gap, T8.queueGapM + T8.queueHeadwaySec * v + T8.lengthM / 2, 1.5);
    eq(`AQ3_${v} without ever touching it`, settled[v].touched, 0);
  }
  gt('AQ4 so the gap grows with speed', settled[22].gap, settled[0].gap + 15);
  note(`AQ  centre to centre: ${settled[0].gap.toFixed(1)} m stopped, `
     + `${settled[12].gap.toFixed(1)} m at 12 m/s, ${settled[22].gap.toFixed(1)} m at road speed`);

  /* AND ONLY THE CAR IN FRONT. Same geometry twice, one sign different: a car facing the other way
   * in your lane is a head-on, and a stopping-distance curve applied to it halts both of them nose
   * to nose forever. */
  const pastAt = (leadDir) => {
    const gg = roadJob(); const s = gg.state;
    clearTheRoad(s); noSpawns(s);
    const lane = laneY(s.terrain, EAST);
    const lead = putCar(s, leadDir, 90, 0, lane);
    const back = putCar(s, EAST, 20, 22);
    let minV = Infinity;
    for (let i = 0; i < 60 * 12; i++) {
      lead.wantMps = 0; lead.creepUntilX = null; lead.stuckMs = 0;
      lead.body.x = 90; lead.body.y = lane; lead.body.angle = leadDir === EAST ? 0 : Math.PI;
      lead.body.vx = 0; lead.body.vy = 0; lead.body.omega = 0;
      back.creepUntilX = null; back.stuckMs = 0;
      gg.step(STEP, s.simTimeMs + STEP, null);
      if (back.body.x > 40 && back.body.x < 80) minV = Math.min(minV, Math.abs(back.body.vx));
    }
    return minV;
  };
  near('AQ5 a car facing the other way is not a car in front', pastAt(WEST), 22, 0.5);
  lt('AQ6 whereas one facing the same way is', pastAt(EAST), 8);

  /* THE TAILBACK, which is what the clause is actually for: a queue behind an unclosed scene,
   * standing in order and a car apart, rather than a scrum held together by the contact solver. */
  {
    const gg = roadJob(); const s = gg.state;
    clearTheRoad(s); noSpawns(s);
    const tb = s.vehicles.truck.body;
    tb.x = 110; tb.y = laneY(s.terrain, EAST); tb.angle = 0;
    tb.vx = 0; tb.vy = 0; tb.omega = 0;
    s.vehicles.truck.parkBrake = true;
    for (const p of s.crew) { p.y = BANDS.shoulderS + 1.0; p.x = 110; p.vx = 0; p.vy = 0; }
    const cars = [putCar(s, EAST, 60, 22), putCar(s, EAST, 30, 22), putCar(s, EAST, 2, 22)];
    let touched = 0;
    gg.bus.on(EVENTS.TRAFFIC_HIT, () => { touched++; });
    for (let i = 0; i < 60 * 20; i++) {
      // Held off the creep-and-overtake path: this measures the QUEUE, not the escape.
      for (const c of cars) { c.creepUntilX = null; c.stuckMs = 0; c.onOtherSide = false; }
      gg.step(STEP, s.simTimeMs + STEP, null);
    }
    const x = cars.map((c) => c.body.x);
    eq('AQ7 three cars at a blocked lane all come to a stand',
       cars.filter((c) => Math.abs(c.body.vx) < 0.6).length, 3);
    ok('AQ8 in the order they arrived', x[0] > x[1] && x[1] > x[2]);
    ok(`AQ9 a car apart, not a heap (${(x[0] - x[1]).toFixed(1)} / ${(x[1] - x[2]).toFixed(1)} m)`,
       x[0] - x[1] > T8.lengthM + 2 && x[1] - x[2] > T8.lengthM + 2);
    gt(`AQ10 which is ${(x[0] - x[2]).toFixed(1)} m of tailback`, x[0] - x[2], 14);
    eq('AQ11 with nobody touching anybody', touched, 0);
    note(`AQ  three cars behind a blocked lane: ${(x[0] - x[2]).toFixed(1)} m of tailback, `
       + `${touched} contacts in 20 s`);
  }

  /* AND IT STILL CLEARS ITSELF. The wrecker square across BOTH lanes, so there is no other side to
   * take and creep is the only way out — the deadlock the following rule could have made permanent,
   * a queue whose members brake for each other forever. */
  {
    const gg = roadJob(); const s = gg.state;
    clearTheRoad(s); noSpawns(s);
    const tb = s.vehicles.truck.body;
    tb.x = 110; tb.y = ROAD.centreY; tb.angle = Math.PI / 2;
    tb.vx = 0; tb.vy = 0; tb.omega = 0;
    s.vehicles.truck.parkBrake = true;
    for (const p of s.crew) { p.y = BANDS.shoulderS + 1.0; p.x = 110; p.vx = 0; p.vy = 0; }
    const cars = [putCar(s, EAST, 60, 22), putCar(s, EAST, 30, 22), putCar(s, EAST, 2, 22)];
    const stopMs = new Map(), creepMs = new Map(), pastMs = new Map();
    let queuedMs = null;
    for (let i = 0; i < 60 * 150; i++) {
      gg.step(STEP, s.simTimeMs + STEP, null);
      if (queuedMs === null && cars.every((c) => Math.abs(c.body.vx) < 0.6)) queuedMs = s.simTimeMs;
      for (const c of cars) {
        if (!stopMs.has(c.id) && Math.abs(c.body.vx) < 0.5) stopMs.set(c.id, s.simTimeMs);
        if (!creepMs.has(c.id) && c.creepUntilX !== null) creepMs.set(c.id, s.simTimeMs);
        if (!pastMs.has(c.id) && c.body.x > 125) pastMs.set(c.id, s.simTimeMs);
      }
    }
    ok('AQ12 both lanes blocked: the whole queue comes to a complete stop', queuedMs !== null);
    eq('AQ13 and every one of them starts edging round', creepMs.size, 3);
    /* Per car, because the front of a queue stops long before the back of it does. The wait is at
     * LEAST creepAfterMs and can be longer: a car further back shuffles forward again as the gaps
     * ahead of it settle, and every shuffle over 0.5 m/s puts its stuck timer back to zero. */
    const waits = cars.map((c) => creepMs.get(c.id) - stopMs.get(c.id));
    ok(`AQ14 none of them early (${waits.map((w) => (w / 1000).toFixed(1)).join(', ')} s)`,
       waits.every((w) => w >= T8.creepAfterMs - 2 * STEP));
    near('AQ15 and the first at exactly creepAfterMs', Math.min(...waits), T8.creepAfterMs, 2 * STEP);
    eq('AQ16 so a blocked road never deadlocks — all three get past', pastMs.size, 3);
    note(`AQ  both lanes blocked: stopped at ${(queuedMs / 1000).toFixed(1)} s, all three past at `
       + `${(Math.max(...pastMs.values()) / 1000).toFixed(1)} s`);
  }
}

/* ══ AK3. seven milestones of numbers that must not have moved ════════════ */

async function sectionAK3() {
  lines.push('--- AK3. seven milestones of numbers that must not have moved ---');

  /* The Milestone 1 recovery, on the light wrecker, which has no boom and must not have noticed
   * any of this. */
  {
    const g = new Game({ seed: 4242, seedLabel: 'm8' });
    g.job = { siteId: 'bend', weatherId: 'dry', mods: {}, traffic: false };
    g.startJob({ reroll: false, attempt: 1 });
    const st = g.state;
    const s = st.vehicles.sedan.body, b = st.vehicles.truck.body;
    b.x = s.x + 11; b.y = BANDS.roadN + 1.4; b.angle = 0; b.vx = 0; b.vy = 0; b.omega = 0;
    st.vehicles.truck.parkBrake = true;
    const zone = findZone(st.vehicles.sedan.def, 'towHook');
    const p = s.toWorld(zone.local.x, zone.local.y);
    st.winch.hook.x = p.x; st.winch.hook.y = p.y;
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
    ok('AK3-1 the far-lane recovery still works', st.goal.complete);
    inRange(`AK3-2 in the time it always took (${(st.goal.completedAtMs / 1000).toFixed(0)} s)`,
            st.goal.completedAtMs / 1000, 25, 50);
    inRange(`AK3-3 at the tension it always took (${kN(peak)} kN)`, peak, 8000, 20000);
    ok('AK3-4 and nothing on a boomless truck ever left the ground', !st.vehicles.sedan.suspended);
  }

  // No new nondeterminism.
  {
    const bad = [];
    for (const f of ['recovery/rig.js', 'world/traffic.js', 'recovery/lift.js']) {
      const src = await (await fetch(`../src/${f}`)).text();
      if (/Math\.random/.test(src)) bad.push(`${f}: Math.random`);
      if (/(Date\.now|performance\.now|new Date)\s*\(/.test(src)) bad.push(`${f}: wall clock`);
    }
    eq('AK3-5 no Math.random or wall clock in the Milestone 8 modules', bad.length, 0, bad.join('; '));
  }

  {
    const a = job({ casualtyId: 'van' });
    const b = job({ casualtyId: 'van' });
    a.skipMs(4000); b.skipMs(4000);
    near('AK3-6 a job with a hoist on it still replays bit-for-bit',
         a.state.vehicles.sedan.body.x, b.state.vehicles.sedan.body.x, 1e-9);
  }

  const TB = window.__TB;
  ok('AK3-7 the live game booted', !!TB);
  eq('AK3-8 and no errors on the crash banner', document.getElementById('err-banner'), null);
}

/* ── run ─────────────────────────────────────────────────────────────────── */

(async function run() {
  const sections = [['AT', sectionAT], ['AU', sectionAU], ['AQ', sectionAQ], ['AK3', sectionAK3]];
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
