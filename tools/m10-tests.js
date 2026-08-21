/* TOW BROS — Milestone 10 suite: the one that comes in two halves.
 *
 *   .\tools\smoketest.ps1 -Tests tools\m10-tests.js -Quiet
 *
 * GDD §7 Milestone 10. Milestone 9 put two vehicles at a scene and gave them an order; this one
 * joins them together. An articulated lorry is not a bigger box truck — it is two bodies on a
 * hinge, and the hinge is the whole problem and the whole answer.
 *
 *   BA the pin: a fifth wheel, and what the angle between the halves does to a pull
 *   BB taking it apart: what uncoupling costs, and when it is refused
 *   BC the two halves: what each weighs, and what one drum can and cannot do about them
 *   BD two drums, and the one place the second line must not go
 *   AK5 hygiene — nine milestones of numbers that must not have moved
 */

import { CONFIG } from '../src/config.js';
import { EVENTS } from '../src/core/eventBus.js';
import { Game } from '../src/game.js';
import { BANDS } from '../src/data/terrain.js';
import { findZone, casualtyDefById } from '../src/data/vehicles.js';
import { attachHook, detachHook } from '../src/recovery/attach.js';
import { WINCH, cablePath, pathLength, drumsOf, cableBreakN } from '../src/recovery/cable.js';
import { casualties, cornersOnRoad } from '../src/sim/vehicle.js';
import {
  COUPLING, couplingOf, jackKnifeRad, joinedByCoupling, seatCoupling, uncouple,
  canUncouple, uncoupleRefusal, describeCoupling, pinLocal, plateLocal,
} from '../src/recovery/coupling.js';
import { jobMinutes } from '../src/meta/clock.js';
import { rollSituation, situationToOffer } from '../src/meta/situations.js';

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
/* The line is a spring at the RIG's rate, not one global number: bare 520 kN/m, strap 240, chain
 * 700. Holding "12 kN" means shortening the rest length by 12000/that, and using the wrong one
 * gives NaN — CONFIG.winch has no springK at all. */
const rigK = (w) => (CONFIG.rigging[w.rig] || CONFIG.rigging.bare).springK;
const kN = (n) => (n / 1000).toFixed(1);
const G = CONFIG.sim.gravity;

/* ── helpers ─────────────────────────────────────────────────────────────── */

function job(extra = {}) {
  const g = new Game({ seed: 4242, seedLabel: 'm10' });
  g.job = { siteId: 'bend', weatherId: 'dry', mods: { seizedChance: 0 }, traffic: false, ...extra };
  g.startJob({ reroll: false, attempt: 1 });
  return g;
}


/* ══ BA. the pin, and what the angle between the halves does ══════════════ */

/**
 * A coupled pair, posed exactly where the test wants it.
 *
 * A REAL tractor unit and a REAL semitrailer, because the geometry is the point: the plate is
 * 0.10 m behind the drive axle and the kingpin is 1.50 m back from the trailer's nose, and both
 * are declared on the defs. A pair of box trucks stood in while the artic defs were being written
 * and every number in this section was wrong — with no kingpin field to read, `pinLocal` fell back
 * to the front-axle midpoint and put the pin a metre and a half from where a fifth wheel is.
 *
 * `seatCoupling` does the placement, ALWAYS — on the bank as well as on the flat — because the pin
 * has to start exactly in the plate. 1.4 MN/m over a metre of slack is meganewtons on step one,
 * which is the lesson `engageLift` already paid for. Left unseated on the bank the pair simply
 * tore itself apart on the first step and every reading in the section came back 0.0 kN.
 */
function pair({ foldRad = 0, onBank = false, brakes = true } = {}) {
  const g = job({ casualtyId: 'tractorUnit', secondCasualtyId: 'semitrailer',
                  secondLie: { x: -5.2, y: 0, angle: foldRad, coupled: true, jackKnifeRad: foldRad } });
  const st = g.state;
  const tractor = st.vehicles.sedan, trailer = st.vehicles.second;
  if (!onBank) {
    /* Flat pavement in the yard apron, so the only thing bending the answer is the fold. Asserted
     * dead flat below rather than assumed. */
    tractor.body.x = 138; tractor.body.y = BANDS.roadS + 4.5; tractor.body.angle = 0;
    tractor.body.vx = 0; tractor.body.vy = 0; tractor.body.omega = 0;
    tractor.boggedN0 = 0; tractor.boggedFactor = 0;
    trailer.boggedN0 = 0; trailer.boggedFactor = 0;
  }
  seatCoupling(st, foldRad);
  tractor.parkBrake = brakes; trailer.parkBrake = brakes;
  st.vehicles.truck.body.x = 20; st.vehicles.truck.body.y = BANDS.shoulderS + 1;
  st.vehicles.truck.parkBrake = true;
  g.skipMs(500);
  return { g, st, tractor, trailer };
}

/**
 * Rig the wrecker to the tractor's tow eye and hold a fixed line for `seconds`.
 *
 * TWENTY-TWO METRES back, not fourteen: a 12 kN pull moves this pair five metres in four seconds
 * and a 30 kN pull moves it fourteen, and at fourteen metres the outfit simply drove into the
 * wrecker. Six of those runs logged contacts, and a contact into a 1.4 MN/m pin reads 160 kN —
 * the solver cap — which looked exactly like the constraint exploding and was not.
 */
function haul(p, { newtons = null, seconds = 4 } = {}) {
  const { g, st, tractor } = p;
  const truck = st.vehicles.truck;
  const ahead = tractor.body.forward;
  truck.body.x = tractor.body.x + ahead.x * 22;
  truck.body.y = tractor.body.y + ahead.y * 22;
  truck.body.angle = tractor.body.angle;
  truck.body.vx = 0; truck.body.vy = 0; truck.body.omega = 0;
  truck.parkBrake = true;
  const zone = findZone(tractor.def, 'towHook');
  const hp = tractor.body.toWorld(zone.local.x, zone.local.y);
  const w = drumsOf(st)[0];
  w.hook.x = hp.x; w.hook.y = hp.y;
  w.state = WINCH.ATTACHED; w.targetId = tractor.id; w.zoneId = zone.id;
  const len = pathLength(cablePath(w, truck, st.vehicles, st.blocksById));
  w.state = WINCH.LOOSE;
  attachHook(st, tractor, zone, g.bus, st.simTimeMs, w);
  w.lineM = len;

  const x0 = tractor.body.x, y0 = tractor.body.y;
  let peakPin = 0, peakLine = 0, stalls = 0, contacts = 0;
  g.bus.on(EVENTS.WINCH_STALLED, () => { stalls++; });
  g.bus.on(EVENTS.IMPACT, () => { contacts++; });
  for (let i = 0; i < seconds * 60; i++) {
    /* A FIXED LINE, not a drum. `newtons` is held by shortening the rest length to whatever
     * produces that tension, so "12 kN at 0 degrees" and "12 kN at 60" are the same 12 kN — the
     * comparison is the whole point and a drum reeling at its own rate would not give it.
     * At the RIG's spring rate, which is per-rig and not one global number: bare is 520 kN/m,
     * strap 240, chain 700. CONFIG.winch has no springK at all, and dividing by it returned NaN
     * through every reading in the section without one of them failing loudly. */
    if (newtons !== null) {
      const path = cablePath(w, truck, st.vehicles, st.blocksById);
      w.lineM = Math.max(CONFIG.winch.minLineM, pathLength(path) - newtons / rigK(w));
    } else {
      w.motor = 1;
    }
    g.step(STEP, st.simTimeMs + STEP, null);
    peakPin = Math.max(peakPin, tractor.coupling ? tractor.coupling.forceN : 0);
    peakLine = Math.max(peakLine, w.tensionN);
  }
  w.motor = 0;
  return {
    movedM: Math.hypot(tractor.body.x - x0, tractor.body.y - y0),
    peakPin, peakLine, stalls, contacts,
    frac: peakLine > 0 ? peakPin / peakLine : 0,
  };
}

function sectionBA() {
  lines.push('--- BA. two bodies on a pin, and the angle between them ---');
  const C = CONFIG.coupling;

  /* It exists, it is on the tractor, and it knows what is behind it. */
  {
    const p = pair();
    const c = couplingOf(p.st);
    ok('BA1 a coupled pair has a fifth wheel', !!c);
    eq('BA2 which lives on the tractor, not in a side table', p.st.vehicles.sedan.coupling, c);
    eq('BA3 and is the one record of what is on the back of it', c.trailerId, 'second');
    ok('BA4 an ordinary job has no coupling at all', !couplingOf(job().state));
    /* Flat, and asserted rather than assumed — a slope under this section would put the whole
     * angle comparison out. */
    const t = p.st.terrain;
    lt('BA5 the pair is standing on the flat', t.slopeAt(p.tractor.body.x, p.tractor.body.y).mag, 0.02);
    lt('BA6 both of them', t.slopeAt(p.trailer.body.x, p.trailer.body.y).mag, 0.02);
    /* THE PIN STARTS IN THE PLATE. Any gap left for a 1.4 MN/m spring is meganewtons on step one. */
    lt('BA7 and the pin is seated, not left for the spring to close', c.gapM, 0.01);
    lt('BA8 so it is carrying nothing on the flat', c.forceN, 500);
    eq('BA9 straight, to begin with', Math.round(jackKnifeRad(p.st) * 57.3), 0);

    /* THE ONE PIECE OF GEOMETRY THE WHOLE CONSTRAINT IS BUILT ON, and nothing else would ever
     * check it. `pinLocal` falls back to the front-axle midpoint when a def does not declare a
     * kingpin — and a semitrailer HAS no front axle, so a name that does not match puts the pin
     * at the trailer's nose: a silent 1.50 m error with no error raised anywhere. It was spelt
     * `kingpinLocal` against `kingPinLocal` for exactly one revision. Same family as the box
     * truck's `part: 'wheelRL'` naming a wheel that was not in its wheel list. */
    const tDef = casualtyDefById('tractorUnit'), sDef = casualtyDefById('semitrailer');
    ok('BA9b the trailer declares its kingpin', !!sDef.kingPinLocal);
    eq('BA9c and the coupling reads that field, not an axle',
       pinLocal(sDef).x, sDef.kingPinLocal.x);
    ok('BA9d the tractor declares its fifth wheel', !!tDef.fifthWheelLocal);
    eq('BA9e and the coupling reads that one too',
       plateLocal(tDef).x, tDef.fifthWheelLocal.x);
    lt('BA9f the kingpin is set back from the nose, not on it',
       sDef.kingPinLocal.x, sDef.lengthM / 2 - 0.5);
    /* And the id in one data table names a row in the other, which nothing else checks either. */
    eq('BA9g the tractor names the trailer it couples to', tDef.couplesTo, sDef.id);
  }

  /* THE ANGLE IS THE WHOLE CLAUSE. Same pose, same tow eye, same held 12 kN, four seconds — only
   * the fold different, and the park brakes OFF, because a pair standing on its brakes does not
   * move at any angle and the comparison would be four zeroes. */
  {
    const moved = {};
    const pinFrac = {};
    for (const deg of [0, 30, 60, 90]) {
      const r = haul(pair({ foldRad: deg * Math.PI / 180, brakes: false }), { newtons: 12000, seconds: 4 });
      moved[deg] = r.movedM;
      pinFrac[deg] = r.frac;
      eq(`BA10_${deg} and none of it is a collision`, r.contacts, 0);
    }
    gt('BA11 straight, a fixed 12 kN moves the pair', moved[0], 4);
    lt('BA12 folded 30 degrees, the same 12 kN moves it appreciably less', moved[30], moved[0] * 0.85);
    lt('BA13 folded 60, less again', moved[60], moved[30]);
    lt('BA13b and the whole spread is worth having — 60 costs a third of the travel',
       moved[60], moved[0] * 0.7);
    /* WHERE THE MISSING TRAVEL WENT. Straight, about half the line ends up in the pin and the rest
     * reaches the ground as traction. Folded, MORE than the whole line does: the trailer is being
     * skidded sideways and swung at the same time, and its own inertia adds to what the wrecker
     * is putting in. A number over 100% is not an error — it is what a jack-knife is. */
    inRange('BA14 straight, about half the line stops in the pin', pinFrac[0], 0.40, 0.70);
    gt('BA15 folded, more than the whole of it does', pinFrac[60], 1.0);
    note(`BA  a fixed 12 kN moves the pair ${moved[0].toFixed(2)} m straight, `
      + `${moved[30].toFixed(2)} at 30°, ${moved[60].toFixed(2)} at 60°, ${moved[90].toFixed(2)} at 90° `
      + `— and the share of the line that stops in the pin goes `
      + `${(pinFrac[0] * 100).toFixed(0)}% → ${(pinFrac[60] * 100).toFixed(0)}%`);
    /* AND IT IS NOT MONOTONE, which is worth asserting as the fact it is rather than pretending.
     * At 90 degrees the pull has its longest moment arm about the trailer's own mass and swings it
     * round instead of having to skid it, so the cost PEAKS near 60 and comes back. Measured at
     * three separate loads — 12 kN, 20 kN and 30 kN — and it holds at all three. */
    gt('BA16 the cost peaks near 60 rather than at 90', moved[90], moved[60]);
  }

  /* WHAT THE PIN CARRIES is the DIFFERENCE between the two halves, and that is worth saying twice
   * because it is the least obvious thing here: two halves that are each holding themselves up put
   * NOTHING through the pin, however steep the hill and however far round the fold. */
  {
    const flat = pair();
    flat.g.skipMs(4000);
    lt('BA17 flat and straight, the pin carries nothing', couplingOf(flat.st).forceN, 500);
    const parked = pair({ onBank: true, foldRad: 1.0 });
    parked.g.skipMs(4000);
    lt('BA17b nor on a 28 degree bank, jack-knifed, with both sets of brakes on',
       couplingOf(parked.st).forceN, 500);
    lt('BA17c because neither half has moved', Math.abs(parked.tractor.body.vx), 0.02);

    /* Take the brakes off and the difference appears. Straight, both halves slide down the same
     * hill at the same rate and the pin has nothing to do. Folded, the trailer is broadside and
     * its tyres bite far harder sideways than the tractor's do rolling — so the pin drags one
     * down the hill against the other. */
    const straight = pair({ onBank: true, foldRad: 0, brakes: false });
    const sx = straight.tractor.body.x, sy = straight.tractor.body.y;
    straight.g.skipMs(4000);
    const folded = pair({ onBank: true, foldRad: 1.0, brakes: false });
    const fx = folded.tractor.body.x, fy = folded.tractor.body.y;
    folded.g.skipMs(4000);
    const sN = couplingOf(straight.st).forceN, fN = couplingOf(folded.st).forceN;
    const sM = Math.hypot(straight.tractor.body.x - sx, straight.tractor.body.y - sy);
    const fM = Math.hypot(folded.tractor.body.x - fx, folded.tractor.body.y - fy);
    gt('BA18 sliding, a folded pair carries far more through the pin than a straight one', fN, sN * 4);
    lt('BA18b and the fold pays for it in travel', fM, sM);
    lt('BA18c and the slide straightens it out — a pair dragged downhill wants to line up',
       jackKnifeRad(folded.st), 1.0);
    ok('BA18d neither of which is a rollover', !folded.tractor.rolled && !folded.trailer.rolled);
    note(`BA  four seconds of sliding down the 28° bank: straight ${sM.toFixed(1)} m with `
      + `${kN(sN)} kN in the pin, folded ${fM.toFixed(1)} m with ${kN(fN)} kN — and the fold `
      + `closes from 57° to ${(jackKnifeRad(folded.st) * 57.3).toFixed(0)}°`);
  }

  /* STABILITY, which is the thing a stiff constraint has to earn. Thirty kilonewtons, not the
   * forty-five the first draft asked for: the cable parts at 42 kN, so 45 kN is not a load this
   * rig can hold, and the run that asked for it measured a line tension of zero for thirty
   * seconds and called the pin stable. */
  {
    const p = pair({ foldRad: 1.0 });
    const r = haul(p, { newtons: 30000, seconds: 30 });
    const c = couplingOf(p.st);
    lt('BA19 30 kN held on a folded pair for thirty seconds does not diverge', c.gapM, 0.01);
    lt('BA20 nor reach the solver cap', r.peakPin, C.maxForceN);
    ok('BA21 and the pin is still in', c.state !== COUPLING.FREE);
    /* AND IT CANNOT BE PULLED APART BY THE WINCH AT ALL, which is a fact about two numbers in two
     * different files and is the reason BA19 can be a stability test rather than a strength one. */
    lt('BA21b the cable parts long before the pin does',
       cableBreakN(drumsOf(p.st)[0]), C.pinBreakN);
    note(`BA  30 s at 30 kN: pin ${kN(r.peakPin)} kN, ${(c.gapM * 1000).toFixed(1)} mm of travel — `
      + `and the line would part at ${kN(cableBreakN(drumsOf(p.st)[0]))} kN, against a pin rated `
      + `${kN(C.pinBreakN)} kN`);
  }

  /* AND THE TWO HALVES DO NOT COLLIDE WITH EACH OTHER. A semitrailer's nose overhangs the cab, so
   * their boxes are nested by design — without the filter the solver resolves a two-metre
   * penetration every step and feeds it into the pin. */
  {
    const p = pair();
    ok('BA22 the halves are exempt from the contact pass while coupled',
       joinedByCoupling(p.tractor, p.trailer));
    let contacts = 0;
    p.g.bus.on(EVENTS.IMPACT, () => { contacts++; });
    p.g.skipMs(4000);
    eq('BA23 so four seconds of standing there is not four seconds of collisions', contacts, 0);
    ok('BA24 and nothing has been shaken apart', couplingOf(p.st).state !== COUPLING.FREE);
  }
}

/* ══ BB. taking it apart ══════════════════════════════════════════════════ */

/**
 * Hold the release handle for `ms`, the way a crew member does.
 *
 * THE STAMP GOES ON THE STEP THAT IS ABOUT TO RUN, not the one that has just finished. `uncouple`
 * writes `releaseTouchedMs = simTimeMs` and `stepCoupling` — later in the SAME step — throws the
 * attempt away when that stamp is not this step's, which is how letting go is exact rather than a
 * timeout. Stamped with the previous step's time instead, every single call was discarded by the
 * step that followed it: twelve seconds of held handle made no progress at all and the pin never
 * came out. stepCrew gets this right for free by being inside the step; a test driving `uncouple`
 * from outside has to pass the time the step is about to be given.
 */
function hold(p, ms) {
  const st = p.st;
  let held = 0;
  for (let i = 0; i < Math.round(ms / STEP); i++) {
    const next = st.simTimeMs + STEP;
    uncouple(st, p.g.bus, next, STEP / 1000);
    p.g.step(STEP, next, null);
    held += STEP;
    if (couplingOf(st).state === COUPLING.FREE) break;
  }
  return held;
}

function sectionBB() {
  lines.push('--- BB. pulling the pin, and when it will not come out ---');
  const C = CONFIG.coupling;

  /* IT IS HELD, NOT TAPPED. Eight seconds of standing there — and letting go loses it. */
  {
    const p = pair();
    const st = p.st;
    ok('BB1 flat and straight, the pin can come out', canUncouple(st));
    let out = null;
    p.g.bus.on(EVENTS.COUPLING_RELEASED, (e) => { if (!out) out = e; });
    const held = hold(p, 14000);
    ok('BB2 held long enough, it comes out', !!out);
    near(`BB3 after the ${(C.uncoupleMs / 1000).toFixed(0)} s it says it takes`,
         held, C.uncoupleMs, 200);
    eq('BB4 and the log says who did it', out && out.reason, 'player');
    eq('BB4b and which two vehicles came apart', out && out.trailer, 'second');
    eq('BB5 the coupling is free', couplingOf(st).state, COUPLING.FREE);
    note(`BB  the pin came out after ${(held / 1000).toFixed(1)} s of held handle`);
  }
  {
    const p = pair();
    const st = p.st;
    hold(p, 4000);
    gt('BB6 four seconds in, it is part way', couplingOf(st).releaseMs, 3000);
    lt('BB6b and not there yet', couplingOf(st).releaseMs, C.uncoupleMs);
    // Let go: stop calling uncouple, and stepCoupling notices nobody touched it this step.
    for (let i = 0; i < 60; i++) p.g.step(STEP, st.simTimeMs + STEP, null);
    eq('BB7 let go and it is back to nothing', Math.round(couplingOf(st).releaseMs), 0);
    ok('BB8 with the pin still in', couplingOf(st).state !== COUPLING.FREE);
  }

  /* AND IT IS REFUSABLE, in physical terms. You cannot pull the pin with a load on it — and the
   * load that matters is not the hill, it is the WRECKER. Two halves parked on a bank with their
   * brakes on put nothing through the pin however steep it is (BA17b), so the refusal that means
   * something is the one that fires while the line is on. */
  {
    const flat = pair();
    flat.g.skipMs(2000);
    ok('BB9 a flat road with no line on it lets it go', canUncouple(flat.st));

    const p = pair({ foldRad: 1.0 });
    haul(p, { newtons: 12000, seconds: 2 });
    ok('BB10 a jack-knifed pair with the wrecker pulling does not', !canUncouple(p.st));
    ok('BB11 and says so in newtons, with the limit beside it',
       /kN.*kN/.test(uncoupleRefusal(p.st) || ''));
    note(`BB  refused: "${uncoupleRefusal(p.st)}"`);
    /* Holding the handle against a refusal keeps what progress there is rather than throwing it
     * away — one step of noise is not an event — but it does not add to it either. */
    const st = p.st;
    hold(p, 3000);
    lt('BB12 holding the handle against a refusal makes no progress', couplingOf(st).releaseMs, 200);
    ok('BB13 and it is still coupled', couplingOf(st).state !== COUPLING.FREE);
    ok('BB14 with the refusal on the readout', !!describeCoupling(st).refusal);
    gt('BB14b and the number in it is the one in the pin',
       parseFloat(uncoupleRefusal(st)), C.uncoupleMaxN / 1000);
  }

  /* AND ONCE IT IS APART, IT IS A MILESTONE 9 SHUNT — two casualties that collide like any others. */
  {
    const p = pair();
    const st = p.st;
    hold(p, 14000);
    eq('BB15 the pin is out', couplingOf(st).state, COUPLING.FREE);
    eq('BB16 and there are still two vehicles to get onto the road', casualties(st).length, 2);
    ok('BB17 the pin carries nothing now', couplingOf(st).forceN < 1);
    /* The exemption from the contact pass survives until they are clear of one another, and then
     * goes for good — otherwise two vehicles nested by design would pass through each other for
     * the rest of the job. */
    ok('BB18 they are still exempt from contacts while overlapping',
       joinedByCoupling(p.tractor, p.trailer));
    p.trailer.body.x -= 30;
    p.g.step(STEP, st.simTimeMs + STEP, null);
    ok('BB19 and once they are clear of each other, they are not',
       !joinedByCoupling(p.tractor, p.trailer));
    p.trailer.body.x += 30;
    p.g.step(STEP, st.simTimeMs + STEP, null);
    ok('BB20 and it does not come back — an uncoupled pair collides like any other two',
       !joinedByCoupling(p.tractor, p.trailer));
  }

  /* THE COST, in the currency the game already spends. */
  {
    const walkM = (C.uncoupleMs / 1000) * CONFIG.player.maxSpeed;
    const dayMin = jobMinutes(C.uncoupleMs);
    gt('BB21 pulling the pin costs as much time as a real walk across the site', walkM, 20);
    gt('BB22 and a real bite out of the working day', dayMin, 30);
    note(`BB  ${(C.uncoupleMs / 1000).toFixed(0)} s of handle = ${walkM.toFixed(0)} m of walking `
      + `= ${Math.round(dayMin)} minutes of the day`);
  }
}

/* ══ BC. the two halves, and the choice between them ══════════════════════ */

/**
 * Recover `veh` the way a player does: park on the road above it, hook on, reel until the line is
 * nearly all in, then MOVE THE WRECKER and do it again.
 *
 * The re-park is not a convenience — it is the recovery. A drum holds 30 m of line and pulls its
 * load to the fairlead, so one park is worth one drum's length of travel and no more; the first
 * draft of this helper reeled from a single park, watched the trailer stop two metres short of
 * the carriageway with 2.3 m of line left, and reported that a semitrailer cannot be recovered.
 *
 * `dx` may be a function of the park index, because the second half of a long trailer's recovery
 * is not more of the first: up the bank it is pulled straight, and once it is on the carriageway
 * lying across both lanes it has to be pulled ALONG the road to swing it in line. Four parks —
 * two up, two round — is what an 8.20 m trailer takes.
 */
function recover(g, veh, zoneId, { parks = 4, secondsPerPark = 60, dx = 2 } = {}) {
  const st = g.state;
  const truck = st.vehicles.truck;
  const w = drumsOf(st)[0];
  let peak = 0, stalls = 0, snaps = 0, zoneFail = null, used = 0;
  g.bus.on(EVENTS.WINCH_STALLED, () => { stalls++; });
  g.bus.on(EVENTS.CABLE_SNAPPED, () => { snaps++; });
  g.bus.on(EVENTS.ZONE_FAILED, (e) => { if (!zoneFail) zoneFail = e; });
  for (let park = 0; park < parks; park++) {
    used = park + 1;
    if (w.state === WINCH.ATTACHED) detachHook(st, g.bus, st.simTimeMs, 'player', w);
    truck.body.x = veh.body.x + (typeof dx === 'function' ? dx(park) : dx);
    truck.body.y = BANDS.roadN + 1.4;
    truck.body.angle = 0; truck.body.vx = 0; truck.body.vy = 0; truck.body.omega = 0;
    truck.parkBrake = true;
    const zone = findZone(veh.def, zoneId);
    const p = veh.body.toWorld(zone.local.x, zone.local.y);
    w.hook.x = p.x; w.hook.y = p.y;
    w.state = WINCH.ATTACHED; w.targetId = veh.id; w.zoneId = zone.id;
    w.state = WINCH.LOOSE;
    attachHook(st, veh, zone, g.bus, st.simTimeMs, w);
    w.lineM = pathLength(cablePath(w, truck, st.vehicles, st.blocksById));
    let lastY = veh.body.y, still = 0;
    for (let t = 0; t < secondsPerPark * 1000; t += 500) {
      w.motor = 1;
      g.skipMs(500);
      peak = Math.max(peak, w.tensionN);
      if (cornersOnRoad(veh, st.terrain).all) break;
      if (w.lineM <= CONFIG.winch.minLineM + 0.9) break;
      /* Twenty seconds of nothing is a park that is not going to work. A STALL is not that: the
       * drum eases off, the load creeps, and it stalls again — which is how a heavy pull sounds
       * and looks, and cutting the park at the first stall is what made a tractor unit that comes
       * up in three parks look like one that cannot be moved at all. */
      if (Math.abs(veh.body.y - lastY) < 0.02) { if (++still > 40) break; } else still = 0;
      lastY = veh.body.y;
    }
    w.motor = 0;
    if (cornersOnRoad(veh, st.terrain).all) break;
  }
  return { up: cornersOnRoad(veh, st.terrain).all, on: cornersOnRoad(veh, st.terrain).on,
           peak, stalls, snaps, zoneFail, parks: used, sec: st.simTimeMs / 1000 };
}

/** An artic on the bend, folded 51 degrees, exactly as the generator would hand it over. */
function articJob(truckId = 'truck', fold = 0.9) {
  return job({ truckId, casualtyId: 'tractorUnit', secondCasualtyId: 'semitrailer',
               secondLie: { x: -5.2, y: 0, angle: fold, coupled: true, jackKnifeRad: fold } });
}

/** Pull the pin, however long it takes. Returns the seconds it took. */
function pullPin(g) {
  const st = g.state;
  const t0 = st.simTimeMs;
  for (let i = 0; i < 60 * 20 && couplingOf(st).state !== COUPLING.FREE; i++) {
    const next = st.simTimeMs + STEP;
    uncouple(st, g.bus, next, STEP / 1000);
    g.step(STEP, next, null);
  }
  return (st.simTimeMs - t0) / 1000;
}

function sectionBC() {
  lines.push('--- BC. the two halves, and the choice between them ---');

  /* WHAT THE TWO HALVES ARE — and the number here is not the one this section was written
   * expecting. A tractor unit and a semitrailer come to 6.7 t between them, which is LESS than
   * the 7.2 t box truck the game has had since Milestone 6, and each half on its own is little
   * more than half of that. So whatever it is that makes an artic hard, it is not the weight.
   * It is that it is two bodies on a hinge: BC14 below cannot move this pair a metre in a hundred
   * seconds, and the box truck that outweighs it comes up in one park. */
  {
    const t = casualtyDefById('tractorUnit'), s = casualtyDefById('semitrailer');
    const box = casualtyDefById('boxTruck');
    eq('BC1 the pair weighs the two halves', t.massKg + s.massKg, 6700);
    lt('BC2 and each half on its own is little more than half a box truck',
       Math.max(t.massKg, s.massKg), box.massKg * 0.6);
    lt('BC3 the pair together is lighter than one box truck — the difficulty is not the weight',
       t.massKg + s.massKg, box.massKg);
    note(`BC  tractor ${t.massKg} kg + trailer ${s.massKg} kg = ${t.massKg + s.massKg}, against a `
      + `box truck's ${box.massKg} — an artic is not heavy, it is hinged`);

    /* AND THE TRAILER HAS NO TOW EYE. Nothing on the back of an artic is designed to be pulled
     * from the front by somebody else, because in its whole working life the only thing that ever
     * pulls it is the pin. So the crew have to choose a structural member instead — and the
     * obvious handle under the nose is the worst one on either half. */
    ok('BC4 the trailer has no tow eye at all', !findZone(s, 'towHook'));
    const legs = findZone(s, 'landingLegs'), pin = findZone(s, 'kingpin');
    const front = findZone(s, 'frameFront');
    lt('BC5 the landing legs are the weakest thing on it', legs.strengthN, front.strengthN);
    /* AND THE TRAP IS LIVE, not a comparison of two numbers in a table. Rig the obvious handle
     * under the trailer's nose and it does not last a second: the first step of the pull asks it
     * for more than it is rated at and it comes off in your hand. */
    {
      const g = articJob();
      const r = recover(g, g.state.vehicles.second, 'landingLegs', { parks: 1, secondsPerPark: 20 });
      ok('BC5b and rigging to them tears them off', !!r.zoneFail);
      eq('BC5c which is the trailer\'s, not somebody else\'s', r.zoneFail && r.zoneFail.zone, 'landingLegs');
      gt('BC5d because the pull asked for more than they are rated at',
         r.zoneFail.loadN, r.zoneFail.capacityN);
      lt('BC5e and it took a tenth of a second to find out', r.zoneFail.simTimeMs, 100);
      note(`BC  the landing legs came off at ${kN(r.zoneFail.loadN)} kN against `
        + `${kN(r.zoneFail.capacityN)} kN, ${Math.round(r.zoneFail.simTimeMs)} ms into the pull`);
    }
    /* THE TWO STRONGEST POINTS IN THE WHOLE OUTFIT ARE THE TWO HALVES OF THE COUPLING, which is
     * exactly right and worth pinning down: the plate is rated above the pin that sits in it, so
     * a fifth wheel fails at the pin and never at the tractor, and both are rated far above
     * anything a 42 kN cable could ever ask of them. */
    const plate = findZone(t, 'fifthWheel');
    gt('BC6 the kingpin is the strongest thing on the trailer', pin.strengthN, front.strengthN);
    gt('BC6b and the plate it sits in is stronger still', plate.strengthN, pin.strengthN);
    gt('BC6c so the two strongest points in the outfit are the coupling itself',
       Math.min(plate.strengthN, pin.strengthN),
       Math.max(...s.zones.filter((z) => z.id !== 'kingpin').map((z) => z.strengthN)));
    note(`BC  the trailer's handles: landing legs ${kN(legs.strengthN)} kN, front bolster `
      + `${kN(front.strengthN)} kN, kingpin ${kN(pin.strengthN)} kN, in a plate rated `
      + `${kN(plate.strengthN)} kN`);
  }

  /* THE DISPATCH SIDE. An artic is not a difficulty setting and it is not a seventh axis — it is
   * one row in VEHICLES dragging a second body in behind it, gated on reputation like everything
   * else, and it overrules the shunt because there is no third casualty slot for it to use. */
  {
    let atRep = 0, belowRep = 0, first = null;
    for (let seed = 1; seed <= 400; seed++) {
      const s = rollSituation(seed, 60);
      if (s.second && s.second.id === 'semitrailer') { atRep++; if (!first) first = s; }
      const b = rollSituation(seed, 59);
      if (b.second && b.second.id === 'semitrailer') belowRep++;
    }
    eq('BC7 no artic below the tractor unit\'s reputation gate', belowRep, 0);
    gt('BC8 and a real share of jobs above it', atRep, 10);
    note(`BC  ${atRep} of 400 seeds are an artic at reputation 60, none at 59`);

    ok('BC9 it arrives coupled', !!first.secondLie.coupled);
    eq('BC10 with one number for the fold, under both its names',
       first.secondLie.angle, first.secondLie.jackKnifeRad);
    lt('BC11 and inside the angle a fifth wheel is free to',
       Math.abs(first.secondLie.angle), CONFIG.coupling.freeRad);
    eq('BC12 the sixth axis has nothing to say about it', first.shunt.id, 'artic');
    /* Both slots are full, so a shunt partner has nowhere to go — and the fee says there are two
     * of it, which is the only thing an artic is priced for. */
    let plain = null;
    for (let seed = 1; seed <= 400 && !plain; seed++) {
      const s = rollSituation(seed, 60);
      if (s.vehicle.id === 'boxTruck' && !s.second) plain = s;
    }
    gt('BC13 and it pays for two recoveries, not one', first.feeMul, plain.feeMul);
    note(`BC  the offer: "${situationToOffer(first, 'bc').blurb}"`);
  }

  /* THE CHOICE, MEASURED. This is the milestone.
   *
   * Coupled, one drum, off the bank: the outfit does not come. Five parks, a hundred seconds of
   * drum and forty-seven stalls move it two thirds of a metre — 6.7 t of bogged artic against a
   * 26 kN motor, and the fold means most of what the line does put in went into the pin rather
   * than up the hill (BA15). Split it and the same wrecker from the same parks brings the tractor
   * up in three and the trailer in four. Eight seconds with the handle buys that. */
  {
    const g = articJob();
    const st = g.state;
    const y0 = st.vehicles.sedan.body.y;
    const r = recover(g, st.vehicles.sedan, 'towHook', { parks: 5 });
    ok('BC14 coupled, one drum will not bring an artic off the bank', !r.up);
    lt('BC15 five parks move it less than a metre', Math.abs(st.vehicles.sedan.body.y - y0), 1.0);
    gt('BC16 because the drum spends the whole time stalling', r.stalls, 20);
    lt('BC17 and it is the motor that is the limit, not the cable',
       r.peak, cableBreakN(drumsOf(st)[0]));
    eq('BC18 nothing tore off trying', r.zoneFail, null);
    ok('BC19 and the pin is still in at the end of it', couplingOf(st).state !== COUPLING.FREE);
    note(`BC  coupled: ${r.parks} parks, ${r.sec.toFixed(0)} s, ${r.stalls} stalls, `
      + `${Math.abs(st.vehicles.sedan.body.y - y0).toFixed(1)} m of travel, peak ${kN(r.peak)} kN`);
  }
  {
    const g = articJob();
    const st = g.state;
    const tractor = st.vehicles.sedan, trailer = st.vehicles.second;
    const pinSec = pullPin(g);
    near('BC20 the pin comes out in the eight seconds it costs', pinSec * 1000,
         CONFIG.coupling.uncoupleMs, 200);
    const r1 = recover(g, tractor, 'towHook', { parks: 5 });
    ok('BC21 and then the tractor unit is an ordinary recovery', r1.up);
    lt('BC22 inside the motor\'s reach', r1.peak, CONFIG.winch.motorMaxN + 2500);
    /* The trailer needs the two extra parks along the road: 8.20 m of it lying across a 9.40 m
     * carriageway is not on the road until it has been swung in line with it. */
    const r2 = recover(g, trailer, 'frameFront', { parks: 5, dx: (i) => [2, 2, 10, 16, 22][i] });
    ok('BC23 and so is the trailer, on its front bolster', r2.up);
    gt('BC24 which takes more parks than the tractor did', r2.parks, r1.parks);
    eq('BC25 and nothing has torn off either of them', r2.zoneFail, null);
    note(`BC  split: ${pinSec.toFixed(0)} s on the handle, tractor up in ${r1.parks} parks at `
      + `${kN(r1.peak)} kN, trailer up in ${r2.parks} at ${kN(r2.peak)} kN — `
      + `${r2.sec.toFixed(0)} s all in`);
  }

  /* AND BOTH OF THEM COUNT. Milestone 9's rule, re-checked on a pair that arrived as one vehicle:
   * the job is not done because the front half is on the road. */
  {
    const g = articJob();
    const st = g.state;
    pullPin(g);
    const r1 = recover(g, st.vehicles.sedan, 'towHook', { parks: 5 });
    ok('BC26 the tractor is up', r1.up);
    ok('BC27 the trailer is not', !cornersOnRoad(st.vehicles.second, st.terrain).all);
    ok('BC28 so the job is not done', !st.goal.complete);
    eq('BC29 and it knows there are two of them to do', st.goal.casualties, 2);
  }
}

/* ══ BD. two drums, and where the second line has to go ═══════════════════ */

/**
 * Recover a COUPLED pair with `rigs` lines on it — `[[vehicleSlot, zoneId], ...]`, one per drum.
 *
 * Everything else is held equal to `recover()` above: same parks, same sixty seconds a park, same
 * machine, same casualty, same seed. The only thing that differs between the arms of BD is how
 * many lines are on the outfit and where the second one is tied.
 */
function recoverCoupled(g, rigs, { parks = 4, secondsPerPark = 60 } = {}) {
  const st = g.state;
  const truck = st.vehicles.truck;
  const ws = drumsOf(st);
  let peak = 0, stalls = 0;
  g.bus.on(EVENTS.WINCH_STALLED, () => { stalls++; });
  const halves = [st.vehicles.sedan, st.vehicles.second];
  const active = ws.slice(0, rigs.length);
  for (let park = 0; park < parks; park++) {
    truck.body.x = st.vehicles.sedan.body.x + [2, 2, 10, 16][park];
    truck.body.y = BANDS.roadN + 1.4;
    truck.body.angle = 0; truck.body.vx = 0; truck.body.vy = 0; truck.body.omega = 0;
    truck.parkBrake = true;
    for (let i = 0; i < rigs.length; i++) {
      const [slot, zoneId] = rigs[i];
      const veh = st.vehicles[slot], w = active[i];
      if (w.state === WINCH.ATTACHED) detachHook(st, g.bus, st.simTimeMs, 'player', w);
      const zone = findZone(veh.def, zoneId);
      const p = veh.body.toWorld(zone.local.x, zone.local.y);
      w.hook.x = p.x; w.hook.y = p.y;
      w.state = WINCH.ATTACHED; w.targetId = veh.id; w.zoneId = zone.id;
      w.state = WINCH.LOOSE;
      attachHook(st, veh, zone, g.bus, st.simTimeMs, w);
      w.lineM = pathLength(cablePath(w, truck, st.vehicles, st.blocksById));
    }
    let lastY = halves[0].body.y, still = 0;
    for (let t = 0; t < secondsPerPark * 1000; t += 500) {
      for (const w of active) w.motor = 1;
      g.skipMs(500);
      for (const w of active) peak = Math.max(peak, w.tensionN);
      if (halves.every((v) => cornersOnRoad(v, st.terrain).all)) break;
      if (active.every((w) => w.lineM <= CONFIG.winch.minLineM + 0.9)) break;
      if (Math.abs(halves[0].body.y - lastY) < 0.02) { if (++still > 40) break; } else still = 0;
      lastY = halves[0].body.y;
    }
    for (const w of active) w.motor = 0;
    if (halves.every((v) => cornersOnRoad(v, st.terrain).all)) break;
  }
  return {
    up: halves.every((v) => cornersOnRoad(v, st.terrain).all),
    peak, stalls, sec: st.simTimeMs / 1000,
    foldDeg: Math.round(jackKnifeRad(st) * 57.3),
    coupled: couplingOf(st).state !== COUPLING.FREE,
  };
}

function sectionBD() {
  lines.push('--- BD. two drums, and where the second line has to go ---');

  /* WHICH MACHINE, FIRST. The rotator has had a second drum since Milestone 6 and it has been a
   * convenience; it also has a motor half again as strong, and on an artic that difference is not
   * a convenience at all. BC14 measured the light wrecker failing to move this pair a metre. */
  {
    const light = articJob(), heavy = articJob('heavy');
    eq('BD1 the light wrecker has one drum', drumsOf(light.state).length, 1);
    eq('BD2 the rotator has two', drumsOf(heavy.state).length, 2);
    const lN = drumsOf(light.state)[0].motorMaxN || CONFIG.winch.motorMaxN;
    const hN = drumsOf(heavy.state)[0].motorMaxN || CONFIG.winch.motorMaxN;
    gt('BD3 and a motor half again as strong on each of them', hN, lN * 1.4);
    note(`BD  the light wrecker: 1 drum at ${kN(lN)} kN. The rotator: 2 at ${kN(hN)} kN.`);
  }

  /* THE THREE WAYS TO TAKE A COUPLED ARTIC OFF A BANK, same machine, same parks, same clock. */
  const one = recoverCoupled(articJob('heavy'), [['sedan', 'towHook']]);
  const nose = recoverCoupled(articJob('heavy'), [['sedan', 'towHook'], ['second', 'frameFront']]);
  const tail = recoverCoupled(articJob('heavy'), [['sedan', 'towHook'], ['second', 'axleRear']]);

  ok('BD4 one line on the tractor brings a coupled artic up, on the big machine', one.up);
  ok('BD5 and so do two', tail.up);
  lt('BD6 but two are only faster if the second one is on the far end of the trailer',
     tail.sec, one.sec * 0.8);
  /* AND THIS IS THE MEASUREMENT THAT MATTERS, because it is the one that could have gone either
   * way and the GDD assumed it could not. Tied to the trailer's NOSE — a metre and a half from
   * the pin, which is the obvious place because it is the strong end and the end you can reach —
   * the second line is not a second line at all. Both lines pull from almost the same point
   * toward almost the same point, so the pair concertinas against its own pin instead of coming
   * up the hill, and it is HALF AS FAST AGAIN as using one line and leaving the other on the
   * drum. The second line has to be somewhere the first one is not. */
  gt('BD7 tied to the trailer\'s nose instead, two lines are slower than one', nose.sec, one.sec);
  gt('BD8 and cost more stalls doing it', nose.stalls, one.stalls);
  ok('BD9 all three leave the pin in — none of this needs uncoupling',
     one.coupled && nose.coupled && tail.coupled);
  lt('BD10 and none of them parts a line', Math.max(one.peak, nose.peak, tail.peak),
     cableBreakN(drumsOf(articJob('heavy').state)[0]));
  note(`BD  a coupled artic off the bank, on the rotator: one line on the tractor `
    + `${one.sec.toFixed(0)} s / ${one.stalls} stalls; two with the second on the trailer's back `
    + `axle ${tail.sec.toFixed(0)} s / ${tail.stalls}; two with the second on its nose `
    + `${nose.sec.toFixed(0)} s / ${nose.stalls}`);
  note(`BD  and what it leaves behind: ${one.foldDeg}° of fold on one line, ${tail.foldDeg}° on two `
    + `— pulling the tail round is faster and it does not straighten the outfit out`);
}

/* ══ AK5. nine milestones of numbers that must not have moved ═════════════ */

async function sectionAK5() {
  lines.push('--- AK5. nine milestones of numbers that must not have moved ---');

  /* The Milestone 1 recovery, one more time. It is in every suite from here on for the reason it
   * was in the last four: it is the oldest measurement in the tree and the one most likely to be
   * quietly broken by something that had nothing to do with it. */
  {
    const g = job();
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
    ok('AK5-1 the far-lane recovery still works', st.goal.complete);
    inRange(`AK5-2 in the time it always took (${(st.goal.completedAtMs / 1000).toFixed(0)} s)`,
            st.goal.completedAtMs / 1000, 25, 50);
    inRange(`AK5-3 at the tension it always took (${kN(peak)} kN)`, peak, 8000, 20000);
    ok('AK5-4 without rolling the machine doing it', !st.vehicles.truck.rolled);
  }

  {
    const bad = [];
    for (const f of ['recovery/coupling.js', 'data/vehicles.js', 'meta/situations.js']) {
      let src;
      try { src = await (await fetch(`../src/${f}`)).text(); } catch { continue; }
      if (/Math\.random/.test(src)) bad.push(`${f}: Math.random`);
      if (/(Date\.now|performance\.now|new Date)\s*\(/.test(src)) bad.push(`${f}: wall clock`);
    }
    eq('AK5-5 no Math.random or wall clock in the Milestone 10 modules', bad.length, 0, bad.join('; '));
  }

  const TB = window.__TB;
  ok('AK5-6 the live game booted', !!TB);
  eq('AK5-7 and no errors on the crash banner', document.getElementById('err-banner'), null);
}

/* ── run ─────────────────────────────────────────────────────────────────── */

(async function run() {
  const sections = [['BA', sectionBA], ['BB', sectionBB], ['BC', sectionBC], ['BD', sectionBD],
                    ['AK5', sectionAK5]];
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
