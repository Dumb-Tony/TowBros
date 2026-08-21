/* The fifth wheel. GDD §7 Milestone 10: "an articulated lorry is not a bigger box truck. It is
 * two bodies on a hinge, and the hinge is the whole problem and the whole answer."
 *
 * ── WHY THIS IS THE WHEEL LIFT'S CONSTRAINT AND NOT A NEW ONE ────────────────────────
 * Read the header of recovery/lift.js first; every word of its "why a hitch is a hinge" applies
 * here unchanged. A point on the tractor and a point on the trailer are the SAME point, the angle
 * between the bodies is free, and the whole thing is one damped spring applied equal-and-opposite
 * at two physical offsets — so both halves get torque and nothing anywhere has to know which one
 * is "the load". That last property is the reason this is the right shape: an artic has no load.
 * It has two halves, and a player may pull either.
 *
 * The damping clamp is ABSOLUTE and not a fraction of the spring term, for the reason lift.js
 * measured and wrote down: proportional, a tow needing 2.8 kN ramped 0.3 -> 11.2 kN over nine
 * steps and then peaked at 106 kN, because at small displacement the clamp leaves almost no
 * damping exactly when it is needed. `dampCapN` is that lesson, copied deliberately — and
 * re-measured here rather than taken on trust: with the cap dropped to 100 N, which is what a
 * fraction of a small spring term amounts to, the same 20 kN pull takes the pin from 11.8 kN and
 * 7.1 mm to 20.0 kN and 14.2 mm. Less dramatic than the yoke's 106 kN, and the same shape.
 *
 * ── WHAT IS NEW: THE ANGLE HAS TO DECIDE WHAT A PULL ACHIEVES ────────────────────────
 * The wheel lift's articulation limit exists to stop a load snaking. Here the articulation IS the
 * mechanic. Nothing in this file makes a folded pair hard to recover — it falls out of two things
 * the simulation already had:
 *
 *   the trailer's tyres     resist sideways far harder than they resist rolling (sim/tires.js:
 *                           a lateral impulse capped at mu·N against crr·N of rolling). Straight,
 *                           a pull rolls the trailer. Folded, it has to SKID it.
 *   the pin is off-centre   on the trailer, so the pull's lateral component is a torque about the
 *                           trailer's own mass. Pull a planted trailer and the tractor swings
 *                           round the pin instead of dragging the pair anywhere.
 *
 * MEASURED on 7.2 t of tractor and 7.2 t of trailer, on level pavement, same tractor pose, same
 * tow eye, only the trailer's angle different. `breaks away at` is the smallest pull that moves
 * the pair half a metre in four seconds; the second column is what a fixed 12 kN does in the same
 * four seconds, and the third is how much of that 12 kN ended up in the pin instead of in the
 * ground:
 *
 *      0 deg    4 kN     5.16 m    50% into the pin
 *     30 deg   12 kN     0.65 m    88%
 *     60 deg   30 kN     0.15 m    91%
 *     90 deg   16 kN     0.39 m    90%
 *
 * Straight, half the line goes into moving the trailer. Bent, nine tenths of it goes into the pin
 * and the pair stays where it is — which is the GDD's sentence with numbers under it. It is 7.5x
 * the pull at the worst of it, against a 26 kN light drum and a 42 kN heavy one, so a light
 * wrecker cannot break a 60-degree jack-knife loose at all.
 *
 * AND IT IS NOT MONOTONE, which is the part worth knowing: the cost peaks near 60 degrees and
 * comes back down at 90, because at 90 the pull has its longest moment arm about the trailer's
 * own mass and swings it round rather than having to skid it sideways. The worst place to find an
 * artic is folded most of the way, not folded all of the way.
 *
 * ── WHICH IS WHY THE PIN COMES OUT ───────────────────────────────────────────────────
 * The same heavy drum on the same tow eye, up the 28-degree bank at the bend, folded 57 degrees,
 * forty seconds:
 *
 *   coupled, 14.4 t   the tractor went DOWN 1.22 m   peak line 42.6 kN   18 stalls
 *   split,    7.2 t   the tractor came up 10.15 m    peak line 40.6 kN    0 stalls
 *
 * One line cannot recover a coupled artic up that bank at all — the drum stalls and the pair
 * slides. The pin is what turns it into a job the machine can walk, and eight seconds is what the
 * pin costs.
 *
 * ── AND ONE THING FROM THE LIFT DELIBERATELY NOT COPIED ──────────────────────────────
 * `weightTransfer`. A real fifth wheel puts a third of the trailer on the tractor's drive axle,
 * and the lift models exactly that with `groundLoadMul` / `extraLoadKg`. It is not done here, for
 * two reasons that are the same reason: the lift already writes both of those fields, and a
 * coupled tractor being carried home on a wrecker's underlift would have two writers of one fact
 * — which is the bug crew/authority.js exists to prevent. See the report.
 */

import { CONFIG } from '../config.js';
import { EVENTS } from '../core/eventBus.js';
import { angleDelta, clamp, clamp01 } from '../core/vec.js';

/* The two event names, read off `EVENTS` with a same-named string fallback — the seam
 * sim/righting.js and world/police.js use, for the same reason. Every event in core/eventBus.js
 * is named identically to its own value, so this is exactly `EVENTS.COUPLING_RELEASED` once the
 * bus carries the key, and a real string rather than `undefined` before it does. */
const COUPLING_MADE = EVENTS.COUPLING_MADE || 'COUPLING_MADE';
const COUPLING_RELEASED = EVENTS.COUPLING_RELEASED || 'COUPLING_RELEASED';

/** Where the pin is in its cycle. FREE still names both halves: they are lying where they were. */
export const COUPLING = Object.freeze({
  COUPLED:   'coupled',      // the pin is in and the constraint is live
  RELEASING: 'releasing',    // somebody has hold of the handle. Still coupled.
  FREE:      'free',          // two vehicles
});

/**
 * The state of one fifth wheel.
 *
 * OWNERSHIP LIVES ON THE OBJECT. This belongs on the tractor — `tractor.coupling` — exactly as
 * the wheel lift belongs on the truck, and `trailerId` is THE record of what is on the back of
 * it, exactly as `lift.carryingId` is. There is no side table of couplings and nothing else
 * anywhere records that these two vehicles are joined; see the note at the top of
 * crew/authority.js for what the second copy of a fact costs.
 *
 * @param {object} o
 * @param {string} o.tractorId  the half with the plate. Not necessarily the half with a driver.
 * @param {string} o.trailerId  the half with the pin
 */
export function createCoupling({ tractorId, trailerId, state = COUPLING.COUPLED } = {}) {
  return {
    state,
    tractorId,
    trailerId,
    /** Progress on the release handle, ms. Reset the moment nobody is working it. */
    releaseMs: 0,
    /** The step a crew member last had hold of the handle. Compared against `simTimeMs`, so
     *  "somebody let go" is exact rather than a timeout. See uncouple(). */
    releaseTouchedMs: -1,
    /** Why the handle would not move, or null. A fact for the HUD, not a rule. */
    refusal: null,
    /* Two nested boxes must not collide (see joinedByCoupling). Coupled they never do; uncoupled
     * they do not until the tractor has actually driven out from under the trailer, and this is
     * the latch that says it has. */
    separated: false,
    /** Live readouts. Derived every step, records of nothing. */
    forceN: 0,
    rawN: 0,
    gapM: 0,
    foldRad: 0,
    foldTorqueNm: 0,
  };
}

/* ── geometry ──────────────────────────────────────────────────────────────── */

/**
 * The midpoint of one end's axle, in the def's own local frame.
 *
 * Adapted from `axleMid` in recovery/lift.js — the same averaging, in local coordinates, so it
 * can be asked of a definition rather than of a placed vehicle. A def with no wheels at that end
 * gets its own extremity, which is what a semitrailer with all its axles at the back is.
 */
function axleLocal(def, end) {
  const ws = def.wheels.filter((w) => (end === 'front' ? w.local.x > 0 : w.local.x < 0));
  if (!ws.length) return { x: (end === 'front' ? 1 : -1) * def.lengthM / 2, y: 0 };
  let x = 0, y = 0;
  for (const w of ws) { x += w.local.x; y += w.local.y; }
  return { x: x / ws.length, y: y / ws.length };
}

/**
 * Where the plate and the pin sit on their own halves.
 *
 * Both default to being OVER AN AXLE, which is not a convenience: a fifth wheel is put over the
 * drive axle because that is the whole point of it, and a semitrailer's pin is over whatever it
 * has at the front. So the geometry comes from `def.wheels` — data the vehicle already carries —
 * and a def that wants to say otherwise says so with `fifthWheelLocal` / `kingPinLocal` rather
 * than by having a number written about it in here.
 */
export const plateLocal = (def) => def.fifthWheelLocal || axleLocal(def, 'rear');
export const pinLocal = (def) => def.kingPinLocal || axleLocal(def, 'front');

/** The plate, in world space. */
export function platePos(tractor) {
  const l = plateLocal(tractor.def);
  return tractor.body.toWorld(l.x, l.y);
}

/** The kingpin, in world space. */
export function pinPos(trailer) {
  const l = pinLocal(trailer.def);
  return trailer.body.toWorld(l.x, l.y);
}

/* ── finding it ────────────────────────────────────────────────────────────── */

/** The coupling at this scene, or null. Iterated in insertion order, which is deterministic. */
export function couplingOf(st) {
  for (const id of Object.keys(st.vehicles)) {
    const c = st.vehicles[id].coupling;
    if (c) return c;
  }
  return null;
}

/** The two halves a coupling names. Either may be missing — a scene can be torn down mid-step. */
export function halvesOf(st, c = couplingOf(st)) {
  if (!c) return { tractor: null, trailer: null };
  return { tractor: st.vehicles[c.tractorId] || null, trailer: st.vehicles[c.trailerId] || null };
}

/**
 * Are these two bodies the halves of an artic that must not collide with each other?
 *
 * Read by sim/collision.js, which already skips the pair joined by a wheel lift and says why: a
 * positional correction is a TELEPORT, and a stiff constraint reading positions sees a teleport
 * as instantaneous deformation. It is worse here than there. A semitrailer's nose overhangs the
 * cab — the two boxes genuinely overlap by metres when the pair is straight, because a top-down
 * box is a projection of a thing that is stacked in the third dimension — so the contact solver
 * would be resolving a two-metre penetration every step of every artic job.
 *
 * It stays true after the pin comes out, until the boxes are clear of one another. Uncoupling two
 * nested bodies and letting them collide on the same step would fire the whole two metres of
 * correction at once; what actually happens is that the tractor drives out from under the
 * trailer. `separated` is the latch for that, and once it is set the trailer is an obstacle like
 * any other — which is what makes an uncoupled artic the Milestone 9 shunt it becomes.
 */
export function joinedByCoupling(A, B) {
  const c = (A.coupling && A.coupling.trailerId === B.id) ? A.coupling
    : (B.coupling && B.coupling.trailerId === A.id) ? B.coupling : null;
  return !!c && !c.separated;
}

/**
 * The angle between the two halves, signed, in radians. THE number this milestone is about.
 *
 * Zero is straight. Positive is the trailer swung round toward the tractor's right. SIGNED, and
 * that is not a detail: this project's most common bug is a magnitude used where a signed
 * quantity was meant, and it has been paid for in `sepRate` (recovery/lift.js, a negated damping
 * rate rang a rigid hinge between 0 and the 120 kN solver cap) and in `Math.abs(b.vx)`
 * (world/traffic.js, a car knocked backwards read as one driving forwards). A fold that has to be
 * resisted back toward straight cannot be resisted at all without knowing which side it is on.
 */
export function jackKnifeRad(st) {
  const { tractor, trailer } = halvesOf(st);
  if (!tractor || !trailer) return 0;
  return angleDelta(tractor.body.angle, trailer.body.angle);
}

/* ── assembly ──────────────────────────────────────────────────────────────── */

/**
 * Put the pin exactly in the plate, at a given articulation.
 *
 * A ONE-OFF KINEMATIC PLACEMENT, for the reason `engageLift` gives at length: leaving any gap for
 * a 1.4 MN/m spring to close is meganewtons on the first step. It is a teleport, and it is
 * legitimate precisely because it happens once — at scene assembly, or when a player has backed
 * the plate under the pin and asked for it — rather than every step.
 *
 * Called with no angle it re-seats whatever fold the pair already has, which is what world/scene.js
 * wants: author the two halves wherever the situation says, then close the pin.
 */
export function seatCoupling(st, relRad = null) {
  const c = couplingOf(st);
  const { tractor, trailer } = halvesOf(st, c);
  if (!c || !tractor || !trailer) return false;

  const rel = relRad === null ? angleDelta(tractor.body.angle, trailer.body.angle) : relRad;
  const ang = tractor.body.angle + rel;
  const plate = platePos(tractor);
  const l = pinLocal(trailer.def);
  const cos = Math.cos(ang), sin = Math.sin(ang);

  trailer.body.angle = ang;
  trailer.body.x = plate.x - (l.x * cos - l.y * sin);
  trailer.body.y = plate.y - (l.x * sin + l.y * cos);
  trailer.body.vx = tractor.body.vx;
  trailer.body.vy = tractor.body.vy;
  trailer.body.omega = 0;
  c.gapM = 0;
  return true;
}

/* ── taking it apart ───────────────────────────────────────────────────────── */

/**
 * Whether the pin can be pulled right now.
 *
 * IT IS A PHYSICAL CONDITION AND THE PLAYER CAN READ THE NUMBER. A fifth wheel's release handle
 * withdraws a locking jaw from around the pin, and it will not withdraw while the trailer's
 * weight is on it — so what refuses this is `coupling.forceN` against `uncoupleMaxN`, and both
 * numbers are in `describeCoupling`. Nothing about the shape of the vehicle, the phase of the
 * job, or where anybody is standing.
 *
 * MEASURED, which is what `uncoupleMaxN` has to be sized against — two identical 7.2 t halves,
 * settled for four seconds:
 *
 *   flat pavement, straight, brakes on or off      0.0 kN
 *   the bank at the bend, straight, brakes on      1.7 kN
 *   the bank, folded 57 deg, brakes on             7.4 kN
 *   the bank, folded, bogged in                    0.0 kN   both halves held; nothing to carry
 *   the bank, folded, with the heavy's line on    21.9 kN
 *
 * Both halves lying on the same slope carry only the DIFFERENCE between them, which is why a
 * straight pair on a 28-degree bank is worth 1.7 kN and a folded one 7.4. See the report for what
 * that says about the shipped 12 kN.
 *
 * The force is LAST step's, because the crew act (stepCrew) runs before the constraint
 * (stepCoupling) in the same step. One step of lag against an eight-second act; the same
 * one-step lag `axPrev` carries for load transfer, and for the same reason.
 */
export function canUncouple(st, C = CONFIG.coupling) {
  const c = couplingOf(st);
  if (!c || c.state === COUPLING.FREE) return false;
  return c.forceN <= C.uncoupleMaxN;
}

/** Why not, in words, or null. Kept beside canUncouple so the two cannot disagree. */
export function uncoupleRefusal(st, C = CONFIG.coupling) {
  const c = couplingOf(st);
  if (!c) return 'There is no coupling here.';
  if (c.state === COUPLING.FREE) return 'It is already uncoupled.';
  if (canUncouple(st, C)) return null;
  const kN = (n) => (n / 1000).toFixed(1);
  return `${kN(c.forceN)} kN through the pin. The handle will not move past `
       + `${kN(C.uncoupleMaxN)} kN.`;
}

/**
 * Work the release handle for one step.
 *
 * Called EVERY STEP while a crew member holds the context key on it — the same shape as
 * `pumpJack` in recovery/gear.js, and it returns true on the step the pin actually comes out the
 * way pumpJack returns true on the step a pump completes.
 *
 * ── WHY IT COSTS TIME AND WHY IT IS THIS MUCH TIME ─────────────────────────────────
 * `uncoupleMs` is eight seconds: winding the landing legs down, pulling the airlines, and
 * cranking the handle over. MEASURED against what a second of this job is worth elsewhere — the
 * crew walk at 3.4 m/s, so it is 27 m of walking; the Milestone 1 recovery is 38 s end to end, so
 * it is 21% of a whole job; and meta/clock.js spends it at 51 minutes of the working day, which is
 * a fifth of what a clean recovery costs. A real fraction of the job, and not a cutscene.
 *
 * A refusal does NOT throw the progress away. The crew keep hold of the handle; it simply does
 * not move while the trailer is leaning on the pin. Resetting on a load spike would be the force-
 * threshold mistake this codebase has now paid for four times (sim/collision.js's guardrail,
 * lift.js's `dropNs`, anchors.js's `pullNs`, rig.js's `tipNms`) wearing a stopwatch: one step of
 * noise is not an event. Letting go IS an event, and that costs the whole eight seconds.
 */
export function uncouple(st, bus, simTimeMs, dtSec = CONFIG.sim.stepMs / 1000,
                         C = CONFIG.coupling) {
  const c = couplingOf(st);
  if (!c || c.state === COUPLING.FREE) return false;

  c.state = COUPLING.RELEASING;
  c.releaseTouchedMs = simTimeMs;

  if (!canUncouple(st, C)) { c.refusal = uncoupleRefusal(st, C); return false; }
  c.refusal = null;

  c.releaseMs += dtSec * 1000;
  if (c.releaseMs < C.uncoupleMs) return false;
  return partCoupling(st, c, bus, simTimeMs, 'player');
}

/** The pin comes out. The only writer of `state = FREE`. */
function partCoupling(st, c, bus, simTimeMs, reason) {
  const { tractor, trailer } = halvesOf(st, c);
  const foldDeg = Math.round(jackKnifeRad(st) * 57.3);
  c.state = COUPLING.FREE;
  c.releaseMs = 0;
  c.releaseTouchedMs = -1;
  c.refusal = null;
  c.foldTorqueNm = 0;
  /* Still nested — the trailer's nose is over the cab. They start colliding when they are clear
   * of each other and not before; see joinedByCoupling. */
  c.separated = false;
  bus.emit(COUPLING_RELEASED, {
    tractor: tractor ? tractor.id : c.tractorId,
    trailer: trailer ? trailer.id : c.trailerId,
    reason,
    foldDeg,
    forceN: Math.round(c.forceN),
  }, simTimeMs);
  c.forceN = 0;
  c.rawN = 0;
  return true;
}

/**
 * Put it back together. The inverse of the pin coming out, and it exists because a mechanic with
 * only one direction is a one-way door — which is the thing Milestone 9 was written to remove.
 *
 * Geometry, not a flag, exactly like `liftTarget`: the plate has to be within reach of the pin
 * and the two halves roughly in line. A tractor parked across the pin cannot back under it.
 *
 * The tolerances are the wheel lift's, deliberately, because backing a plate under a pin and
 * backing a yoke under an axle are the same manoeuvre at the same precision. If they want their
 * own numbers they belong in CONFIG.coupling beside the rest — see the report.
 */
export function recouple(st, bus, simTimeMs) {
  const c = couplingOf(st);
  const { tractor, trailer } = halvesOf(st, c);
  if (!c || c.state !== COUPLING.FREE || !tractor || !trailer) return false;

  const C = CONFIG.coupling;
  const reachM = C.engageM === undefined ? CONFIG.lift.engageM : C.engageM;
  const alignRad = C.engageAlignRad === undefined ? CONFIG.lift.engageAlignRad : C.engageAlignRad;

  const plate = platePos(tractor);
  const pin = pinPos(trailer);
  if (Math.hypot(plate.x - pin.x, plate.y - pin.y) > reachM) return false;
  if (Math.abs(angleDelta(tractor.body.angle, trailer.body.angle)) > alignRad) return false;

  c.state = COUPLING.COUPLED;
  c.separated = false;
  c.releaseMs = 0;
  c.refusal = null;
  seatCoupling(st);
  bus.emit(COUPLING_MADE, {
    tractor: tractor.id, trailer: trailer.id,
    foldDeg: Math.round(jackKnifeRad(st) * 57.3),
  }, simTimeMs);
  return true;
}

/* ── the physics ───────────────────────────────────────────────────────────── */

/**
 * Hold the kingpin in the plate, and resist the pair folding past what the cab allows.
 *
 * ADAPTED from `stepTowBar` (recovery/lift.js), keeping its shape so the two constraints cannot
 * drift apart: one displacement, one damped spring along it, applied equal-and-opposite at two
 * physical offsets, damping clamped to an ABSOLUTE force. The rest length is zero, as it is
 * there. What differs is that there is no securement decision — a fifth wheel is not a cradle
 * with straps, it is a pin — and that the articulation is the point rather than a stability fix.
 *
 * ── WHERE IT HAS TO RUN ─────────────────────────────────────────────────────────────
 * Between the contact pass and the ground, and BEFORE stepRighting. Both halves of that matter.
 * The tire model sizes its static resistance against the force already in the accumulator
 * (sim/tires.js resistanceCap), so a trailer asked to hold against the pin has to be asked in
 * that order or it creeps. And stepRighting reads the same accumulator to decide what is rolling
 * a vehicle over — a jack-knifed artic dragging its trailer sideways is exactly how a trailer
 * goes over, and it cannot be if the pin's force arrives after the question is asked.
 *
 * @returns {number} what the pin is carrying, in newtons.
 */
export function stepCoupling(st, dtSec, bus, simTimeMs, C = CONFIG.coupling) {
  const c = couplingOf(st);
  if (!c) return 0;
  const { tractor, trailer } = halvesOf(st, c);
  /* The coupling lives on the tractor, so only the trailer can go missing — and if it has, the
   * pin is holding nothing. Same guard stepLift keeps for the same reason. */
  if (!tractor) return 0;
  if (!trailer) {
    if (c.state !== COUPLING.FREE) partCoupling(st, c, bus, simTimeMs, 'vanished');
    return 0;
  }

  c.foldRad = angleDelta(tractor.body.angle, trailer.body.angle);

  if (c.state === COUPLING.FREE) {
    /* Two vehicles now. The only thing left to do is notice when they are clear of each other, at
     * which point the trailer stops being invisible to the tractor and starts being in its way.
     * Bounding circles rather than the boxes: it is the conservative test, it costs one hypot, and
     * it does not need sim/collision.js imported into here to answer a question about a latch. */
    if (!c.separated) {
      const d = Math.hypot(trailer.body.x - tractor.body.x, trailer.body.y - tractor.body.y);
      if (d > tractor.body.boundRadius + trailer.body.boundRadius) c.separated = true;
    }
    c.forceN = 0; c.rawN = 0; c.gapM = 0; c.foldTorqueNm = 0;
    return 0;
  }

  /* Nobody had hold of the handle this step. stepCrew runs first and stamps `releaseTouchedMs`
   * with this step's time, so this is exact rather than a timeout — and it means walking away
   * costs the whole eight seconds. */
  if (c.state === COUPLING.RELEASING && c.releaseTouchedMs !== simTimeMs) {
    c.state = COUPLING.COUPLED;
    c.releaseMs = 0;
    c.refusal = null;
  }

  const plate = platePos(tractor);
  const pin = pinPos(trailer);
  const dx = plate.x - pin.x, dy = plate.y - pin.y;
  const gap = Math.hypot(dx, dy);
  c.gapM = gap;
  const u = gap > 1e-6 ? { x: dx / gap, y: dy / gap } : { x: 0, y: 0 };

  /* Rate at which the pin is coming OUT of the plate. `u` points from the pin to the plate, so
   * this is d(gap)/dt and positive means separating — the sign convention cable.js and lift.js
   * both use, and the one lift.js records getting backwards: negated, the damper cancelled the
   * spring for the first ten steps of every tow and the pair rang between zero and the solver cap
   * for the rest of it. */
  const vP = tractor.body.velocityAt(plate.x, plate.y);
  const vK = trailer.body.velocityAt(pin.x, pin.y);
  const sepRate = (vP.x - vK.x) * u.x + (vP.y - vK.y) * u.y;

  const mEff = (tractor.body.massKg * trailer.body.massKg)
             / (tractor.body.massKg + trailer.body.massKg);
  const damp = C.damp * 2 * Math.sqrt(C.springK * mEff);
  const springT = C.springK * gap;
  const raw = springT + clamp(damp * sepRate, -C.dampCapN, C.dampCapN);
  c.rawN = raw > 0 ? raw : 0;
  const T = clamp(raw, 0, C.maxForceN);
  c.forceN = T;

  trailer.body.applyForceAt(u.x * T, u.y * T, pin.x, pin.y,
                            CONFIG.debug.showForces ? 'pinTrailer' : '');
  tractor.body.applyForceAt(-u.x * T, -u.y * T, plate.x, plate.y,
                            CONFIG.debug.showForces ? 'pinTractor' : '');

  /* ── THE FOLD ─────────────────────────────────────────────────────────────────────
   * The POSITION spring is free inside `freeRad` and resists past it — that is the plate against
   * the back of the cab, and it is what `freeRad` means. The DAMPER acts everywhere, exactly as
   * the wheel lift's `alignDamp` does, and that is not a copied-by-accident line.
   *
   * A damper resists RATE and not displacement, so it costs no articulation: the pair still folds
   * to any angle inside the free range, it simply cannot snap there. MEASURED, a 12 kN·s shove at
   * the trailer's tail while the pair is under way:
   *
   *   shipped damper    worst fold 5.5 deg   2.1 deg after 5 s   0 zero crossings
   *   foldDamp at 0     worst fold 6.4 deg   2.3 deg after 5 s   0 zero crossings
   *
   * So it is NOT what puts a yaw disturbance away at these masses — the trailer's own tyres are
   * (applyYawResistance, sim/vehicle.js), and a pair released from past the fold limit settles in
   * exactly the same place with the damper switched off. It is kept unconditional because that is
   * `stepTowBar`'s shape and because the failure it insures against is one lift.js has already
   * paid for at the smaller scale — "a yaw mode with nothing damping it", which diverged two
   * hundred steps after a swerve. Cheap insurance, and honestly labelled as insurance.
   *
   * Equal-and-opposite, so the trailer leaning on the back of the cab is felt in the cab. */
  const over = Math.abs(c.foldRad) > C.freeRad
    ? Math.sign(c.foldRad) * (Math.abs(c.foldRad) - C.freeRad)
    : 0;
  const relOmega = trailer.body.omega - tractor.body.omega;
  const fold = clamp(-C.foldK * over - C.foldDamp * relOmega, -C.foldMaxNm, C.foldMaxNm);
  trailer.body.applyTorque(fold);
  tractor.body.applyTorque(-fold);
  c.foldTorqueNm = fold;

  /* ── THE BACKSTOP, JUDGED AS TRAVEL RATHER THAN AS FORCE ──────────────────────────
   * `pinBreakN` is what the steel takes, and the temptation is to compare it against `forceN`.
   * Two things are wrong with that. It is unreachable — `maxForceN` clamps the applied force to
   * 160 kN, below the 240 kN rating — and a force threshold fails on the first spike, which is
   * the lesson this project has written down four times over.
   *
   * So it is judged where a stiff spring makes it a position: `pinBreakN / springK` is 171 mm of
   * travel, and a position cannot spike. It is the same rule `maxGapM` is in recovery/lift.js —
   * "if the gap is that big the wheels are simply not in the yoke any more" — with the threshold
   * DERIVED from the rating rather than authored separately, so the two cannot drift.
   *
   * It is a solver backstop with a story, and what it insures against is the one thing a penalty
   * constraint genuinely cannot answer: an instantaneous velocity change inside the step it
   * arrives. MEASURED, a sideways impulse driven straight into the trailer —
   *
   *    4 kN·s ->  68 kN in the pin,   8 mm      15 kN·s -> 133 kN,  54 mm
   *    8 kN·s ->  85 kN,             24 mm      26 kN·s -> 160 kN, 115 mm
   *                                             40 kN·s -> the pin shears
   *
   * — against Milestone 5's own worst arrival, which is 14 989 N·s: a car that never saw you, at
   * night. That uses 54 mm of the 171, so nothing traffic can do takes a trailer off a tractor.
   * Sustained load never gets near it either: 45 kN held on a folded pair for thirty seconds
   * opens the pin 12.75 mm, which is what 18.8 kN through a 1.4 MN/m spring should be. */
  if (gap > C.pinBreakN / C.springK) {
    partCoupling(st, c, bus, simTimeMs, 'sheared');
    c.gapM = gap;
    return T;
  }

  return T;
}

/* ── reporting ─────────────────────────────────────────────────────────────── */

/** For the HUD, the inspect card and the tests. Facts, never advice — GDD §5. */
export function describeCoupling(st, C = CONFIG.coupling) {
  const c = couplingOf(st);
  if (!c) return null;
  const deg = Math.round(jackKnifeRad(st) * 57.3);
  const kN = (n) => (n / 1000).toFixed(1);
  const releaseFrac = clamp01(c.releaseMs / C.uncoupleMs);

  /* "Rated 22 kN, carrying 31" is the anchors' whole story and the player does the subtraction.
   * Same here: how far round it is folded, what the pin is carrying, and what the handle will
   * move under. Never "straighten it out first" and never "you cannot uncouple here". */
  const fold = deg === 0 ? 'Straight'
    : `Jack-knifed ${Math.abs(deg)}° to its ${deg > 0 ? 'right' : 'left'}`;
  let line;
  if (c.state === COUPLING.FREE) {
    line = `Uncoupled. ${fold}, and the trailer is on its own.`;
  } else if (c.state === COUPLING.RELEASING && c.refusal) {
    line = `${fold}. ${c.refusal}`;
  } else if (c.state === COUPLING.RELEASING) {
    line = `${fold}. Pulling the pin: ${(c.releaseMs / 1000).toFixed(1)} s of `
         + `${(C.uncoupleMs / 1000).toFixed(0)}.`;
  } else {
    line = `${fold}. ${kN(c.forceN)} kN through the pin; the handle will not move past `
         + `${kN(C.uncoupleMaxN)} kN.`;
  }

  return {
    state: c.state,
    tractor: c.tractorId,
    trailer: c.trailerId,
    coupled: c.state !== COUPLING.FREE,
    jackKnifeDeg: deg,
    jackKnifeRad: Math.round(jackKnifeRad(st) * 1000) / 1000,
    /** Past the free range, so it is being resisted rather than just bent. */
    folded: Math.abs(jackKnifeRad(st)) > C.freeRad,
    forceN: Math.round(c.forceN),
    gapMm: Math.round(c.gapM * 1000),
    foldTorqueNm: Math.round(c.foldTorqueNm),
    canUncouple: canUncouple(st, C),
    refusal: c.state === COUPLING.FREE ? null : uncoupleRefusal(st, C),
    releaseFrac: Math.round(releaseFrac * 100) / 100,
    separated: c.separated,
    line,
  };
}
