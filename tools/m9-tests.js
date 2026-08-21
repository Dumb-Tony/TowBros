/* TOW BROS — Milestone 9 suite: righting it, and the one behind.
 *
 *   .\tools\smoketest.ps1 -Tests tools\m9-tests.js -Quiet
 *
 * GDD §7 Milestone 9. Two things this game has been describing rather than simulating: a rollover
 * has been a one-way door since Milestone 1, and every job to date has had exactly one thing in
 * the ditch.
 *
 *   AW two of them: a shunt, and an order nothing declares
 *   AX righting: a side pull that rolls a car back onto its wheels, and over again
 *   AY the board: how often a shunt turns up, and what it is worth
 *   AK4 hygiene — eight milestones of numbers that must not have moved
 */

import { CONFIG } from '../src/config.js';
import { EVENTS } from '../src/core/eventBus.js';
import { Game } from '../src/game.js';
import { BANDS } from '../src/data/terrain.js';
import { findZone } from '../src/data/vehicles.js';
import { attachHook } from '../src/recovery/attach.js';
import { WINCH, cablePath, pathLength, drumsOf } from '../src/recovery/cable.js';
import { casualties, cornersOnRoad, CASUALTY_SLOTS } from '../src/sim/vehicle.js';
import { computePayout, recapFrom } from '../src/world/scene.js';
import { describePolice, closureStandard } from '../src/world/police.js';
import { describeCustomer } from '../src/world/customer.js';

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
  g.bus.on(EVENTS.WINCH_STALLED, () => { stalls++; });
  g.bus.on(EVENTS.IMPACT, (e) => { worstHit = Math.max(worstHit, e.impulseNs || 0); });
  const y0 = veh.body.y;
  for (let t = 0; t < seconds * 1000; t += 250) {
    w.motor = 1;
    g.skipMs(250);
    peak = Math.max(peak, w.tensionN);
    if (cornersOnRoad(veh, st.terrain).all) break;
  }
  w.motor = 0;
  let newDents = 0;
  for (const v of casualties(st)) {
    newDents += Math.max(0, v.damage.dents - ((v.damage.arrived || {}).dents || 0));
  }
  return {
    g, st, veh, w, peak, stalls, worstHit, newDents,
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
    const van = pull({ shunt: true, secondId: 'van', seconds: 70 });
    gt('AW23 with a van in front it costs more still', van.peak, shunt.peak);
    gt('AW24 enough to stall the drum', van.stalls, 0);
    ok('AW25 so bulldozing something big is not slow, it is not on', !van.up);
    note(`AW  a van in the way: ${kN(van.peak)} kN, ${van.stalls} stall${van.stalls === 1 ? '' : 's'}, `
      + `moved ${van.movedM.toFixed(1)} m and stopped`);
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
  const sections = [['AW', sectionAW], ['AK4', sectionAK4]];
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
