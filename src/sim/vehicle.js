/* A vehicle: a Body, a wheel layout, a damage record, and the driver's three inputs.
 *
 * The tow truck and the sedan are the SAME object with different data. That is deliberate
 * and load-bearing: GDD §4 lists "accidental escalation in which the tow truck slides into
 * the recovery zone" as a supported outcome, and pillar 2 says the winch does not know who
 * should win. Neither is possible if the wreck is a special-cased prop. Both vehicles have
 * mass, wheels, grip, damage, attachment zones and a bogged-in state; the only difference
 * is that one of them has a driver and a winch on the back.
 *
 * Force order within a step is fixed and matters — see stepVehicle().
 */

import { CONFIG } from '../config.js';
import { Body, stoppingForce } from './body.js';
import { applyWheelForces, resistanceCap } from './tires.js';
import { boxInertia } from '../data/vehicles.js';
import { clamp, unit } from '../core/vec.js';

/**
 * @param {object} def     SEDAN_DEF or TRUCK_DEF
 * @param {{x:number,y:number,angle:number}} spawn
 * @param {object} [opts]
 * @param {number} [opts.boggedN]  starting bogged-in resistance, N (0 for the truck)
 * @param {string[]} [opts.lockedWheels]  wheel ids seized from the start
 */
export function createVehicle(def, spawn, opts = {}) {
  const body = new Body({
    id: def.id,
    x: spawn.x, y: spawn.y, angle: spawn.angle || 0,
    massKg: def.massKg,
    inertia: boxInertia(def.massKg, def.lengthM, def.widthM),
    halfL: def.lengthM / 2,
    halfW: def.widthM / 2,
  });

  const locked = new Set(opts.lockedWheels || []);

  const wheelState = def.wheels.map((w) => ({
    id: w.id,
    attached: true,     // false once the hub loses the argument
    locked: locked.has(w.id),
    lifted: false,      // a jack is holding this corner
    gripMul: 1,
    dragMul: 1,         // raised by a bent axle or a lost wheel
    // presentation, written by the tire model each step
    x: 0, y: 0, steerRad: 0, surface: 'pavement', load: 0, forceN: 0,
    slipFrac: 0, slipMps: 0, soft: 0,
  }));

  return {
    id: def.id,
    def,
    body,
    wheelState,

    // driver inputs, -1..1 / 0..1 / boolean
    steerRad: 0,
    throttle: 0,
    brakeInput: 0,
    parkBrake: !def.driven,       // the sedan arrives with its handbrake on
    occupied: false,

    // multipliers written by src/recovery/gear.js every step, read here and by the tires
    gripMul: 1,
    dragMul: 1,
    boggedMul: 1,
    spinResistN: 0,
    chockAids: [],               // {wheelIndex, dirX, dirY, resistN}

    // dug in. Decays with distance travelled: breaking a vehicle free really frees it.
    boggedN: opts.boggedN || 0,
    boggedN0: opts.boggedN || 0,
    boggedFactor: opts.boggedN ? 1 : 0,
    travelledM: 0,

    damage: {
      parts: {},                 // partId -> 'bent' | 'lost' | 'dented'
      dents: 0,
      worstImpactNs: 0,
    },

    rolled: false,
    maxSlipMps: 0,
    totalLoadN: 0,

    /** Peak force the drivetrain and brakes could ever apply. Debug/HUD only. */
    get isTruck() { return !!def.driven; },
  };
}

/** Apply the in-plane component of gravity where the body is standing.
 *  Separated out so the tests can assert it against a hand-computed number. */
export function applySlopeForce(veh, terrain) {
  const b = veh.body;
  const s = terrain.slopeAt(b.x, b.y);
  if (s.mag < 1e-6) return 0;
  // Gravity resolved onto the inclined plane: magnitude m·g·sinθ, direction straight
  // downhill (-∇h). normalFrac is cosθ, and sinθ = |∇h|·cosθ.
  const f = b.massKg * CONFIG.sim.gravity * s.normalFrac;
  b.applyForce(-s.gx * f, -s.gy * f, CONFIG.debug.showForces ? 'slope' : '');
  return f * s.mag;
}

/**
 * The bogged-in hump: a vehicle with its nose in wet ground resists the first metre far
 * harder than the next one. Applied at the centre of mass, opposing motion, with the same
 * static cap the tires use — so a pull below the hump produces a bar-tight cable and no
 * movement at all, which is the moment the whole game is built around.
 */
export function applyBoggedResistance(veh, dtSec) {
  const b = veh.body;
  if (veh.boggedFactor <= 1e-3 || veh.boggedN <= 0) return 0;

  const avail = veh.boggedN * veh.boggedFactor * veh.boggedMul;
  if (avail <= 0) return 0;

  // Direction to resist: the way it is moving, or if it is still, the way it is being pushed.
  const sp = b.speed;
  const d = sp > 1e-4 ? unit(b.vx, b.vy) : unit(b.fx, b.fy);
  if (d.x === 0 && d.y === 0) return 0;

  const applied = b.forceAlong(d.x, d.y);
  const rc = resistanceCap(b.massKg, sp > 1e-4 ? sp : 0, applied, dtSec);
  const use = Math.min(avail, rc.cap);
  b.applyForce(-d.x * use, -d.y * use, CONFIG.debug.showForces ? 'bogged' : '');

  // Dug in also resists being pivoted. Without this the sedan spins in its own hole under
  // any off-centre pull, which looks weightless and makes rigging position not matter.
  const spinAvail = avail * 0.30 * b.halfL;
  const spinCap = Math.abs(b.omega) * b.inertia / dtSec + Math.max(0, Math.sign(b.omega) * b.torque);
  const spin = Math.min(spinAvail, spinCap);
  if (b.omega !== 0 || b.torque !== 0) {
    b.applyTorque(-Math.sign(b.omega || b.torque) * spin);
  }
  return use;
}

/**
 * Static resistance to being ROTATED, from the same tire friction that resists being dragged.
 *
 * Why this exists: the per-wheel model in tires.js sizes its static resistance against the
 * external force divided by the number of wheels. That holds a parked vehicle against
 * TRANSLATION perfectly and against ROTATION not at all — with the yaw axis unguarded, all four
 * wheels produce the same corrective force, which sums to cancel the pull and contributes zero
 * opposing torque. So a cable hooked 3 m behind the centre of a 6.8 tonne truck yawed it 40
 * degrees over half a minute on dry pavement, at 7 cm/s, while every translation assertion
 * passed. Measured in the Ha trace, where the fairlead had wandered 2.3 m south of where it was
 * parked.
 *
 * The friction torque available is sum(fMax_i * |r_i|), scaled by `yawFrictionShare` because
 * those same contact patches are already spending part of their grip on holding the vehicle
 * still. Splitting one friction budget across two axes with a constant is a simplification, and
 * it is the kind the GDD's §4 contract allows: the player can still say exactly why the truck
 * did or did not swing.
 *
 * ── IT IS A STATIC EFFECT ONLY, AND THAT MATTERS ──────────────────────────────────────
 * Once a body is actually moving, the per-wheel lateral forces in tires.js ALREADY oppose each
 * contact patch's scrub, and that is the same friction. Applying a yaw torque on top of it
 * double-counts, and the thing it breaks is not subtle: a dragged car stops swinging its nose
 * toward the pull and gets hauled broadside instead. Measured — with this applied at full
 * strength while moving, a recovery that needed 12 kN from one parking spot needed 42 kN from
 * another and parted the cable, because the sedan was being dragged sideways across the slope
 * rather than rolling up it. That read to a player as "the wrong parking spot is impossible",
 * which is exactly the kind of invisible gate the design cannot have.
 *
 * So it fades out as the body starts to move. A parked truck creeping in yaw at 0.02 rad/s still
 * gets ~95% of it; a load being dragged at 0.4 m/s gets none.
 */
export function applyYawResistance(veh, dtSec) {
  const b = veh.body;
  const V = CONFIG.vehicle;
  const restFrac = 1 - clamp(Math.max(b.speed / V.yawStaticMps, Math.abs(b.omega) / V.yawStaticRadps), 0, 1);
  if (restFrac <= 0) return 0;

  let avail = 0;
  for (let i = 0; i < veh.def.wheels.length; i++) {
    const ws = veh.wheelState[i];
    if (!ws.attached || !ws.fMax) continue;
    avail += ws.fMax * Math.hypot(ws.x - b.x, ws.y - b.y);
  }
  avail *= V.yawFrictionShare * restFrac;
  if (avail <= 0) return 0;

  const dir = Math.abs(b.omega) > 1e-4 ? Math.sign(b.omega) : Math.sign(b.torque) || 1;
  const cap = Math.abs(b.omega) * b.inertia / dtSec + Math.max(0, dir * b.torque);
  const use = Math.min(avail, cap);
  if (use > 0) b.applyTorque(-dir * use);
  return use;
}

/** Cribbing resists the body pivoting away from the blocks. GDD §4: "reduces drag and
 *  limits rotation". Applied as pure yaw resistance, capped so it cannot reverse the spin. */
export function applySpinResistance(veh, dtSec) {
  const b = veh.body;
  if (veh.spinResistN <= 0) return 0;
  const cap = Math.abs(b.omega) * b.inertia / dtSec + Math.max(0, Math.sign(b.omega) * b.torque);
  const use = Math.min(veh.spinResistN, cap);
  if (use > 0) b.applyTorque(-Math.sign(b.omega || b.torque || 1) * use);
  return use;
}

/**
 * Wheel chocks. A chock only resists motion of the wheel TOWARD it — that is what a wedge
 * does — so its usefulness is entirely a question of which side of the wheel it is on.
 * GDD §4: "poor placement has little effect". Nothing here checks whether the placement was
 * clever; it checks the geometry, and clever placements pass.
 */
export function applyChockResistance(veh, dtSec) {
  const b = veh.body;
  let total = 0;
  for (const aid of veh.chockAids) {
    const ws = veh.wheelState[aid.wheelIndex];
    if (!ws || !ws.attached) continue;
    const vel = b.velocityAt(ws.x, ws.y);
    // Positive means this wheel is moving into the chock.
    const into = vel.x * aid.dirX + vel.y * aid.dirY;
    const applied = (b.fx * aid.dirX + b.fy * aid.dirY) / veh.wheelState.length;
    if (into < -0.02 && applied <= 0) continue;    // rolling away from it: a chock does nothing
    const rc = resistanceCap(b.massKg / veh.wheelState.length, Math.max(0, into), applied, dtSec);
    const use = Math.min(aid.resistN, rc.cap);
    if (use <= 0) continue;
    b.applyForceAt(-aid.dirX * use, -aid.dirY * use, ws.x, ws.y,
                   CONFIG.debug.showForces ? 'chock' : '');
    total += use;
  }
  return total;
}

/**
 * One vehicle, one step. Order is fixed:
 *
 *   external forces already in the accumulator (cable, contacts)
 *   -> slope        because the tires need to know what they are holding back
 *   -> bogged       same reason, and it reads the cable force to decide whether to hold
 *   -> chocks       they resist the same load the tires do, in parallel with them
 *   -> tires        reads the accumulated external force to size its static resistance
 *   -> spin resist
 *   -> integrate
 *
 * Reorder this and the static-friction cap starts sizing itself against a force that has
 * not arrived yet, at which point vehicles creep under loads they should hold.
 */
export function stepVehicle(veh, terrain, dtSec, bus = null, simTimeMs = 0) {
  const b = veh.body;

  applySlopeForce(veh, terrain);
  applyBoggedResistance(veh, dtSec);
  applyChockResistance(veh, dtSec);
  applyWheelForces(veh, terrain, dtSec);
  applyYawResistance(veh, dtSec);       // must follow the tires: it reads their friction budget
  applySpinResistance(veh, dtSec);

  // Roll-over check, before integrating while the accumulated force is still readable.
  //
  // It has to be SUSTAINED. A rollover is a body rotating over its outside wheels, which takes
  // a couple of hundred milliseconds of lateral load — not one step of it. Checking the instant
  // value flipped cars on a single-step force spike: a hard winch pull is briefly worth 3 g at
  // the tow eye, and the sedan would arrive on the road upside down for no reason a player could
  // see. Caught in the m1 Ha trace, where ROLLED_OVER fired during an ordinary recovery.
  if (!veh.rolled) {
    const r = b.right;
    const latG = Math.abs((b.fx * r.x + b.fy * r.y) / b.massKg) / CONFIG.sim.gravity;
    if (latG > CONFIG.vehicle.rollThresholdG && b.speed > 1.0) {
      veh.rollLoadMs = (veh.rollLoadMs || 0) + dtSec * 1000;
    } else {
      veh.rollLoadMs = 0;
    }
    if ((veh.rollLoadMs || 0) >= CONFIG.vehicle.rollSustainMs) {
      veh.rolled = true;
      veh.gripMul = 0.55;
      veh.dragMul = 1.6;
      if (bus) bus.emit('ROLLED_OVER', { vehicle: veh.id, lateralG: Math.round(latG * 100) / 100 }, simTimeMs);
    }
  }

  const before = { x: b.x, y: b.y };
  b.integrate(dtSec);

  // Distance travelled frees a bogged vehicle. Measured after integration so it counts
  // real displacement rather than intent.
  const moved = Math.hypot(b.x - before.x, b.y - before.y);
  if (moved > 0) {
    veh.travelledM += moved;
    if (veh.boggedN0 > 0) {
      veh.boggedFactor = Math.exp(-veh.travelledM / CONFIG.sedan.boggedFreeM);
      if (veh.boggedFactor < 1e-3) veh.boggedFactor = 0;
    }
  }

  const c = terrain.clampToWorld(b.x, b.y, b.boundRadius * 0.5);
  if (c.clamped) { b.x = c.x; b.y = c.y; b.vx *= -0.2; b.vy *= -0.2; }
}

/** Driver inputs from a steering/throttle axis pair. Steering eases toward the request and
 *  self-centres when released, so a parked truck does not hold full lock forever. */
export function applyDriverInput(veh, steerAxis, throttleAxis, parkBrakeToggle, dtSec) {
  const T = CONFIG.truck;
  const target = steerAxis * T.maxSteerRad;
  const rate = (steerAxis === 0 ? T.steerReturnRad : T.steerRateRad) * dtSec;
  const d = target - veh.steerRad;
  veh.steerRad += clamp(d, -rate, rate);
  veh.steerRad = clamp(veh.steerRad, -T.maxSteerRad, T.maxSteerRad);

  // Pressing away from travel is braking, not reverse, until the vehicle has nearly stopped
  // — otherwise a tap of S at 8 m/s throws a 7-tonne truck into reverse.
  const fwd = veh.body.forward;
  const vf = veh.body.vx * fwd.x + veh.body.vy * fwd.y;
  if (throttleAxis < 0 && vf > 0.6) { veh.brakeInput = -throttleAxis; veh.throttle = 0; }
  else if (throttleAxis > 0 && vf < -0.6) { veh.brakeInput = throttleAxis; veh.throttle = 0; }
  else { veh.brakeInput = 0; veh.throttle = throttleAxis; }

  if (parkBrakeToggle) veh.parkBrake = !veh.parkBrake;
  // Touching the throttle releases the parking brake, because everybody does that anyway
  // and discovering it as a bug report would be worse than discovering it as a rule.
  if (veh.throttle > 0 && veh.parkBrake) veh.parkBrake = false;
}

/** Nobody in the seat: no drive, no steering input, handbrake as left. */
export function releaseDriverInput(veh) {
  veh.throttle = 0;
  veh.brakeInput = 0;
  veh.steerRad *= 0.9;
}

/** Are all four chassis corners over pavement? The success test, and nothing else. */
export function cornersOnRoad(veh, terrain) {
  const cs = veh.body.corners();
  let on = 0;
  for (const c of cs) if (terrain.onRoad(c.x, c.y)) on++;
  return { on, of: cs.length, all: on === cs.length };
}

/** Human-readable state for the inspect card. Facts only — no advice. GDD §5. */
export function describeVehicle(veh, terrain) {
  const b = veh.body;
  const surf = terrain.surfaceAt(b.x, b.y);
  const slope = terrain.slopeAt(b.x, b.y);
  const lost = Object.entries(veh.damage.parts).filter(([, s]) => s === 'lost').map(([p]) => p);
  const bent = Object.entries(veh.damage.parts).filter(([, s]) => s === 'bent').map(([p]) => p);
  const lockedWheels = veh.wheelState.filter((w) => w.locked || (veh.parkBrake && w.attached)).length;
  return {
    label: veh.def.label,
    surface: surf.label,
    slopeDeg: Math.round(Math.atan(slope.mag) * 180 / Math.PI),
    boggedFrac: Math.round(veh.boggedFactor * 100),
    lockedWheels,
    lost, bent,
    dents: veh.damage.dents,
    rolled: veh.rolled,
    speed: Math.round(b.speed * 10) / 10,
    onRoad: cornersOnRoad(veh, terrain),
  };
}

export { stoppingForce };
