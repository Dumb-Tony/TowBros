/* The player: on foot, in the seat, and everything they can reach.
 *
 * GDD §5: "Controls must remain small enough to remember after one glance. Walking and
 * driving share directional input. The nearby world provides context-sensitive actions."
 * So this file has one movement axis pair, one context key, and a priority chain that
 * decides what the context key means from what is standing nearby. Nothing is modal.
 *
 * GDD §5 again: "No inventory grid is required. The player carries one physical object."
 * There is exactly one slot — `carryingGearId` — plus the winch hook, which is not gear and
 * is carried differently because it is attached to a drum by thirty metres of cable.
 *
 * Inspection returns FACTS. Never a recommendation, never a hint about what to do next. If
 * a string produced here would survive being read aloud by a bored mechanic, it is right.
 */

import { CONFIG } from '../config.js';
import { EVENTS } from '../core/eventBus.js';
import { clamp, unit, len } from '../core/vec.js';
import { closestOnBox } from '../sim/collision.js';
import { nearestZone } from '../data/vehicles.js';
import { applyDriverInput, releaseDriverInput, describeVehicle } from '../sim/vehicle.js';
import { WINCH, fairleadPos, hookPos, cablePath, pathLength } from '../recovery/cable.js';
import { attachHook, detachHook, rigZone, zoneCapacityN } from '../recovery/attach.js';
import {
  nearestGear, pickUpGear, placeGear, mountBlock, routeThroughBlock, pumpJack, contextFor,
} from '../recovery/gear.js';
import { gearDef, USE } from '../data/equipment.js';

export function createPlayer(spawn) {
  return {
    x: spawn.x, y: spawn.y,
    vx: 0, vy: 0,
    facing: -Math.PI / 2,        // looking north, up at the road
    radiusM: CONFIG.player.radiusM,
    inVehicleId: null,
    carryingGearId: null,
    holdingHook: false,
    /** The last thing looked at, shown as a card until it times out. */
    inspect: null,
    /** What the context key would do right now — computed each step, read by the HUD. */
    contextHint: null,
  };
}

/* ── movement ───────────────────────────────────────────────────────────────── */

function walk(st, terrain, dtSec, input) {
  const p = st.player;
  const ax = input ? input.moveAxis() : { x: 0, y: 0 };
  const P = CONFIG.player;

  // Uphill is slower. A cheap effect that makes the player's legs agree with the contour
  // lines they are looking at.
  const slope = terrain.slopeAt(p.x, p.y);
  let speedMul = 1;
  if (ax.x || ax.y) {
    const up = ax.x * slope.gx + ax.y * slope.gy;      // >0 means climbing
    speedMul = 1 - clamp(up, 0, 1.2) * P.slopeSpeedPenalty;
  }
  if (p.holdingHook) speedMul *= P.carryHookDrag;
  if (p.carryingGearId) {
    const g = st.gear.find((q) => q.id === p.carryingGearId);
    if (g) speedMul *= 1 - Math.min(0.30, (gearDef(g.kind).massKg || 0) / 60);
  }

  const maxSpeed = P.maxSpeed * Math.max(0.3, speedMul);
  const targetVx = ax.x * maxSpeed, targetVy = ax.y * maxSpeed;
  const rate = (ax.x || ax.y ? P.accel : P.friction) * dtSec;
  p.vx += clamp(targetVx - p.vx, -rate, rate);
  p.vy += clamp(targetVy - p.vy, -rate, rate);

  if (ax.x || ax.y) p.facing = Math.atan2(ax.y, ax.x);

  p.x += p.vx * dtSec;
  p.y += p.vy * dtSec;

  // Vehicles and trees are solid. Push out, do not bounce: being shoved around by a moving
  // truck is fine, being launched by it is not.
  for (const id of Object.keys(st.vehicles)) {
    const v = st.vehicles[id];
    const c = closestOnBox(v.body, p.x, p.y);
    const d = Math.hypot(p.x - c.x, p.y - c.y);
    if (c.inside || d < p.radiusM) {
      const n = c.inside
        ? unit(p.x - v.body.x, p.y - v.body.y)
        : unit(p.x - c.x, p.y - c.y);
      const push = c.inside ? p.radiusM + 0.15 : (p.radiusM - d);
      p.x += n.x * push; p.y += n.y * push;
      p.vx *= 0.4; p.vy *= 0.4;
    }
  }
  for (const t of terrain.trees) {
    const d = Math.hypot(p.x - t.x, p.y - t.y);
    const min = t.r + p.radiusM;
    if (d < min && d > 1e-6) {
      const n = unit(p.x - t.x, p.y - t.y);
      p.x = t.x + n.x * min; p.y = t.y + n.y * min;
    }
  }

  const c = terrain.clampToWorld(p.x, p.y, p.radiusM);
  p.x = c.x; p.y = c.y;
}

/** Ride along in the cab. The player is not simulated while driving; they are furniture. */
function rideAlong(st) {
  const p = st.player;
  const v = st.vehicles[p.inVehicleId];
  if (!v) { p.inVehicleId = null; return; }
  const seat = v.body.toWorld(v.def.lengthM * 0.18, -0.35);
  p.x = seat.x; p.y = seat.y;
  p.vx = 0; p.vy = 0;
  p.facing = v.body.angle;
}

/**
 * The casualty's own parking brake, reachable from outside through the driver's door.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NOT MILESTONE 2 ────────────────────────────────────
 * GDD §7 defers "an occupiable recovered vehicle for steering/braking" to Milestone 2. Reaching
 * in and dropping the handbrake is not that: nobody gets in, nobody steers.
 *
 * It is here because of something the geometry forced into the open. A winch pulls the load TO
 * THE DRUM, so from the last few metres of the road the car can never finish on the pavement by
 * winch alone — its own footprint will not fit between the truck and the shoulder. Measured over
 * fourteen parks: every one of them ends with the car against the truck. The move that finishes
 * those jobs is a TOW, and a car whose rear wheels are locked does not tow, it ploughs. With the
 * brake off it tows onto the road in one pass.
 *
 * And it cuts both ways, which is the part worth having. On the bank the downhill pull is ~6 kN
 * against ~1.2 kN of rolling resistance, so a car released in the wrong place runs away downhill
 * — straight into the mud if that is what is below it. Chock it first, or hold it on the line.
 * The gear to do that is already lying in the pile.
 *
 * The player is never told any of this. The wheel inspection says "Locked by the parking brake",
 * standing at the car offers the release, and the rest is theirs.
 */
function brakeReachable(st, p) {
  for (const id of Object.keys(st.vehicles)) {
    const v = st.vehicles[id];
    if (v.def.driven) continue;             // the truck has a cab; get in it
    const c = closestOnBox(v.body, p.x, p.y);
    if (Math.hypot(p.x - c.x, p.y - c.y) <= CONFIG.player.reachM * 0.75) return v;
  }
  return null;
}

/* ── the hook ───────────────────────────────────────────────────────────────── */

/**
 * Carry the hook: it sits just ahead of the player, and THE LINE IS A LEASH.
 *
 * The invariant that matters: the paid-out length must never be less than the distance the hook
 * has actually travelled. Without it, `lineM` while carrying is fiction — and then the moment the
 * player hooks on, the cable spring sees `dist - lineM` metres of stretch it did not earn and
 * parts a 42 kN line on the first step. Caught by m1 J9, which walked the hook 20 m out with 1.5 m
 * off the drum and watched the attachment explode.
 *
 * So: pay out at up to freeSpoolMps, and if the drum cannot keep up — or if the drum is simply
 * empty — pull the player back to the end of the line. They are stopped by a cable, not by an
 * invisible wall, and it is the same code path for both reasons.
 */
function carryHook(st, terrain, dtSec) {
  const p = st.player;
  const w = st.winch;
  const off = CONFIG.player.hookCarryOffsetM;
  w.hook.x = p.x + Math.cos(p.facing) * off;
  w.hook.y = p.y + Math.sin(p.facing) * off;

  const path = cablePath(w, st.vehicles.truck, st.vehicles, st.blocksById);
  const total = pathLength(path);

  const want = total + 0.15;
  if (want > w.lineM) {
    w.lineM = Math.min(CONFIG.winch.spoolLengthM, w.lineM + CONFIG.winch.freeSpoolMps * dtSec, want);
  }

  const over = total - w.lineM;
  if (over > 0) {
    const anchor = path.length > 2 ? path[1] : path[0];
    const back = unit(anchor.x - w.hook.x, anchor.y - w.hook.y);
    p.x += back.x * over; p.y += back.y * over;
    w.hook.x += back.x * over; w.hook.y += back.y * over;
    p.vx *= 0.2; p.vy *= 0.2;
    const c = terrain.clampToWorld(p.x, p.y, p.radiusM);
    p.x = c.x; p.y = c.y;
  }
}

/* ── inspection ─────────────────────────────────────────────────────────────── */

/**
 * Look at whatever is nearest and state what is true about it.
 * GDD §5: facts, not prescriptions.
 */
export function inspectNearest(st, terrain, bus, simTimeMs) {
  const p = st.player;
  const reach = CONFIG.player.reachM + 0.9;

  // A specific attachment zone beats the vehicle as a whole: standing at the bumper and
  // pressing look should tell you about the bumper.
  let bestZone = null;
  for (const id of Object.keys(st.vehicles)) {
    const v = st.vehicles[id];
    const nz = nearestZone(v.def, v.body, p.x, p.y, 1.5);
    if (nz && (!bestZone || nz.dist < bestZone.dist)) bestZone = { ...nz, veh: v };
  }
  if (bestZone) {
    const v = bestZone.veh, z = bestZone.zone;
    const rig = v.rigging[z.id] || 'bare';
    const cap = zoneCapacityN(v, z, rig);
    const lost = v.damage.parts[z.part] === 'lost';
    const bent = v.damage.parts[z.part] === 'bent';
    const lines = [z.inspect];
    if (lost) lines.push('It is not there any more.');
    else if (bent) lines.push('Already deformed. It will not take what it took last time.');
    if (rig !== 'bare') lines.push(`A ${CONFIG.rigging[rig].label} is wrapped round it.`);
    lines.push(lost ? 'Nothing here to hook to.'
      : `Holds about ${(cap / 1000).toFixed(0)} kN as rigged. The cable parts at 42 kN.`);
    st.player.inspect = { title: `${v.def.label} — ${z.label}`, lines, ttlMs: 5200 };
    bus.emit(EVENTS.INSPECTED, { kind: 'zone', vehicle: v.id, zone: z.id }, simTimeMs);
    return st.player.inspect;
  }

  const g = nearestGear(st, p.x, p.y, reach);
  if (g) {
    const def = gearDef(g.item.kind);
    const lines = [def.inspect, def.effect];
    if (g.item.kind === 'jack' && g.item.liftStep > 0) {
      lines.push(`Wound out ${g.item.liftStep} of ${CONFIG.gear.jack.liftSteps} turns.`);
    }
    if (g.item.kind === 'snatchBlock') {
      lines.push(g.item.attachedTo ? 'Secured to a tree.' : 'Not secured to anything.');
    }
    st.player.inspect = { title: def.label, lines, ttlMs: 5200 };
    bus.emit(EVENTS.INSPECTED, { kind: 'gear', gear: g.item.id }, simTimeMs);
    return st.player.inspect;
  }

  // Nothing to hand: describe the ground. Slope and surface ARE information, and the GDD
  // wants the player reading terrain before they read a UI.
  const surf = terrain.surfaceAt(p.x, p.y);
  const slope = terrain.slopeAt(p.x, p.y);
  const deg = Math.round(Math.atan(slope.mag) * 180 / Math.PI);
  const down = slope.mag > 0.03
    ? ` Falls away toward ${bearing(-slope.gx, -slope.gy)}.`
    : ' Flat.';
  st.player.inspect = {
    title: `ground — ${surf.label}`,
    lines: [
      `${deg}° of slope underfoot.${down}`,
      surf.id === 'pavement' ? 'Hard and dry. Best grip on the site.'
        : surf.id === 'shoulder' ? 'Loose gravel over hardpack. Reasonable grip.'
        : surf.id === 'wetGrass' ? 'Wet grass over soft ground. Tires will spin here.'
        : 'Standing water and churned mud. Poor grip, heavy drag.',
    ],
    ttlMs: 4600,
  };
  bus.emit(EVENTS.INSPECTED, { kind: 'ground', surface: surf.id }, simTimeMs);
  return st.player.inspect;
}

function bearing(dx, dy) {
  const a = Math.atan2(dy, dx);
  const dirs = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
  const i = Math.round(((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
  return dirs[i];
}

/* ── actions ────────────────────────────────────────────────────────────────── */

/**
 * The context key. Priority order, highest first — the chain is the whole interface, so it
 * is written as one readable list rather than spread across handlers:
 *
 *   1. holding the hook, standing at a vehicle  -> hook it on there
 *   2. holding the hook, standing nowhere       -> put it down
 *   3. carrying a strap or chain at a vehicle   -> wrap it round the nearest strong point
 *   4. carrying anything else                   -> set it down / mount it
 *   5. standing at a mounted block              -> run the line through it
 *   6. standing at a jack under a vehicle       -> pump it
 *   7. standing at any gear                     -> pick it up
 *   8. standing at the drum                     -> take the hook
 */
export function doContext(st, terrain, bus, simTimeMs) {
  const p = st.player;
  const w = st.winch;
  if (p.inVehicleId) return null;

  /* 1 & 2 — the hook */
  if (p.holdingHook) {
    let best = null;
    for (const id of Object.keys(st.vehicles)) {
      const v = st.vehicles[id];
      const nz = nearestZone(v.def, v.body, w.hook.x, w.hook.y, 1.7);
      if (nz && (!best || nz.dist < best.dist)) best = { ...nz, veh: v };
    }
    if (best) {
      // A zone whose part has already torn off is not there to hook to.
      if (best.veh.zoneMod[best.zone.id] === 0) {
        st.player.inspect = {
          title: `${best.zone.label}`, lines: ['Torn out. There is nothing left to hook to.'], ttlMs: 3200,
        };
        return null;
      }
      p.holdingHook = false;
      attachHook(st, best.veh, best.zone, bus, simTimeMs);
      return 'attach';
    }
    p.holdingHook = false;
    w.state = WINCH.LOOSE;
    bus.emit(EVENTS.HOOK_STOWED, { where: 'ground' }, simTimeMs);
    return 'drop-hook';
  }

  /* 3 & 4 — carried gear */
  if (p.carryingGearId) {
    const item = st.gear.find((q) => q.id === p.carryingGearId);
    if (!item) { p.carryingGearId = null; return null; }
    const def = gearDef(item.kind);

    if (def.use === USE.RIG) {
      let best = null;
      for (const id of Object.keys(st.vehicles)) {
        const v = st.vehicles[id];
        const nz = nearestZone(v.def, v.body, p.x, p.y, 2.0);
        if (nz && (!best || nz.dist < best.dist)) best = { ...nz, veh: v };
      }
      if (best) {
        p.carryingGearId = null;
        item.carriedBy = null;
        item.usedAsRig = true;
        item.placed = true;
        const q = best.veh.body.toWorld(best.zone.local.x, best.zone.local.y);
        item.x = q.x; item.y = q.y;
        item.attachedTo = best.veh.id;
        rigZone(best.veh, best.zone.id, item.kind, bus, simTimeMs);
        // Already hooked to that zone? Then the rigging it is hooked through just changed.
        if (st.winch.state === WINCH.ATTACHED && st.winch.targetId === best.veh.id
            && st.winch.zoneId === best.zone.id) {
          st.winch.rig = item.kind;
        }
        return 'rig';
      }
      // Nothing to wrap it round: it goes on the ground like anything else.
    }

    if (def.use === USE.MOUNT) {
      const anchor = mountBlock(st, item, terrain, bus, simTimeMs);
      if (anchor) { p.carryingGearId = null; return 'mount'; }
    }

    const ahead = CONFIG.gear.placeAheadM;
    placeGear(st, item, p.x + Math.cos(p.facing) * ahead, p.y + Math.sin(p.facing) * ahead,
              p.facing, bus, simTimeMs);
    p.carryingGearId = null;
    return 'place';
  }

  /* 5, 6 & 7 — gear on the ground */
  const g = nearestGear(st, p.x, p.y);
  if (g) {
    const item = g.item;
    if (item.kind === 'snatchBlock' && item.attachedTo && st.winch.blockId !== item.id) {
      routeThroughBlock(st, item, bus, simTimeMs);
      return 'route';
    }
    if (item.kind === 'jack' && item.liftStep < CONFIG.gear.jack.liftSteps) {
      // Pumping is a hold, handled per step in stepPlayer; a tap starts it.
      st.player._pumpingGearId = item.id;
      return 'pump';
    }
    pickUpGear(st, item, bus, simTimeMs);
    p.carryingGearId = item.id;
    return 'pickup';
  }

  /* 8 — the casualty's own parking brake. AFTER gear on purpose: if the player is standing on a
   *     jack they just placed under the car, pumping it is what they meant. Walk round to the
   *     door side and the brake is what is offered instead. */
  const brakeTarget = brakeReachable(st, p);
  if (brakeTarget) {
    brakeTarget.parkBrake = !brakeTarget.parkBrake;
    // NOTE: ws.locked is left alone. That flag is a SEIZED wheel, not a braked one — a handbrake
    // does not un-jam a hub, so an attempt that seeded a jammed front wheel stays partly stuck.
    bus.emit(EVENTS.BRAKE_SET, { vehicle: brakeTarget.id, on: brakeTarget.parkBrake }, simTimeMs);
    return brakeTarget.parkBrake ? 'brake-on' : 'brake-off';
  }

  /* 9 — the drum */
  const truck = st.vehicles.truck;
  const fl = fairleadPos(truck);
  const hp = hookPos(w, st.vehicles);
  const nearDrum = Math.hypot(p.x - fl.x, p.y - fl.y) <= CONFIG.player.reachM + 0.6;
  const nearHook = Math.hypot(p.x - hp.x, p.y - hp.y) <= CONFIG.player.reachM;

  if (w.state === WINCH.STOWED && nearDrum) {
    p.holdingHook = true;
    w.state = WINCH.HELD;
    bus.emit(EVENTS.HOOK_TAKEN, { from: 'drum' }, simTimeMs);
    return 'take-hook';
  }
  if (w.state === WINCH.LOOSE && nearHook) {
    p.holdingHook = true;
    w.state = WINCH.HELD;
    w.broken = false;
    bus.emit(EVENTS.HOOK_TAKEN, { from: 'ground' }, simTimeMs);
    return 'take-hook';
  }
  return null;
}

/** The detach key: give back whatever is in hand, in the order it would actually matter. */
export function doDetach(st, bus, simTimeMs) {
  const p = st.player;
  if (p.holdingHook) {
    p.holdingHook = false;
    st.winch.state = WINCH.LOOSE;
    bus.emit(EVENTS.HOOK_STOWED, { where: 'ground' }, simTimeMs);
    return 'drop-hook';
  }
  if (st.winch.state === WINCH.ATTACHED) {
    detachHook(st, bus, simTimeMs, 'player');
    return 'detach';
  }
  if (p.carryingGearId) {
    const item = st.gear.find((q) => q.id === p.carryingGearId);
    if (item) {
      placeGear(st, item, p.x + Math.cos(p.facing) * 0.7, p.y + Math.sin(p.facing) * 0.7,
                p.facing, bus, simTimeMs);
    }
    p.carryingGearId = null;
    return 'drop-gear';
  }
  return null;
}

/** Get in / get out. The truck is the only thing with a seat in Milestone 1 — GDD §7 puts
 *  an occupiable recovered vehicle in Milestone 2. */
export function doEnterExit(st, bus, simTimeMs) {
  const p = st.player;
  if (p.inVehicleId) {
    const v = st.vehicles[p.inVehicleId];
    releaseDriverInput(v);
    v.occupied = false;
    const side = v.body.toWorld(0, -(v.def.widthM / 2 + 0.9));
    p.inVehicleId = null;
    p.x = side.x; p.y = side.y;
    p.vx = 0; p.vy = 0;
    bus.emit(EVENTS.VEHICLE_EXITED, { vehicle: v.id }, simTimeMs);
    return 'exit';
  }

  const truck = st.vehicles.truck;
  const c = closestOnBox(truck.body, p.x, p.y);
  if (Math.hypot(p.x - c.x, p.y - c.y) > CONFIG.player.reachM) return null;

  // Climbing into the cab with the hook in your hand is not a thing. Put it down first —
  // and say so, rather than silently refusing.
  if (p.holdingHook) {
    p.holdingHook = false;
    st.winch.state = WINCH.LOOSE;
    bus.emit(EVENTS.HOOK_STOWED, { where: 'ground', reason: 'boarding' }, simTimeMs);
  }
  p.inVehicleId = truck.id;
  truck.occupied = true;
  bus.emit(EVENTS.VEHICLE_ENTERED, { vehicle: truck.id }, simTimeMs);
  return 'enter';
}

/* ── the step ───────────────────────────────────────────────────────────────── */

/**
 * One simulation step of everything the player is. Reads input edges, so it must run inside
 * the fixed step and not on the render frame.
 */
export function stepPlayer(st, terrain, dtSec, input, bus, simTimeMs) {
  const p = st.player;

  if (input) {
    if (input.wasPressed('enterExit')) doEnterExit(st, bus, simTimeMs);
    if (input.wasPressed('context')) doContext(st, terrain, bus, simTimeMs);
    if (input.wasPressed('detach')) doDetach(st, bus, simTimeMs);
    if (input.wasPressed('inspect')) inspectNearest(st, terrain, bus, simTimeMs);
  }

  if (p.inVehicleId) {
    const v = st.vehicles[p.inVehicleId];
    const ax = input ? input.driveAxis() : { steer: 0, throttle: 0 };
    applyDriverInput(v, ax.steer, ax.throttle, input ? input.wasPressed('brake') : false, dtSec);
    rideAlong(st);
  } else {
    for (const id of Object.keys(st.vehicles)) {
      if (!st.vehicles[id].occupied) releaseDriverInput(st.vehicles[id]);
    }
    walk(st, terrain, dtSec, input);
    if (p.holdingHook) carryHook(st, terrain, dtSec);

    // Holding the context key on a jack keeps pumping it.
    if (p._pumpingGearId) {
      const item = st.gear.find((q) => q.id === p._pumpingGearId);
      const holding = input && input.isDown('context');
      if (!item || !holding || Math.hypot(item.x - p.x, item.y - p.y) > CONFIG.gear.jack.reachM) {
        p._pumpingGearId = null;
        if (item) item.pumpMs = 0;
      } else {
        pumpJack(st, item, dtSec, bus, simTimeMs);
      }
    }
  }

  // The winch is reachable at all times — GDD §5. Reeling while walking is not a mistake,
  // it is how you take up slack before you have finished rigging.
  if (input) {
    const inn = input.isDown('winchIn'), out = input.isDown('winchOut');
    st.winch.motor = inn && !out ? 1 : out && !inn ? -1 : 0;
    if (st.winch.motor !== 0 && st.winch.state === WINCH.HELD) st.winch.motor = 0;
  }

  // What the context key would do, recomputed for the HUD prompt.
  const carried = p.carryingGearId ? st.gear.find((q) => q.id === p.carryingGearId) : null;
  p.contextHint = p.inVehicleId ? null : hintFor(st, terrain, p, carried);

  if (p.inspect) {
    p.inspect.ttlMs -= CONFIG.sim.stepMs;
    if (p.inspect.ttlMs <= 0) p.inspect = null;
  }
}

/** The prompt text. Mirrors doContext's priority chain — kept adjacent to it on purpose so
 *  the two cannot drift into disagreeing about what E does. */
function hintFor(st, terrain, p, carried) {
  if (p.holdingHook) {
    for (const id of Object.keys(st.vehicles)) {
      const v = st.vehicles[id];
      const nz = nearestZone(v.def, v.body, st.winch.hook.x, st.winch.hook.y, 1.7);
      if (nz) return { key: 'E', label: `hook onto the ${nz.zone.label}` };
    }
    return { key: 'E', label: 'set the hook down' };
  }
  const ctx = contextFor(st, terrain, p.x, p.y, carried);
  if (ctx) return { key: 'E', label: ctx.label };

  const brake = brakeReachable(st, p);
  if (brake) {
    return { key: 'E', label: brake.parkBrake ? "release the sedan's parking brake" : "set the sedan's parking brake" };
  }

  const truck = st.vehicles.truck;
  const fl = fairleadPos(truck);
  if (st.winch.state === WINCH.STOWED && Math.hypot(p.x - fl.x, p.y - fl.y) <= CONFIG.player.reachM + 0.6) {
    return { key: 'E', label: 'take the winch hook' };
  }
  const hp = hookPos(st.winch, st.vehicles);
  if (st.winch.state === WINCH.LOOSE && Math.hypot(p.x - hp.x, p.y - hp.y) <= CONFIG.player.reachM) {
    return { key: 'E', label: 'pick the hook back up' };
  }
  const c = closestOnBox(truck.body, p.x, p.y);
  if (Math.hypot(p.x - c.x, p.y - c.y) <= CONFIG.player.reachM) {
    return { key: 'Enter', label: 'get in the truck' };
  }
  return null;
}

export { describeVehicle };
