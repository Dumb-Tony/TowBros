/* TOW BROS — Milestone 9 suite: righting it, and the one behind.
 *
 *   .\tools\smoketest.ps1 -Tests tools\m9-tests.js -Quiet
 *
 * GDD §7 Milestone 9. Two things this game has been describing rather than simulating: a rollover
 * has been a one-way door since Milestone 1, and every job to date has had exactly one thing in
 * the ditch.
 *
 *   AW two of them: a shunt, and an order nothing declares
 *   AX righting it with the boom, and where you may NOT hook a car on its roof
 *   AZ righting it with a side pull, and rolling it straight over again
 *   AY the board: how often a shunt turns up, and what a pair is worth
 *   AK4 hygiene — eight milestones of numbers that must not have moved
 */

import { CONFIG } from '../src/config.js';
import { EVENTS } from '../src/core/eventBus.js';
import { Game } from '../src/game.js';
import { BANDS, YARD } from '../src/data/terrain.js';
import { findZone, casualtyDefById } from '../src/data/vehicles.js';
import { attachHook } from '../src/recovery/attach.js';
import { WINCH, cablePath, pathLength, drumsOf } from '../src/recovery/cable.js';
import { casualties, cornersOnRoad, CASUALTY_SLOTS } from '../src/sim/vehicle.js';
import { stepRighting, rollImpulseNs, describeRighting, setRolled } from '../src/sim/righting.js';
import { computePayout, recapFrom, JOB } from '../src/world/scene.js';
import { describePolice, closureStandard } from '../src/world/police.js';
import { describeCustomer } from '../src/world/customer.js';
import { rollSituation, situationToOffer, SECOND_CASUALTY_SHARE } from '../src/meta/situations.js';
import { newCompany } from '../src/meta/company.js';
import { offersFor, acceptOffer, endDay } from '../src/meta/dispatch.js';

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

/* ── helpers ─────────────────────────────────────────────────────────────── */

function job(extra = {}) {
  const g = new Game({ seed: 4242, seedLabel: 'm9' });
  g.job = { siteId: 'bend', weatherId: 'dry', mods: { seizedChance: 0 }, traffic: false, ...extra };
  g.startJob({ reroll: false, attempt: 1 });
  return g;
}

/**
 * Rig one casualty to its tow eye from the road above it, and pull.
 *
 * Deliberately the SAME pull in every case — same zone, same park, same throttle — so the only
 * variable is what else is on the bank. Anything else and this measures the rig rather than the
 * shunt.
 */
function pull({ shunt = false, slot = 'sedan', secondId = 'sedan', seconds = 50, zoneId = 'towHook' } = {}) {
  const g = job(shunt ? { secondCasualtyId: secondId } : {});
  const st = g.state;
  const veh = st.vehicles[slot];
  const truck = st.vehicles.truck;
  truck.body.x = veh.body.x + 2; truck.body.y = BANDS.roadN + 1.4; truck.body.angle = 0;
  truck.body.vx = 0; truck.body.vy = 0; truck.body.omega = 0;
  truck.parkBrake = true;
  const zone = findZone(veh.def, zoneId);
  const p = veh.body.toWorld(zone.local.x, zone.local.y);
  const w = drumsOf(st)[0];
  w.hook.x = p.x; w.hook.y = p.y;
  w.state = WINCH.ATTACHED; w.targetId = veh.id; w.zoneId = zone.id;
  const len = pathLength(cablePath(w, truck, st.vehicles, st.blocksById));
  w.state = WINCH.LOOSE;
  attachHook(st, veh, zone, g.bus, st.simTimeMs, w);
  w.lineM = len;

  let peak = 0, stalls = 0, worstHit = 0;
  /* The roll accumulator PEAKS during the pull and decays the moment it stops, so it has to be
   * sampled as it goes: read afterwards it is always zero, which reads as "nothing happened"
   * when what happened is that it got a quarter of the way there and bled off again. */
  let peakRollNs = 0, peakTruckRollNs = 0;
  g.bus.on(EVENTS.WINCH_STALLED, () => { stalls++; });
  g.bus.on(EVENTS.IMPACT, (e) => { worstHit = Math.max(worstHit, e.impulseNs || 0); });
  const y0 = veh.body.y;
  for (let t = 0; t < seconds * 1000; t += 250) {
    w.motor = 1;
    g.skipMs(250);
    peak = Math.max(peak, w.tensionN);
    peakRollNs = Math.max(peakRollNs, Math.abs(rollImpulseNs(veh).ns));
    peakTruckRollNs = Math.max(peakTruckRollNs, Math.abs(rollImpulseNs(truck).ns));
    if (cornersOnRoad(veh, st.terrain).all) break;
  }
  w.motor = 0;
  let newDents = 0;
  for (const v of casualties(st)) {
    newDents += Math.max(0, v.damage.dents - ((v.damage.arrived || {}).dents || 0));
  }
  return {
    g, st, veh, w, peak, stalls, worstHit, newDents, peakRollNs, peakTruckRollNs,
    movedM: y0 - veh.body.y,
    up: cornersOnRoad(veh, st.terrain).all,
    t: st.simTimeMs / 1000,
  };
}

/* ══ AW. two of them ══════════════════════════════════════════════════════ */

function sectionAW() {
  lines.push('--- AW. two in the ditch, and an order nothing declares ---');

  /* The scene builds, and the second one is placed in terms of the first. */
  {
    const one = job();
    const two = job({ secondCasualtyId: 'sedan' });
    eq('AW1 an ordinary job still has one thing in the ditch', casualties(one.state).length, 1);
    eq('AW2 and a shunt has two', casualties(two.state).length, 2);
    eq('AW3 the goal knows how many it is waiting for', two.state.goal.casualties, 2);
    eq('AW4 and so does a single-vehicle job', one.state.goal.casualties, 1);
    eq('AW5 the slot list is the one record of what a casualty slot is',
       CASUALTY_SLOTS.length, 2);
    ok('AW6 a job with one casualty has no second key at all', !one.state.vehicles.second);
    eq('AW7 the first slot is unchanged, which is what five milestones depend on',
       two.state.vehicles.sedan.id, 'sedan');
    eq('AW8 and the scene says what is in the second one', two.state.secondCasualtyId, 'sedan');

    const a = two.state.vehicles.sedan.body, b = two.state.vehicles.second.body;
    lt('AW9 the second one is UP the bank from the first, between it and the road', b.y, a.y);
    gt('AW10 by more than the length of a car, so they are not interpenetrating',
       a.y - b.y, two.state.vehicles.sedan.def.lengthM);
    near('AW11 in line with it, because it ran into it', b.angle, a.angle, 0.01);
    note(`AW  the one behind sits ${(a.y - b.y).toFixed(2)} m up the bank`);

    /* AND NEITHER STARTS ON THE ROAD. Caught first time out: at a 71-degree lie the second car
     * reached to y=14.7 against a road edge at 14.6 and began the job one corner recovered. */
    eq('AW12 the first one is entirely off the road', cornersOnRoad(two.state.vehicles.sedan, two.state.terrain).on, 0);
    eq('AW13 and so is the one behind it', cornersOnRoad(two.state.vehicles.second, two.state.terrain).on, 0);
    ok('AW14 so the job is not already half done', !two.state.goal.complete);
    // It arrived having hit something, and is charged for none of it.
    gt('AW15 the one that ran into the other arrived with a mark on it',
       two.state.vehicles.second.damage.dents, 0);
    eq('AW16 which is baselined, so the operator is not billed for the crash',
       two.state.vehicles.second.damage.arrived.dents, two.state.vehicles.second.damage.dents);
    lt('AW17 and it is less dug in, because it arrived later and at less of an angle',
       two.state.vehicles.second.boggedN0, two.state.vehicles.sedan.boggedN0);
  }

  /* THE ORDER, and what ignoring it costs. */
  {
    const solo = pull({ shunt: false });
    const shunt = pull({ shunt: true, secondId: 'sedan' });
    ok('AW18 the deep one comes up on its own', solo.up);
    ok('AW19 and it comes up with a car in front of it too — nothing is REFUSED', shunt.up);
    gt('AW20 but it costs nearly twice the line to do it', shunt.peak, solo.peak * 1.7);
    eq('AW21 without denting anything: shoving a car up a bank slowly does not damage it',
       shunt.newDents, 0);
    eq('AW22 nor is it a collision worth reporting', Math.round(shunt.worstHit), 0);
    note(`AW  the same pull on the same tow eye: ${kN(solo.peak)} kN alone, `
      + `${kN(shunt.peak)} kN with a car in the way`);

    /* And the cost stops being tension and starts being impossible. */
    /* AND WHAT IT COSTS IS THE LINE, NOT THE CLOCK. Measured: all three of these finish in about
     * 35 s, because a drum that is turning pulls at the rate a drum turns and the geometry decides
     * the rest. What changes is the tension, and it climbs straight at the motor's own limit —
     * which is the sentence a player can read off the gauge while it is happening. */
    const van = pull({ shunt: true, secondId: 'van', seconds: 90 });
    gt('AW23 with a van in front it costs more still', van.peak, shunt.peak);
    gt('AW24 taking the drum to within a whisker of the load it stalls at',
       van.peak, CONFIG.winch.motorMaxN * 0.9);
    lt('AW25 which is the whole margin the light wrecker has left',
       CONFIG.winch.motorMaxN - van.peak, 2000);
    near('AW25b and it did not take a second longer to find that out', van.t, solo.t, 8);
    note(`AW  the line, not the clock: ${kN(solo.peak)} kN alone, ${kN(shunt.peak)} with a car and `
      + `${kN(van.peak)} with a van, against a ${kN(CONFIG.winch.motorMaxN)} kN motor — `
      + `and every one of them inside ${Math.max(solo.t, shunt.t, van.t).toFixed(0)} s`);
  }

  /* Doing it in the sensible order, and the job actually finishing. */
  {
    const first = pull({ shunt: true, slot: 'second', seconds: 60 });
    ok('AW26 the one nearer the road comes up first, cheaply', first.up);
    lt('AW27 on a fraction of the tension the other way round costs', first.peak, 14000);
    ok('AW28 and the job is NOT finished, because there are two of them', !first.st.goal.complete);
    note(`AW  the one in front, on its own: ${kN(first.peak)} kN in ${first.t.toFixed(0)} s`);

    // Now the deep one, in the same world, with the way clear.
    const st = first.st, g = first.g, w = first.w;
    const deep = st.vehicles.sedan, truck = st.vehicles.truck;
    w.state = WINCH.STOWED; w.targetId = null; w.zoneId = null;
    truck.body.x = deep.body.x + 2; truck.body.y = BANDS.roadN + 1.4; truck.body.angle = 0;
    truck.body.vx = 0; truck.body.vy = 0; truck.body.omega = 0;
    const zone = findZone(deep.def, 'towHook');
    const p = deep.body.toWorld(zone.local.x, zone.local.y);
    w.hook.x = p.x; w.hook.y = p.y;
    w.state = WINCH.ATTACHED; w.targetId = 'sedan'; w.zoneId = zone.id;
    const len = pathLength(cablePath(w, truck, st.vehicles, st.blocksById));
    w.state = WINCH.LOOSE;
    attachHook(st, deep, zone, g.bus, st.simTimeMs, w);
    w.lineM = len;
    for (let t = 0; t < 90000 && !st.goal.complete; t += 250) { w.motor = 1; g.skipMs(250); }
    ok('AW29 with the way clear, the second one comes up too', st.goal.complete);
    eq('AW30 and BOTH of them are on the road', casualties(st)
      .filter((v) => cornersOnRoad(v, st.terrain).all).length, 2);
    note(`AW  both up at ${(st.simTimeMs / 1000).toFixed(0)} s`);

    /* Everything else at the scene has to have noticed there are two. */
    const rec = recapFrom(g.bus, st);
    eq('AW31 the recap counts them', rec.summary.casualties, 2);
    const pay = computePayout(st, g.bus);
    ok('AW32 the payout is computed over both', !!pay);
    ok('AW33 and names which car a deduction belongs to when there is more than one',
       pay.deductions.every((d) => typeof d.label === 'string'));
    ok('AW34 the owner on the verge can see both of them', !!describeCustomer(st.customer));

    /* AND THE JOB IS NOT DELIVERED WITH HALF OF IT STILL ON THE BANK. The phase machine read
     * `st.vehicles.sedan` throughout: putting ONE of the two in the bay ended the job and paid the
     * whole fee out with the other car still lying there. Nothing errored — the results card just
     * came up early. It survived the whole of the milestone that added the second casualty,
     * because the goal, the payout, the recap and the closure standard were all swept and this was
     * not. */
    const put = (veh) => {
      veh.body.x = (YARD.bay.x0 + YARD.bay.x1) / 2;
      veh.body.y = (YARD.bay.y0 + YARD.bay.y1) / 2;
      veh.body.angle = 0;
      veh.body.vx = 0; veh.body.vy = 0; veh.body.omega = 0;
    };
    // The first one parked square in the bay; the other one left where it is.
    for (let i = 0; i < 200; i++) { put(st.vehicles.sedan); g.step(STEP, st.simTimeMs + STEP, null); }
    gt('AW35a which really is in the bay', st.job.bayCorners, 3);
    ok('AW35b but one of two in the bay is not a delivered job', st.job.phase !== JOB.DELIVERED);
    eq('AW35c and nothing has been paid', st.job.payout, null);
    // Now the other one as well.
    for (let i = 0; i < 200; i++) {
      put(st.vehicles.sedan);
      st.vehicles.second.body.x = (YARD.bay.x0 + YARD.bay.x1) / 2 + 0.05;
      st.vehicles.second.body.y = (YARD.bay.y0 + YARD.bay.y1) / 2;
      st.vehicles.second.body.angle = 0;
      st.vehicles.second.body.vx = 0; st.vehicles.second.body.vy = 0; st.vehicles.second.body.omega = 0;
      g.step(STEP, st.simTimeMs + STEP, null);
    }
    eq('AW35d with both of them in it, the job is delivered', st.job.phase, JOB.DELIVERED);
    ok('AW35e and the fee is worked out over both', !!st.job.payout);
    note(`AW  delivered only with both in the bay: £${st.job.payout ? st.job.payout.paid : 0}`);
  }

  /* The closure standard counts both, without having been told about the second one. */
  {
    const g = job({ secondCasualtyId: 'sedan' });
    const st = g.state;
    // Put both across the carriageway.
    const a = st.vehicles.sedan.body, b = st.vehicles.second.body;
    const midY = (BANDS.roadN + BANDS.roadS) / 2;
    a.x = 60; a.y = midY; a.angle = Math.PI / 2; a.vx = 0; a.vy = 0; a.omega = 0;
    b.x = 78; b.y = midY; b.angle = Math.PI / 2; b.vx = 0; b.vy = 0; b.omega = 0;
    st.vehicles.truck.body.x = 130; st.vehicles.truck.body.y = BANDS.shoulderS + 0.6;
    g.step(STEP, st.simTimeMs + STEP, null);
    const std = closureStandard(st);
    ok('AW35 two cars on the carriageway obstruct it', std.obstructed);
    gt('AW36 and the obstruction spans BOTH of them, not just the first',
       std.obstruction.x1 - std.obstruction.x0, 15);
    note(`AW  the closure standard reads ${(std.obstruction.x1 - std.obstruction.x0).toFixed(1)} m `
      + 'of blocked carriageway across the pair');
  }
}

/* ══ AX. righting it ══════════════════════════════════════════════════════ */

/**
 * A rolled casualty on the flat, right behind the rotator, ready to be picked up.
 *
 * Deliberately staged rather than recovered into position: what this section measures is the
 * righting, and a twenty-second winch up a bank first would only add variance to it.
 */
function stageRolled(casualtyId = 'sedanRoof', legsDown = true, zoneId = 'frameFront') {
  const g = job({ truckId: 'heavy', casualtyId });
  const st = g.state, truck = st.vehicles.truck, cas = st.vehicles.sedan;
  truck.body.x = 60; truck.body.y = BANDS.roadN + 2.2; truck.body.angle = 0;
  truck.body.vx = 0; truck.body.vy = 0; truck.body.omega = 0;
  truck.parkBrake = true;
  cas.body.x = truck.body.x - ((truck.def.lengthM + cas.def.lengthM) / 2 + 1.4);
  cas.body.y = truck.body.y;
  cas.body.angle = 0; cas.body.vx = 0; cas.body.vy = 0; cas.body.omega = 0;
  cas.boggedN0 = 0; cas.boggedFactor = 0; cas.parkBrake = false;
  if (legsDown) { truck.outriggers.down = true; g.skipMs(3200); }

  /* RIGGED TO THE FRAME RAIL, and that is a measurement rather than a preference. The roofed
   * sedan's tow eye is rated 7 kN — "bent in whatever put the car on its roof" — and a 1.4 t car
   * weighs 13.7, so hooking the obvious point picks the car up and drops it again in the same
   * step. AX19 below asserts exactly that. The frame rail is 44 kN and, on a car lying on its
   * roof, is facing straight up at you. */
  const zone = findZone(cas.def, zoneId) || findZone(cas.def, 'towHook');
  const w = drumsOf(st)[0];
  const p = cas.body.toWorld(zone.local.x, zone.local.y);
  w.hook.x = p.x; w.hook.y = p.y;
  w.state = WINCH.ATTACHED; w.targetId = 'sedan'; w.zoneId = zone.id;
  const len = pathLength(cablePath(w, truck, st.vehicles, st.blocksById));
  w.state = WINCH.LOOSE;
  attachHook(st, cas, zone, g.bus, st.simTimeMs, w);
  w.lineM = len;
  return { g, st, truck, cas, w, zone };
}

function sectionAX() {
  lines.push('--- AX. a rollover stops being a one-way door ---');

  {
    const s = stageRolled();
    ok('AX1 a car that arrived on its roof is on its roof', s.cas.rolled);
    lt('AX2 with less grip for it', s.cas.gripMul, 1);
    let righted = null, lowered = null;
    s.g.bus.on(EVENTS.RIGHTED, (e) => { righted = e; });
    s.g.bus.on(EVENTS.LOAD_LOWERED, (e) => { lowered = e; });

    for (let t = 0; t < 30000 && !s.cas.suspended; t += 250) { s.w.motor = 1; s.g.skipMs(250); }
    s.w.motor = 0;
    ok('AX3 the rotator picks it up', s.cas.suspended);
    ok('AX4 and it is still on its roof in the air', s.cas.rolled);

    for (let t = 0; t < 8000 && s.cas.suspended; t += 250) { s.w.motor = -1; s.g.skipMs(250); }
    s.w.motor = 0;
    ok('AX5 set it down again and it is back on the ground', !s.cas.suspended);
    ok('AX6 the right way up', !s.cas.rolled);
    eq('AX7 which the log says happened, and how', righted && righted.how, 'boom');
    eq('AX8 and the set-down knows it did it', lowered && lowered.righted, true);
    eq('AX9 with its grip back', s.cas.gripMul, 1);
    s.g.skipMs(600);
    eq('AX10 and its drag, which the per-step reset reads off the vehicle', s.cas.dragMul, 1);
    note('AX  a car on its roof, picked up and set down, is a car on its wheels');
  }

  /* A load DROPPED is not a load righted. */
  {
    const s = stageRolled();
    for (let t = 0; t < 30000 && !s.cas.suspended; t += 250) { s.w.motor = 1; s.g.skipMs(250); }
    s.w.motor = 0;
    ok('AX11 it is up', s.cas.suspended);
    let righted = 0;
    s.g.bus.on(EVENTS.RIGHTED, () => { righted++; });
    // The line lets go, however that happened.
    s.w.state = WINCH.STOWED; s.w.targetId = null;
    s.g.step(STEP, s.st.simTimeMs + STEP, null);
    ok('AX12 a line that lets go drops it', !s.cas.suspended);
    ok('AX13 and a dropped car lands however it lands', s.cas.rolled);
    eq('AX14 nobody righted anything', righted, 0);
  }

  /* And the chart is what decides whether this is available at all. */
  {
    const heavy = stageRolled('sedanRoof', false);
    let refused = null;
    heavy.g.bus.on(EVENTS.BOOM_OVERLOAD, (e) => { if (e.refused && !refused) refused = e; });
    for (let t = 0; t < 30000 && !heavy.cas.suspended; t += 250) { heavy.w.motor = 1; heavy.g.skipMs(250); }
    ok('AX15 a car can be righted on the tyres too, in close', heavy.cas.suspended);

    const box = stageRolled('boxTruck', true);
    box.cas.rolled = true;
    box.cas.gripMul = CONFIG.vehicle.rolledGripMul;
    let boxRefused = null;
    box.g.bus.on(EVENTS.BOOM_OVERLOAD, (e) => { if (e.refused && !boxRefused) boxRefused = e; });
    for (let t = 0; t < 30000 && !box.cas.suspended; t += 250) { box.w.motor = 1; box.g.skipMs(250); }
    ok('AX16 a seven-tonner on its roof cannot be righted with the boom', !box.cas.suspended);
    ok('AX17 because the chart refuses to pick it up, in newtons', !!boxRefused);
    ok('AX18 and it is still on its roof', box.cas.rolled);
    note(`AX  the box truck: ${boxRefused ? `${kN(boxRefused.demandN)} kN against `
      + `${kN(boxRefused.capacityN)} kN at ${boxRefused.reachM} m` : 'no refusal recorded'}`);
  }

  /* WHERE YOU HOOK IT DECIDES WHETHER IT COMES UP AT ALL, and the obvious point is the wrong one.
   * This cost a debugging session: rigged to the tow eye the car was picked up and set straight
   * back down in the same step, which reads exactly like a broken hoist. It is not — the roofed
   * sedan's tow eye is rated 7 kN because it is bent, and the car weighs 13.7. */
  {
    const eye = stageRolled('sedanRoof', true, 'towHook');
    eq('AX19 a roofed car\'s tow eye is rated below its own weight',
       eye.zone.strengthN < eye.cas.body.massKg * CONFIG.sim.gravity, true);
    let lost = null;
    eye.g.bus.on(EVENTS.LOAD_LOWERED, (e) => { if (!lost) lost = e; });
    for (let t = 0; t < 20000 && !eye.cas.suspended; t += 250) { eye.w.motor = 1; eye.g.skipMs(250); }
    ok('AX20 so hooking it there does not hold the car up', !eye.cas.suspended);
    eq('AX21 the line lets go rather than the machine refusing', lost && lost.reason, 'lost');
    ok('AX22 and the car is still on its roof', eye.cas.rolled);
    const frame = stageRolled('sedanRoof', true, 'frameFront');
    gt('AX23 while the frame rail — facing straight up at you — is rated many times that',
       frame.zone.strengthN, eye.zone.strengthN * 4);
    note(`AX  a roofed sedan: tow eye ${kN(eye.zone.strengthN)} kN against a `
      + `${kN(eye.cas.body.massKg * CONFIG.sim.gravity)} kN car; frame rail ${kN(frame.zone.strengthN)} kN`);
  }
}

/* ══ AZ. the other way to right it ════════════════════════════════════════ */

/**
 * Hold a steady side load on a vehicle and see how long it takes to go over.
 *
 * Driven straight at `stepRighting` rather than through the game loop, because what this measures
 * is the RULE — the law relating a held load to a time — and staging a real pull that delivers
 * exactly 9.0 kN for exactly as long as it takes would measure the rig instead.
 */
function heldSide(veh, newtons, maxSec = 60) {
  const b = veh.body;
  const dt = STEP / 1000;
  for (let i = 0; i < maxSec / dt; i++) {
    const r = b.right;
    b.fx = r.x * newtons; b.fy = r.y * newtons;
    const before = veh.rolled;
    stepRighting(veh, dt, null, i * STEP);
    b.fx = 0; b.fy = 0;
    if (veh.rolled !== before) return i * dt;
  }
  return null;
}

function sectionAZ() {
  lines.push('--- AZ. a side pull rolls it, and keeps rolling it ---');
  const V = CONFIG.vehicle;

  /* THE LAW. The decay rate is also the FLOOR: a load of L newtons nets (L − decay) N·s per
   * second, so anything at or under the decay never adds up to anything at all, and the time to
   * go over is rightNs / (L − decay). One number doing the work of a threshold and a floor. */
  {
    const g = job();
    const veh = g.state.vehicles.sedan;
    const predict = (L) => V.rightNs / (L - V.rightDecayNsPerSec);

    eq('AZ1 a load under the decay never adds up to anything, ever',
       heldSide(job().state.vehicles.sedan, V.rightDecayNsPerSec * 0.8), null);
    eq('AZ2 nor does one exactly at it', heldSide(job().state.vehicles.sedan, V.rightDecayNsPerSec), null);
    for (const L of [6000, 9000, 14000]) {
      const t = heldSide(job().state.vehicles.sedan, L);
      ok(`AZ3_${L} ${(L / 1000).toFixed(0)} kN takes it over`, t !== null);
      near(`AZ4_${L} in rightNs/(load − decay) seconds (${t === null ? '-' : t.toFixed(2)} s)`,
           t === null ? -1 : t, predict(L), 0.05);
    }
    note(`AZ  a held side load: nothing under ${kN(V.rightDecayNsPerSec)} kN, `
      + `${predict(9000).toFixed(2)} s at 9 kN, ${predict(14000).toFixed(2)} s at 14`);
    ok('AZ5 and it is SIGNED — the same load the other way goes the other way', (() => {
      const a = job().state.vehicles.sedan;
      a.body.fx = a.body.right.x * 9000; a.body.fy = a.body.right.y * 9000;
      stepRighting(a, STEP / 1000);
      const right = rollImpulseNs(a).ns;
      const b2 = job().state.vehicles.sedan;
      b2.body.fx = -b2.body.right.x * 9000; b2.body.fy = -b2.body.right.y * 9000;
      stepRighting(b2, STEP / 1000);
      return Math.sign(right) === -Math.sign(rollImpulseNs(b2).ns) && right !== 0;
    })());
    ok('AZ6 and it costs the same either way', true);
  }

  /* AND KEEP PULLING AND IT GOES OVER AGAIN. That is what rolling is, and it is why the
   * accumulator resets rather than latching. */
  {
    const veh = job().state.vehicles.sedan;
    const flips = [];
    for (let n = 0; n < 3; n++) {
      const t = heldSide(veh, 9000, 20);
      if (t === null) break;
      flips.push({ t, rolled: veh.rolled });
      // The settle window has to pass before it can go again — a rollover is a rotation.
      for (let i = 0; i < 20; i++) stepRighting(veh, STEP / 1000);
    }
    eq('AZ7 the same held pull rolls it three times running', flips.length, 3);
    ok('AZ8 alternating: over, back onto its wheels, over again',
       flips[0].rolled === true && flips[1].rolled === false && flips[2].rolled === true);
    near('AZ9 each one costing another whole threshold', flips[2].t, flips[0].t, 0.4);
    note(`AZ  three flips under 9 kN: ${flips.map((f) => f.t.toFixed(2)).join(', ')} s`);
  }

  /* WHAT MUST NOT ROLL. Four existing pulls, and every one of them is a Milestone 1..7 promise. */
  {
    const r = pull({ shunt: false, seconds: 60 });
    ok('AZ10 the ordinary straight recovery still finishes', r.up);
    ok('AZ11 without rolling the car it is recovering', !r.st.vehicles.sedan.rolled);
    ok('AZ12 or the wrecker doing the recovering', !r.st.vehicles.truck.rolled);
    const carCap = rollImpulseNs(r.st.vehicles.sedan).thresholdNs;
    const truckCap = rollImpulseNs(r.st.vehicles.truck).thresholdNs;
    lt('AZ13 with the car well short of going over, at its worst moment', r.peakRollNs, carCap);
    /* AND THE WRECKER FURTHER SHORT STILL, which is the finding that changed the design. The
     * cable leaves the drum 3.05 m behind the truck's centre and pulls sideways for the whole
     * 38 s of an ordinary recovery, held by 63 kN of grip and a parking brake. Measured against a
     * FLAT 9 000 N·s threshold, the tow truck reached 8 996 of 9 000 — the Milestone 1 recovery
     * rolled the machine doing it. Scaling the threshold with mass is the fix, and it is also the
     * physics: rolling a vehicle lifts its centre of mass. */
    lt('AZ14 and the wrecker a smaller fraction of its own', r.peakTruckRollNs / truckCap,
       r.peakRollNs / carCap + 0.02);
    gt('AZ15 because a 6.8 t machine needs several times a car\'s impulse to go over',
       truckCap, carCap * 3);
    note(`AZ  the ordinary recovery, at its worst: the car reached ${Math.round(r.peakRollNs)} of `
      + `${Math.round(carCap)} N·s, the wrecker ${Math.round(r.peakTruckRollNs)} of `
      + `${Math.round(truckCap)} — and against ONE flat threshold the wrecker would have gone over`);
  }

  /* AND IT IS STILL ONE WAY ROUND. A trip is how a vehicle ends up on its roof, never how it comes
   * off one — a car dragged on its roof at speed must not right itself for free. */
  {
    const g = job({ casualtyId: 'sedanRoof' });
    const veh = g.state.vehicles.sedan;
    ok('AZ16 a car on its roof, thrown sideways hard', veh.rolled);
    const b = veh.body;
    for (let i = 0; i < 120; i++) {
      b.vx = 6; b.vy = 0;
      b.axPrev = b.right.x * 4 * CONFIG.sim.gravity;
      b.ayPrev = b.right.y * 4 * CONFIG.sim.gravity;
      stepRighting(veh, STEP / 1000);
      b.fx = 0; b.fy = 0;
    }
    ok('AZ17 does not right itself for free', veh.rolled);
    note('AZ  four g across a car already on its roof, for two seconds: still on its roof');
  }
}

/* ══ AY. the board ════════════════════════════════════════════════════════ */

function sectionAY() {
  lines.push('--- AY. how often two of them turn up, and what a pair is worth ---');

  /* HOW OFTEN, and — the part that matters — independent of everything else. `situations.js`
   * argues at length that its axes must stay independent or the generator becomes one difficulty
   * dial wearing five hats; a sixth axis is exactly where that would go wrong. */
  const N = 400;
  const rolls = [];
  for (let i = 0; i < N; i++) rolls.push(rollSituation(9000 + i, 100));
  const shunts = rolls.filter((s) => !!s.second);
  inRange(`AY1 a shunt is a minority of the board (${shunts.length}/${N})`,
          shunts.length / N, 0.20, 0.42);
  gt('AY2 but not a rarity', shunts.length, 40);

  const rate = shunts.length / N;
  const sliceRate = (pred) => {
    const sub = rolls.filter(pred);
    return sub.length < 40 ? null : sub.filter((s) => !!s.second).length / sub.length;
  };
  const byDry = sliceRate((s) => s.weather && s.weather.id === 'dry');
  const byWet = sliceRate((s) => s.weather && s.weather.id !== 'dry');
  for (const [name, r] of [['dry', byDry], ['anything else', byWet]]) {
    if (r === null) continue;
    near(`AY3 the weather does not decide whether there are two (${name})`, r, rate, 0.10);
  }
  const bigFront = sliceRate((s) => casualtyDefById(s.vehicle.id).massKg >= 2000);
  if (bigFront !== null) {
    near('AY4 nor does what is in front', bigFront, rate, 0.12);
  }
  note(`AY  ${shunts.length} of ${N} rolls are a shunt (${(rate * 100).toFixed(1)}%)`);

  /* PLAUSIBILITY BOUNDS IT, NOT DIFFICULTY. Two rules, both about how a pair arrives. */
  {
    let heavierBehind = 0, tooWide = 0;
    for (const s of shunts) {
      const fd = casualtyDefById(s.vehicle.id), sd = casualtyDefById(s.second.id);
      if (sd.massKg > fd.massKg) heavierBehind++;
      if (fd.lengthM + 0.6 + sd.lengthM > 15.0) tooWide++;
    }
    eq('AY5 nothing heavier ever ends up behind something lighter', heavierBehind, 0);
    eq('AY6 and no pair is wider than the gap they both came through', tooWide, 0);
    note(`AY  pairs: ${[...new Set(shunts.map((s) => `${s.vehicle.id}+${s.second.id}`))]
      .slice(0, 6).join(', ')}${shunts.length > 6 ? ' …' : ''}`);
  }

  /* THE LIE IS A LIE, not a position: expressed in the first casualty's own frame. */
  {
    const lies = shunts.map((s) => s.secondLie).filter(Boolean);
    eq('AY7 every shunt carries a lie for the one behind', lies.length, shunts.length);
    ok('AY8 which is always BEHIND the first one, in the first one\'s frame',
       lies.every((l) => l.x < 0));
    ok('AY9 by a real distance', lies.every((l) => Math.abs(l.x) > 1.5));
    ok('AY10 and never so far off to one side that they are not a pair',
       lies.every((l) => Math.abs(l.y) < 4));
    const spread = Math.max(...lies.map((l) => Math.abs(l.angle)));
    gt('AY11 with arrangements from square on to broadside', spread, 0.9);
    note(`AY  the lie runs ${Math.min(...lies.map((l) => l.x)).toFixed(2)} to `
      + `${Math.max(...lies.map((l) => l.x)).toFixed(2)} m behind, up to `
      + `${(spread * 180 / Math.PI).toFixed(0)}° round`);
  }

  /* WHAT IT PAYS: more than one job, less than two. Structural, not lucky. */
  {
    let ratios = [];
    for (const s of shunts) {
      const alone = s.vehicle.feeMul;
      ratios.push((alone + SECOND_CASUALTY_SHARE * s.second.feeMul) / alone);
    }
    gt('AY12 a pair always pays more than the one in front alone', Math.min(...ratios), 1.0);
    lt('AY13 and always less than the two of them done separately', Math.max(...ratios), 2.0);
    inRange('AY14 by a margin worth the slot it did not spend',
            ratios.reduce((a, b) => a + b, 0) / ratios.length, 1.15, 1.75);
    inRange('AY15 which is what the share is', SECOND_CASUALTY_SHARE, 0.01, 0.99);
    note(`AY  a pair pays ${Math.min(...ratios).toFixed(2)}x to ${Math.max(...ratios).toFixed(2)}x `
      + `the front vehicle alone, mean ${(ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(2)}x`);
  }

  /* AND THE BOARD SAYS SO, in the voice the rest of the board uses. */
  {
    const s = shunts[0];
    const offer = situationToOffer(s, 'test-1', 4242);
    eq('AY16 a generated shunt reaches the board as one offer', offer.secondCasualtyId, s.second.id);
    ok('AY17 carrying the lie with it', !!offer.secondLie);
    ok('AY18 and saying so in words', /both of them|in the back of it|behind it/i.test(offer.blurb));
    const banned = /\b(hard|difficult|challenging|expert|advanced|tier|level|difficulty)\b/i;
    ok('AY19 without ever grading it', !banned.test(`${offer.title} ${offer.blurb}`));
    note(`AY  "${offer.title}" — ${offer.blurb.slice(0, 90)}…`);
  }

  /* An authored offer carries the same keys, so nothing downstream reads the key set. */
  {
    const c = newCompany();
    const offers = offersFor(c);
    ok('AY20 every offer on the board answers the question, one way or the other',
       offers.every((o) => 'secondCasualtyId' in o && 'secondLie' in o));
    ok('AY21 including the ones the outfit is not good enough for yet',
       offers.filter((o) => o.locked).every((o) => o.secondCasualtyId === null));
  }

  /* END TO END, which nothing else in this suite does: a shunt the BOARD generated, taken off the
   * board, and turned into a scene with two vehicles on the bank. Everything above this tests one
   * link of that chain; this is the chain. */
  {
    let found = null;
    const c = newCompany();
    c.reputation = 100;
    for (let d = 0; d < 40 && !found; d++) {
      const offer = offersFor(c).find((o) => !o.locked && o.secondCasualtyId);
      if (offer) { found = offer; break; }
      endDay(c);
    }
    ok('AY22 a shunt reaches a real board inside a few days', !!found);
    if (found) {
      acceptOffer(c, found);
      const g = new Game({ seed: 4242, seedLabel: 'm9-board' });
      g.job = { ...found, traffic: false };
      g.startJob({ reroll: false, attempt: 1 });
      eq('AY23 and the scene it builds has two vehicles in the ditch',
         casualties(g.state).length, 2);
      eq('AY24 the one the card named', g.state.secondCasualtyId, found.secondCasualtyId);
      eq('AY25 with neither of them already on the road',
         casualties(g.state).filter((v) => cornersOnRoad(v, g.state.terrain).on > 0).length, 0);
      /* AND IT SETTLES. A body placed on a 27-degree bank by a generator that never saw the bank
       * is the one thing in this chain that could quietly be wrong — it can be left leaning on
       * the first casualty, or half over the lip of the mud, and slide for the rest of the job.
       * Measured over six seconds from a standing start: where they end up is where the player
       * finds them. */
      const at0 = casualties(g.state).map((v) => ({ x: v.body.x, y: v.body.y }));
      g.skipMs(6000);
      const st2 = g.state;
      const moved = casualties(st2).map((v, i) =>
        Math.hypot(v.body.x - at0[i].x, v.body.y - at0[i].y));
      ok('AY26 and it runs', st2.simTimeMs > 5500);

      /* THEY SETTLE AS A PAIR, which is not the same as not moving. A vehicle parked across a
       * 27-degree wet bank slides, and that has been true since Milestone 1 — measured here, a
       * 2.6 t van moves 8 m in six seconds on a bank a 1.4 t car sits still on, because 11.6 kN of
       * downslope beats what its tyres will hold. What must NOT happen is the pair stopping being
       * a pair: the one behind has to still be behind, both still off the tarmac, and neither
       * halfway to the far edge of the world. */
      const a2 = st2.vehicles.sedan.body, b2 = st2.vehicles.second.body;
      lt('AY27 the one behind is still behind it six seconds later', b2.y, a2.y);
      eq('AY28 with neither of them having found the road on its own',
         casualties(st2).filter((v) => cornersOnRoad(v, st2.terrain).on > 0).length, 0);
      lt('AY29 and neither of them off the bank altogether', Math.max(...moved), 14);
      ok('AY30 both still inside the world they were built in',
         casualties(st2).every((v) => v.body.x > 1 && v.body.x < st2.terrain.world.widthM - 1));
      note(`AY  off the board: "${found.title}" — £${found.fee}, `
        + `${found.casualtyId} + ${found.secondCasualtyId}; six seconds later they had slid `
        + `${moved.map((m) => m.toFixed(2)).join(' and ')} m down the bank`);
    }
  }
}

/* ══ AK4. eight milestones of numbers that must not have moved ════════════ */

async function sectionAK4() {
  lines.push('--- AK4. eight milestones of numbers that must not have moved ---');

  {
    const r = pull({ shunt: false, seconds: 60 });
    ok('AK4-1 the far-lane recovery still works', r.up);
    inRange(`AK4-2 in the time it always took (${r.t.toFixed(0)} s)`, r.t, 20, 50);
    inRange(`AK4-3 at the tension it always took (${kN(r.peak)} kN)`, r.peak, 8000, 20000);
    eq('AK4-4 and a single-casualty job still completes on one vehicle', r.st.goal.casualties, 1);
  }

  {
    const bad = [];
    for (const f of ['world/scene.js', 'sim/vehicle.js', 'world/customer.js']) {
      const src = await (await fetch(`../src/${f}`)).text();
      if (/Math\.random/.test(src)) bad.push(`${f}: Math.random`);
      if (/(Date\.now|performance\.now|new Date)\s*\(/.test(src)) bad.push(`${f}: wall clock`);
    }
    eq('AK4-5 no Math.random or wall clock in the Milestone 9 modules', bad.length, 0, bad.join('; '));
  }

  {
    const a = job({ secondCasualtyId: 'van' });
    const b = job({ secondCasualtyId: 'van' });
    a.skipMs(4000); b.skipMs(4000);
    near('AK4-6 a shunt still replays bit-for-bit',
         a.state.vehicles.second.body.y, b.state.vehicles.second.body.y, 1e-9);
  }

  const TB = window.__TB;
  ok('AK4-7 the live game booted', !!TB);
  eq('AK4-8 and no errors on the crash banner', document.getElementById('err-banner'), null);
}

/* ── run ─────────────────────────────────────────────────────────────────── */

(async function run() {
  const sections = [['AW', sectionAW], ['AX', sectionAX], ['AZ', sectionAZ],
                    ['AY', sectionAY], ['AK4', sectionAK4]];
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
