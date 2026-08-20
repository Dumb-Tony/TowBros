/* TOW BROS — Milestone 5 suite: regional operations.
 *
 *   .\tools\smoketest.ps1 -Tests tools\m5-tests.js -Quiet
 *
 * GDD §7 Milestone 5: "connect job scenes with a regional map or compact open county, dynamic
 * dispatch, traffic/work zones, weather modifiers, and rival-job persistence."
 *
 * The question here is whether the county is four PLACES or one place with four names, and whether
 * a live carriageway is a system or scenery. So:
 *
 *   AC the county: four sites that take away different things
 *   AD weather: one grip number and one light level, both arriving where they should
 *   AE traffic and the work zone: does the road use itself, and do the cones do anything
 *   AF the day: dynamic dispatch, rivals, and the Milestone 1-4 numbers that must not have moved
 */

import { CONFIG } from '../src/config.js';
import { EVENTS } from '../src/core/eventBus.js';
import { Game } from '../src/game.js';
import {
  SITES, siteById, BANDS, ROAD, WORLD, baseHeightAt, SURFACES,
} from '../src/data/terrain.js';
import { WEATHER, weatherById, rollWeather } from '../src/world/weather.js';
import { laneY, workZone, describeTraffic, EAST, WEST } from '../src/world/traffic.js';
import { gripBudgetN } from '../src/sim/tires.js';
import { newCompany, activeTruck, conditionEffects, loadOutFor } from '../src/meta/company.js';
import {
  offersFor, acceptOffer, useSlot, endDay, RIVALS, SLOTS_PER_DAY, JOB_TYPES,
} from '../src/meta/dispatch.js';
import { STARTER_PILE } from '../src/data/equipment.js';
import { mulberry32 } from '../src/core/rng.js';
import { findZone } from '../src/data/vehicles.js';
import { attachHook } from '../src/recovery/attach.js';
import { WINCH, cablePath, pathLength } from '../src/recovery/cable.js';
import { LIFT, axleMid, liftTarget, extendLift, engageLift } from '../src/recovery/lift.js';

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
const kmh = (mps) => Math.round(mps * 3.6);

/** Rig the winch to the sedan's tow eye, the way m1/m3 do — walked out, hooked on, zero stretch. */
function rigTo(g) {
  const st = g.state;
  const zone = findZone(st.vehicles.sedan.def, 'towHook');
  const at = st.vehicles.sedan.body.toWorld(zone.local.x, zone.local.y);
  st.winch.hook.x = at.x; st.winch.hook.y = at.y;
  st.winch.state = WINCH.ATTACHED; st.winch.targetId = 'sedan'; st.winch.zoneId = 'towHook';
  const len = pathLength(cablePath(st.winch, st.vehicles.truck, st.vehicles, st.blocksById));
  st.winch.state = WINCH.LOOSE;
  attachHook(st, st.vehicles.sedan, zone, g.bus, st.simTimeMs);
  st.winch.lineM = len;
}

/** A game at one site, in one forecast, with everything else at its default. */
function jobAt(siteId, weatherId = 'dry', extra = {}) {
  const g = new Game({ seed: 4242, seedLabel: siteId });
  g.job = { siteId, weatherId, mods: {}, loadout: null, effects: null, ...extra };
  g.startJob({ reroll: false, attempt: 1 });
  return g;
}

/* ── AC. the county ──────────────────────────────────────────────────────── */

function sectionAC() {
  lines.push('--- AC. the county: four places, each taking away something different ---');

  gt('AC1 there is more than one place a car can end up', SITES.length, 3);
  eq('AC2 and the first of them is the Milestone 1 site', SITES[0].id, 'bend');
  ok('AC3 every site has a name a person would use',
     SITES.every((s) => /^[a-z]/.test(s.name) && s.name.length > 8));
  eq('AC4 an unknown site id falls back rather than throwing', siteById('nowhere').id, 'bend');
  eq('AC5 and so does no id at all', siteById(undefined).id, 'bend');

  /* THE BEND IS UNTOUCHED. Four suites of assertions measure it, so it has to be the same site to
   * the last decimal — which is why the profile takes a MULTIPLIER that defaults to 1 rather than
   * being rewritten per site. */
  const mid = (BANDS.shoulderS + BANDS.embankmentS) / 2;
  eq('AC6 the default profile is the Milestone 1 profile exactly',
     baseHeightAt(46, mid), baseHeightAt(46, mid, 1));
  near('AC7 which is the number the m1 suite measures', baseHeightAt(46, mid), -0.42 - 4.15 * 0.5, 1e-12);

  const built = SITES.map((s) => {
    const g = jobAt(s.id);
    const t = g.state.terrain;
    return {
      id: s.id,
      trees: t.trees.length,
      boulders: t.boulders.length,
      hazard: t.mud.kind,
      bottom: t.surfaceAt(t.mud.x, t.mud.y).id,
      dropM: t.heightAt(46, 2) - t.heightAt(46, 34),
      gapM: t.rail.gapX1 - t.rail.gapX0,
      downslopeN: Math.abs(t.slopeAt(46, mid).mag),
    };
  });
  for (const b of built) {
    note(`AC  ${b.id}: ${b.trees} trees, ${b.boulders} rocks, ${b.hazard || 'no hazard'}, `
       + `${b.dropM.toFixed(2)} m drop, ${b.gapM.toFixed(1)} m gap`);
  }

  const by = (id) => built.find((b) => b.id === id);
  eq('AC8 the bend is wooded', by('bend').trees, 5);
  eq('AC9 the ford has ONE tree, so there is exactly one place to hang a block', by('ford').trees, 1);
  eq('AC10 the quarry has none at all — no side pull exists there', by('quarry').trees, 0);
  gt('AC11 and it has rock instead', by('quarry').boulders, 3);
  eq('AC12 the bridge has a couple of each', by('bridge').trees, 2);

  eq('AC13 the bend has mud at the bottom', by('bend').bottom, 'mud');
  eq('AC14 the ford has standing water', by('ford').bottom, 'water');
  eq('AC15 the quarry has loose rock', by('quarry').bottom, 'scree');
  eq('AC16 and the bridge has nothing but grass', by('bridge').bottom, 'wetGrass');

  lt('AC17 the ford is the shallowest', by('ford').dropM, by('bend').dropM);
  gt('AC18 the quarry the steepest', by('quarry').dropM, by('bend').dropM);
  gt('AC19 which means a bigger downslope pull to fight', by('quarry').downslopeN, by('bend').downslopeN);
  gt('AC20 the ford has the widest way back through the rail', by('ford').gapM, by('bend').gapM);
  lt('AC21 and the bridge the narrowest', by('bridge').gapM, by('bend').gapM);

  /* The surfaces are DIFFERENT PROBLEMS, not a worse one and a better one. Water grips better than
   * mud and drags far more; rock grips well and drags like gravel. */
  gt('AC22 water grips better than mud', SURFACES.water.mu, SURFACES.mud.mu);
  gt('AC23 and drags more', SURFACES.water.crr, SURFACES.mud.crr);
  gt('AC24 rock grips better than either', SURFACES.scree.mu, SURFACES.water.mu);
  lt('AC25 and drags less', SURFACES.scree.crr, SURFACES.water.crr);

  // Boulders are solid, and are NOT anchors.
  const q = jobAt('quarry');
  const rocks = q.state.scenery.filter((s) => s.kind === 'rock');
  eq('AC26 boulders are in the collision set', rocks.length, q.state.terrain.boulders.length);
  eq('AC27 but not in the tree list, so no block can be mounted on one',
     q.state.terrain.trees.length, 0);
  ok('AC28 and none of them is on the pavement',
     q.state.terrain.boulders.every((b) => b.y > BANDS.roadS));

  // Every site is still reproducible from its seed, and still a different layout per seed.
  const a1 = jobAt('quarry').state.terrain;
  const a2 = jobAt('quarry').state.terrain;
  eq('AC29 the same seed and site lay out identically',
     `${a1.mud.x},${a1.boulders.map((b) => b.x).join()}`,
     `${a2.mud.x},${a2.boulders.map((b) => b.x).join()}`);
}

/* ── AD. weather ─────────────────────────────────────────────────────────── */

async function sectionAD() {
  lines.push('--- AD. weather: one grip number and one light level ---');

  eq('AD1 a dry day changes nothing at all', WEATHER.dry.gripMul, 1);
  eq('AD2 nor its light', WEATHER.dry.light, 1);
  eq('AD3 nor what it pays', WEATHER.dry.feeMul, 1);
  eq('AD4 an unknown forecast falls back to dry', weatherById('snow').id, 'dry');

  for (const id of Object.keys(WEATHER)) {
    const w = WEATHER[id];
    ok(`AD5 ${id} keeps its grip inside a believable range`, w.gripMul > 0.6 && w.gripMul <= 1);
    ok(`AD6 ${id} pays at least the dry rate`, w.feeMul >= 1);
  }
  lt('AD7 rain is the one that costs grip', WEATHER.wet.gripMul, WEATHER.damp.gripMul);
  lt('AD8 and night is the one that costs light', WEATHER.night.light, WEATHER.wet.light);
  gt('AD9 while barely touching the grip, because darkness is not slippery',
     WEATHER.night.gripMul, WEATHER.wet.gripMul);
  gt('AD10 the worse the conditions the better it pays', WEATHER.night.feeMul, WEATHER.damp.feeMul);

  /* IT REACHES THE TIRE MODEL. That is the whole assertion — everything else is a table. */
  const dry = jobAt('bend', 'dry');
  const wet = jobAt('bend', 'wet');
  const gDry = gripBudgetN(dry.state.vehicles.truck, dry.state.terrain);
  const gWet = gripBudgetN(wet.state.vehicles.truck, wet.state.terrain);
  lt('AD11 a wet road grips less', gWet, gDry);
  near('AD12 by exactly the forecast\'s number', gWet / gDry, WEATHER.wet.gripMul, 1e-9);
  note(`AD  truck grip ${(gDry / 1000).toFixed(1)} kN dry -> ${(gWet / 1000).toFixed(1)} kN wet`);

  eq('AD13 the terrain carries the forecast for the renderer too', wet.state.terrain.weather.id, 'wet');
  eq('AD14 and a job with no forecast is a dry one', jobAt('bend').state.terrain.gripMul, 1);

  /* And it MOVES the recovery. A wet job is the same job with less grip everywhere, which is a
   * different job — measured as how far the same pull gets in the same time. */
  async function pull(weatherId) {
    const g = jobAt('bend', weatherId, { traffic: false });
    const st = g.state;
    st.vehicles.truck.body.x = st.vehicles.sedan.body.x + 11;
    st.vehicles.truck.body.y = BANDS.roadN + 1.4;
    st.vehicles.truck.body.angle = 0;
    st.vehicles.truck.body.vx = 0; st.vehicles.truck.body.vy = 0; st.vehicles.truck.body.omega = 0;
    st.vehicles.truck.parkBrake = true;
    await rigTo(g);
    let done = false, secs = 0;
    for (let t = 0; t < 90000 && !st.goal.complete; t += 250) {
      st.winch.motor = 1;
      g.skipMs(250);
      secs = st.simTimeMs / 1000;
    }
    return { done: st.goal.complete, secs, truckMoved: Math.abs(st.vehicles.truck.body.x - (st.vehicles.sedan.body.x + 11)) };
  }
  const pDry = await pull('dry');
  const pWet = await pull('wet');
  ok('AD15 the far-lane recovery still works in the dry', pDry.done, `${pDry.secs.toFixed(1)} s`);
  note(`AD  the same pull: dry ${pDry.secs.toFixed(1)} s (truck moved ${pDry.truckMoved.toFixed(2)} m) · `
     + `wet ${pWet.secs.toFixed(1)} s (${pWet.truckMoved.toFixed(2)} m)`);
  gt('AD16 and in the wet the truck is the one that gives ground',
     pWet.truckMoved, pDry.truckMoved + 0.05);

  // Seeded, so a board's forecast is stable.
  const r1 = mulberry32(99), r2 = mulberry32(99);
  eq('AD17 rolling a forecast is seeded', rollWeather(r1).id, rollWeather(r2).id);
  const many = [];
  const r3 = mulberry32(7);
  for (let i = 0; i < 300; i++) many.push(rollWeather(r3).id);
  ok('AD18 most days are dry, because bad weather is only interesting if it is not the default',
     many.filter((x) => x === 'dry').length > many.length * 0.3);
  ok('AD19 and every forecast turns up eventually',
     new Set(many).size === Object.keys(WEATHER).length, [...new Set(many)].join(','));
}

/* ── AE. traffic and the work zone ───────────────────────────────────────── */

function sectionAE() {
  lines.push('--- AE. a live carriageway, and the cones that keep it off you ---');

  const g = jobAt('bend');
  const st = g.state;
  ok('AE1 a job has traffic on it', !!st.traffic);
  eq('AE2 with nothing on the road to start with', st.traffic.cars.length, 0);
  eq('AE3 and a job can turn it off, for the tests that do not care',
     jobAt('bend', 'dry', { traffic: false }).state.traffic, null);

  const eLane = laneY(st.terrain, EAST), wLane = laneY(st.terrain, WEST);
  ok('AE4 eastbound and westbound are different lanes', Math.abs(eLane - wLane) > 3);
  ok('AE5 both of them on the pavement',
     eLane > ROAD.y0 && eLane < ROAD.y1 && wLane > ROAD.y0 && wLane < ROAD.y1);

  eq('AE6 cones are in the pile now', STARTER_PILE.filter((k) => k === 'cone').length, 3);
  eq('AE7 with nothing out, there is no work zone', workZone(st).cones, 0);

  /* THE MEASUREMENT THIS SECTION EXISTS FOR: does putting cones out slow the traffic down?
   *
   * The road has to be CLEAR for this to mean anything. A truck parked across a lane, or a crew
   * member standing on the pavement — which is where they start — stops every car that arrives,
   * and then the number being measured is the queue rather than the cones. */
  function run(weatherId, cones, { clearRoad = true, seconds = 150 } = {}) {
    const gg = jobAt('bend', weatherId);
    const s = gg.state;
    const tb = s.vehicles.truck.body;
    if (clearRoad) {
      tb.y = BANDS.shoulderS + 0.5; tb.angle = 0;
      tb.vx = 0; tb.vy = 0; tb.omega = 0;
      s.vehicles.truck.parkBrake = true;
      for (const p of s.crew) { p.y = BANDS.shoulderS + 1.0; p.vx = 0; p.vy = 0; }
    }
    const zoneX = tb.x;
    s.gear.filter((q) => q.kind === 'cone').slice(0, cones).forEach((c, i) => {
      c.placed = true; c.carriedBy = null;
      c.x = zoneX - 12 + i * 4; c.y = BANDS.shoulderS - 0.5;
    });
    // The worst single arrival, which is what "did they see you in time" actually measures.
    let worstHit = 0;
    gg.bus.on(EVENTS.TRAFFIC_HIT, (e) => { worstHit = Math.max(worstHit, e.impulseNs); });

    const speeds = [];
    for (let i = 0; i < 60 * seconds; i++) {
      gg.step(STEP, s.simTimeMs + STEP, null);
      for (const car of s.traffic.cars) {
        if (Math.abs(car.body.x - zoneX) < 8) speeds.push(Math.abs(car.body.vx));
      }
    }
    const d = describeTraffic(s.traffic);
    return {
      ...d,
      avgPast: speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0,
      dents: s.vehicles.truck.damage.dents,
      hitEvents: gg.bus.count(EVENTS.TRAFFIC_HIT),
      worstNs: s.vehicles.truck.damage.worstImpactNs || 0,
      worstHitNs: worstHit,
    };
  }

  const clear0 = run('dry', 0);
  const clear1 = run('dry', 1);
  const clear3 = run('dry', 3);
  gt('AE8 traffic actually uses the road', clear0.passed, 5);
  eq('AE9 and a clear road costs nobody anything', clear0.hits, 0);
  inRange(`AE10 at something like a rural road speed (${kmh(clear0.avgPast)} km/h)`,
          kmh(clear0.avgPast), 55, 95);
  lt('AE11 ONE cone slows it', clear1.avgPast, clear0.avgPast - 1);
  lt('AE12 and three slow it a lot more', clear3.avgPast, clear1.avgPast - 1);
  gt('AE13 without stopping the road working', clear3.passed, 5);
  note(`AE  past the zone: ${kmh(clear0.avgPast)} km/h bare, ${kmh(clear1.avgPast)} with one cone, `
     + `${kmh(clear3.avgPast)} with three (${clear3.passed} cars)`);

  /* AND THE CONSEQUENCE OF NOT CLEARING THE ROAD. Leave the wrecker across the carriageway and
   * traffic will be scraping past it all afternoon — which is a cost, in money, via the damage. */
  const blocked = run('dry', 0, { clearRoad: false });
  gt('AE14 a truck left across the road gets hit', blocked.hits, 3);
  gt('AE15 which the job log reports as its own kind of event', blocked.hitEvents, 3);
  /* Not "it dents the truck" — measured, a car edging past at 2.2 m/s delivers 3 080 N·s, which is
   * just under the 3 200 N·s dent threshold. What IS true is that it is being hit, repeatedly and
   * hard enough to register, and that is the thing with a cost attached. */
  gt('AE16 hard enough to register on the truck', blocked.worstNs, CONFIG.damage.impactMinNs);
  lt('AE17 while barely anybody gets past', blocked.passed, clear0.passed);
  gt('AE18 but the road does not seize up completely, because drivers edge round', blocked.passed, 0);
  note(`AE  road blocked: ${blocked.hits} hits, ${blocked.dents} dents, only ${blocked.passed} past`);

  /* Night is worse for exactly the reason it should be: a driver who cannot see you commits later.
   * It is the ONLY place the light level touches a decision rather than a picture. */
  const nightBlocked = run('night', 0, { clearRoad: false });
  /* What the dark costs is SEVERITY, not frequency. Counting contacts measures the opposite: in
   * daylight drivers see the obstruction, stop, and queue against it, and a queue grinding on a
   * truck generates far more contact events than a road nobody is stopping on. What night changes
   * is how fast the one that does not stop is going when it arrives. */
  gt('AE19 in the dark, the ones that do not stop arrive harder',
     nightBlocked.worstHitNs, blocked.worstHitNs);
  note(`AE  worst single hit: ${Math.round(blocked.worstHitNs)} N·s in daylight, `
     + `${Math.round(nightBlocked.worstHitNs)} N·s after dark`);
  note(`AE  and after dark: ${nightBlocked.hits} hits against ${blocked.hits} in daylight`);

  /* ── AND WHAT TRAFFIC MUST NOT COST ────────────────────────────────────────
   *
   * Sections Hh/Hk of the Milestone 1 suite and section V of the Milestone 3 suite measure the
   * pull and the lift on an empty road, deliberately, because a car arriving mid-pull moves a
   * kilonewton figure by a third and says nothing about the winch. The price of that decision is
   * that the claims have to be re-made HERE, in the world the player actually gets. */

  /* The wrecker weighs 6.8 t, a hatchback weighs 1.4 t, and a car in the way is an obstruction
   * rather than a wall.
   *
   * This is the regression test for a sign. `stepTraffic` drives a car along x itself and reads its
   * own speed back as `Math.abs(b.vx)`, which meant a car shoved BACKWARDS read as one doing the
   * same speed forwards, and `Math.max(0, next)` then threw the shove away — so along the road axis
   * a hatchback was immovable. MEASURED: the truck at full throttle, nose against a stopped car,
   * moved 0.24 m in two seconds, then got free only when the car's own creep logic took it round. */
  {
    const gg = jobAt('bend', 'dry');
    const s = gg.state;
    const truck = s.vehicles.truck;
    const lane = laneY(s.terrain, EAST);
    /* Wait for the road to produce an EASTBOUND car of its own rather than fabricating one — and
     * eastbound specifically, because the first version took whichever car turned up and got a
     * westbound one, so what it actually measured was a head-on and the car "moved" 32 m backwards
     * on its own business. */
    const eastbound = () => s.traffic.cars.find((c) => c.dir === EAST && c.body.x > 20);
    for (let i = 0; i < 60 * 120 && !eastbound(); i++) gg.step(STEP, s.simTimeMs + STEP, null);
    const car = eastbound();
    ok('AE20 the road produces a car going the same way as you', !!car);
    if (car) {
      truck.body.angle = 0; truck.body.y = lane;
      truck.body.vx = 0; truck.body.vy = 0; truck.body.omega = 0;
      truck.body.x = car.body.x - 7;        // nose 7 m behind it, same lane, facing east
      truck.parkBrake = false; truck.occupiedBy = 'crew0';
      const x0 = truck.body.x, c0 = car.body.x;
      for (let i = 0; i < 180; i++) {
        truck.throttle = 1;
        /* Held stopped on purpose, and re-held every step: this measures mass against a driver with
         * their foot flat on the brake, which is the hardest version of the question. */
        car.wantMps = 0; car.creepUntilX = null; car.stuckMs = 0;
        gg.step(STEP, s.simTimeMs + STEP, null);
      }
      const moved = truck.body.x - x0, shoved = car.body.x - c0;
      gt(`AE21 and shoves one along rather than parking behind it (${moved.toFixed(2)} m in 3 s)`,
         moved, 2);
      gt(`AE22 which is the car being moved, not squeezed past (${shoved.toFixed(2)} m)`, shoved, 0.5);
      note(`AE  nose to tail at full throttle: the truck made ${moved.toFixed(2)} m in three seconds `
         + `and pushed the car ${shoved.toFixed(2)} m up the road`);
    }
  }

  /* The Milestone 1 headline recovery, on the road as shipped. The pull is the same pull; what is
   * different is that there are cars going past while it happens. */
  {
    const rows = [];
    let kept = 0, total = 0, farDone = 0, farTotal = 0;
    for (const [label, ty] of [['far', BANDS.roadN + 1.4], ['centre', ROAD.centreY], ['near', BANDS.roadS - 1.4]]) {
      for (const dx of [8, 10, 12]) {
        const gg = new Game({ seed: 2001, seedLabel: 'test' });
        gg.startJob();
        const s = gg.state;
        const sd = s.vehicles.sedan.body, b = s.vehicles.truck.body;
        b.x = sd.x + dx; b.y = ty; b.angle = 0; b.vx = 0; b.vy = 0; b.omega = 0;
        s.vehicles.truck.parkBrake = true;
        rigTo(gg);
        let snaps = 0;
        gg.bus.on(EVENTS.CABLE_SNAPPED, () => { snaps++; });
        s.winch.motor = 1;
        for (let t = 0; t < 90000 && !s.goal.complete; t += 250) gg.skipMs(250);
        total++;
        if (!snaps) kept++;
        if (label === 'far') { farTotal++; if (s.goal.complete) farDone++; }
        if (label === 'far' && dx === 10) {
          rows.push(`far dx10 took ${(s.simTimeMs / 1000).toFixed(0)} s with ${describeTraffic(s.traffic).passed} cars past`);
        }
      }
    }
    eq(`AE23 the far-lane recovery still works with traffic on it (${farDone}/${farTotal})`, farDone, farTotal);
    eq(`AE24 and no park across the whole road costs you the cable (${kept}/${total})`, kept, total);
    for (const r of rows) note(`AE  ${r}`);
  }

  /* And the Milestone 3 delivery. This is the one place the two milestones genuinely disagree, and
   * the disagreement is the point: the lane you choose to tow in is now a decision. */
  {
    const runs = {};
    for (const [label, ty] of [['lane', null], ['middle', ROAD.centreY]]) {
      const gg = jobAt('bend', 'dry');
      const s = gg.state;
      const sedan = s.vehicles.sedan, truck = s.vehicles.truck;
      const y = ty === null ? laneY(s.terrain, EAST) : ty;
      sedan.body.x = 60; sedan.body.y = y; sedan.body.angle = 0;
      sedan.body.vx = 0; sedan.body.vy = 0; sedan.body.omega = 0;
      sedan.parkBrake = false; sedan.boggedN = 0; sedan.boggedFactor = 0;
      truck.body.angle = 0; truck.body.y = y;
      const a = axleMid(sedan, 'front');
      truck.body.x = a.x + truck.def.lengthM / 2 + CONFIG.lift.reachM + CONFIG.lift.yokeOffsetM;
      truck.body.vx = 0; truck.body.vy = 0; truck.body.omega = 0;
      truck.parkBrake = true;
      gg.skipMs(100);
      extendLift(s, gg.bus, s.simTimeMs);
      if (liftTarget(s)) engageLift(s, gg.bus, s.simTimeMs);
      truck.parkBrake = false; truck.occupiedBy = 'crew0';
      const x0 = truck.body.x;
      let dropped = null, worst = 0;
      gg.bus.on(EVENTS.TRAFFIC_HIT, (e) => { worst = Math.max(worst, e.impulseNs); });
      for (let i = 0; i < 3000; i++) {
          truck.throttle = 1;
        gg.step(STEP, s.simTimeMs + STEP, null);
        if (truck.lift.state !== LIFT.CARRYING) { dropped = i; break; }
        if (truck.body.x > 150) break;
      }
      runs[label] = { travelled: truck.body.x - x0, dropped, worst };
    }
    eq('AE25 a load towed in its own lane comes home', runs.lane.dropped, null);
    gt('AE26 all the way', runs.lane.travelled, 60);
    ok('AE27 towed down the centre line instead, a head-on takes it off the yoke',
       runs.middle.dropped !== null, String(runs.middle.dropped));
    lt('AE28 and it never gets near the yard', runs.middle.travelled, 60);
    note(`AE  towing home: own lane ${runs.lane.travelled.toFixed(0)} m and still on; `
       + `centre line ${runs.middle.travelled.toFixed(0)} m, hit at `
       + `${Math.round(runs.middle.worst)} N·s, load off`);
  }
}

/* ── AF. the day, the rivals, and everything that must not have moved ─────── */

async function sectionAF() {
  lines.push('--- AF. dynamic dispatch, rivals, and four suites of prior numbers ---');

  const c = newCompany();
  eq('AF1 an outfit starts on day one', c.day, 1);
  eq('AF2 with a day\'s work in front of it', c.slotsLeft, SLOTS_PER_DAY);
  eq('AF3 and nothing taken yet', c.takenToday.length, 0);
  eq('AF4 nor anything lost to a rival', c.rivalTook.length, 0);

  const board = offersFor(c).filter((o) => !o.locked);
  eq('AF5 the board offers a day\'s choice', board.length, CONFIG.company.offerCount);
  ok('AF6 every job says where it is', board.every((o) => o.siteId && o.siteName));
  ok('AF7 and what the weather is doing', board.every((o) => o.weatherId));
  ok('AF8 across more than one place',
     new Set(offersFor({ ...c, dispatchCursor: 3 }).filter((o) => !o.locked).map((o) => o.siteId)).size >= 1);

  /* The fee has to reflect BOTH — a wet night at the quarry pays more for exactly the reason it is
   * worth more, and the player can see that before deciding. */
  const wetOne = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => offersFor({ ...c, dispatchCursor: n }))
    .flat().find((o) => !o.locked && o.weatherId !== 'dry');
  ok('AF9 a job in bad weather turns up on the board', !!wetOne);
  if (wetOne) {
    const type = JOB_TYPES.find((t) => t.id === wetOne.type);
    near('AF10 and pays the job rate times the weather rate',
         wetOne.fee, Math.round(CONFIG.job.baseFee * type.feeMul * weatherById(wetOne.weatherId).feeMul), 1);
  }

  /* THE DAY. The board belongs to it, not to each acceptance — that was a bug: the rivals at day
   * end were awarded jobs the player had never been shown. */
  const taken = board[0];
  acceptOffer(c, taken);
  eq('AF11 a taken job comes off the board', offersFor(c).some((o) => o.id === taken.id), false);
  eq('AF12 and the rest are still there for the second slot',
     offersFor(c).filter((o) => !o.locked).length, CONFIG.company.offerCount - 1);
  useSlot(c, taken);
  eq('AF13 which cost a slot', c.slotsLeft, SLOTS_PER_DAY - 1);
  eq('AF14 without ending the day', c.day, 1);

  const second = offersFor(c).filter((o) => !o.locked)[0];
  acceptOffer(c, second);
  const rivals = useSlot(c, second);
  eq('AF15 the last slot ends the day', c.day, 2);
  eq('AF16 with a fresh day\'s work', c.slotsLeft, SLOTS_PER_DAY);
  eq('AF17 and nothing carried over as taken', c.takenToday.length, 0);
  ok('AF18 whatever was left went to somebody else', rivals && rivals.length > 0);
  ok('AF19 by name', rivals.every((r) => RIVALS.includes(r.by)), JSON.stringify(rivals));
  ok('AF20 and the board says where it went and for how much',
     rivals.every((r) => r.title && r.fee > 0));
  ok('AF21 none of them is a job the player actually did',
     !rivals.some((r) => r.title === taken.title && r.fee === taken.fee) || rivals.length < 2);
  note(`AF  day 1 -> 2: ${rivals.length} jobs went elsewhere, e.g. "${rivals[0].title}" to ${rivals[0].by}`);

  const tomorrow = offersFor(c).filter((o) => !o.locked);
  ok('AF22 tomorrow is different work',
     JSON.stringify(tomorrow.map((o) => o.seed)) !== JSON.stringify(board.map((o) => o.seed)));
  eq('AF23 and there is a full board of it', tomorrow.length, CONFIG.company.offerCount);

  /* DETERMINISM, with a county, weather and traffic all in the loop. Traffic is the risky one: it
   * spawns bodies from an rng inside the step, so it is driven from the FX stream — the one stream
   * no rule reads — and a job with different traffic must still lay out the same world. */
  function sig(seed, siteId, weatherId) {
    const g = new Game({ seed, seedLabel: 'det' });
    g.job = { siteId, weatherId, mods: {}, loadout: null, effects: null };
    g.startJob({ reroll: false, attempt: 2 });
    g.state.vehicles.sedan.parkBrake = false;
    g.skipMs(6000);
    const b = g.state.vehicles.sedan.body;
    return [b.x, b.y, b.angle, b.vx, b.vy, b.omega].map((n) => n.toFixed(9)).join(',');
  }
  eq('AF24 a job at a site in weather replays bit-for-bit',
     sig(2468, 'quarry', 'wet'), sig(2468, 'quarry', 'wet'));
  ok('AF25 a different site is a different job', sig(2468, 'quarry', 'wet') !== sig(2468, 'ford', 'wet'));
  /* Weather is NOT asserted here as "a different trajectory". On a bank where static friction holds
   * the car in both forecasts, the two runs are identical and correctly so — grip only shows up
   * once something is actually sliding, which is what AD16 measures under load. What this asserts
   * is that the number reached the world at all. */
  lt('AF26 and a wet job carries less grip into the world',
     jobAt('bend', 'wet').state.terrain.gripMul, jobAt('bend', 'dry').state.terrain.gripMul);

  const withTraffic = new Game({ seed: 777, seedLabel: 'tr' });
  withTraffic.job = { siteId: 'bend', weatherId: 'dry', mods: {} };
  withTraffic.startJob({ reroll: false, attempt: 1 });
  const without = new Game({ seed: 777, seedLabel: 'tr' });
  without.job = { siteId: 'bend', weatherId: 'dry', mods: {}, traffic: false };
  without.startJob({ reroll: false, attempt: 1 });
  eq('AF27 traffic is drawn from the FX stream, so it cannot move the sedan',
     withTraffic.state.vehicles.sedan.body.x, without.state.vehicles.sedan.body.x);
  eq('AF28 nor the mud', withTraffic.state.terrain.mud.x, without.state.terrain.mud.x);

  /* And the Milestone 1 recovery, re-measured from scratch. A new site system, a grip multiplier
   * and three more bodies in the contact pass are all things that could have quietly retuned it. */
  const m1 = jobAt('bend', 'dry', { traffic: false });
  const st = m1.state;
  st.vehicles.truck.body.x = st.vehicles.sedan.body.x + 11;
  st.vehicles.truck.body.y = BANDS.roadN + 1.4;
  st.vehicles.truck.body.angle = 0;
  st.vehicles.truck.body.vx = 0; st.vehicles.truck.body.vy = 0; st.vehicles.truck.body.omega = 0;
  st.vehicles.truck.parkBrake = true;
  await rigTo(m1);
  let peak = 0;
  for (let t = 0; t < 60000 && !st.goal.complete; t += 250) {
    st.winch.motor = 1;
    m1.skipMs(250);
    peak = Math.max(peak, st.winch.tensionN);
  }
  ok('AF29 the far-lane recovery still works', st.goal.complete);
  inRange(`AF30 in the time it always took (${(st.goal.completedAtMs / 1000).toFixed(0)} s)`,
          st.goal.completedAtMs / 1000, 25, 50);
  inRange(`AF31 at the tension it always took (${(peak / 1000).toFixed(1)} kN)`, peak, 8000, 20000);
  eq('AF32 without parting the cable', m1.bus.count(EVENTS.CABLE_SNAPPED), 0);
  note(`AF  M1 far-lane recovery: ${(st.goal.completedAtMs / 1000).toFixed(1)} s at ${(peak / 1000).toFixed(1)} kN`);

  // No new sources of nondeterminism.
  const bad = [];
  for (const f of ['world/traffic.js', 'world/weather.js', 'meta/dispatch.js']) {
    const src = await (await fetch(`../src/${f}`)).text();
    if (/Math\.random/.test(src)) bad.push(`${f}: Math.random`);
    if (/(Date\.now|performance\.now)\s*\(/.test(src)) bad.push(`${f}: wall clock`);
  }
  eq('AF33 no Math.random or wall clock in the Milestone 5 modules', bad.length, 0, bad.join('; '));

  const TB = window.__TB;
  ok('AF34 the live game booted', !!TB);
  ok('AF35 with a county on the board',
     TB.garage.offers.filter((o) => !o.locked).every((o) => !!o.siteId));
  eq('AF36 and no errors on the crash banner', document.getElementById('err-banner'), null);

  /* The map, on the real screen. GDD §7 Milestone 5 asks for "a regional map or compact open
   * county", and the test of a map is that every place is on it — including the ones with no work
   * today, because a county that only exists where the jobs are is a level select. */
  {
    TB.garage.focusSite = null;
    TB.garage.render();
    const el = TB.garage.el;
    const markers = el.querySelectorAll('.county-site');
    eq('AF37 every site in the county is on the map', markers.length, SITES.length);
    const liveIds = new Set(TB.garage.offers.filter((o) => !o.locked && o.siteId).map((o) => o.siteId));
    const marked = [...el.querySelectorAll('.county-site.live')].map((n) => n.dataset.arg);
    eq('AF38 and the ones with work on them are the ones marked',
       marked.slice().sort().join(), [...liveIds].sort().join());
    ok('AF39 the map never offers to take a job — it is for looking at',
       !el.querySelector('.county [data-act="take"]'));

    // Click a place, through the real delegated handler, from a child node of the marker.
    if (marked.length) {
      const before = el.querySelectorAll('.offer:not(.locked)').length;
      const dot = el.querySelector(`.county-site.live[data-arg="${marked[0]}"] .county-dot`);
      dot.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      eq('AF40 clicking a place on the map selects it', TB.garage.focusSite, marked[0]);
      const after = el.querySelectorAll('.offer:not(.locked)').length;
      ok(`AF41 and narrows the board to it (${before} offers -> ${after})`, after <= before && after > 0);
      ok('AF42 to that place only',
         [...el.querySelectorAll('.offer:not(.locked) .offer-where')]
           .every((n) => n.textContent.includes(siteById(marked[0]).name)));
      el.querySelector(`.county-site[data-arg="${marked[0]}"] .county-dot`)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      eq('AF43 clicking it again puts the rest of the board back', TB.garage.focusSite, null);
      eq('AF44 all of it', el.querySelectorAll('.offer:not(.locked)').length, before);
    }
  }
}

/* ── run ─────────────────────────────────────────────────────────────────── */

(async function run() {
  const sections = [['AC', sectionAC], ['AD', sectionAD], ['AE', sectionAE], ['AF', sectionAF]];
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
