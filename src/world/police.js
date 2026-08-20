/* Police, and the road closure that keeps them away. GDD §7 Milestone 7: "Scene safety and
 * the authorities."
 *
 * ── A CLOSURE IS THE CONES, FORMALISED ───────────────────────────────────────────────
 * Nothing here is a new mechanic to learn. The crew can already place cones, and
 * world/traffic.js already reads them back as a work zone that slows passing traffic — three
 * cones already take a rural road from about 78 km/h to about 40 (traffic.js zoneSlowPerCone,
 * measured by the m5 suite's AE10-12). That existing mechanic IS the "measurable change" this
 * milestone asks a closure to earn; nothing here adds a second one. What was missing is a
 * STANDARD: a work zone only counts as a CLOSURE once it is enough cones, spread far enough,
 * actually either side of whatever is blocking the road — and that is computed from where the
 * cones and the obstruction ARE, never from a flag the player sets.
 *
 * ── "UNSAFE" IS A MEASURED CONDITION, NOT A TIMER ────────────────────────────────────
 * A vehicle stopped across the live carriageway with no closure is a hazard; one that has been
 * that way for a heartbeat is not — GDD §7 asks for "long enough to matter". The anchors
 * (recovery/anchors.js) already answer this shape of question for a physical overload: judge an
 * ACCUMULATED quantity against a threshold, decaying while the condition does not hold, rather
 * than a binary "is it bad right now". There is no force here — an unprotected road is not a
 * newton reading, so this is deliberately NOT judged in newton-seconds the way the anchors and
 * the wheel lift are — but the shape is the same one on purpose: `unsafeSec` climbs while the
 * road is obstructed and unclosed, decays once it is not, and CROSSING THE THRESHOLD is the
 * event, not "however long the flag happened to be true for". A cone clipped by a wheel for one
 * frame must not both dispatch a unit and stand it down again on the next step; accumulate-and-
 * decay is what stops that, in seconds of exposure rather than newtons of load.
 *
 * ── WHY IT NEVER JOINS THE CONTACT PASS ──────────────────────────────────────────────
 * A responding unit is a vehicle on the road, and the obvious way to build that is a Body in
 * `dynamics` next to the traffic cars in game.js — right up until it is asked to brake for, or
 * be braked for by, the recovery it was sent to protect. This module's own brief warns against
 * exactly that: a police unit must not be able to shove the truck or the casualty around.
 * traffic.js earns real contact physics because ordinary traffic has to be dodgeable, hittable
 * and worth putting cones out for; a police unit doesn't need any of that; it has one job,
 * driving to a fixed point and stopping. With no way to edit sim/collision.js's pairing rules
 * from this file, it is far safer to keep it OUT of the dynamics array entirely than to add a
 * body that could, on the wrong step, put a contact impulse into the very recovery it turned
 * out for. It still drives in kinematically (see driveTowards) and parks on the shoulder, clear
 * of both travel lanes, so it reads as a real arrival without ever being a real obstacle.
 *
 * ── WHY THERE IS NO EXPLICIT "JOB ENDED" CHECK ───────────────────────────────────────
 * GDD §7 asks a unit to stay "until it is safe or the job ends". Delivering the car means
 * driving it into the yard bay (world/scene.js YARD.bay), which is off the live carriageway by
 * definition — so the moment the job actually ends, `obstructionExtent` below already finds
 * nothing stopped on the road and the unit stands itself down for being safe. Importing job
 * phase from world/scene.js to check the same fact a second time would also point this module's
 * imports back at the file that imports IT, for a condition that is already true by the time it
 * would fire.
 */

import { CONFIG } from '../config.js';
import { EVENTS } from '../core/eventBus.js';
import { clamp } from '../core/vec.js';
import { BANDS } from '../data/terrain.js';
import { workZone } from './traffic.js';

/* The four event names this module emits, read off `EVENTS` with a same-named string fallback.
 * Every event in core/eventBus.js is named identically to its own value (`SIM_RESET: 'SIM_RESET'`,
 * and so on without exception), so `EVENTS.POLICE_CITED || 'POLICE_CITED'` is exactly
 * `EVENTS.POLICE_CITED` once eventBus.js carries these four keys, and a real string instead of
 * `undefined` before it does. The same seam as `P = CONFIG.police` below, for the same reason:
 * this module runs and is measured (tools/_probe-police.js) before its own event names exist
 * anywhere but here. */
const POLICE_DISPATCHED = EVENTS.POLICE_DISPATCHED || 'POLICE_DISPATCHED';
const POLICE_ON_SCENE = EVENTS.POLICE_ON_SCENE || 'POLICE_ON_SCENE';
const POLICE_CITED = EVENTS.POLICE_CITED || 'POLICE_CITED';
const POLICE_CLEARED = EVENTS.POLICE_CLEARED || 'POLICE_CLEARED';

/* `P = CONFIG.police` as a default parameter, on every function below that needs a tunable,
 * rather than each one reading `CONFIG.police` off the module import directly. Every real call
 * site — game.js, the HUD — passes nothing for it and gets the real CONFIG, so this changes
 * nothing about how the module runs. What it buys is a seam: this module was built and measured
 * before CONFIG.police existed, one file at a time and without editing config.js to do it (see
 * tools/_probe-police.js), and the seam is what let that happen without a second, fake copy of
 * the numbers living in the test file instead of in this one. */

/** Where a unit is in its callout. Ownership of "is anyone coming" lives here, on the object,
 *  not on a flag the player sets — see the module note above. */
export const POLICE = Object.freeze({
  NONE:     'none',      // nobody has been called
  ENROUTE:  'enroute',   // driving in
  ON_SCENE: 'onScene',   // parked, watching
});

export function createPolice() {
  return {
    state: POLICE.NONE,
    /** Accumulated exposure, in SECONDS — see the module note on why this is seconds and not
     *  newton-seconds. */
    unsafeSec: 0,
    /** How many citations this attempt. The payout multiplies this by CONFIG.police.citationN
     *  itself — see world/scene.js computePayout — so there is exactly one place that number
     *  is spent rather than two records of it. */
    citations: 0,
    x: 0, y: 0, angle: 0,
    fromX: 0, toX: 0, toY: 0,
    speedMps: 0, cruiseMps: 0,
    calledAtMs: null,
  };
}

/**
 * Where the live carriageway is actually blocked right now: the x-span of every STOPPED
 * vehicle's on-road corners.
 *
 * "Stopped" uses `CONFIG.success.maxSpeedMps` — the exact line stepGoal (world/scene.js) already
 * draws between "arrived" and "still moving" — so a wrecker driving the load home at ordinary
 * speed is not an obstruction merely for using the same tarmac ordinary traffic does. It only
 * counts once it has actually stopped there, which is the situation the cones exist to protect
 * and the only situation a closure can be built around.
 */
function obstructionExtent(st) {
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const id of Object.keys(st.vehicles)) {
    const v = st.vehicles[id];
    if (v.body.speed > CONFIG.success.maxSpeedMps) continue;
    for (const c of v.body.corners()) {
      if (!st.terrain.onRoad(c.x, c.y)) continue;
      if (c.x < x0) x0 = c.x;
      if (c.x > x1) x1 = c.x;
    }
  }
  return x0 <= x1 ? { present: true, x0, x1 } : { present: false, x0: 0, x1: 0 };
}

/**
 * Is the road obstructed, and if so, is it properly closed?
 *
 * Reuses `workZone` (world/traffic.js) rather than re-reading the cone pile — the same gear is
 * both mechanics, and the day this module computed its own idea of "how many cones are out" is
 * the day it could quietly disagree with the one traffic actually reacts to.
 *
 * A closure is three things, all geometry, never a flag: enough cones, spread over enough road
 * to be a taper rather than a pile dropped in one spot, and actually bracketing whatever is
 * stopped.
 */
export function closureStandard(st, P = CONFIG.police) {
  const ob = obstructionExtent(st);
  const zone = workZone(st);
  if (!ob.present) return { obstructed: false, closed: true, zone, obstruction: ob };

  const spread = zone.cones > 0 ? zone.x1 - zone.x0 : 0;
  /* Bracket, not merely reach: the cone zone has to extend PAST each end of the obstruction by
   * at least the margin, not just up to it. Caught by measurement (tools/_probe-police.js): the
   * first draft had these two comparisons the other way round, which required the zone to reach
   * only to WITHIN a margin of each edge — so a generous margin could pass a closure whose cones
   * never reached the obstruction at all. Three cones dumped in the middle of a 9 m truck's own
   * footprint should not count as closing the road round it. */
  const closed = zone.cones >= P.closureMinCones
    && spread >= P.closureMinSpreadM
    && zone.x0 <= ob.x0 - P.closureCoverMarginM
    && zone.x1 >= ob.x1 + P.closureCoverMarginM;
  return { obstructed: true, closed, zone, obstruction: ob };
}

/** Send a unit. Spawns off whichever edge of the world is nearer, so the drive stays short and
 *  the direction is legible — the same reasoning traffic.js spawns off the nearer approach. */
function dispatch(st, P, rng, simTimeMs, bus) {
  const pol = st.police;
  const ob = obstructionExtent(st);
  const worldW = st.terrain.world.widthM;
  const midX = ob.present ? (ob.x0 + ob.x1) / 2 : worldW / 2;
  const fromEast = midX > worldW / 2;

  pol.fromX = fromEast ? worldW + P.spawnMarginM : -P.spawnMarginM;
  pol.toX = clamp(midX, 4, worldW - 4);
  pol.toY = BANDS.roadS + P.parkOffsetM;     // the shoulder, clear of both travel lanes
  pol.x = pol.fromX;
  pol.y = pol.toY;
  pol.angle = fromEast ? Math.PI : 0;
  // Presentation-only spread on the response speed, drawn from the fx stream (see game.js
  // STREAMS): it can change how the arrival LOOKS without shifting WHEN it happens, because
  // nothing that gates a citation ever reads this stream.
  pol.cruiseMps = P.respondMps * (0.92 + rng.range(0, 0.16));
  pol.speedMps = pol.cruiseMps;
  pol.state = POLICE.ENROUTE;
  pol.calledAtMs = simTimeMs;
  bus.emit(POLICE_DISPATCHED,
    { fromX: Math.round(pol.fromX), toX: Math.round(pol.toX) }, simTimeMs);
}

/**
 * Kinematic approach to the parked spot: constant speed, then a textbook braking curve
 * (`v = sqrt(2*a*d)` — the same stopping-distance shape traffic.js uses to hold up for an
 * obstruction) over the final stretch, snapped the last few centimetres. The snap is legitimate
 * for the same reason engageLift's one-off placement is (recovery/lift.js): it happens once, and
 * decaying asymptotically toward zero is otherwise a curve that never quite finishes.
 */
function driveTowards(pol, P, dtSec) {
  const dir = pol.toX >= pol.fromX ? 1 : -1;
  const remaining = Math.max(0, (pol.toX - pol.x) * dir);
  if (remaining < P.arriveSnapM) { pol.x = pol.toX; pol.speedMps = 0; return; }
  const stopSpeed = Math.sqrt(2 * P.brakeMps2 * remaining);
  pol.speedMps = Math.min(pol.cruiseMps, stopSpeed);
  pol.x += dir * pol.speedMps * dtSec;
}

/**
 * One step. Runs as a REPORT, alongside stepGoal/stepJob/stepEscalation/stepCustomer — it reads
 * where the vehicles ended up this step and never applies a force to anything, so where exactly
 * it sits relative to THEM does not matter. It does have to run after the vehicles have actually
 * moved and after stepJob, or "obstructed" and "delivered" would both be reading one step stale.
 */
export function stepPolice(st, dtSec, rng, bus, simTimeMs, P = CONFIG.police) {
  const pol = st.police;
  if (!pol) return;

  const std = closureStandard(st, P);

  if (!std.obstructed || std.closed) {
    pol.unsafeSec = Math.max(0, pol.unsafeSec - P.recoverPerSec * dtSec);
    if (pol.state !== POLICE.NONE) {
      pol.state = POLICE.NONE;
      bus.emit(POLICE_CLEARED, {}, simTimeMs);
    }
    return;
  }

  pol.unsafeSec += dtSec;
  /* WHO IS THERE DECIDES WHETHER IT COSTS ANYTHING. The first crossing only turns a unit out;
   * nothing is written down until somebody is actually standing at the scene to write it. The
   * draft cited on the same step it dispatched, which meant the fine arrived before the car did
   * — money moving with nobody there to move it, and no chance to get the cones out between
   * being noticed and being charged. Now: cross the line and a unit is called (free); it drives
   * in; the citation is issued the step it parks, and again every dispatchSec the road is still
   * open after that. Close the road while it is en route and it turns round having cost nothing,
   * which is the whole point of the gap.
   *
   * Reset on each action for the reason a tree's pullNs resets once it goes over
   * (recovery/anchors.js): a continued violation has to earn the NEXT citation rather than
   * free-run past the first one. */
  if (pol.unsafeSec >= P.dispatchSec) {
    if (pol.state === POLICE.NONE) {
      pol.unsafeSec = 0;
      dispatch(st, P, rng, simTimeMs, bus);
    } else if (pol.state === POLICE.ON_SCENE) {
      pol.unsafeSec = 0;
      cite(pol, P, bus, simTimeMs);
    }
    /* ENROUTE and already over the line again: deliberately NOT reset. Nobody has arrived, so
     * nothing is charged, and leaving the accumulator over the threshold means the citation
     * lands the step they park rather than a whole dispatchSec after it. Unreachable at the
     * shipped numbers — 45 s to cross against a 5 s drive — but it is the branch that would
     * silently swallow a violation if it were written the obvious way. */
  }

  if (pol.state === POLICE.ENROUTE) {
    driveTowards(pol, P, dtSec);
    if (pol.x === pol.toX) {
      pol.state = POLICE.ON_SCENE;
      pol.speedMps = 0;
      bus.emit(POLICE_ON_SCENE, {}, simTimeMs);
      // Turning up IS the first citation: the road is still open, and now there is somebody
      // here who has seen it. The clock for the next one starts from the arrival.
      pol.unsafeSec = 0;
      cite(pol, P, bus, simTimeMs);
    }
  }
}

/** One citation. Only ever called with a unit ON SCENE — see the note in stepPolice. */
function cite(pol, P, bus, simTimeMs) {
  pol.citations++;
  bus.emit(POLICE_CITED, {
    citations: pol.citations, amountN: P.citationN, totalN: pol.citations * P.citationN,
  }, simTimeMs);
}

/** For the HUD and the tests. A fact, never advice — GDD §5: what the closure IS, not what to
 *  do about it. Recomputes `closureStandard` rather than caching it, the same rule the rest of
 *  the equipment follows (see the note at the top of recovery/gear.js). */
export function describePolice(st, P = CONFIG.police) {
  const pol = st.police;
  if (!pol) return null;
  const std = closureStandard(st, P);
  const r1 = (v) => Math.round(v * 10) / 10;

  let line;
  if (!std.obstructed) line = 'Clear.';
  else if (std.closed) {
    line = `Closed: ${std.zone.cones} cones across ${Math.round(std.zone.x1 - std.zone.x0)} m.`;
  } else if (pol.state === POLICE.NONE) {
    line = `Unprotected, ${r1(pol.unsafeSec)} of ${P.dispatchSec}s.`;
  } else if (pol.state === POLICE.ENROUTE) {
    line = 'A unit is on its way.';
  } else {
    line = `On scene. ${pol.citations} citation${pol.citations === 1 ? '' : 's'}, `
      + `£${pol.citations * P.citationN}.`;
  }

  return {
    state: pol.state,
    obstructed: std.obstructed,
    closed: std.closed,
    cones: std.zone.cones,
    unsafeSec: r1(pol.unsafeSec),
    citations: pol.citations,
    citationTotalN: pol.citations * P.citationN,
    x: r1(pol.x), y: r1(pol.y),
    line,
  };
}
