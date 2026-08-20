/* The tire model. Four contact patches per vehicle, one friction circle each.
 *
 * This file decides who wins. GDD pillar 2: "The winch does not know who should win.
 * Cable forces affect every connected body. Position, traction, slope, mass, and rigging
 * decide the result." Those five inputs meet here and nowhere else — the winch just adds a
 * force, and whether the wreck comes up the bank or the wrecker goes down it is settled by
 * comparing two sets of friction circles.
 *
 * Per wheel, per step:
 *   1. where is it, how fast is that patch of rubber actually moving
 *   2. how much weight is on it        (mass share x slope cosine x load transfer x jack)
 *   3. how much grip does that buy     (surface mu x damage)
 *   4. what does it want to do         (drive / brake / roll / resist sideways)
 *   5. clamp the total to the circle   -> whatever is left over is SLIP, and slip is
 *                                         what the player sees, hears and learns from
 *
 * ── THE PART THAT IS EASY TO GET WRONG ────────────────────────────────────────────────
 * Resistance forces are capped by `resistanceCap` below rather than applied at full
 * strength. Without that cap a locked wheel under a 8 kN pull creeps forward at a
 * constant 0.09 m/s forever: every step the brake cancels the velocity it already has,
 * never the force still arriving. With it, the brake is allowed to cancel the incoming
 * force too, so a load below the resistance produces NO motion — which is what "the sedan
 * sits there while the line goes bar-tight" requires. Static friction is the whole drama
 * of a recovery; a model that only does kinetic friction has no tension in it.
 */

import { CONFIG } from '../config.js';
import { clamp } from '../core/vec.js';

/**
 * Largest resistance force that may be applied against motion along one axis without
 * pushing the body back the other way.
 *
 * @param {number} massShare  kg this contact is responsible for
 * @param {number} vel        current velocity along the axis, m/s
 * @param {number} applied    external force already accumulated along the axis, N
 * @param {number} dtSec
 * @returns {{cap:number, dir:number}} cap in newtons, and the sign the resistance opposes
 */
export function resistanceCap(massShare, vel, applied, dtSec) {
  // Below the threshold the body is effectively at rest, so "which way is it going" has to
  // be answered by the force trying to move it instead.
  const dir = Math.abs(vel) > 1e-4 ? Math.sign(vel) : Math.sign(applied) || 1;
  const stop = (massShare * Math.abs(vel)) / dtSec;
  const hold = Math.max(0, dir * applied);
  return { cap: stop + hold, dir };
}

/**
 * Apply every wheel force for one vehicle. Mutates the body's force accumulators and each
 * wheel's diagnostic state; integrates nothing.
 *
 * Reads `body.fx/fy` as already-accumulated EXTERNAL force (cable, collisions, slope), so
 * it must run after those and before integrate(). src/game.js owns that order.
 *
 * @param {object} veh   a vehicle from src/sim/vehicle.js
 * @param {object} terrain  from src/data/terrain.js
 * @param {number} dtSec
 */
export function applyWheelForces(veh, terrain, dtSec) {
  const b = veh.body;
  const wheels = veh.def.wheels;
  const n = wheels.length;
  const g = CONFIG.sim.gravity;
  const V = CONFIG.vehicle;

  const nDriven = wheels.reduce((a, w) => a + (w.drive ? 1 : 0), 0) || 1;

  // Load transfer from LAST step's longitudinal acceleration. One step of lag, imperceptible,
  // and it breaks the circular dependency between load and the forces that depend on it.
  const fwd = b.forward;
  const aLong = b.axPrev * fwd.x + b.ayPrev * fwd.y;
  const transfer = clamp((aLong / g) * V.loadTransfer, -0.45, 0.45);

  // Snapshot the external force BEFORE any wheel touches the accumulator, so every wheel
  // judges the same incoming load. Reading it live would make wheel 1 hold the whole pull
  // and wheels 2-4 hold nothing.
  const extFx = b.fx, extFy = b.fy;

  /* How many wheels are actually on the ground, and how much weight they are holding.
   *
   * `airborne` is a wheel-lift axle: fully off the ground, carrying nothing, and its share of the
   * car's weight has to go to the wheels that ARE down rather than simply vanishing. Dividing by
   * `n` regardless left a carried sedan's two rear tyres holding a quarter of its mass each
   * instead of half, which is half the grip and reads as a car that skates.
   *
   * `groundLoadMul` is the rest of the same fact from the other side: 45% of a lifted car's mass
   * is on the truck now, so only 55% is on its own tyres. And `extraLoadKg` is where that 45% went
   * — a loaded wrecker really does have more grip, which is most of why the tow works at all. */
  const grounded = veh.wheelState.reduce((a, s) => a + (s.airborne ? 0 : 1), 0) || n;
  const groundKg = (b.massKg + veh.extraLoadKg) * veh.groundLoadMul;
  const massShare = groundKg / grounded;

  /* The governor, computed ONCE. Scaling `veh.throttle` itself inside the wheel loop would have
   * compounded per driven wheel and leaked the reduced value out to the HUD and the next step —
   * the same class of mistake as reading `b.fx` live per wheel instead of snapshotting it. */
  let govMul = 1;
  if (veh.lift && veh.lift.state === 'carrying') {
    const over = b.speed - CONFIG.lift.towSpeedMaxMps;
    if (over > 0) govMul = Math.max(0, 1 - over / 1.5);
  }

  let anySlip = 0, totalLoad = 0;

  for (let i = 0; i < n; i++) {
    const w = wheels[i];
    const ws = veh.wheelState[i];
    const p = b.toWorld(w.local.x, w.local.y);

    const steer = w.steer ? veh.steerRad : 0;
    const wa = b.angle + steer;
    const fx = Math.cos(wa), fy = Math.sin(wa);   // wheel forward
    const lx = -fy, ly = fx;                      // wheel lateral (its right)

    const vel = b.velocityAt(p.x, p.y);
    const vf = vel.x * fx + vel.y * fy;
    const vl = vel.x * lx + vel.y * ly;

    const surf = terrain.surfaceAt(p.x, p.y);
    const slope = terrain.slopeAt(p.x, p.y);

    // Weight on this patch. Front wheels lighten under acceleration, rear under braking.
    let share = (1 / grounded) * (1 + (w.local.x >= 0 ? -transfer : transfer));
    share = Math.max(V.minNormalFrac / grounded, share);
    // A jacked corner has its weight taken by the jack, not by the tire — so grip there
    // genuinely disappears. That is the trade the player is making. A wheel-lift axle is a
    // stronger version of the same thing: not lightened, off the ground.
    const liftMul = ws.airborne ? 0 : (ws.lifted ? 0.15 : 1);
    const N = groundKg * g * slope.normalFrac * share * liftMul;
    totalLoad += N;

    // A dug-in hub is not a tire and is not bound by a tire's friction circle: it is a plough,
    // and it can resist far more than the rubber it replaced. Without raising the circle here,
    // the extra drag computed below was clamped straight back down to mu*N and a lost wheel
    // cost the sedan nothing — m1 Hh measured a wheel-less car coming up FASTER than an intact
    // one. GDD §4 says a detached wheel "sharply increases drag", so the ceiling has to move too.
    const mu = surf.mu * ws.gripMul * veh.gripMul
      * (ws.attached ? 1 : CONFIG.damage.wheelLostDragMul);
    const fMax = mu * N;

    /* ── longitudinal ─────────────────────────────────────────────────── */
    let long = 0;

    /* Drive. Only driven wheels, only when the vehicle has a driver.
     *
     * A loaded wrecker is governed: past `towSpeedMaxMps` the drive force fades out. Real recovery
     * trucks are limited with something on the lift, and a game one has to be — a two-wheeled
     * trailer on a hitch is dynamically unstable above about ten metres a second no matter how
     * well the constraint is damped, and a governor is a far more honest answer to that than
     * pretending the physics holds. */
    if (w.drive && veh.throttle !== 0) {
      const thr = veh.throttle * (veh.throttle > 0 ? govMul : 1);
      // driveMul is the company's truck condition (meta/company.js), 1 for a game without one.
      long += thr > 0
        ? thr * (CONFIG.truck.driveForceN * veh.driveMul / nDriven)
        : thr * (CONFIG.truck.reverseForceN * veh.driveMul / nDriven);
    }

    // How much this wheel is willing to resist rolling. A missing wheel is not a wheel: the
    // corner ploughs, and it ploughs hard.
    let resistAvail;
    if (!ws.attached) {
      resistAvail = mu * N * CONFIG.damage.wheelLostDragMul;
    } else {
      const rolling = surf.crr * N * ws.dragMul * veh.dragMul;
      const locked = ws.locked || (w.park && veh.parkBrake) || veh.brakeInput > 0;
      const brake = veh.brakeInput > 0
        ? veh.brakeInput * (veh.def.driven ? CONFIG.truck.brakeForceN * veh.brakeMul : CONFIG.sedan.brakeForceN) / n
        : (veh.def.driven ? CONFIG.truck.parkBrakeForceN : CONFIG.sedan.brakeForceN) / n;
      resistAvail = locked ? Math.max(rolling, brake) : rolling;
    }

    const along = (extFx * fx + extFy * fy) / n + long;
    const rc = resistanceCap(massShare, vf, along, dtSec);
    const resist = Math.min(resistAvail, rc.cap);
    long -= rc.dir * resist;

    /* ── lateral ──────────────────────────────────────────────────────── */
    // The impulse that would cancel sideways motion this step, softened by lateralGrip so
    // a vehicle can be dragged sideways instead of running on rails.
    //
    // A wheel-less corner grips sideways MORE, not less: a bare hub digging into wet ground
    // resists in every direction, where a tire only resists across its tread. This was
    // backwards at first, and m1 Hh caught it as the wrong outcome rather than a wrong number —
    // a sedan missing a wheel came up FASTER than an intact one, because it skated sideways on
    // a diagonal pull. The GDD says a lost wheel "sharply increases drag"; a plough it is.
    const latGrip = ws.attached ? V.lateralGrip : Math.min(1, V.lateralGrip * 1.3);
    let lat = (-vl * massShare / dtSec) * latGrip;
    // Same static logic sideways: a stationary wheel must be able to hold the sideways
    // component of the pull, or a taut cable would walk a parked truck across the road.
    const latExt = (extFx * lx + extFy * ly) / n;
    const lrc = resistanceCap(massShare, vl, latExt, dtSec);
    const latMax = Math.min(fMax, lrc.cap);
    if (Math.abs(lat) > latMax) lat = Math.sign(lat) * latMax;
    if (Math.abs(vl) < 1e-4) lat = -clamp(latExt, -latMax, latMax);

    /* ── the friction circle ──────────────────────────────────────────── */
    const want = Math.hypot(long, lat);
    let slipFrac = 0;
    if (want > fMax && want > 1e-6) {
      const k = fMax / want;
      long *= k; lat *= k;
      slipFrac = clamp(want / Math.max(fMax, 1) - 1, 0, 4);
    }

    b.applyForceAt(long * fx + lat * lx, long * fy + lat * ly, p.x, p.y,
                   CONFIG.debug.showForces ? `tire${i}` : '');

    // Diagnostics for presentation: spray, smoke, tracks, and the audio slip channel. The
    // sliding SPEED is what a player sees, so record that rather than the force deficit.
    ws.x = p.x; ws.y = p.y;
    ws.steerRad = steer;
    ws.surface = surf.id;
    ws.load = N;
    ws.fMax = fMax;          // read by applyYawResistance to size its friction torque
    ws.forceN = Math.hypot(long, lat);
    ws.slipFrac = slipFrac;
    ws.slipMps = slipFrac > 0 ? Math.hypot(vf * 0.35, vl) : Math.abs(vl) * 0.35;
    ws.soft = surf.soft;
    if (ws.slipMps > anySlip) anySlip = ws.slipMps;
  }

  veh.maxSlipMps = anySlip;
  veh.totalLoadN = totalLoad;
  return anySlip;
}

/**
 * Peak force a vehicle's tires could resist as parked, given where it is standing.
 * Nothing in the simulation consumes this — it exists so the tests can assert the force
 * budget in src/config.js is still true, and so the debug overlay can show the number the
 * player is implicitly betting on.
 */
export function gripBudgetN(veh, terrain) {
  const b = veh.body;
  // Same accounting as applyWheelForces: only wheels on the ground count, they share the weight
  // that is actually on this vehicle, and a loaded wrecker is carrying more of it.
  const grounded = veh.wheelState.reduce((a, s) => a + (s.airborne ? 0 : 1), 0) || veh.def.wheels.length;
  const groundKg = (b.massKg + veh.extraLoadKg) * veh.groundLoadMul;
  let total = 0;
  veh.def.wheels.forEach((w, i) => {
    if (veh.wheelState[i].airborne) return;
    const p = b.toWorld(w.local.x, w.local.y);
    const surf = terrain.surfaceAt(p.x, p.y);
    const slope = terrain.slopeAt(p.x, p.y);
    total += surf.mu * (groundKg * CONFIG.sim.gravity / grounded) * slope.normalFrac;
  });
  return total * veh.gripMul;
}

/** Downhill force on a body where it stands, in newtons. The other half of the budget. */
export function downslopeN(body, terrain) {
  const s = terrain.slopeAt(body.x, body.y);
  return body.massKg * CONFIG.sim.gravity * s.mag * s.normalFrac;
}
