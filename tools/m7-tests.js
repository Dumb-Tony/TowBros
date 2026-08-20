/* TOW BROS — Milestone 7 suite: the scene, and everybody at it.
 *
 *   .\tools\smoketest.ps1 -Tests tools\m7-tests.js -Quiet
 *
 * GDD §7 Milestone 7: "scene safety and the authorities, the customer at the scene, a wider
 * casualty library, and a job clock."
 *
 * Six milestones built the machinery of a recovery and the company around it. What the scene still
 * had was nobody in it: traffic went past, but nothing at the site cared how long you took or what
 * the owner of the car thought of the state it came back in. So:
 *
 *   AN the working day: a clock that advances on JOBS, and a light level that goes with it
 *   AP the customer: an opinion formed from things that already happened, and what it is worth
 *   AK2 hygiene — six milestones of numbers that must not have moved
 */

import { CONFIG } from '../src/config.js';
import { EVENTS } from '../src/core/eventBus.js';
import { Game } from '../src/game.js';
import { BANDS } from '../src/data/terrain.js';
import { findZone } from '../src/data/vehicles.js';
import { attachHook } from '../src/recovery/attach.js';
import { WINCH, cablePath, pathLength, drumsOf } from '../src/recovery/cable.js';
import {
  newCompany, settleJob, describeCompany, activeTruck,
} from '../src/meta/company.js';
import { offersFor, acceptOffer, useSlot, endDay, canTakeJob } from '../src/meta/dispatch.js';
import {
  hourOf, clockLabel, minutesLeft, daylightAt, jobMinutes, spendTime, resetClock, describeClock,
} from '../src/meta/clock.js';
import {
  MOOD, moodOf, createCustomer, stepCustomer, settleCustomer, describeCustomer, noteCableSnap,
} from '../src/world/customer.js';

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

/* ── helpers ─────────────────────────────────────────────────────────────── */

function job(extra = {}) {
  const g = new Game({ seed: 4242, seedLabel: 'm7' });
  g.job = { siteId: 'bend', weatherId: 'dry', mods: {}, traffic: false, ...extra };
  g.startJob({ reroll: false, attempt: 1 });
  return g;
}

/** A recap shaped the way world/scene.js emits one, for settleJob. */
const recapOf = (o = {}) => ({
  lines: [],
  summary: {
    delivered: o.delivered !== false,
    dents: o.dents || 0,
    partsLost: o.partsLost || 0,
    partsBent: 0,
    cableSnaps: o.snaps || 0,
    droppedInTransit: o.dropped || 0,
    strapsUsed: 2,
    customer: o.customer || null,
    payout: { baseFee: 1400, deductions: [], deducted: 0, paid: o.paid === undefined ? 1400 : o.paid, clean: !!o.clean, floored: false },
  },
});

/* ══ AN. the working day ══════════════════════════════════════════════════ */

function sectionAN() {
  lines.push('--- AN. a clock that advances on jobs, and the light that goes with it ---');

  const c = newCompany();
  eq('AN1 an outfit starts at the beginning of the day', clockLabel(c), '08:00');
  eq('AN2 with a full day in front of it',
     minutesLeft(c), (CONFIG.company.dayEndHour - CONFIG.company.dayStartHour) * 60);
  eq('AN3 in full daylight', daylightAt(c), 1);

  /* THE CLOCK ADVANCES ON JOBS AND ON NOTHING ELSE. Not on wall time — nothing in this project
   * reads real time except presentation — and not on stepping the simulation either. */
  const before = clockLabel(c);
  const g = job();
  g.skipMs(30000);
  eq('AN4 running the simulation does not move the county clock', clockLabel(c), before);

  const spent = spendTime(c, 36000);
  gt('AN5 finishing a job does', minutesLeft(c), 0);
  eq('AN6 by the time the job took', Math.round(spent.minutes), Math.round(jobMinutes(36000)));
  note(`AN  a 36 s recovery is ${Math.round(jobMinutes(36000))} minutes of the day; `
     + `it is ${clockLabel(c)} and there are ${describeClock(c).leftLabel}`);

  /* The exchange rate has to be believable at both ends: a clean recovery is a morning, and two
   * jobs fill a day. Measured against the suites — a far-lane pull is 39 s and a box truck in two
   * parks is 67, plus 20-30 s of delivery on top. */
  inRange(`AN7 a clean 39 s recovery is a few hours (${(jobMinutes(39000) / 60).toFixed(1)} h)`,
          jobMinutes(39000) / 60, 2, 5);
  inRange(`AN8 and a bad 90 s one is most of a day (${(jobMinutes(90000) / 60).toFixed(1)} h)`,
          jobMinutes(90000) / 60, 5, 12);
  {
    const two = newCompany();
    spendTime(two, 39000);
    spendTime(two, 39000);
    lt('AN9 so two ordinary recoveries fill the day', minutesLeft(two), 150);
    gt('AN10 without going wildly past it', minutesLeft(two), -240);
    /* AND THE SECOND ONE FINISHES IN FALLING LIGHT. This is the whole point of the exchange rate:
     * at the rate it was first tuned to, two jobs finished at 14:40 and the clock cost nothing. */
    lt(`AN10b the second job ends in the dusk (${clockLabel(two)}, light ${daylightAt(two).toFixed(2)})`,
       daylightAt(two), 0.999);
    note(`AN  two 39 s recoveries: finished at ${clockLabel(two)} with the light at `
       + `${daylightAt(two).toFixed(2)} and ${describeClock(two).leftLabel}`);
  }

  /* THE LIGHT. This is the whole reason the clock is worth having: the light level was already
   * wired to the traffic's sight distance and to the renderer in Milestone 5, so an afternoon
   * running out is a consequence rather than a colour. */
  {
    const late = newCompany();
    late.clockMin = (CONFIG.company.dayEndHour - CONFIG.company.dayStartHour - 1) * 60;
    lt('AN11 an hour before the end of the day the light is going', daylightAt(late), 0.9);
    gt('AN12 but it is not dark yet', daylightAt(late), CONFIG.company.nightLightFloor);
    const past = newCompany();
    past.clockMin = (CONFIG.company.dayEndHour - CONFIG.company.dayStartHour + 2) * 60;
    near('AN13 past the end of it, it is as dark as it gets',
         daylightAt(past), CONFIG.company.nightLightFloor, 0.02);
    note(`AN  light through the day: 10:00 ${daylightAt({ clockMin: 120 }).toFixed(2)}, `
       + `16:00 ${daylightAt({ clockMin: 480 }).toFixed(2)}, `
       + `17:30 ${daylightAt({ clockMin: 570 }).toFixed(2)}, `
       + `after ${daylightAt(past).toFixed(2)}`);
  }

  /* And it REACHES THE SCENE. One number on the terrain, which is what traffic and the renderer
   * both read — see world/scene.js for why it is one and not two. */
  {
    const noon = job({ daylight: 1 });
    const dusk = job({ daylight: 0.5 });
    eq('AN14 a job at noon has the forecast to itself', noon.state.terrain.light, 1);
    near('AN15 a job at dusk is half as light', dusk.state.terrain.light, 0.5, 1e-9);
    const wetDusk = job({ weatherId: 'wet', daylight: 0.5 });
    near('AN16 and the forecast multiplies with the hour rather than replacing it',
         wetDusk.state.terrain.light, 0.5 * wetDusk.state.terrain.weather.light, 1e-9);
    lt('AN17 so a wet afternoon is darker than a wet morning',
       wetDusk.state.terrain.light, job({ weatherId: 'wet', daylight: 1 }).state.terrain.light);
  }

  /* The day ends on whichever runs out first: slots, or the light. */
  {
    const a = newCompany();
    const offers = offersFor(a).filter((o) => !o.locked);
    useSlot(a, offers[0]);
    eq('AN18 one job in, the day is still going', a.day, 1);
    useSlot(a, offers[1] || offers[0]);
    eq('AN19 two jobs in, it is over', a.day, 2);
    eq('AN20 and the clock is back to the morning', clockLabel(a), '08:00');

    /* THE LIGHT, which is the other way to run out — and it does NOT end the day by itself.
     * A job that ran into the evening leaves the outfit with a slot it cannot use, and the player
     * closes the day themselves: a day that turned over while they were looking at the board would
     * be a thing happening to them rather than a thing they did. */
    const b = newCompany();
    ok('AN21 in the morning there is work to take', canTakeJob(b).ok);
    b.clockMin = (CONFIG.company.dayEndHour - CONFIG.company.dayStartHour) * 60 + 30;
    ok('AN22 once the light has gone there is not', !canTakeJob(b).ok);
    eq('AN23 and it says which of the two ways it ran out', canTakeJob(b).why, 'no-light');
    eq('AN24 with a slot still unspent — the day cost you a job', b.slotsLeft, 2);
    eq('AN25 the day has NOT turned over on its own', b.day, 1);
    endDay(b);
    eq('AN26 until it is called', b.day, 2);
    eq('AN27 and then it is the morning again', clockLabel(b), '08:00');
    ok('AN28 with work on the board', canTakeJob(b).ok);

    const full = newCompany();
    full.slotsLeft = 0;
    eq('AN29 running out of slots says so differently', canTakeJob(full).why, 'no-slots');
  }

  // Nothing about the clock may be a wall clock. Same rule as everything else in this project.
  eq('AN30 the clock is a number of minutes, not a timestamp', typeof newCompany().clockMin, 'number');

  // And a job settling spends the time it actually took.
  {
    const d = newCompany();
    const r = settleJob(d, recapOf({}), { impactsNs: 0, peakTensionN: 0, cableSnaps: 0, simTimeMs: 48000 });
    gt('AN31 settling a job spends the day', d.clockMin, 0);
    eq('AN32 by the job\'s own simulated time', Math.round(d.clockMin), Math.round(jobMinutes(48000)));
    ok('AN33 and says so on the results card', r.minutesTaken > 0 && !!r.clock);
    note(`AN  after a 48 s job it is ${r.clock.label} — ${r.clock.leftLabel}`);
  }
}

/* ══ AP. the customer ═════════════════════════════════════════════════════ */

function sectionAP() {
  lines.push('--- AP. the person whose car it is ---');

  const g = job();
  const st = g.state;
  ok('AP1 there is somebody at the scene', !!st.customer);
  ok('AP2 standing on the verge, not in the ditch',
     st.customer.y < BANDS.embankmentS && st.customer.y > BANDS.roadS);
  ok('AP3 and they start on your side', st.customer.mood >= 0.8);
  eq('AP4 which reads as a word, not a number', describeCustomer(st.customer).moodLabel, moodOf(st.customer.mood).label);

  /* THEY ARE NOT A CREW MEMBER. Nothing addresses them, nothing claims them, and no authority
   * rule has to learn about a person who does not act — see the note at the top of customer.js. */
  eq('AP5 they are not in the crew', st.crew.filter((c) => c === st.customer).length, 0);
  ok('AP6 and they own nothing', !st.gear.some((it) => it.carriedBy === st.customer.name));

  /* WATCHING costs patience, and only their own time — a job with nobody at the scene has
   * nobody getting impatient. */
  {
    const watched = job();
    watched.skipMs(60000);
    const alone = job({ customerPresent: false });
    alone.skipMs(60000);
    lt('AP7 an hour of standing there wears on them',
       watched.state.customer.mood, CONFIG.customer.startMood);
    eq('AP8 while a job nobody attended does not',
       alone.state.customer.mood, CONFIG.customer.startMood);
    note(`AP  after 60 s on site: ${describeCustomer(watched.state.customer).moodLabel} `
       + `(${describeCustomer(watched.state.customer).moodFrac}), nobody watching: `
       + `${describeCustomer(alone.state.customer).moodFrac}`);
    /* And time ALONE must not be enough to make anybody furious. The combination worth being
     * afraid of is time AND a mistake; a clock that ruins a clean job on its own would be a
     * countdown, which is exactly what Milestone 7 is not. */
    gt('AP9 but time alone never makes anybody furious', watched.state.customer.mood, 0.5);
  }

  /* WHAT YOU DID TO THE CAR, weighted much more heavily than the payout weights it: the payout
   * charges for the repair, this is about watching it happen. */
  {
    const mk = (mut) => {
      const gg = job({ customerPresent: false });   // no time component, so damage is isolated
      const veh = gg.state.vehicles.sedan;
      mut(veh, gg.state);
      gg.step(STEP, gg.state.simTimeMs + STEP, null);
      return gg.state.customer.mood;
    };
    const clean = mk(() => {});
    const dented = mk((v) => { v.damage.dents = (v.damage.arrived.dents || 0) + 3; });
    const parted = mk((v) => { v.damage.parts.bumperFront = 'lost'; });
    const dropped = mk((v, s) => { s.job.droppedInTransit = 1; });

    eq('AP10 a clean job leaves them where they started', clean, CONFIG.customer.startMood);
    lt('AP11 dents cost you', dented, clean);
    lt('AP12 a part coming off costs more than three dents', parted, dented);
    lt('AP13 and dropping it in the road costs most of all', dropped, parted);
    note(`AP  mood after: clean ${clean.toFixed(2)}, three dents ${dented.toFixed(2)}, `
       + `a part off ${parted.toFixed(2)}, dropped ${dropped.toFixed(2)}`);
  }

  /* DAMAGE THE CAR ARRIVED WITH IS NOT YOURS. The same rule the payout follows: docking somebody
   * for the crash they called you out to is not a consequence of any decision they made. */
  {
    const gg = job({ customerPresent: false });
    const veh = gg.state.vehicles.sedan;
    veh.damage.dents = 4;
    veh.damage.arrived = { dents: 4, parts: { ...veh.damage.parts } };
    gg.step(STEP, gg.state.simTimeMs + STEP, null);
    eq('AP14 a car that arrived dented is not held against you',
       gg.state.customer.mood, CONFIG.customer.startMood);
  }

  // A parted cable is loud and they remember it.
  {
    const gg = job({ customerPresent: false });
    const before = gg.state.customer.mood;
    gg.bus.emit(EVENTS.CABLE_SNAPPED, { tensionN: 42000 }, gg.state.simTimeMs);
    gg.step(STEP, gg.state.simTimeMs + STEP, null);
    lt('AP15 they were standing there when the cable went', gg.state.customer.mood, before);
  }

  /* THE VERDICT, and what it is worth. It must be able to be POSITIVE, or the customer is only
   * ever a penalty and the player learns to ignore them rather than to work around them. */
  {
    const happy = createCustomer({ x: 0, y: 0 });
    const vh = settleCustomer(happy);
    gt('AP16 a clean quick job is worth something on its own', vh.rep, 0);
    ok('AP17 and says why, in a sentence', vh.line.length > 10, vh.line);
    ok('AP18 which never tells the player what to do',
       !/you should|try |use the|next time/i.test(vh.line), vh.line);

    const sad = createCustomer({ x: 0, y: 0 });
    sad.mood = 0.05;
    sad.saw = { dents: 4, partsLost: 1, drops: 1, snaps: 1 };
    const vs = settleCustomer(sad);
    lt('AP19 a bad one costs you', vs.rep, 0);
    ok('AP20 and names what they actually saw', /drop/i.test(vs.line), vs.line);
    gt('AP21 the whole swing is worth caring about but not decisive', vh.rep - vs.rep, 4);
    lt('AP22 which is smaller than delivering the job at all is worth',
       vh.rep - vs.rep, CONFIG.company.repClean * 6);
    note(`AP  verdicts: "${vh.line}" ${vh.rep >= 0 ? '+' : ''}${vh.rep}  ·  `
       + `"${vs.line}" ${vs.rep}`);
  }

  /* And it reaches REPUTATION, in parallel with the damage table rather than through it. */
  {
    const good = newCompany();
    const bad = newCompany();
    const happy = createCustomer({ x: 0, y: 0 });
    const sad = createCustomer({ x: 0, y: 0 });
    sad.mood = 0.05;
    settleJob(good, recapOf({ clean: true, customer: settleCustomer(happy) }),
              { impactsNs: 0, peakTensionN: 0, cableSnaps: 0, simTimeMs: 30000 });
    settleJob(bad, recapOf({ clean: true, customer: settleCustomer(sad) }),
              { impactsNs: 0, peakTensionN: 0, cableSnaps: 0, simTimeMs: 30000 });
    gt('AP23 the same job with a happy owner is worth more reputation',
       good.reputation, bad.reputation);
    note(`AP  identical clean deliveries: happy owner ${Math.round(good.reputation)} reputation, `
       + `furious owner ${Math.round(bad.reputation)}`);
  }

  // The mood ladder is a ladder.
  {
    const ids = MOOD.map((m) => m.id);
    eq('AP24 there are five things they can be', ids.length, 5);
    ok('AP25 and the ladder is in order',
       MOOD.every((m, i) => i === 0 || m.at > MOOD[i - 1].at));
    eq('AP26 the bottom of it is furious', moodOf(0).id, 'furious');
    eq('AP27 and the top is grateful', moodOf(1).id, 'grateful');
  }
}

/* ══ AK2. hygiene ═════════════════════════════════════════════════════════ */

async function sectionAK2() {
  lines.push('--- AK2. six milestones of numbers that must not have moved ---');

  // Determinism, with a customer and a clock in the world.
  function sig() {
    const g = job();
    const st = g.state;
    st.vehicles.sedan.parkBrake = false;
    g.skipMs(6000);
    const b = st.vehicles.sedan.body;
    return [b.x, b.y, b.angle, b.vx, b.vy, b.omega].map((n) => n.toFixed(9)).join(',');
  }
  eq('AK2-1 a job still replays bit-for-bit', sig(), sig());
  {
    const withC = job();
    const without = job({ customerPresent: false });
    eq('AK2-2 and whether anybody is watching does not move the world',
       withC.state.vehicles.sedan.body.x, without.state.vehicles.sedan.body.x);
  }

  /* The Milestone 1 recovery, re-measured with a clock and a customer in the scene. */
  {
    const g = job();
    const st = g.state;
    const s = st.vehicles.sedan.body, b = st.vehicles.truck.body;
    b.x = s.x + 11; b.y = BANDS.roadN + 1.4; b.angle = 0; b.vx = 0; b.vy = 0; b.omega = 0;
    st.vehicles.truck.parkBrake = true;
    const zone = findZone(st.vehicles.sedan.def, 'towHook');
    const p = st.vehicles.sedan.body.toWorld(zone.local.x, zone.local.y);
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
    ok('AK2-3 the far-lane recovery still works', st.goal.complete);
    inRange(`AK2-4 in the time it always took (${(st.goal.completedAtMs / 1000).toFixed(0)} s)`,
            st.goal.completedAtMs / 1000, 25, 50);
    inRange(`AK2-5 at the tension it always took (${(peak / 1000).toFixed(1)} kN)`, peak, 8000, 20000);
  }

  // No new nondeterminism.
  const bad = [];
  for (const f of ['meta/clock.js', 'world/customer.js']) {
    const src = await (await fetch(`../src/${f}`)).text();
    if (/Math\.random/.test(src)) bad.push(`${f}: Math.random`);
    if (/(Date\.now|performance\.now|new Date)\s*\(/.test(src)) bad.push(`${f}: wall clock`);
  }
  eq('AK2-6 no Math.random or wall clock in the Milestone 7 modules', bad.length, 0, bad.join('; '));

  const TB = window.__TB;
  ok('AK2-7 the live game booted', !!TB);
  ok('AK2-8 with a clock on the yard screen', !!describeCompany(TB.company).clock);
  eq('AK2-9 and no errors on the crash banner', document.getElementById('err-banner'), null);
}

/* ── run ─────────────────────────────────────────────────────────────────── */

(async function run() {
  const sections = [['AN', sectionAN], ['AP', sectionAP], ['AK2', sectionAK2]];
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
