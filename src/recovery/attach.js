/* Attachment: hooking on, tearing off, and what is left afterwards.
 *
 * GDD §4: "Forgiving attachment zones… almost any plausible choice works until its strength
 * does not." Nothing in this file rejects an attachment. attachHook() always succeeds. The
 * only question it ever answers is what happens LATER, when the load arrives.
 *
 * And the answer is never "you failed". GDD §4 again: "No instant fail for damage or a
 * worsening scene." A torn bumper becomes an object in the road. A bent axle becomes drag
 * the player will feel for the rest of the job. A lost wheel becomes a corner that ploughs.
 * Every one of those leaves the recovery possible and the story better.
 *
 * ── ESCALATION, NOT BINARY FAILURE ────────────────────────────────────────────────────
 * A zone rated BEND does not detach the first time it is overloaded: it deforms, its rating
 * drops to 70%, and the drag it adds is permanent. Overload it again and it lets go. That is
 * two distinct consequences from one mistake repeated, which is a much better teacher than
 * one loud one.
 */

import { CONFIG } from '../config.js';
import { EVENTS } from '../core/eventBus.js';
import { FAIL } from '../data/vehicles.js';
import { Body } from '../sim/body.js';
import { boxInertia } from '../data/vehicles.js';
import { WINCH, drumsOf } from './cable.js';
import { unit, clamp } from '../core/vec.js';

/** Physical shape of each part once it is no longer part of a car. */
const DEBRIS = Object.freeze({
  bumperFront: { label: 'front bumper', lengthM: 1.72, widthM: 0.26, massKg: 12 },
  bumperRear:  { label: 'rear bumper',  lengthM: 1.72, widthM: 0.26, massKg: 12 },
  doorL:       { label: 'door',         lengthM: 1.08, widthM: 0.16, massKg: 24 },
  doorR:       { label: 'door',         lengthM: 1.08, widthM: 0.16, massKg: 24 },
  wheelFL:     { label: 'wheel',        lengthM: 0.62, widthM: 0.62, massKg: 22 },
  wheelFR:     { label: 'wheel',        lengthM: 0.62, widthM: 0.62, massKg: 22 },
  wheelRL:     { label: 'wheel',        lengthM: 0.62, widthM: 0.62, massKg: 22 },
  wheelRR:     { label: 'wheel',        lengthM: 0.62, widthM: 0.62, massKg: 22 },
});

/** What an attachment can actually take right now: its rating, times the rigging wrapped
 *  round it, times whatever deformation it has already suffered. */
export function zoneCapacityN(veh, zone, rigName) {
  const rig = CONFIG.rigging[rigName] || CONFIG.rigging.bare;
  const mod = veh.zoneMod[zone.id] === undefined ? 1 : veh.zoneMod[zone.id];
  return zone.strengthN * rig.strengthMul * mod;
}

/** Wrap a strap or chain round a zone. The gear stays there until it is taken back off, so
 *  a well-rigged car stays well rigged across a re-hook. */
export function rigZone(veh, zoneId, kind, bus, simTimeMs) {
  veh.rigging[zoneId] = kind;
  bus.emit(EVENTS.RIG_APPLIED, { vehicle: veh.id, zone: zoneId, rig: kind }, simTimeMs);
}

/** Hook the line onto a zone. Always allowed.
 *  @param {object} [winch]  which drum's hook. Omitted means the primary — see recovery/cable.js. */
export function attachHook(st, veh, zone, bus, simTimeMs, winch = null) {
  const w = winch || st.winch;
  const rig = veh.rigging[zone.id] || 'bare';
  w.state = WINCH.ATTACHED;
  w.targetId = veh.id;
  w.zoneId = zone.id;
  w.rig = rig;
  w.broken = false;

  // Start from a taut-but-unloaded line so hooking on does not itself yank anything.
  const p = veh.body.toWorld(zone.local.x, zone.local.y);
  w.hook.x = p.x; w.hook.y = p.y;

  bus.emit(EVENTS.HOOK_ATTACHED, {
    vehicle: veh.id, zone: zone.id, zoneLabel: zone.label, rig,
    capacityN: Math.round(zoneCapacityN(veh, zone, rig)),
  }, simTimeMs);
}

/** Unhook, leaving the line where it is. */
export function detachHook(st, bus, simTimeMs, reason = 'player', winch = null) {
  const w = winch || st.winch;
  if (w.state !== WINCH.ATTACHED) return false;
  const p = { x: w.hook.x, y: w.hook.y };
  const veh = st.vehicles[w.targetId];
  if (veh) {
    const z = veh.def.zones.find((q) => q.id === w.zoneId);
    if (z) { const q = veh.body.toWorld(z.local.x, z.local.y); p.x = q.x; p.y = q.y; }
  }
  w.state = WINCH.LOOSE;
  w.hook.x = p.x; w.hook.y = p.y;
  const was = { vehicle: w.targetId, zone: w.zoneId };
  w.targetId = null; w.zoneId = null; w.rig = 'bare';
  w.tensionN = 0; w.tensionFrac = 0; w.motor = 0;
  bus.emit(EVENTS.HOOK_DETACHED, { ...was, reason }, simTimeMs);
  return true;
}

/**
 * Detach a part from a vehicle and put it in the world as an object.
 * @param {{x:number,y:number}} [kick]  velocity to leave with
 */
export function detachPart(st, veh, partId, bus, simTimeMs, kick = null) {
  if (veh.damage.parts[partId] === 'lost') return null;
  const spec = DEBRIS[partId];
  veh.damage.parts[partId] = 'lost';

  // A lost wheel is not cosmetic: that corner now drags on its hub.
  const wi = veh.wheelState.findIndex((w) => w.id === partId);
  if (wi >= 0) {
    veh.wheelState[wi].attached = false;
    veh.wheelState[wi].dragMul = CONFIG.damage.wheelLostDragMul;
    veh.wheelState[wi].lifted = false;
  }
  // Whatever a hook was holding is gone, so that hook is on the ground. Every drum, because two
  // of them can be rigged to two zones on the same vehicle (Milestone 6).
  for (const w of drumsOf(st)) {
    if (w.state !== WINCH.ATTACHED || w.targetId !== veh.id) continue;
    const z = veh.def.zones.find((q) => q.id === w.zoneId);
    if (z && z.part === partId) detachHook(st, bus, simTimeMs, 'part-detached', w);
  }

  if (!spec) {
    bus.emit(EVENTS.COMPONENT_DETACHED, { vehicle: veh.id, part: partId, debris: null }, simTimeMs);
    return null;
  }

  // Place it where the part was, using whichever record knows: the zone, or the wheel.
  const zone = veh.def.zones.find((q) => q.part === partId);
  const local = zone ? zone.local
    : (veh.def.wheels.find((q) => q.id === partId) || { local: { x: 0, y: 0 } }).local;
  const p = veh.body.toWorld(local.x, local.y);

  const body = new Body({
    id: `debris_${veh.id}_${partId}_${st.nextDebrisId++}`,
    x: p.x, y: p.y, angle: veh.body.angle,
    massKg: spec.massKg,
    inertia: boxInertia(spec.massKg, spec.lengthM, spec.widthM),
    halfL: spec.lengthM / 2, halfW: spec.widthM / 2,
  });
  const v0 = veh.body.velocityAt(p.x, p.y);
  body.vx = v0.x + (kick ? kick.x : 0);
  body.vy = v0.y + (kick ? kick.y : 0);
  body.omega = veh.body.omega + (kick ? 0.9 : 0);

  const debris = { id: body.id, kind: partId, label: spec.label, body, from: veh.id, restMs: 0 };
  st.debris.push(debris);
  bus.emit(EVENTS.COMPONENT_DETACHED, {
    vehicle: veh.id, part: partId, label: spec.label, debris: body.id,
  }, simTimeMs);
  return debris;
}

/** Deform a part: it survives, permanently worse. */
export function bendPart(st, veh, partId, bus, simTimeMs) {
  if (veh.damage.parts[partId]) return false;
  veh.damage.parts[partId] = 'bent';
  // A bent axle drags both of its wheels.
  const end = partId === 'axleFront' ? 1 : -1;
  for (let i = 0; i < veh.def.wheels.length; i++) {
    const w = veh.def.wheels[i];
    if (Math.sign(w.local.x) === end) {
      veh.wheelState[i].dragMul = Math.max(veh.wheelState[i].dragMul, CONFIG.damage.bentAxleDragMul);
    }
  }
  bus.emit(EVENTS.COMPONENT_DAMAGED, { vehicle: veh.id, part: partId, state: 'bent' }, simTimeMs);
  return true;
}

/**
 * Check the live attachment against what it can take. Runs after stepCable, which is where
 * `lastEffectiveN` (tension plus rigging shock) comes from.
 */
export function stepAttachment(st, bus, simTimeMs) {
  // Every drum, because from Milestone 6 there may be two of them on two different zones.
  for (const w of drumsOf(st)) stepOneAttachment(st, w, bus, simTimeMs);
}

function stepOneAttachment(st, w, bus, simTimeMs) {
  if (w.state !== WINCH.ATTACHED) return;
  const veh = st.vehicles[w.targetId];
  if (!veh) return;
  const zone = veh.def.zones.find((z) => z.id === w.zoneId);
  if (!zone) return;

  const load = Math.max(w.tensionN, w.lastEffectiveN);
  const cap = zoneCapacityN(veh, zone, w.rig);
  if (load <= cap) return;

  const dir = unit(w.hook.x - veh.body.x, w.hook.y - veh.body.y);

  if (zone.fail === FAIL.HOLD) {
    // Stronger than the line. Nothing to do here — the cable will part first, and that is
    // exactly the promise the GDD makes about the tow hook and the frame.
    return;
  }

  if (zone.fail === FAIL.BEND && veh.damage.parts[zone.part] !== 'bent') {
    bendPart(st, veh, zone.part, bus, simTimeMs);
    veh.zoneMod[zone.id] = 0.70;      // deformed, and weaker for it
    bus.emit(EVENTS.ZONE_FAILED, {
      vehicle: veh.id, zone: zone.id, zoneLabel: zone.label, mode: 'bent',
      loadN: Math.round(load), capacityN: Math.round(cap),
    }, simTimeMs);
    return;
  }

  // Detach: either a DETACH zone, or a BEND zone that has already been bent once.
  bus.emit(EVENTS.ZONE_FAILED, {
    vehicle: veh.id, zone: zone.id, zoneLabel: zone.label, mode: 'tore',
    loadN: Math.round(load), capacityN: Math.round(cap),
  }, simTimeMs);
  if (zone.part) {
    detachPart(st, veh, zone.part, bus, simTimeMs,
               { x: dir.x * 3.2, y: dir.y * 3.2 });
  } else {
    detachHook(st, bus, simTimeMs, 'zone-failed');
  }
  veh.zoneMod[zone.id] = 0;           // there is nothing left there to hook to
}

/**
 * Damage from a contact, judged on the normal IMPULSE in newton-seconds.
 *
 * Not on a force. An impulse divided by the step is not a force anyone experienced — see the
 * note in CONFIG.damage. The nearest part to the contact takes it, which is why a corner shunt
 * takes the bumper and a side-swipe takes a door.
 */
export function applyImpactDamage(st, A, B, impulseNs, hit, bus, simTimeMs) {
  const imp = Math.abs(impulseNs);
  if (imp < CONFIG.damage.impactMinNs) return 0;

  for (const side of [A, B]) {
    const veh = side && side.def ? side : null;
    if (!veh) continue;
    veh.damage.worstImpactNs = Math.max(veh.damage.worstImpactNs || 0, imp);

    if (imp >= CONFIG.damage.impactDetachNs) {
      const part = nearestLoseablePart(veh, hit.cx, hit.cy);
      if (part) {
        detachPart(st, veh, part, bus, simTimeMs, null);
        continue;
      }
    }
    if (imp >= CONFIG.damage.impactDentNs) {
      veh.damage.dents++;
      bus.emit(EVENTS.COMPONENT_DAMAGED, {
        vehicle: veh.id, part: 'body', state: 'dented', impulseNs: Math.round(imp),
      }, simTimeMs);
    }
  }

  /* Was one of them a passing car? That is a different event and a much worse one: the whole point
   * of the work zone is that this does not happen, so it is reported separately and counted, and
   * the recap tells the story of it. (Milestone 5.) */
  const trafficSide = [A, B].find((s) => s && !s.def && /^traffic_/.test(String(s.id)));
  if (trafficSide && st.traffic) {
    st.traffic.hits++;
    const other = trafficSide === A ? B : A;
    bus.emit(EVENTS.TRAFFIC_HIT, {
      car: trafficSide.id,
      what: (other && other.id) || 'something',
      impulseNs: Math.round(imp),
      speed: Math.round(Math.abs(trafficSide.body.vx) * 10) / 10,
    }, simTimeMs);
  }

  bus.emit(EVENTS.IMPACT, {
    a: A && A.id, b: B && B.id, impulseNs: Math.round(imp),
    x: hit.cx, y: hit.cy,
  }, simTimeMs);
  return imp;
}

/** The nearest part to a world point that is still attached and can come off. */
function nearestLoseablePart(veh, wx, wy) {
  let best = null, bestD = Infinity;
  for (const partId of veh.def.parts) {
    if (!DEBRIS[partId]) continue;
    if (veh.damage.parts[partId] === 'lost') continue;
    const zone = veh.def.zones.find((z) => z.part === partId);
    const local = zone ? zone.local
      : (veh.def.wheels.find((q) => q.id === partId) || null);
    if (!local) continue;
    const l = zone ? zone.local : local.local;
    const p = veh.body.toWorld(l.x, l.y);
    const d = Math.hypot(p.x - wx, p.y - wy);
    if (d < bestD) { bestD = d; best = partId; }
  }
  // Only if the contact was actually near it, or a nose-first shunt would rip a rear door off.
  return bestD < 1.6 ? best : null;
}

/**
 * Debris on the ground: slope, ground friction, and settling. Small objects, simple rules —
 * but they are real bodies, so a bumper left in the road is something the truck can hit.
 */
export function stepDebris(st, terrain, dtSec) {
  for (const d of st.debris) {
    const b = d.body;
    const s = terrain.slopeAt(b.x, b.y);
    const surf = terrain.surfaceAt(b.x, b.y);
    const g = CONFIG.sim.gravity;

    b.applyForce(-s.gx * b.massKg * g * s.normalFrac, -s.gy * b.massKg * g * s.normalFrac);

    // Ground friction, static-capped the same way the tires are, so debris comes to rest on
    // a slope instead of sliding forever.
    const sp = b.speed;
    if (sp > 1e-4 || b.fx || b.fy) {
      const dir = sp > 1e-4 ? unit(b.vx, b.vy) : unit(b.fx, b.fy);
      const avail = surf.mu * 1.25 * b.massKg * g * s.normalFrac;
      const applied = b.forceAlong(dir.x, dir.y);
      const cap = b.massKg * sp / dtSec + Math.max(0, applied);
      const use = Math.min(avail, cap);
      b.applyForce(-dir.x * use, -dir.y * use);
    }
    b.omega *= Math.exp(-4.5 * dtSec);
    b.integrate(dtSec);

    const c = terrain.clampToWorld(b.x, b.y, 0.2);
    if (c.clamped) { b.x = c.x; b.y = c.y; b.vx *= -0.2; b.vy *= -0.2; }
    d.restMs = b.speed < 0.05 ? d.restMs + CONFIG.sim.stepMs : 0;
  }
}

export { DEBRIS };
