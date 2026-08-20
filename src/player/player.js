/* The crew: one to four of them, on foot or in a seat, and everything they can reach.
 *
 * Milestone 1 had a single player and this file read `st.player` in twenty places. Milestone 2
 * puts a crew on the site (GDD §7), so every function here now takes the member it is acting for
 * and reads nothing global about who that is. That is the whole refactor, and it is what makes
 * the next part possible: a command arriving over a network is just a call to one of these with
 * somebody else's id.
 *
 * GDD §5 still governs the interface: "Controls must remain small enough to remember after one
 * glance. Walking and driving share directional input. The nearby world provides context-sensitive
 * actions." One movement axis, one context key, one priority chain — per person.
 *
 * ── NOTHING HERE STORES WHO OWNS WHAT ─────────────────────────────────────────────────
 * A crew member does not have `holdingHook`, `inVehicleId` or `carryingGearId` any more. Those
 * were three more places for the same fact to live, and with one player they could not disagree.
 * With four they would. Ownership is on the object (src/crew/authority.js) and read back through
 * the three tiny helpers below.
 *
 * Inspection returns FACTS. Never a recommendation, never a hint about what to do next.
 */

import { CONFIG } from '../config.js';
import { EVENTS } from '../core/eventBus.js';
import { clamp, unit } from '../core/vec.js';
import { closestOnBox } from '../sim/collision.js';
import { nearestZone } from '../data/vehicles.js';
import { applyDriverInput, releaseDriverInput, describeVehicle } from '../sim/vehicle.js';
import { WINCH, fairleadPos, hookPos, cablePath, pathLength } from '../recovery/cable.js';
import { attachHook, detachHook, rigZone, zoneCapacityN } from '../recovery/attach.js';
import {
  nearestGear, placeGear, mountBlock, routeThroughBlock, pumpJack, contextFor,
} from '../recovery/gear.js';
import { gearDef, USE } from '../data/equipment.js';
import {
  claimHook, releaseHook, claimGear, releaseGear, claimSeat, releaseSeat, seatFree,
} from '../crew/authority.js';

/** Crew colours, so four people on one screen are four people and not four identical dots. */
const CREW_TINT = ['#e0a33c', '#4fb0d8', '#9ad14a', '#d87ac0'];

/**
 * One member of the crew.
 * @param {string} id     stable identity — commands and claims are addressed to this
 * @param {number} seat   0-3, decides colour and which input map drives them
 */
export function createCrewMember(id, seat, spawn, name = null) {
  return {
    id,
    seat,
    name: name || `crew ${seat + 1}`,
    tint: CREW_TINT[seat % CREW_TINT.length],
    x: spawn.x, y: spawn.y,
    vx: 0, vy: 0,
    facing: -Math.PI / 2,        // looking north, up at the road
    radiusM: CONFIG.player.radiusM,
    /** The last thing looked at, shown as a card until it times out. Per person. */
    inspect: null,
    /** What the context key would do right now — recomputed each step, read by the HUD. */
    contextHint: null,
    /** Knocked off their feet. GDD §7 "player stumble/ragdoll punctuation". */
    stumbleMs: 0,
    _pumpingGearId: null,
  };
}

/* ── who owns what, asked rather than stored ───────────────────────────────── */

/** Is this member carrying the winch hook? */
export const holdsHook = (st, p) => st.winch.heldBy === p.id;

/** The vehicle this member is sitting in, or null. */
export function seatOf(st, p) {
  for (const id of Object.keys(st.vehicles)) {
    if (st.vehicles[id].occupiedBy === p.id) return st.vehicles[id];
  }
  return null;
}

/** The one gear item this member is carrying, or null. GDD §5: one object each. */
export const carriedItem = (st, p) => st.gear.find((g) => g.carriedBy === p.id) || null;

/* ── movement ───────────────────────────────────────────────────────────────── */

function walk(st, p, terrain, dtSec, input, bus, simTimeMs) {
  const ax = input ? input.moveAxis() : { x: 0, y: 0 };
  const P = CONFIG.player;

  // Uphill is slower. A cheap effect that makes the crew's legs agree with the contour lines
  // they are looking at.
  const slope = terrain.slopeAt(p.x, p.y);
  let speedMul = 1;
  if (ax.x || ax.y) {
    const up = ax.x * slope.gx + ax.y * slope.gy;      // >0 means climbing
    speedMul = 1 - clamp(up, 0, 1.2) * P.slopeSpeedPenalty;
  }
  if (holdsHook(st, p)) speedMul *= P.carryHookDrag;
  const carrying = carriedItem(st, p);
  if (carrying) speedMul *= 1 - Math.min(0.30, (gearDef(carrying.kind).massKg || 0) / 60);

  // On the ground and getting up: no steering, and a scramble back to their feet.
  if (p.stumbleMs > 0) speedMul *= 0.12;

  const maxSpeed = P.maxSpeed * Math.max(0.3, speedMul);
  const targetVx = ax.x * maxSpeed, targetVy = ax.y * maxSpeed;
  const rate = (ax.x || ax.y ? P.accel : P.friction) * dtSec;
  p.vx += clamp(targetVx - p.vx, -rate, rate);
  p.vy += clamp(targetVy - p.vy, -rate, rate);

  if ((ax.x || ax.y) && p.stumbleMs <= 0) p.facing = Math.atan2(ax.y, ax.x);

  p.x += p.vx * dtSec;
  p.y += p.vy * dtSec;

  // Vehicles and trees are solid. Push out, do not bounce.
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
      // A MOVING vehicle knocks you down; a parked one you just bump into. GDD §7 asks for
      // stumble as punctuation, and being clipped by the thing you are recovering is exactly the
      // moment that deserves it.
      if (v.body.speed > CONFIG.crew.knockdownMps) knockDown(st, p, v.body.speed, bus, simTimeMs);
    }
  }
  // Crew do not walk through each other either.
  for (const q of st.crew) {
    if (q === p) continue;
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    const min = p.radiusM + q.radiusM;
    if (d < min && d > 1e-6) {
      const n = unit(p.x - q.x, p.y - q.y);
      const push = (min - d) * 0.5;
      p.x += n.x * push; p.y += n.y * push;
      q.x -= n.x * push; q.y -= n.y * push;
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

/**
 * Knock a crew member down. GDD §7: "player stumble/ragdoll punctuation."
 *
 * Punctuation is the right word — it is not a damage system and there is no health. Being clipped
 * by a moving vehicle costs a couple of seconds on the ground, drops whatever was in your hands,
 * and is funny. Dropping what you were holding is the part that matters mechanically: a crew
 * member flattened while carrying the hook releases it, so the claim does not strand.
 */
export function knockDown(st, p, byMps, bus = null, simTimeMs = 0) {
  if (p.stumbleMs > 0) return false;
  p.stumbleMs = clamp(CONFIG.crew.stumbleMs * (0.6 + byMps * 0.25), 400, CONFIG.crew.stumbleMaxMs);
  const away = unit(p.vx, p.vy);
  p.vx = away.x * byMps * 0.4;
  p.vy = away.y * byMps * 0.4;
  if (bus) bus.emit(EVENTS.CREW_STUMBLED, { crew: p.id, speed: Math.round(byMps * 100) / 100 }, simTimeMs);
  return true;
}

/** Ride along in the cab. A seated member is not simulated on foot; they are furniture. */
function rideAlong(st, p, veh) {
  const seat = veh.body.toWorld(veh.def.lengthM * 0.18, -0.35);
  p.x = seat.x; p.y = seat.y;
  p.vx = 0; p.vy = 0;
  p.facing = veh.body.angle;
}

/**
 * The casualty's own parking brake, reachable from outside through the driver's door.
 *
 * GDD §7 defers "an occupiable recovered vehicle for steering/braking" to Milestone 2 — which is
 * now, so the sedan has a seat too. This stays because it is the thing you do WITHOUT getting in,
 * and because it is what makes a winched-up car towable: a car whose rear wheels are locked does
 * not tow, it ploughs.
 *
 * It cuts both ways. On the bank the downhill pull is ~6 kN against ~1.2 kN of rolling resistance,
 * so a car released in the wrong place runs away downhill. Chock it, or hold it on the line.
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
 * Carry the hook: it sits just ahead of its holder, and THE LINE IS A LEASH.
 *
 * The invariant: the paid-out length must never be less than the distance the hook has actually
 * travelled. Without it, `lineM` while carrying is fiction, and the moment the hook goes on the
 * cable spring sees metres of stretch it did not earn and parts a 42 kN line on the first step.
 */
function carryHook(st, p, terrain, dtSec) {
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

/** Look at whatever is nearest and state what is true about it. Facts, not prescriptions. */
export function inspectNearest(st, p, terrain, bus, simTimeMs) {
  const reach = CONFIG.player.reachM + 0.9;

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
      : `Holds about ${(cap / 1000).toFixed(0)} kN as rigged. The cable parts at ${(CONFIG.winch.cableBreakN / 1000).toFixed(0)} kN.`);
    p.inspect = { title: `${v.def.label} — ${z.label}`, lines, ttlMs: 5200 };
    bus.emit(EVENTS.INSPECTED, { crew: p.id, kind: 'zone', vehicle: v.id, zone: z.id }, simTimeMs);
    return p.inspect;
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
    if (g.item.carriedBy && g.item.carriedBy !== p.id) {
      const who = st.crew.find((c) => c.id === g.item.carriedBy);
      lines.push(`${who ? who.name : 'Somebody'} has it.`);
    }
    p.inspect = { title: def.label, lines, ttlMs: 5200 };
    bus.emit(EVENTS.INSPECTED, { crew: p.id, kind: 'gear', gear: g.item.id }, simTimeMs);
    return p.inspect;
  }

  const surf = terrain.surfaceAt(p.x, p.y);
  const slope = terrain.slopeAt(p.x, p.y);
  const deg = Math.round(Math.atan(slope.mag) * 180 / Math.PI);
  const down = slope.mag > 0.03 ? ` Falls away toward ${bearing(-slope.gx, -slope.gy)}.` : ' Flat.';
  p.inspect = {
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
  bus.emit(EVENTS.INSPECTED, { crew: p.id, kind: 'ground', surface: surf.id }, simTimeMs);
  return p.inspect;
}

function bearing(dx, dy) {
  const a = Math.atan2(dy, dx);
  const dirs = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
  const i = Math.round(((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
  return dirs[i];
}

/* ── actions ────────────────────────────────────────────────────────────────── */

/**
 * The context key, for one crew member. Priority order, highest first — the chain is the whole
 * interface, so it is written as one readable list rather than spread across handlers:
 *
 *   1. holding the hook, standing at a vehicle  -> hook it on there
 *   2. holding the hook, standing nowhere       -> put it down
 *   3. carrying a strap or chain at a vehicle   -> wrap it round the nearest strong point
 *   4. carrying anything else                   -> set it down / mount it
 *   5. standing at a mounted block              -> run the line through it
 *   6. standing at a jack under a vehicle       -> pump it
 *   7. standing at any gear                     -> pick it up
 *   8. standing at the casualty's door          -> work its parking brake
 *   9. standing at the drum                     -> take the hook
 *
 * Every branch that takes hold of something goes through src/crew/authority.js, so two people
 * pressing E on the same jack in the same step cannot both end up carrying it.
 */
export function doContext(st, p, terrain, bus, simTimeMs) {
  const w = st.winch;
  if (seatOf(st, p)) return null;
  if (p.stumbleMs > 0) return null;      // you cannot pick things up off your back

  /* 1 & 2 — the hook */
  if (holdsHook(st, p)) {
    let best = null;
    for (const id of Object.keys(st.vehicles)) {
      const v = st.vehicles[id];
      const nz = nearestZone(v.def, v.body, w.hook.x, w.hook.y, 1.7);
      if (nz && (!best || nz.dist < best.dist)) best = { ...nz, veh: v };
    }
    if (best) {
      if (best.veh.zoneMod[best.zone.id] === 0) {
        p.inspect = {
          title: `${best.zone.label}`, lines: ['Torn out. There is nothing left to hook to.'], ttlMs: 3200,
        };
        return null;
      }
      releaseHook(st, p.id, bus, simTimeMs, 'attached');
      attachHook(st, best.veh, best.zone, bus, simTimeMs);
      return 'attach';
    }
    releaseHook(st, p.id, bus, simTimeMs, 'ground');
    w.state = WINCH.LOOSE;
    return 'drop-hook';
  }

  /* 3 & 4 — carried gear */
  const item = carriedItem(st, p);
  if (item) {
    const def = gearDef(item.kind);

    if (def.use === USE.RIG) {
      let best = null;
      for (const id of Object.keys(st.vehicles)) {
        const v = st.vehicles[id];
        const nz = nearestZone(v.def, v.body, p.x, p.y, 2.0);
        if (nz && (!best || nz.dist < best.dist)) best = { ...nz, veh: v };
      }
      if (best) {
        releaseGear(item, p.id);
        item.usedAsRig = true;
        item.placed = true;
        const q = best.veh.body.toWorld(best.zone.local.x, best.zone.local.y);
        item.x = q.x; item.y = q.y;
        item.attachedTo = best.veh.id;
        rigZone(best.veh, best.zone.id, item.kind, bus, simTimeMs);
        if (w.state === WINCH.ATTACHED && w.targetId === best.veh.id && w.zoneId === best.zone.id) {
          w.rig = item.kind;
        }
        return 'rig';
      }
    }

    if (def.use === USE.MOUNT) {
      const anchor = mountBlock(st, item, terrain, bus, simTimeMs);
      if (anchor) { releaseGear(item, p.id); return 'mount'; }
    }

    const ahead = CONFIG.gear.placeAheadM;
    releaseGear(item, p.id);
    placeGear(st, item, p.x + Math.cos(p.facing) * ahead, p.y + Math.sin(p.facing) * ahead,
              p.facing, bus, simTimeMs);
    return 'place';
  }

  /* 5, 6 & 7 — gear on the ground */
  const g = nearestGear(st, p.x, p.y);
  if (g) {
    const it = g.item;
    if (it.kind === 'snatchBlock' && it.attachedTo && w.blockId !== it.id) {
      routeThroughBlock(st, it, bus, simTimeMs);
      return 'route';
    }
    if (it.kind === 'jack' && it.liftStep < CONFIG.gear.jack.liftSteps) {
      p._pumpingGearId = it.id;
      return 'pump';
    }
    if (claimGear(st, it, p.id, bus, simTimeMs)) return 'pickup';
    // Somebody else has it. Say whose hands it is in rather than doing nothing.
    const who = st.crew.find((c) => c.id === it.carriedBy);
    p.inspect = {
      title: gearDef(it.kind).label,
      lines: [`${who ? who.name : 'Somebody'} is carrying it.`], ttlMs: 2600,
    };
    return null;
  }

  /* 8 — the casualty's own parking brake. AFTER gear on purpose: if you are standing over a jack
   *     you just placed, pumping it is what you meant. Walk round to the door side instead. */
  const brakeTarget = brakeReachable(st, p);
  if (brakeTarget) {
    brakeTarget.parkBrake = !brakeTarget.parkBrake;
    // ws.locked is left alone: that flag is a SEIZED wheel, and a handbrake does not un-jam a hub.
    bus.emit(EVENTS.BRAKE_SET, {
      crew: p.id, vehicle: brakeTarget.id, on: brakeTarget.parkBrake,
    }, simTimeMs);
    return brakeTarget.parkBrake ? 'brake-on' : 'brake-off';
  }

  /* 9 — the drum */
  const truck = st.vehicles.truck;
  const fl = fairleadPos(truck);
  const hp = hookPos(w, st.vehicles);
  const nearDrum = Math.hypot(p.x - fl.x, p.y - fl.y) <= CONFIG.player.reachM + 0.6;
  const nearHook = Math.hypot(p.x - hp.x, p.y - hp.y) <= CONFIG.player.reachM;

  if (w.state === WINCH.STOWED && nearDrum && claimHook(st, p.id, bus, simTimeMs, 'drum')) {
    w.state = WINCH.HELD;
    return 'take-hook';
  }
  if (w.state === WINCH.LOOSE && nearHook && claimHook(st, p.id, bus, simTimeMs, 'ground')) {
    w.state = WINCH.HELD;
    w.broken = false;
    return 'take-hook';
  }
  return null;
}

/** The detach key: give back whatever is in hand, in the order it would actually matter. */
export function doDetach(st, p, bus, simTimeMs) {
  if (holdsHook(st, p)) {
    releaseHook(st, p.id, bus, simTimeMs, 'ground');
    st.winch.state = WINCH.LOOSE;
    return 'drop-hook';
  }
  // Anybody may unhook a rigged line. That is a crew decision, and arguing about it is the game.
  if (st.winch.state === WINCH.ATTACHED) {
    detachHook(st, bus, simTimeMs, 'player');
    return 'detach';
  }
  const item = carriedItem(st, p);
  if (item) {
    releaseGear(item, p.id);
    placeGear(st, item, p.x + Math.cos(p.facing) * 0.7, p.y + Math.sin(p.facing) * 0.7,
              p.facing, bus, simTimeMs);
    return 'drop-gear';
  }
  return null;
}

/**
 * Get in / get out. BOTH vehicles have a seat now — GDD §7 Milestone 2 asks for "an occupiable
 * recovered vehicle for steering/braking", and the sedan is it. Steering a car that is being
 * winched up a bank is the single most useful thing a second crew member can do.
 */
export function doEnterExit(st, p, bus, simTimeMs) {
  const seated = seatOf(st, p);
  if (seated) {
    releaseDriverInput(seated);
    releaseSeat(st, seated, p.id, bus, simTimeMs);
    const side = seated.body.toWorld(0, -(seated.def.widthM / 2 + 0.9));
    p.x = side.x; p.y = side.y;
    p.vx = 0; p.vy = 0;
    return 'exit';
  }
  if (p.stumbleMs > 0) return null;

  // Nearest vehicle with a door within reach, truck first if both are.
  let target = null, bestD = Infinity;
  for (const id of ['truck', 'sedan']) {
    const v = st.vehicles[id];
    if (!v) continue;
    const c = closestOnBox(v.body, p.x, p.y);
    const d = Math.hypot(p.x - c.x, p.y - c.y);
    if (d <= CONFIG.player.reachM && d < bestD) { bestD = d; target = v; }
  }
  if (!target) return null;

  if (!seatFree(target, p.id)) {
    const who = st.crew.find((c) => c.id === target.occupiedBy);
    p.inspect = {
      title: target.def.label,
      lines: [`${who ? who.name : 'Somebody'} is already in the seat.`], ttlMs: 2600,
    };
    return null;
  }

  // Climbing in with the hook in your hand is not a thing. Put it down first, and say so.
  if (holdsHook(st, p)) {
    releaseHook(st, p.id, bus, simTimeMs, 'boarding');
    st.winch.state = WINCH.LOOSE;
  }
  claimSeat(st, target, p.id, bus, simTimeMs);
  return 'enter';
}

/* ── the step ───────────────────────────────────────────────────────────────── */

/**
 * One simulation step for the whole crew. Reads input edges, so it must run inside the fixed step.
 *
 * @param {object[]} inputs  one input source per crew SEAT; a missing entry means that member
 *   takes no action this step, which is exactly what a networked client looks like between packets.
 */
export function stepCrew(st, terrain, dtSec, inputs, bus, simTimeMs) {
  // Nobody is driving until somebody says so. Cleared first so a vehicle whose driver got out —
  // or got knocked down — coasts instead of holding its last throttle.
  for (const id of Object.keys(st.vehicles)) {
    if (!st.vehicles[id].occupiedBy) releaseDriverInput(st.vehicles[id]);
  }

  let reelIn = false, reelOut = false, sawInput = false;

  for (const p of st.crew) {
    const input = inputs ? inputs[p.seat] : null;

    if (p.stumbleMs > 0) {
      p.stumbleMs = Math.max(0, p.stumbleMs - CONFIG.sim.stepMs);
      // Whatever was in their hands is on the ground now. Doing this on the way DOWN rather than
      // on the way up matters: a stumbling crew member must not keep a claim on the hook.
      if (holdsHook(st, p)) { releaseHook(st, p.id, bus, simTimeMs, 'dropped'); st.winch.state = WINCH.LOOSE; }
      const held = carriedItem(st, p);
      if (held) {
        releaseGear(held, p.id);
        placeGear(st, held, p.x, p.y, p.facing, bus, simTimeMs);
      }
    }

    if (input) {
      if (input.wasPressed('enterExit')) doEnterExit(st, p, bus, simTimeMs);
      if (input.wasPressed('context')) doContext(st, p, terrain, bus, simTimeMs);
      if (input.wasPressed('detach')) doDetach(st, p, bus, simTimeMs);
      if (input.wasPressed('inspect')) inspectNearest(st, p, terrain, bus, simTimeMs);
    }

    const seated = seatOf(st, p);
    if (seated) {
      /* No input source: HOLD the last command rather than snapping the controls to neutral.
       * A remote member between packets is still holding the throttle down, and so is the
       * headless harness, which sets the throttle itself and steps the world with no inputs.
       * Zeroing here would be this function inventing a decision nobody made. */
      if (input) {
        const ax = input.driveAxis();
        applyDriverInput(seated, ax.steer, ax.throttle, input.wasPressed('brake'), dtSec);
      }
      rideAlong(st, p, seated);
    } else {
      walk(st, p, terrain, dtSec, input, bus, simTimeMs);
      if (holdsHook(st, p)) carryHook(st, p, terrain, dtSec);

      if (p._pumpingGearId) {
        const it = st.gear.find((q) => q.id === p._pumpingGearId);
        const holding = input && input.isDown('context');
        if (!it || !holding || Math.hypot(it.x - p.x, it.y - p.y) > CONFIG.gear.jack.reachM) {
          p._pumpingGearId = null;
          if (it) it.pumpMs = 0;
        } else {
          pumpJack(st, it, dtSec, bus, simTimeMs);
        }
      }
    }

    // The winch is reachable by ANYONE, at any time — GDD §5. Collected across the crew and
    // resolved once below.
    if (input) {
      sawInput = true;
      if (input.isDown('winchIn')) reelIn = true;
      if (input.isDown('winchOut')) reelOut = true;
    }

    const carried = carriedItem(st, p);
    p.contextHint = seated ? null : hintFor(st, p, terrain, carried);

    if (p.inspect) {
      p.inspect.ttlMs -= CONFIG.sim.stepMs;
      if (p.inspect.ttlMs <= 0) p.inspect = null;
    }
  }

  /* ── one drum, several hands ─────────────────────────────────────────────────
   * Two crew pressing opposite ways is not an error to resolve in favour of somebody. The drum
   * does nothing, the HUD says the controls are being fought over, and they sort it out. Anything
   * else would pick a winner silently, which is worse than a stopped winch.
   *
   * Guarded on `sawInput` because a crew with NO input source attached must not be read as
   * everybody letting go of the winch. That is the headless case — the test harness sets
   * `winch.motor` itself and steps the world with no inputs — and it is also what a lobby of
   * purely remote members looks like before the first packet arrives. Silently zeroing the drum
   * in either case would be a system asserting a decision nobody made. */
  if (sawInput) {
    st.winch.contested = reelIn && reelOut;
    st.winch.motor = st.winch.contested ? 0 : reelIn ? 1 : reelOut ? -1 : 0;
  }
  // The interlock is not an input, so it applies either way: you cannot spin the drum while the
  // hook is in somebody's hand.
  if (st.winch.motor !== 0 && st.winch.state === WINCH.HELD) st.winch.motor = 0;
}

/** Is this member close enough to a vehicle's body to climb in? Same test doContext/doEnterExit
 *  use, kept as a named function so the hint and the action cannot disagree about the distance. */
function withinDoorReach(veh, p) {
  const c = closestOnBox(veh.body, p.x, p.y);
  return Math.hypot(p.x - c.x, p.y - c.y) <= CONFIG.player.reachM;
}

/** The prompt text for one member. Mirrors doContext's priority chain — kept adjacent to it so
 *  the two cannot drift into disagreeing about what E does. */
function hintFor(st, p, terrain, carried) {
  if (p.stumbleMs > 0) return { key: '', label: 'getting up' };

  if (holdsHook(st, p)) {
    for (const id of Object.keys(st.vehicles)) {
      const v = st.vehicles[id];
      const nz = nearestZone(v.def, v.body, st.winch.hook.x, st.winch.hook.y, 1.7);
      if (nz) return { key: 'E', label: `hook onto the ${nz.zone.label}` };
    }
    return { key: 'E', label: 'set the hook down' };
  }
  const ctx = contextFor(st, terrain, p.x, p.y, carried);
  if (ctx) return { key: 'E', label: ctx.label };

  /* The casualty's handbrake and the casualty's SEAT are both here now, and they are different
   * actions on different keys: E reaches in through the door, enterExit gets you in. Since M2 gave
   * the sedan a seat, standing at its door satisfies both, so the hint carries both — showing only
   * the brake would hide a whole mechanic behind "stand slightly further away". */
  const brake = brakeReachable(st, p);
  if (brake) {
    const hint = {
      key: 'E',
      label: brake.parkBrake ? "release the sedan's parking brake" : "set the sedan's parking brake",
    };
    if (seatFree(brake, p.id) && withinDoorReach(brake, p)) {
      hint.alt = { key: 'V', label: `get in the ${brake.def.label}` };
    }
    return hint;
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
  for (const id of ['truck', 'sedan']) {
    const v = st.vehicles[id];
    if (!v) continue;
    const c = closestOnBox(v.body, p.x, p.y);
    if (Math.hypot(p.x - c.x, p.y - c.y) <= CONFIG.player.reachM) {
      if (!seatFree(v, p.id)) {
        const who = st.crew.find((q) => q.id === v.occupiedBy);
        return { key: '', label: `${who ? who.name : 'somebody'} is in the ${v.def.label}` };
      }
      return { key: 'V', label: `get in the ${v.def.label}` };
    }
  }
  return null;
}

export { describeVehicle };
