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
import { createTerrain } from '../data/terrain.js';
import { SEDAN_DEF, TRUCK_DEF } from '../data/vehicles.js';
import { createGearPile } from '../data/equipment.js';
import { createVehicle, cornersOnRoad } from '../sim/vehicle.js';
import { buildScenery } from '../sim/collision.js';
import { createWinch } from '../recovery/cable.js';
import { createCrewMember } from '../player/player.js';

/**
 * Build one attempt. Every draw from `rng` is a variation the GDD asked for; none of them
 * change which approaches work.
 *
 * @param {import('../core/rng.js').Rng} rng  the world stream
 */
export function buildScene(rng) {
  const terrain = createTerrain(rng);

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
  if (rng.chance(0.45)) locked.push(rng.chance(0.5) ? 'wheelFL' : 'wheelFR');

  const boggedN = CONFIG.sedan.boggedBaseN + rng.spread(CONFIG.sedan.boggedRangeN);

  const sedan = createVehicle(SEDAN_DEF, terrain.anchors.sedan, { boggedN, lockedWheels: locked });
  const truck = createVehicle(TRUCK_DEF, terrain.anchors.truck, {});
  truck.parkBrake = true;

  // Zone modifiers and rigging live on the vehicle, not on the definition: the definition is
  // shared, frozen data and one attempt's torn bumper must not follow the player into the next.
  for (const v of [sedan, truck]) { v.zoneMod = {}; v.rigging = {}; }

  // A little pre-existing damage, sometimes. GDD §4: the sedan arrives with "a damage state",
  // and a job that starts with a dented car is a job with a history.
  if (rng.chance(0.35)) sedan.damage.dents = rng.int(1, 3);

  const gear = createGearPile(terrain.anchors.gearPile, rng);

  // The crew. GDD §7 Milestone 2 puts two to four of them on site; they arrive together, spread
  // along the shoulder beside the truck rather than stacked on one spawn point.
  const crew = [];
  for (let i = 0; i < CONFIG.crew.count; i++) {
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
    winch: createWinch(),
    blocksById: {},
    debris: [],
    nextDebrisId: 1,
    goal: {
      cornersOnRoad: 0,
      settledMs: 0,
      complete: false,
      completedAtMs: null,
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
    },
  };
}
