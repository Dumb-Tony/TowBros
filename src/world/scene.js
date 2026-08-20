/* Scene assembly, the one objective, and the recap that answers the GDD's north star.
 *
 * GDD §9: "After a recovery, do players describe what THEY did — where they parked, what
 * they attached to, what broke, and how they saved it — or do they describe what the mission
 * told them to do?"
 *
 * A game cannot make a player say the first thing. What it can do is (a) never tell them
 * what to do, and (b) be able to read the story back to them afterwards from what actually
 * happened. recapFrom() below does the second one, straight off the event log. Everything in
 * it is a fact about a decision the player made. There is no par time, no score, and no
 * grade — GDD §8 defers all of that, and this milestone has nothing to grade.
 */

import { CONFIG } from '../config.js';
import { EVENTS } from '../core/eventBus.js';
import { createTerrain, siteById } from '../data/terrain.js';
import { weatherById } from './weather.js';
import { createTraffic } from './traffic.js';
import { SEDAN_DEF, TRUCK_DEF } from '../data/vehicles.js';
import { createGearPile } from '../data/equipment.js';
import { createVehicle, cornersOnRoad } from '../sim/vehicle.js';
import { buildScenery } from '../sim/collision.js';
import { createWinch } from '../recovery/cable.js';
import { createLift, LIFT } from '../recovery/lift.js';
import { createCrewMember } from '../player/player.js';

/**
 * Build one attempt. Every draw from `rng` is a variation the GDD asked for; none of them
 * change which approaches work.
 *
 * @param {import('../core/rng.js').Rng} rng  the world stream
 */
/**
 *  {object|null} job  the dispatch offer's modifiers and loadout, or null for a plain job.
 *   Milestone 4 lets a job vary how deep the car is in, how much of it is already broken and what
 *   gear the outfit turned up with — and NOTHING ELSE. GDD §4's "no scripted sequence and no
 *   mandatory tool" is a Milestone 1 promise, and a dispatch board does not get to take it back:
 *   every approach that worked on the first job works on all of them.
 */
export function buildScene(rng, crewCount = CONFIG.crew.count, job = null) {
  // WHERE this job is. Milestone 5 gave the county four sites; a job with no site named is the
  // bend, which is the Milestone 1 scene to the last decimal.
  const site = siteById(job && job.siteId);
  const terrain = createTerrain(rng, site);
  // The forecast, which the player saw on the board before taking the job. One grip number and one
  // light level — see world/weather.js for why it is deliberately not more than that.
  const weather = weatherById(job && job.weatherId);
  terrain.weather = weather;
  terrain.gripMul = weather.gripMul;
  const mods = (job && job.mods) || {};

  // Which of the sedan's wheels are SEIZED — jammed hubs, not braked ones.
  //
  // The rear pair are deliberately NOT in here. They are held by the parking brake, which
  // `createVehicle` already sets for an undriven vehicle, and the tire model reads as
  // `w.park && veh.parkBrake`. Listing them as seized as well made the handbrake inert: a player
  // who reached in and released it changed nothing, because the wheels were locked twice and only
  // one of the locks was theirs to undo. The distinction this comment always claimed now exists.
  //
  // A jammed front wheel is the genuinely stuck case, and it survives releasing the brake.
  const locked = [];
  if (rng.chance(mods.seizedChance === undefined ? 0.45 : mods.seizedChance)) {
    locked.push(rng.chance(0.5) ? 'wheelFL' : 'wheelFR');
  }

  const boggedN = (CONFIG.sedan.boggedBaseN + rng.spread(CONFIG.sedan.boggedRangeN))
    * (mods.boggedMul || 1);

  /* How it is lying. The single biggest source of variety between jobs, so a dispatch offer is
   * allowed to widen it — an "awkward lie" is a car across the slope, where the straight pull is
   * not the answer. Drawn from the SAME rng, so the whole scene stays reproducible from its seed. */
  const lieAnchor = { ...terrain.anchors.sedan };
  const extraSpread = Math.max(0, (mods.lieSpread || 1) - 1) * 0.30;
  if (extraSpread > 0) lieAnchor.angle += rng.spread(extraSpread);
  if (mods.lieBias) lieAnchor.angle += mods.lieBias;

  const sedan = createVehicle(SEDAN_DEF, lieAnchor, { boggedN, lockedWheels: locked });
  const truck = createVehicle(TRUCK_DEF, terrain.anchors.truck, {});

  /* What the outfit's own truck is like. Milestone 4: a neglected wrecker is a worse wrecker, and
   * these are the only three places that fact reaches the physics. Defaults of 1 mean a game with
   * no company behind it behaves exactly as it did in Milestones 1-3. */
  const eff = (job && job.effects) || null;
  if (eff) {
    truck.driveMul = eff.driveMul;
    truck.brakeMul = eff.brakeMul;
  }
  truck.parkBrake = true;
  truck.lift = createLift();

  // Zone modifiers and rigging live on the vehicle, not on the definition: the definition is
  // shared, frozen data and one attempt's torn bumper must not follow the player into the next.
  for (const v of [sedan, truck]) { v.zoneMod = {}; v.rigging = {}; }

  // A little pre-existing damage, sometimes. GDD §4: the sedan arrives with "a damage state",
  // and a job that starts with a dented car is a job with a history.
  if (rng.chance(mods.dentChance === undefined ? 0.35 : mods.dentChance)) {
    sedan.damage.dents = rng.int(1, mods.dentsMax || 3);
  }
  // Baseline it, so the payout charges for what the RECOVERY did and not for the crash.
  sedan.damage.arrived = { dents: sedan.damage.dents, parts: { ...sedan.damage.parts } };

  const gear = createGearPile(terrain.anchors.gearPile, rng, job && job.loadout);

  // The crew. GDD §7 Milestone 2 puts two to four of them on site; they arrive together, spread
  // along the shoulder beside the truck rather than stacked on one spawn point.
  const crew = [];
  const n = Math.max(1, Math.min(CONFIG.crew.maxCount, crewCount | 0));
  for (let i = 0; i < n; i++) {
    crew.push(createCrewMember(`crew${i}`, i, {
      x: terrain.anchors.player.x - i * 1.5,
      y: terrain.anchors.player.y + (i % 2) * 0.9,
    }));
  }

  const st = {
    terrain,
    scenery: buildScenery(terrain),
    vehicles: { truck, sedan },
    gear,
    crew,
    winch: createWinch(eff ? eff.cableMul : 1),
    /* A live carriageway (Milestone 5). Absent when a job says so, because the yard's own approach
     * road is not the A-road and a test that does not care should not have to step it. */
    traffic: (job && job.traffic === false) ? null : createTraffic(),
    blocksById: {},
    debris: [],
    nextDebrisId: 1,
    goal: {
      cornersOnRoad: 0,
      settledMs: 0,
      complete: false,
      completedAtMs: null,
    },
    /* The JOB, which is bigger than the recovery. GDD §7 Milestone 3 turns "get the car out of the
     * ditch" into "get the car to the yard", and the recovery becomes its first phase rather than
     * its ending. `goal` above is untouched and still means exactly what it meant in Milestone 1 —
     * the car is on the road — because that is a real milestone in the job and because two hundred
     * assertions depend on it meaning that. */
    job: {
      phase: JOB.RECOVER,
      /* What this particular callout is worth, relative to the standard fee. A dispatch offer that
       * advertises £1890 has to PAY £1890 less deductions — the board's number and the results
       * card's number are the same promise, and they were not: the payout read CONFIG.job.baseFee
       * directly and quietly paid the standard fee for a job the player took because it paid more. */
      feeMul: (job && job.feeMul) || 1,
      offerId: (job && job.id) || null,
      offerType: (job && job.type) || null,
      inBayMs: 0,
      deliveredAtMs: null,
      payout: null,
      droppedInTransit: 0,
      bayCorners: 0,
    },
    escalation: {
      truckSlipping: false,
      truckOffPavement: false,
      truckInDitch: false,
      worstTruckSlipMps: 0,
      _saidMs: -9999,
    },
    /** Presentation-only, written by the sim and read by the renderer. */
    fx: { particles: [], impacts: [], snapFlashMs: 0, peakImpulse: 0 },
  };

  /* `st.player` is crew[0], BY REFERENCE not by copy.
   *
   * The renderer, the HUD and the m1 suite were all written against a single player, and there is
   * no reason to churn them to prove a point: the first crew member IS the local player, and a
   * reference cannot fall out of sync the way a duplicate would. Anything that genuinely has to
   * handle several people — drawing them, the authority checks — reads `st.crew`. */
  st.player = crew[0];
  return st;
}

/**
 * The single objective: get the sedan onto the road, and let go of it.
 *
 * "Settled" matters. Without it, a sedan launched across the pavement by a parting cable
 * would count as recovered while it was still airborne over the far shoulder — which is
 * funny exactly once.
 */
export function stepGoal(st, bus, simTimeMs) {
  const goal = st.goal;
  if (goal.complete) return true;

  const sedan = st.vehicles.sedan;
  const on = cornersOnRoad(sedan, st.terrain);
  goal.cornersOnRoad = on.on;

  const settled = sedan.body.speed <= CONFIG.success.maxSpeedMps;
  const met = CONFIG.success.requireAllCorners ? on.all : on.on >= 2;

  if (met && settled) {
    goal.settledMs += CONFIG.sim.stepMs;
    if (goal.settledMs >= CONFIG.success.settleMs) {
      goal.complete = true;
      goal.completedAtMs = simTimeMs;
      bus.emit(EVENTS.RECOVERY_COMPLETE, {
        atMs: simTimeMs,
        cornersOnRoad: on.on,
        sedanDents: sedan.damage.dents,
        partsLost: Object.entries(sedan.damage.parts).filter(([, s]) => s === 'lost').map(([p]) => p),
      }, simTimeMs);
      return true;
    }
  } else {
    goal.settledMs = 0;
  }
  return false;
}

/* ── the job ───────────────────────────────────────────────────────────────── */

/**
 * The phases of a complete job. GDD §7 Milestone 3.
 *
 * Deliberately a description of where the car IS, not a checklist the player is working through.
 * Nothing here tells anyone what to do next; the HUD's one objective line reads the phase and says
 * what is true, the way it always has. A player who winches the car out and then drives home
 * without it has not failed a step — they have left the car on the road, and the phase says so.
 */
export const JOB = Object.freeze({
  RECOVER:  'recover',    // the car is in the ditch
  LOAD:     'load',       // the car is out, and on the ground
  TRANSPORT: 'transport', // the car is on the lift
  DELIVERED: 'delivered', // the car is standing in the bay
});

/** How many of a vehicle's corners are inside the yard bay. */
export function cornersInBay(veh, terrain) {
  const c = veh.body.corners();
  let n = 0;
  for (const p of c) if (terrain.inBay(p.x, p.y)) n++;
  return { on: n, of: c.length, all: n === c.length };
}

/**
 * What the job paid. GDD §7 Milestone 3: "damage-based payout".
 *
 * A payout, not a grade. There is no par time and no stars — GDD §9's north star is whether the
 * player describes what THEY did, and a letter grade at the end answers that question for them.
 * What this does is put a number on the thing they already knew: the bumper they tore off is worth
 * something, and it came out of the fee.
 *
 * Every deduction names the decision that caused it, so the recap can read back "you got £X, less
 * £Y for the bumper" rather than a single unexplained figure.
 */
export function computePayout(st, bus) {
  const P = CONFIG.job;
  const baseFee = Math.round(P.baseFee * (st.job.feeMul || 1));
  const sedan = st.vehicles.sedan;
  /* Only what THIS job did to it. The car arrives with a damage state (GDD §4), and charging the
   * operator for the crash they were called out to is not a consequence of any decision they made.
   * MEASURED: a "dug in overnight" job advertised at £1890 paid £1810, because the two dents it
   * turned up with came off the fee. */
  const arrived = sedan.damage.arrived || { dents: 0, parts: {} };
  const causedDents = Math.max(0, sedan.damage.dents - (arrived.dents || 0));
  const parts = Object.entries(sedan.damage.parts).filter(([p, s]) => arrived.parts[p] !== s);
  const lost = parts.filter(([, s]) => s === 'lost');
  const bent = parts.filter(([, s]) => s === 'bent');

  const deductions = [];
  const take = (label, amount) => { if (amount > 0) deductions.push({ label, amount: Math.round(amount) }); };

  take(`${causedDents} dent${causedDents === 1 ? '' : 's'}`, causedDents * P.dentCost);
  for (const [p] of lost) take(`lost the ${p}`, P.partLostCost);
  for (const [p] of bent) take(`bent the ${p}`, P.partBentCost);
  const snaps = bus.count(EVENTS.CABLE_SNAPPED);
  take(snaps === 1 ? 'parted the cable' : `parted the cable ${snaps}x`, snaps * P.cableCost);
  const rails = bus.count(EVENTS.GUARDRAIL_BENT);
  take(rails === 1 ? 'damaged the guardrail' : `damaged ${rails} guardrail sections`, rails * P.railCost);
  take('dropped the load in transit', (st.job.droppedInTransit || 0) * P.dropCost);
  if (bus.count(EVENTS.ROLLED_OVER) > 0) take('rolled a vehicle', bus.count(EVENTS.ROLLED_OVER) * P.rollCost);

  const total = deductions.reduce((a, d) => a + d.amount, 0);
  const paid = Math.max(P.minimumFee, baseFee - total);
  return {
    baseFee,
    deductions,
    deducted: total,
    paid,
    clean: total === 0,
    /** True when the deductions bottomed out — the job cost more than it was worth. */
    floored: baseFee - total < P.minimumFee,
  };
}

/**
 * Where the job has got to. Runs every step, after the goal.
 *
 * The phases only ever move forward except LOAD <-> TRANSPORT, which flips both ways because
 * setting a car down and picking it up again is a normal thing to do and dropping one is a normal
 * thing to have happen.
 */
export function stepJob(st, bus, simTimeMs) {
  const job = st.job;
  if (job.phase === JOB.DELIVERED) return job.phase;

  const sedan = st.vehicles.sedan;
  const lift = st.vehicles.truck.lift;
  const carrying = lift.carryingId === sedan.id;

  const to = (phase) => {
    if (job.phase === phase) return;
    bus.emit(EVENTS.JOB_PHASE, { from: job.phase, to: phase }, simTimeMs);
    job.phase = phase;
  };

  const bay = cornersInBay(sedan, st.terrain);
  job.bayCorners = bay.on;

  if (carrying) {
    to(JOB.TRANSPORT);
    job.inBayMs = 0;
    return job.phase;
  }

  /* Delivered: standing in the bay, on its own wheels, settled. Deliberately NOT "the truck is in
   * the yard" — the job is where the car ends up, and a player who shoves it into the bay with the
   * bumper instead of setting it down there has still delivered it. */
  const settled = sedan.body.speed <= CONFIG.success.maxSpeedMps;
  if (bay.all && settled) {
    job.inBayMs += CONFIG.sim.stepMs;
    if (job.inBayMs >= CONFIG.job.settleMs) {
      job.deliveredAtMs = simTimeMs;
      job.payout = computePayout(st, bus);
      to(JOB.DELIVERED);
      bus.emit(EVENTS.JOB_DELIVERED, {
        atMs: simTimeMs,
        paid: job.payout.paid,
        deducted: job.payout.deducted,
        clean: job.payout.clean,
      }, simTimeMs);
      return job.phase;
    }
  } else {
    job.inBayMs = 0;
  }

  // Out of the ditch but not on the truck: it is a load waiting to be picked up.
  to(st.goal.complete ? JOB.LOAD : JOB.RECOVER);
  return job.phase;
}


/**
 * Escalation watch. GDD §4 lists "accidental escalation in which the tow truck slides into
 * the recovery zone" as a SUPPORTED APPROACH, not a failure — so this reports it rather than
 * punishing it. The event exists so the log can tell that part of the story.
 */
export function stepEscalation(st, bus, simTimeMs) {
  const e = st.escalation;
  const truck = st.vehicles.truck;
  const b = truck.body;

  const on = cornersOnRoad(truck, st.terrain);
  e.truckOffPavement = on.on < on.of;
  e.truckInDitch = b.y > st.terrain.bands.shoulderS + 1.5;

  // Slipping means: nobody is driving it, and it is moving anyway.
  const driven = truck.occupied && (truck.throttle !== 0);
  const slipping = !driven && b.speed > 0.45 && st.winch.tensionN > 4000;
  if (slipping) e.worstTruckSlipMps = Math.max(e.worstTruckSlipMps, b.speed);

  if (slipping && !e.truckSlipping && simTimeMs - e._saidMs > 2500) {
    e._saidMs = simTimeMs;
    bus.emit(EVENTS.TRUCK_SLIPPING, {
      speed: Math.round(b.speed * 100) / 100,
      tensionN: Math.round(st.winch.tensionN),
      surface: st.terrain.surfaceAt(b.x, b.y).id,
    }, simTimeMs);
  }
  e.truckSlipping = slipping;
}

/**
 * Read the job back off the event log, in the order it happened.
 *
 * This is the answer to the north-star question made mechanical: every line is something the
 * player chose or something their choice caused. Nothing here is authored per-scenario, so it
 * works for outcomes nobody designed.
 */
export function recapFrom(bus, st) {
  const lines = [];
  const seenRig = new Set();

  // bus.story, not bus.log: the log is a ring and evicts its oldest entries, so on any recovery
  // long enough to be worth recapping it had already thrown away the beginning — which is the
  // part where the player made their decisions.
  for (const e of bus.story) {
    const t = (e.simTimeMs / 1000).toFixed(1);
    switch (e.type) {
      case EVENTS.RIG_APPLIED:
        if (!seenRig.has(e.zone + e.rig)) {
          seenRig.add(e.zone + e.rig);
          lines.push([t, `wrapped a ${e.rig} round the ${e.zone}`]);
        }
        break;
      case EVENTS.BLOCK_MOUNTED: lines.push([t, 'mounted the snatch block on a tree']); break;
      case EVENTS.BRAKE_SET:
        lines.push([t, e.on ? "set the sedan's parking brake" : "released the sedan's parking brake"]);
        break;
      case EVENTS.CABLE_ROUTED:
        lines.push([t, e.removed ? 'took the line back out of the block' : 'ran the line through the block']);
        break;
      case EVENTS.HOOK_ATTACHED:
        lines.push([t, `hooked the ${e.zoneLabel} (${e.rig}, good for ${(e.capacityN / 1000).toFixed(0)} kN)`]);
        break;
      case EVENTS.WINCH_STALLED:
        lines.push([t, `winch stalled at ${(e.tensionN / 1000).toFixed(1)} kN`]);
        break;
      case EVENTS.ZONE_FAILED:
        lines.push([t, e.mode === 'bent'
          ? `bent the ${e.zoneLabel} at ${(e.loadN / 1000).toFixed(1)} kN`
          : `tore the ${e.zoneLabel} off at ${(e.loadN / 1000).toFixed(1)} kN`]);
        break;
      case EVENTS.CABLE_SNAPPED:
        lines.push([t, `parted the cable at ${(e.tensionN / 1000).toFixed(1)} kN`]);
        break;
      case EVENTS.COMPONENT_DETACHED:
        if (e.label) lines.push([t, `lost a ${e.label}`]);
        break;
      case EVENTS.TRUCK_SLIPPING:
        lines.push([t, `the truck started sliding on ${e.surface}`]);
        break;
      case EVENTS.GUARDRAIL_BENT:
        lines.push([t, e.broken ? 'took out a section of guardrail' : 'bent the guardrail']);
        break;
      case EVENTS.ROLLED_OVER:
        lines.push([t, `rolled the ${e.vehicle}`]);
        break;
      case EVENTS.GEAR_SCATTERED:
        lines.push([t, `the ${e.kind} was knocked out of place`]);
        break;
      case EVENTS.RECOVERY_COMPLETE:
        lines.push([t, 'the sedan was on the road']);
        break;
      case EVENTS.LIFT_ENGAGED:
        lines.push([t, `picked the ${e.vehicle} up by its ${e.end} axle`]);
        break;
      case EVENTS.LOAD_SECURED:
        lines.push([t, `strapped the load down — ${e.straps} on, good for ${(e.capacityN / 1000).toFixed(0)} kN`]);
        break;
      case EVENTS.LIFT_RELEASED:
        lines.push([t, e.dropped
          ? `DROPPED the load at ${e.x}, ${e.y}`
          : `set the load down at ${e.x}, ${e.y}`]);
        break;
      case EVENTS.JOB_DELIVERED:
        lines.push([t, `delivered${e.clean ? ', without a scratch' : ''}`]);
        break;
      default: break;
    }
  }

  const sedan = st.vehicles.sedan;
  const lost = Object.entries(sedan.damage.parts).filter(([, s]) => s === 'lost').map(([p]) => p);
  const bent = Object.entries(sedan.damage.parts).filter(([, s]) => s === 'bent').map(([p]) => p);

  return {
    lines,
    summary: {
      partsLost: lost.length,
      partsBent: bent.length,
      dents: sedan.damage.dents,
      cableSnaps: bus.count(EVENTS.CABLE_SNAPPED),
      zoneFailures: bus.count(EVENTS.ZONE_FAILED),
      truckSlipped: bus.count(EVENTS.TRUCK_SLIPPING) > 0,
      guardrailHit: bus.count(EVENTS.GUARDRAIL_BENT) > 0,
      attachments: bus.count(EVENTS.HOOK_ATTACHED),
      usedBlock: bus.count(EVENTS.BLOCK_MOUNTED) > 0,
      complete: st.goal.complete,
      timeMs: st.goal.completedAtMs,
      /* The job, which is bigger than the recovery. `complete` above still means the Milestone 1
       * thing — the car reached the road — because that is a real moment in the job and because a
       * great many assertions depend on it meaning exactly that. */
      phase: st.job.phase,
      delivered: st.job.phase === JOB.DELIVERED,
      deliveredAtMs: st.job.deliveredAtMs,
      droppedInTransit: st.job.droppedInTransit,
      strapsUsed: bus.count(EVENTS.LOAD_SECURED),
      payout: st.job.payout,
    },
  };
}
