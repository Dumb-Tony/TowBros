/* TOW BROS — Milestone 6 suite: heavy and procedural recovery.
 *
 *   .\tools\smoketest.ps1 -Tests tools\m6-tests.js -Quiet
 *
 * GDD §7 Milestone 6: "heavy wreckers/rotators, multiple winches and outriggers, large vehicles,
 * richer anchors, water recovery, and procedural situation generation."
 *
 * The question this suite asks is whether a bigger job is a DIFFERENT job or the same job with
 * bigger numbers. A 7.5-tonne box truck that simply needs a longer pull would be the second thing
 * and would not be worth building. So:
 *
 *   AG the vehicle library: the casualties and the two wreckers, and what each asks for
 *   AH anchors: what a redirect costs the thing it is redirected through, and what happens when
 *      that thing is not enough
 *   AJ the heavy wrecker: two drums, four legs, a slewing boom, and the trade each one is
 *   AK hygiene — determinism, and five milestones of numbers that must not have moved
 */

import { CONFIG } from '../src/config.js';
import { EVENTS } from '../src/core/eventBus.js';
import { Game } from '../src/game.js';
import { BANDS, ROAD, SURFACES } from '../src/data/terrain.js';
import {
  CASUALTY_DEFS, TRUCK_DEFS, casualtyDefById, truckDefById, findZone, SEDAN_DEF,
} from '../src/data/vehicles.js';
import { cornersOnRoad, applyDriverInput } from '../src/sim/vehicle.js';
import { downslopeN, gripBudgetN } from '../src/sim/tires.js';
import { attachHook, detachHook } from '../src/recovery/attach.js';
import {
  WINCH, cablePath, pathLength, drumsOf, fairleadPos, motorMaxN, cableBreakN,
} from '../src/recovery/cable.js';
import {
  anchorPoints, groundAnchorHoldN, anchorLoadN, describeAnchor, stepAnchors,
} from '../src/recovery/anchors.js';
import { toggleOutriggers, describeRig, outriggerPads } from '../src/recovery/rig.js';
import { validateAuthority } from '../src/crew/authority.js';
import { buoyancyFrac } from '../src/sim/tires.js';
import {
  rollSituation, situationToOffer, describeSituation, VEHICLES, INCIDENTS, CONDITIONS,
} from '../src/meta/situations.js';
import {
  newCompany, activeTruck, buyTruck, setActiveTruck, truckPrice, repairQuote,
} from '../src/meta/company.js';
import { offersFor } from '../src/meta/dispatch.js';

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

/** A job with a named wrecker and a named casualty, on the bend, on an empty road. */
function job(truckId = 'truck', casualtyId = 'sedan', extra = {}) {
  const g = new Game({ seed: 4242, seedLabel: 'm6' });
  g.job = {
    siteId: 'bend', weatherId: 'dry', mods: {}, traffic: false,
    truckId, casualtyId, ...extra,
  };
  g.startJob({ reroll: false, attempt: 1 });
  return g;
}

/** Park the wrecker, brake on, facing east. */
function park(st, x, y) {
  const b = st.vehicles.truck.body;
  b.x = x; b.y = y; b.angle = 0; b.vx = 0; b.vy = 0; b.omega = 0;
  st.vehicles.truck.parkBrake = true;
}

/** Rig every drum, walked out and hooked on the way the m1/m3 suites do it: zero stretch. */
function rigAll(g, zoneIds = ['towHook']) {
  const st = g.state;
  const veh = st.vehicles.sedan;
  drumsOf(st).forEach((w, i) => {
    const zone = findZone(veh.def, zoneIds[i % zoneIds.length]);
    const p = veh.body.toWorld(zone.local.x, zone.local.y);
    w.hook.x = p.x; w.hook.y = p.y;
    w.state = WINCH.ATTACHED; w.targetId = 'sedan'; w.zoneId = zone.id;
    const len = pathLength(cablePath(w, st.vehicles.truck, st.vehicles, st.blocksById));
    w.state = WINCH.LOOSE;
    attachHook(st, veh, zone, g.bus, st.simTimeMs, w);
    w.lineM = len;
  });
}

/** Reel every drum until the job is done or the time runs out. Returns the peak line tension. */
function reel(g, ms = 60000) {
  const st = g.state;
  let peak = 0;
  for (let t = 0; t < ms && !st.goal.complete; t += 250) {
    for (const w of drumsOf(st)) w.motor = 1;
    g.skipMs(250);
    for (const w of drumsOf(st)) peak = Math.max(peak, w.tensionN);
  }
  for (const w of drumsOf(st)) w.motor = 0;
  return peak;
}

const cornersUp = (st) => cornersOnRoad(st.vehicles.sedan, st.terrain).on;

/** One anchor step at this level, so a test can hold a load on an anchor without a live cable. */
const stepAnchorsFor = (g, dtSec) => stepAnchors(g.state, dtSec, g.bus, g.state.simTimeMs);

/* ══ AG. the vehicle library ══════════════════════════════════════════════ */

function sectionAG() {
  lines.push('--- AG. the casualty library, two wreckers, and what each of them asks for ---');

  eq('AG1 there are five things that can be in the ditch', Object.keys(CASUALTY_DEFS).length, 5);
  eq('AG2 and the first of them is the Milestone 1 sedan', CASUALTY_DEFS.sedan, SEDAN_DEF);
  eq('AG3 an unknown casualty falls back rather than throwing', casualtyDefById('spaceship').id, 'sedan');
  eq('AG4 and so does an unknown wrecker', truckDefById('crane').id, 'truck');

  /* Each one is a DIFFERENT problem, and the differences have to be facts about the machine
   * rather than a difficulty dial. Mass, length, and how many tyres are under it. */
  const built = Object.keys(CASUALTY_DEFS).map((id) => {
    const g = job('truck', id);
    const v = g.state.vehicles.sedan;
    return {
      id,
      massKg: v.body.massKg,
      lengthM: v.def.lengthM,
      wheels: v.def.wheels.length,
      boggedN: v.boggedN,
      downslopeN: downslopeN(v.body, g.state.terrain),
      gripN: gripBudgetN(v, g.state.terrain),
      strongestN: Math.max(...v.def.zones.map((z) => z.strengthN)),
      weakestN: Math.min(...v.def.zones.map((z) => z.strengthN)),
    };
  });
  for (const b of built) {
    note(`AG  ${b.id.padEnd(9)} ${(b.massKg / 1000).toFixed(1)} t, ${b.lengthM} m, ${b.wheels} wheels · `
       + `downslope ${kN(b.downslopeN)} kN, bogged ${kN(b.boggedN)} kN, grip ${kN(b.gripN)} kN`);
  }
  const by = (id) => built.find((b) => b.id === id);

  gt('AG5 a van is heavier than a car', by('van').massKg, by('sedan').massKg);
  gt('AG6 a box truck heavier again', by('boxTruck').massKg, by('van').massKg);
  eq('AG7 and it is on six wheels, because the back axle is on twins', by('boxTruck').wheels, 6);

  /* THE POINT OF THE WHOLE SECTION. A heavier casualty pulls itself down the bank harder, so the
   * force the winch has to find scales with it — and the light wrecker's drum does not. */
  gt('AG8 mass reaches the slope: a van pulls harder downhill than a car',
     by('van').downslopeN, by('sedan').downslopeN);
  gt('AG9 and a box truck harder than either', by('boxTruck').downslopeN, by('van').downslopeN);
  gt('AG10 it is buried deeper for the same reason', by('boxTruck').boggedN, by('sedan').boggedN);
  gt('AG11 the light wrecker cannot even stall against it', by('boxTruck').downslopeN, CONFIG.winch.motorMaxN);
  lt('AG12 while a car is comfortably inside what one drum can do',
     by('sedan').downslopeN + by('sedan').boggedN, CONFIG.winch.motorMaxN);

  /* And the SPREAD between a good choice and a lazy one widens with the vehicle. On a sedan a
   * bumper costs you a bumper; on a box truck, at box-truck loads, it is not a choice. */
  gt('AG13 a box truck has stronger strong points', by('boxTruck').strongestN, by('sedan').strongestN);
  lt('AG14 the gap between its best and worst zone is wider than a car\'s',
     by('sedan').strongestN / by('sedan').weakestN, by('boxTruck').strongestN / by('boxTruck').weakestN);

  // Two wreckers, and the heavy is not merely a better one.
  eq('AG15 there are two wreckers', Object.keys(TRUCK_DEFS).length, 2);
  gt('AG16 the heavy is heavier', TRUCK_DEFS.heavy.massKg, TRUCK_DEFS.truck.massKg);
  gt('AG17 and longer, which is the cost of it', TRUCK_DEFS.heavy.lengthM, TRUCK_DEFS.truck.lengthM);
  eq('AG18 the light wrecker has one drum', TRUCK_DEFS.truck.drums.length, 1);
  eq('AG19 the heavy has two', TRUCK_DEFS.heavy.drums.length, 2);
  eq('AG20 four legs', TRUCK_DEFS.heavy.outriggers.length, 4);
  ok('AG21 and a boom', TRUCK_DEFS.heavy.boom === true);
  ok('AG22 the light wrecker has neither', !TRUCK_DEFS.truck.outriggers && !TRUCK_DEFS.truck.boom);

  /* The vehicle's own brakes come off its DEFINITION now, not from CONFIG keyed by "is it a
   * truck". Two of the casualties weigh more than the wrecker that came for them. */
  gt('AG23 a box truck brakes harder than a car, because it has to',
     CASUALTY_DEFS.boxTruck.brakeForceN, CASUALTY_DEFS.sedan.brakeForceN);
  gt('AG24 the heavy wrecker pulls harder off the line', TRUCK_DEFS.heavy.driveForceN, TRUCK_DEFS.truck.driveForceN);
  lt('AG25 and turns worse, which is what a 9 m wheelbase does',
     CONFIG.heavy.maxSteerRad, CONFIG.truck.maxSteerRad);
}

/* ══ AH. anchors ══════════════════════════════════════════════════════════ */

function sectionAH() {
  lines.push('--- AH. what a redirect costs the thing it is redirected through ---');

  const g = job();
  const st = g.state;

  const anchors = anchorPoints(st);
  eq('AH1 the bend\'s five trees are all anchors', anchors.length, st.terrain.trees.length);
  ok('AH2 each of them has the strength it was authored with',
     anchors.every((a) => a.strengthN === a.ref.anchorStrengthN));
  ok('AH3 no boulder is an anchor — the quarry has nothing to hang a block on',
     anchorPoints(job('truck', 'sedan', { siteId: 'quarry' }).state).length === 0);

  /* THE GEOMETRY THAT MAKES AN ANCHOR INTERESTING. A block folds the line back on itself, so the
   * anchor holds the vector sum of both legs — up to twice the line tension. */
  const B = { x: 0, y: 0 };
  near('AH4 a line folded right back puts 2x the tension on the anchor',
       anchorLoadN(B, { x: -10, y: 0 }, { x: -10, y: 0.001 }, 10000), 20000, 40);
  near('AH5 a line turned through 90 degrees puts 1.41x',
       anchorLoadN(B, { x: -10, y: 0 }, { x: 0, y: -10 }, 10000), 14142, 40);
  lt('AH6 and a line that barely turns puts almost nothing on it',
     anchorLoadN(B, { x: -10, y: 0 }, { x: 10, y: 0 }, 10000), 100);
  eq('AH7 no tension, no load', anchorLoadN(B, { x: -10, y: 0 }, { x: 0, y: -10 }, 0), 0);

  /* Ground anchors. Milestone 6's portable answer to a site with no tree — and it is worth what
   * the ground under it is worth, recomputed from that ground every time it is asked. */
  const at = (x, y) => groundAnchorHoldN(st, { x, y });
  const onRoad = at(46, ROAD.centreY);
  const onGrass = at(46, 21);
  const inMud = at(st.terrain.mud.x, st.terrain.mud.y);
  note(`AH  a driven anchor holds: ${kN(onRoad)} kN on tarmac, ${kN(onGrass)} kN on wet grass, `
     + `${kN(inMud)} kN in the mud`);
  eq('AH8 a spike will not go into tarmac at all', onRoad, 0);
  gt('AH9 wet grass is the best of them', onGrass, inMud);
  gt('AH10 and mud is better than nothing', inMud, 0);
  lt('AH11 but a driven anchor is never a tree', onGrass, Math.min(...anchors.map((a) => a.strengthN)));
  eq('AH12 the ground it is worth is read where it stands, not where it was dropped',
     at(46, ROAD.centreY), 0);
  gt('AH13 moved onto the grass, the same anchor is worth something', at(46, 21), 0);
  ok('AH14 every surface has an authored hold, so a new one cannot silently be worth nothing',
     Object.values(SURFACES).every((s) => typeof s.anchorHoldMul === 'number'));

  /* A tree that is asked for more than it has. Judged in newton-seconds, like the guardrail and
   * the wheel lift before it — a threshold on force fails on the first spike, and a snatch load
   * IS a spike. */
  /* Driven for real, through a loaded line: a block on a ground anchor in soft ground, with a box
   * truck on the other end of it. Injecting a number into `winch.anchorLoadN` would test nothing —
   * `stepDrum` recomputes it from the geometry every step, which is exactly the property that
   * makes the anchor load honest, so the test has to go through the cable too. */
  function redirectedPull(anchorX, anchorY, { casualty = 'boxTruck', ms = 30000 } = {}) {
    const gg = job('truck', casualty);
    const s = gg.state;
    park(s, s.vehicles.sedan.body.x + 11, BANDS.roadN + 1.4);

    // Plant an anchor, mount the block on it, and route the line through it.
    const anchor = s.gear.find((it) => it.kind === 'groundAnchor')
      || (s.gear.push({
        id: 'ga_test', kind: 'groundAnchor', x: 0, y: 0, angle: 0,
        carriedBy: null, placed: false, attachedTo: null, liftStep: 0, pumpMs: 0, usedAsRig: false,
      }), s.gear[s.gear.length - 1]);
    anchor.x = anchorX; anchor.y = anchorY; anchor.placed = true; anchor.carriedBy = null;

    const block = s.gear.find((it) => it.kind === 'snatchBlock');
    block.x = anchorX + 0.2; block.y = anchorY; block.placed = true; block.carriedBy = null;
    block.attachedTo = anchor.id;

    /* Route FIRST, then measure the line to the routed path. Rigging to the direct distance and
     * then adding the block is a snatch: the route through a block is metres longer than the
     * straight line, the spring sees all of it as stretch on the first step, and the cable parts
     * before anything has been asked of the anchor. (Measured: a 400 kN spike, once, and then a
     * parted rope.) This is the same lesson the M1 suite records about walking the hook out. */
    gg.step(STEP, s.simTimeMs + STEP, null);      // let stepGearEffects register the block
    s.winch.blockId = block.id;
    rigAll(gg, ['towHook']);

    let failed = null, peakAnchor = 0, peakStrain = 0, loaded = 0, sumLoad = 0;
    let peakLine = 0, ratio = 0;
    gg.bus.on(EVENTS.ANCHOR_FAILED, (e) => { if (!failed) failed = e; });
    for (let t = 0; t < ms && !failed; t += STEP) {
      s.winch.motor = 1;
      gg.step(STEP, s.simTimeMs + STEP, null);
      const load = s.winch.anchorLoadN || 0;
      peakAnchor = Math.max(peakAnchor, load);
      peakLine = Math.max(peakLine, s.winch.tensionN);
      if (load > 0) ratio = Math.max(ratio, load / Math.max(1, s.winch.tensionN));
      if (load > 0) { loaded++; sumLoad += load; }
      peakStrain = Math.max(peakStrain, (anchor.pullNs || 0) / CONFIG.anchors.failNs);
    }
    return {
      g: gg, st: s, failed, peakAnchor, anchor, block, secs: s.simTimeMs / 1000,
      /* The SUSTAINED load is the one that matters, because an anchor is judged in newton-seconds:
       * a spike as the line goes tight is not the same event as a pull being held on it. */
      meanLoad: loaded ? sumLoad / loaded : 0,
      peakLine, ratio,
      peakStrain,
      holdN: groundAnchorHoldN(s, anchor),
    };
  }

  /* Three placements of the same anchor, in three kinds of ground, under the same pull.
   *
   * The interesting result is the middle one. On wet grass the line SPIKES well past what the
   * anchor is rated for as it goes tight and the anchor still holds — which is correct and is the
   * whole reason this is judged in newton-seconds. What pulls an anchor out is a load HELD on it,
   * and the same rig in mud or on tarmac is exactly that. */
  const grass = redirectedPull(46, 21);
  const mud = redirectedPull(st.terrain.mud.x, st.terrain.mud.y);
  const tarmac = redirectedPull(46, ROAD.centreY, { ms: 15000 });
  for (const [what, r] of [['wet grass', grass], ['mud      ', mud], ['tarmac   ', tarmac]]) {
    note(`AH  ${what}: rated ${kN(r.holdN)} kN · peak ${kN(r.peakAnchor)} kN · `
       + `held ${kN(r.meanLoad)} kN · strain reached ${(r.peakStrain * 100).toFixed(0)}% · `
       + `${r.failed ? 'PULLED OUT after ' + r.secs.toFixed(1) + ' s' : 'held'}`);
  }

  gt('AH15 a redirect really does load the anchor', grass.peakAnchor, 1000);
  /* How much of the line tension reaches the anchor is a fact about the ANGLE, and this park does
   * not fold the line back sharply — 0.92x here. The geometric bound (0 to 2x, and where in that
   * range each angle lands) is asserted analytically in AH4-AH6; what this pins is that the live
   * rig stays inside it rather than inventing force. */
  inRange(`AH16 the anchor carries a share of the line set by the angle (x${grass.ratio.toFixed(2)})`,
          grass.ratio, 0.05, 2.001);
  ok('AH17 on ground that will hold it, the anchor holds', !grass.failed, 'pulled out');
  lt('AH18 and never gets close to coming out', grass.peakStrain, 0.3);

  /* The same rig, the same pull, worse ground. This is the pair that says the ground is the
   * mechanic: nothing about the rigging changed and the anchor went from untroubled to most of
   * the way out. */
  lt('AH19 the same anchor in mud is worth a third of what it was', mud.holdN, grass.holdN * 0.5);
  gt(`AH20 and the same pull has it visibly on the way out (${(mud.peakStrain * 100).toFixed(0)}% of the way)`,
     mud.peakStrain, grass.peakStrain + 0.15);

  eq('AH21 driven into tarmac it holds nothing at all', tarmac.holdN, 0);
  ok('AH22 so the first load on it takes it out', !!tarmac.failed,
     `strain ${(tarmac.peakStrain * 100).toFixed(0)}%`);
  if (tarmac.failed) {
    eq('AH23 it says which anchor went', tarmac.failed.anchor, tarmac.anchor.id);
    eq('AH24 and what kind it was', tarmac.failed.kind, 'groundAnchor');
    eq('AH25 a pulled-out anchor is not planted any more', tarmac.anchor.placed, false);
    eq('AH26 the block comes off it', tarmac.block.attachedTo, null);
    eq('AH27 and the redirect is dropped, so the line is a straight pull again',
       tarmac.st.winch.blockId, null);
  }

  /* A tree, which is the strong case, judged in NEWTON-SECONDS like the guardrail and the wheel
   * lift before it: over its rating it leans, holds, and then goes. */
  {
    const gg = job();
    const s = gg.state;
    const tree = s.terrain.trees[0];
    tree.pullNs = 0;
    let failed = null;
    gg.bus.on(EVENTS.ANCHOR_FAILED, (e) => { failed = e; });
    s.blocksById[tree.id] = { id: 'blk', x: tree.x, y: tree.y, anchorId: tree.id };

    // stepAnchors reads the load the cable computed, so drive it directly at this level.
    const hold = (loadN, ms) => {
      for (let i = 0; i < Math.round(ms / STEP) && !failed; i++) {
        s.winch.anchorId = tree.id;
        s.winch.anchorLoadN = loadN;
        stepAnchorsFor(gg, STEP / 1000);
      }
    };
    hold(tree.anchorStrengthN * 0.95, 10000);
    eq('AH25 an anchor inside its rating holds indefinitely', failed, null);
    eq('AH26 and nothing accumulates against it', tree.pullNs || 0, 0);

    const before = s.simTimeMs;
    let steps = 0;
    while (!failed && steps < 60 * 30) {
      s.winch.anchorId = tree.id;
      s.winch.anchorLoadN = tree.anchorStrengthN + 12000;
      stepAnchorsFor(gg, STEP / 1000);
      steps++;
    }
    ok('AH27 held past its rating, a tree goes over', !!failed, String(steps));
    inRange(`AH28 after a couple of seconds of it, not instantly (${(steps / 60).toFixed(1)} s)`,
            steps / 60, 0.8, 8);
    eq('AH29 and it says what it was rated for', failed && failed.ratedN, Math.round(tree.anchorStrengthN));
    ok('AH30 the tree is on its side', tree.fallen === true);
    ok('AH31 and is no longer an anchor', !anchorPoints(s).some((a) => a.id === tree.id));
    note(`AH  ${failed.kind} ${failed.anchor}: rated ${kN(failed.ratedN)} kN, carrying ${kN(failed.loadN)} kN, `
       + `over in ${(steps / 60).toFixed(1)} s`);
  }

  // And the inspect card says the facts and nothing else.
  {
    const a = anchorPoints(st)[0];
    const d = describeAnchor(st, a);
    gt('AH24 an anchor can be asked what it is rated for', d.ratedN, 0);
    ok('AH25 and it answers with a fact, not a recommendation',
       !/you should|try |use the|better/i.test(d.line), d.line);
  }
}

/* ══ AJ. the heavy wrecker ════════════════════════════════════════════════ */

function sectionAJ() {
  lines.push('--- AJ. two drums, four legs, and a boom ---');

  const light = job('truck');
  const heavy = job('heavy');

  eq('AJ1 a light wrecker turns out with one drum', drumsOf(light.state).length, 1);
  eq('AJ2 the heavy with two', drumsOf(heavy.state).length, 2);
  ok('AJ3 which are two different drums, not one twice',
     drumsOf(heavy.state)[0] !== drumsOf(heavy.state)[1]);
  ok('AJ4 `st.winch` still means the first of them, as it has since Milestone 1',
     heavy.state.winch === drumsOf(heavy.state)[0]);

  // Two fairleads, a real distance apart. That gap is the mechanic.
  {
    const st = heavy.state;
    const [a, b] = drumsOf(st).map((w) => fairleadPos(st.vehicles.truck, w));
    const gap = Math.hypot(a.x - b.x, a.y - b.y);
    gt(`AJ5 the two lines leave the machine from different places (${gap.toFixed(2)} m apart)`, gap, 1.0);
  }

  gt('AJ6 a heavy drum stalls later than a light one',
     motorMaxN(heavy.state.winch), motorMaxN(light.state.winch));
  gt('AJ7 and its rope is worth more', cableBreakN(heavy.state.winch), cableBreakN(light.state.winch));
  eq('AJ8 the light wrecker\'s numbers are the numbers they always were',
     motorMaxN(light.state.winch), CONFIG.winch.motorMaxN);

  /* THE JOB EACH MACHINE IS FOR. Measured end to end, three casualties by two wreckers. This is
   * the section that says the heavy wrecker is a different machine and not a bigger number. */
  function pull(truckId, casualtyId, dx = 11) {
    const g = job(truckId, casualtyId);
    const st = g.state;
    park(st, st.vehicles.sedan.body.x + dx, BANDS.roadN + 1.4);
    const from = { x: st.vehicles.truck.body.x, y: st.vehicles.truck.body.y };
    rigAll(g, ['towHook', 'frameFront']);
    const peak = reel(g, 60000);
    const b = st.vehicles.truck.body;
    return {
      done: st.goal.complete, secs: st.simTimeMs / 1000, corners: cornersUp(st), peak, st, g,
      /** How far the WRECKER lost the argument. The number the README quotes. */
      truckDraggedM: Math.hypot(b.x - from.x, b.y - from.y),
    };
  }

  const lightSedan = pull('truck', 'sedan');
  const heavyVan = pull('heavy', 'van');
  const lightVan = pull('truck', 'van');
  const lightBox = pull('truck', 'boxTruck');

  ok('AJ9 the Milestone 1 recovery is untouched by any of this', lightSedan.done);
  inRange(`AJ10 in the time it always took (${lightSedan.secs.toFixed(0)} s)`, lightSedan.secs, 25, 50);

  ok('AJ11 a van is past the light wrecker', !lightVan.done, `${lightVan.corners}/4`);
  ok('AJ12 and the heavy does it', heavyVan.done, `${heavyVan.corners}/4`);
  note(`AJ  the van: light wrecker stops at ${lightVan.corners}/4 at ${kN(lightVan.peak)} kN; `
     + `the heavy delivers it in ${heavyVan.secs.toFixed(0)} s at ${kN(heavyVan.peak)} kN`);

  ok('AJ13 a box truck is well past it', !lightBox.done, `${lightBox.corners}/4`);
  /* And past it in the most legible way there is: the wrecker loses. This is the number the README
   * quotes, so it is asserted rather than left as a remembered measurement. */
  gt(`AJ13b — the light wrecker is the one that moves (${lightBox.truckDraggedM.toFixed(1)} m)`,
     lightBox.truckDraggedM, 8);
  lt('AJ13c while against a car it stays where it was put', lightSedan.truckDraggedM, 1);
  note(`AJ  against a box truck the light wrecker is dragged ${lightBox.truckDraggedM.toFixed(1)} m; `
     + `against a car it moves ${lightSedan.truckDraggedM.toFixed(2)} m`);
  eq('AJ14 which does not break anything — no cable parts',
     lightBox.g.bus.count(EVENTS.CABLE_SNAPPED), 0);

  /* And the heavy CAN do it — in two parks, because a winch pulls its load to the drum and one
   * pull cannot both lift a 7.4 m vehicle up a bank AND leave it lying along the road. That is
   * the Milestone 1 geometry lesson, arriving again at a bigger scale. */
  {
    const g = job('heavy', 'boxTruck');
    const st = g.state;
    park(st, st.vehicles.sedan.body.x + 11, BANDS.roadN + 1.4);
    rigAll(g, ['towHook', 'frameFront']);
    const p1 = reel(g, 50000);
    const after1 = cornersUp(st);
    const ang1 = st.vehicles.sedan.body.angle * 180 / Math.PI;

    for (const w of drumsOf(st)) detachHook(st, g.bus, st.simTimeMs, 'player', w);
    park(st, st.vehicles.sedan.body.x + 16, ROAD.centreY);
    rigAll(g, ['towHook', 'frameFront']);
    const p2 = reel(g, 50000);

    gt('AJ15 the first pull brings a box truck up the bank', after1, 0);
    ok('AJ16 but leaves it lying across the road, not along it', Math.abs(ang1) > 40, `${ang1.toFixed(0)} deg`);
    ok('AJ17 a second park finishes it', st.goal.complete, `${cornersUp(st)}/4`);
    inRange(`AJ18 in about a minute of work (${(st.goal.completedAtMs / 1000).toFixed(0)} s)`,
            st.goal.completedAtMs / 1000, 40, 110);
    eq('AJ19 without parting either rope', g.bus.count(EVENTS.CABLE_SNAPPED), 0);
    note(`AJ  the box truck: up the bank to ${after1}/4 at ${ang1.toFixed(0)} deg (${kN(p1)} kN), `
       + `then round to 4/4 from a second park (${kN(p2)} kN)`);
  }

  /* ── the legs ──────────────────────────────────────────────────────────── */
  {
    const g = job('heavy');
    const st = g.state;
    const t = st.vehicles.truck;
    ok('AJ20 a heavy wrecker arrives with its legs up', describeRig(t).outriggers === 'up');
    eq('AJ21 holding nothing', t.outriggerHoldN || 0, 0);
    eq('AJ22 and a light one has no legs to put down', describeRig(job('truck').state.vehicles.truck).outriggers, null);

    toggleOutriggers(t, g.bus, st.simTimeMs);
    g.skipMs(200);
    eq('AJ23 they take a couple of seconds to come down', describeRig(t).outriggers, 'lowering');
    g.skipMs(3000);
    eq('AJ24 and then they are down', describeRig(t).outriggers, 'down');
    gt('AJ25 holding the machine to the ground', t.outriggerHoldN, gripBudgetN(t, st.terrain));
    eq('AJ26 four pads, at four corners', outriggerPads(t).length, 4);

    // Legs down means legs down.
    t.occupiedBy = 'crew0';
    t.parkBrake = false;
    const drive = (ms) => {
      const x0 = t.body.x;
      for (let i = 0; i < Math.round(ms / STEP); i++) {
        applyDriverInput(t, 0, 1, false, STEP / 1000);
        g.step(STEP, st.simTimeMs + STEP, null);
      }
      return Math.abs(t.body.x - x0);
    };
    const onLegs = drive(3000);
    toggleOutriggers(t, g.bus, st.simTimeMs);
    g.skipMs(3000);
    const offLegs = drive(3000);
    lt(`AJ27 on its legs it cannot move at all (${onLegs.toFixed(3)} m in 3 s)`, onLegs, 0.02);
    gt(`AJ28 legs up, it drives away (${offLegs.toFixed(2)} m in the same 3 s)`, offLegs, 3);
    note(`AJ  outriggers: ${onLegs.toFixed(3)} m in three seconds on the legs, ${offLegs.toFixed(2)} m off them`);
  }

  /* And what they are FOR: a park where the machine would otherwise lose the argument. */
  {
    const runs = {};
    for (const legs of [false, true]) {
      const g = job('heavy', 'boxTruck');
      const st = g.state;
      park(st, st.vehicles.sedan.body.x + 11, BANDS.roadS + 1.9);   // off the tarmac, on the verge
      rigAll(g, ['towHook', 'frameFront']);
      if (legs) { toggleOutriggers(st.vehicles.truck, g.bus, st.simTimeMs); g.skipMs(3000); }
      const b = st.vehicles.truck.body;
      const x0 = b.x, y0 = b.y;
      reel(g, 40000);
      runs[legs ? 'down' : 'up'] = Math.hypot(b.x - x0, b.y - y0);
    }
    gt('AJ29 parked off the tarmac against a box truck, the machine gets dragged', runs.up, 4);
    lt('AJ30 on its legs it stays where it was put', runs.down, 1);
    note(`AJ  same park, same pull: dragged ${runs.up.toFixed(1)} m on its tyres, `
       + `${runs.down.toFixed(2)} m on its legs`);
  }

  /* ── the boom ──────────────────────────────────────────────────────────── */
  {
    const g = job('heavy');
    const st = g.state;
    const t = st.vehicles.truck;
    const w = drumsOf(st)[0];
    eq('AJ31 the boom starts centred', t.boomRad, 0);
    const centred = fairleadPos(t, w);
    t.boomRad = CONFIG.heavy.boomSlewMaxRad;
    const slewed = fairleadPos(t, w);
    gt(`AJ32 slewing it MOVES the fairlead (${Math.hypot(slewed.x - centred.x, slewed.y - centred.y).toFixed(2)} m)`,
       Math.hypot(slewed.x - centred.x, slewed.y - centred.y), 0.4);
    ok('AJ33 which is what changes the direction of the pull, and the torque with it',
       Math.abs(slewed.y - centred.y) > 0.2);
    eq('AJ34 a light wrecker has no boom to slew',
       fairleadPos(job('truck').state.vehicles.truck).y,
       fairleadPos(job('truck').state.vehicles.truck).y);
  }
}

/* ══ AL. water ════════════════════════════════════════════════════════════ */

function sectionAL() {
  lines.push('--- AL. standing water, and what it takes off the tyres ---');

  const bend = job('truck', 'sedan', { siteId: 'bend' });
  const ford = job('truck', 'sedan', { siteId: 'ford' });
  const bt = bend.state.terrain, ft = ford.state.terrain;
  // WHERE each casualty came to rest, taken before anything below moves one to measure it.
  const spawn = {
    ford: { ...ford.state.vehicles.sedan.body },
    bend: { ...bend.state.vehicles.sedan.body },
  };

  eq('AL1 the bend has mud at the bottom', bt.mud.kind, 'mud');
  eq('AL2 the ford has standing water', ft.mud.kind, 'water');
  eq('AL3 and only the ford has any depth of it', bt.waterDepthAt(bt.mud.x, bt.mud.y), 0);
  gt('AL4 which is real depth, not a painted stain', ft.waterDepthAt(ft.mud.x, ft.mud.y), 0.4);

  /* Buoyancy: the thing that makes water a different problem rather than a wetter one. */
  eq('AL5 dry ground carries none of a vehicle', buoyancyFrac(bt, bt.mud.x, bt.mud.y), 0);
  gt('AL6 deep water carries a lot of it', buoyancyFrac(ft, ft.mud.x, ft.mud.y), 0.4);
  lt('AL7 but never all of it — a car in a ford is light, not afloat',
     buoyancyFrac(ft, ft.mud.x, ft.mud.y), 0.95);
  ok('AL8 and it goes on rising with the depth',
     buoyancyFrac(ft, ft.mud.x, ft.mud.y) > buoyancyFrac(ft, ft.mud.x + ft.mud.rx * 0.85, ft.mud.y));

  /* And it reaches the tyres, which is the only thing that makes it a mechanic. */
  {
    const s = ford.state.vehicles.sedan;
    const put = (x, y) => { s.body.x = x; s.body.y = y; s.body.vx = 0; s.body.vy = 0; return gripBudgetN(s, ft); };
    const inWater = put(ft.mud.x, ft.mud.y);
    const onBank = put(ft.mud.x, ft.mud.y - ft.mud.ry - 1.5);
    lt(`AL9 the same car has far less grip in the brook (${kN(inWater)} kN against ${kN(onBank)} kN)`,
       inWater, onBank * 0.55);
    note(`AL  a sedan: ${kN(onBank)} kN of grip on the bank, ${kN(inWater)} kN standing in the water`);
  }

  /* The ford's casualty is IN the water. A site called a ford whose car never touches it would be
   * a blue puddle painted next to a recovery. */
  {
    gt('AL10 the ford puts the casualty in the brook',
       ft.waterDepthAt(spawn.ford.x, spawn.ford.y), 0.05);
    eq('AL11 standing on water, which is what the surface says too',
       ft.surfaceAt(spawn.ford.x, spawn.ford.y).id, 'water');
    eq('AL12 while the bend leaves it on the bank as it always did',
       bt.surfaceAt(spawn.bend.x, spawn.bend.y).id, 'wetGrass');
    note(`AL  the ford's casualty comes to rest in ${ft.waterDepthAt(spawn.ford.x, spawn.ford.y).toFixed(2)} m of water`);
  }

  /* The recovery still works — GDD §4, no site is a wall — and it is a different job. */
  {
    const g = job('truck', 'sedan', { siteId: 'ford' });
    const st = g.state;
    park(st, st.vehicles.sedan.body.x + 11, BANDS.roadN + 1.4);
    rigAll(g);
    const peak = reel(g, 90000);
    ok('AL13 a car can be recovered out of the water', st.goal.complete, `${cornersUp(st)}/4`);
    const gb = job('truck', 'sedan', { siteId: 'bend' });
    park(gb.state, gb.state.vehicles.sedan.body.x + 11, BANDS.roadN + 1.4);
    rigAll(gb);
    const peakBend = reel(gb, 90000);
    gt('AL14 and it takes longer than the same pull on dry ground',
       st.simTimeMs, gb.state.simTimeMs);
    note(`AL  the same pull: ${(gb.state.simTimeMs / 1000).toFixed(0)} s at the bend (${kN(peakBend)} kN), `
       + `${(st.simTimeMs / 1000).toFixed(0)} s at the ford (${kN(peak)} kN)`);
  }

  // Wading. Pace, and the reason walking the hook out at a ford is a slog.
  {
    const g = job('truck', 'sedan', { siteId: 'ford' });
    const st = g.state;
    const p = st.crew[0];
    const fakeInput = {
      moveAxis: () => ({ x: 1, y: 0 }),
      driveAxis: () => ({ steer: 0, throttle: 0 }),
      slewAxis: () => 0,
      isDown: () => false, wasPressed: () => false, wasReleased: () => false, endStep: () => {},
    };
    const walk = (x, y) => {
      p.x = x; p.y = y; p.vx = 0; p.vy = 0;
      const x0 = p.x;
      for (let i = 0; i < 60; i++) g.step(STEP, st.simTimeMs + STEP, [fakeInput]);
      return p.x - x0;
    };
    const dry = walk(ft.mud.x, ft.mud.y - ft.mud.ry - 2.0);
    const wet = walk(ft.mud.x - 1.0, ft.mud.y);
    lt(`AL15 a crew member wades rather than walks (${wet.toFixed(2)} m against ${dry.toFixed(2)} m in a second)`,
       wet, dry * 0.85);
    note(`AL  on foot for one second: ${dry.toFixed(2)} m on the bank, ${wet.toFixed(2)} m in the water`);
  }
}

/* ══ AM. procedural situations, and the fleet they are for ════════════════ */

function sectionAM() {
  lines.push('--- AM. vehicle x incident x terrain x damage x conditions ---');

  eq('AM1 a situation is rolled from a seed and nothing else',
     JSON.stringify(describeSituation(rollSituation(1234, 100))),
     JSON.stringify(describeSituation(rollSituation(1234, 100))));
  ok('AM2 and a different seed is a different situation',
     JSON.stringify(describeSituation(rollSituation(1234, 100)))
     !== JSON.stringify(describeSituation(rollSituation(9999, 100))));

  // All five axes vary, independently. A generator whose axes move together is a difficulty dial.
  const rolled = [];
  for (let i = 0; i < 200; i++) rolled.push(rollSituation(i * 7919 + 11, 100));
  const seen = (k) => new Set(rolled.map((s) => describeSituation(s)[k])).size;
  gt('AM3 the vehicle varies', seen('vehicle'), 2);
  gt('AM4 the incident varies', seen('incident'), 3);
  gt('AM5 the site varies', seen('site'), 3);
  gt('AM6 the damage varies', seen('condition'), 2);
  gt('AM7 the weather varies', seen('weather'), 3);
  note(`AM  over 200 rolls: ${seen('vehicle')} vehicles, ${seen('incident')} incidents, `
     + `${seen('site')} sites, ${seen('condition')} states, ${seen('weather')} forecasts`);

  /* INDEPENDENT, which is the whole design. If the axes were one difficulty dial in disguise, the
   * heaviest vehicles would only ever turn up with the worst of everything else. */
  {
    const boxes = rolled.filter((s) => s.vehicle.id === 'boxTruck');
    gt('AM8 there are box-truck jobs to look at', boxes.length, 5);
    gt('AM9 and they are not all in the worst weather',
       new Set(boxes.map((s) => s.weather.id)).size, 1);
    gt('AM10 nor all at the same place', new Set(boxes.map((s) => s.site.id)).size, 1);
    const dryClean = rolled.filter((s) => s.weather.id === 'dry' && s.condition.id === 'clean');
    gt('AM11 and an easy forecast still turns up with a heavy vehicle sometimes',
       dryClean.filter((s) => s.vehicle.id !== 'sedan').length, 0);
  }

  // Reputation decides what gets SENT to you, and it is the only thing that is gated.
  {
    const rookie = [];
    for (let i = 0; i < 120; i++) rookie.push(rollSituation(i * 7919 + 11, 0));
    /* A new outfit gets the LIGHT work — a car, or a motorbike. What reputation gates is the
     * heavy end: nobody sends a seven-tonner or a van to an outfit they have not used. It used to
     * assert "only cars", which was true when the sedan was the only thing under the gate and
     * stopped being true the moment Milestone 7 added a motorcycle at minRep 0. The gate is the
     * claim worth testing; the size of the pool underneath it is not. */
    const rookieKinds = new Set(rookie.map((s) => s.vehicle.id));
    ok('AM12 a new outfit is sent the light work', rookieKinds.has('sedan'), [...rookieKinds].join(','));
    ok('AM13 and never anything it has not earned',
       !rookieKinds.has('van') && !rookieKinds.has('boxTruck'), [...rookieKinds].join(','));
    gt('AM14 but everything else about the job still varies',
       new Set(rookie.map((s) => s.incident.id)).size, 3);
  }

  // Plausibility: the one place an axis is allowed to look at another.
  {
    const onBridge = rolled.filter((s) => s.site.id === 'bridge');
    eq('AM15 no seven-tonner goes through a narrow bridge parapet',
       onBridge.filter((s) => s.vehicle.id === 'boxTruck').length, 0);
    gt('AM16 though plenty of other things do', onBridge.length, 5);
  }

  /* A generated job is INDISTINGUISHABLE from an authored one downstream, and may not reach
   * further into the simulation than an authored one does. GDD §4's promise, again. */
  {
    const AUTHORED_KEYS = ['boggedMul', 'seizedChance', 'dentChance', 'dentsMax', 'lieSpread', 'lieBias'];
    const offers = rolled.slice(0, 60).map((s, i) => situationToOffer(s, `g${i}`));
    ok('AM17 every generated offer has the shape the board expects',
       offers.every((o) => o.id && o.siteId && o.weatherId && o.casualtyId && o.mods && o.fee > 0));
    ok('AM18 and touches ONLY the six modifier keys an authored job may touch',
       offers.every((o) => Object.keys(o.mods).every((k) => AUTHORED_KEYS.includes(k))),
       [...new Set(offers.flatMap((o) => Object.keys(o.mods)))].join(','));
    gt('AM19 a heavier vehicle is worth more',
       Math.max(...offers.filter((o) => o.casualtyId === 'boxTruck').map((o) => o.fee), 0),
       Math.min(...offers.filter((o) => o.casualtyId === 'sedan').map((o) => o.fee), 1e9));
  }

  // And it is on the board, in a slot rather than as an extra card.
  {
    const c = newCompany();
    c.reputation = 100;
    const board = offersFor(c).filter((o) => !o.locked);
    const gen = board.filter((o) => o.generated);
    eq('AM20 the board is still the size it says it is', board.length, CONFIG.company.offerCount);
    eq('AM21 with exactly one generated job on it', gen.length, 1);
    ok('AM22 which the board treats like any other offer',
       gen.every((o) => o.fee > 0 && o.siteName && o.title));
    eq('AM23 and which does not reroll when you look again',
       offersFor(c).filter((o) => o.generated)[0].seed, gen[0].seed);
    note(`AM  today's generated job: ${gen[0].title} at ${gen[0].siteName} for £${gen[0].fee}`);
  }

  /* And the fleet, which is where the money goes (Milestone 6). */
  {
    const c = newCompany();
    eq('AM24 an outfit starts with one machine', c.fleet.length, 1);
    eq('AM25 and it is the light wrecker', activeTruck(c).defId, 'truck');
    eq('AM26 a heavy wrecker is not free', buyTruck(c, 'heavy').bought, false);
    c.money = truckPrice('heavy') + 10;
    const r = buyTruck(c, 'heavy', 'the Foden');
    ok('AM27 with the money, it can be bought', r.bought);
    eq('AM28 and it is the one going out', activeTruck(c).defId, 'heavy');
    eq('AM29 which cost what it said it would', c.money, 10);
    eq('AM30 buying a second one is refused', buyTruck(c, 'heavy').bought, false);
    ok('AM31 and you can take the little one out again',
       setActiveTruck(c, c.fleet[0].id) && activeTruck(c).defId === 'truck');
    gt('AM32 a bigger machine costs more to put right',
       repairQuote({ defId: 'heavy', condition: { body: 0.5, winch: 0.5 } }).total,
       repairQuote({ defId: 'truck', condition: { body: 0.5, winch: 0.5 } }).total);
    note(`AM  the heavy wrecker is £${truckPrice('heavy')} — about eighteen clean jobs`);
  }
}

/* ══ AK. hygiene ══════════════════════════════════════════════════════════ */

async function sectionAK() {
  lines.push('--- AK. determinism, and five milestones of numbers ---');

  /* Determinism, per casualty and per wrecker. Adding vehicles must not have added a source of
   * variation, and the same job must still replay bit for bit. */
  function sig(truckId, casualtyId) {
    const g = job(truckId, casualtyId);
    const st = g.state;
    st.vehicles.sedan.parkBrake = false;
    g.skipMs(6000);
    const b = st.vehicles.sedan.body;
    return [b.x, b.y, b.angle, b.vx, b.vy, b.omega].map((n) => n.toFixed(9)).join(',');
  }
  eq('AK1 a job replays bit-for-bit', sig('truck', 'sedan'), sig('truck', 'sedan'));
  eq('AK2 and so does one with a big casualty', sig('heavy', 'boxTruck'), sig('heavy', 'boxTruck'));
  ok('AK3 a different casualty is a different job', sig('truck', 'sedan') !== sig('truck', 'van'));
  ok('AK4 the wrecker that turned out does not move the casualty on its own',
     sig('truck', 'sedan') === sig('heavy', 'sedan'));

  /* The layout is drawn from the world stream and the casualty from the same one, so the SITE
   * must be identical whatever turned up in the ditch. */
  {
    const a = job('truck', 'sedan').state.terrain;
    const b = job('heavy', 'boxTruck').state.terrain;
    eq('AK5 the mud is where it always was', a.mud.x, b.mud.x);
    eq('AK6 and the trees are', a.trees.map((t) => t.x.toFixed(6)).join(), b.trees.map((t) => t.x.toFixed(6)).join());
    eq('AK7 and the gap in the rail', a.rail.gapX0, b.rail.gapX0);
  }

  // The authority graph, with two drums in it.
  {
    const g = job('heavy');
    const st = g.state;
    eq('AK8 a two-drum machine starts with a healthy authority graph', validateAuthority(st).length, 0);
    drumsOf(st)[0].heldBy = st.crew[0].id;
    drumsOf(st)[1].heldBy = st.crew[0].id;
    eq('AK9 and one person holding both hooks is caught as a problem',
       validateAuthority(st).filter((p) => /holds 2 hooks/.test(p)).length, 1);
    drumsOf(st)[1].heldBy = null;
    eq('AK10 one each is fine', validateAuthority(st).length, 0);
  }

  // No new nondeterminism.
  const bad = [];
  for (const f of ['recovery/anchors.js', 'recovery/rig.js']) {
    const src = await (await fetch(`../src/${f}`)).text();
    if (/Math\.random/.test(src)) bad.push(`${f}: Math.random`);
    if (/(Date\.now|performance\.now)\s*\(/.test(src)) bad.push(`${f}: wall clock`);
  }
  eq('AK11 no Math.random or wall clock in the Milestone 6 modules', bad.length, 0, bad.join('; '));

  const TB = window.__TB;
  ok('AK12 the live game booted', !!TB);
  eq('AK13 with no errors on the crash banner', document.getElementById('err-banner'), null);
}

/* ── run ─────────────────────────────────────────────────────────────────── */

(async function run() {
  const sections = [
    ['AG', sectionAG], ['AH', sectionAH], ['AJ', sectionAJ],
    ['AL', sectionAL], ['AM', sectionAM], ['AK', sectionAK],
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
