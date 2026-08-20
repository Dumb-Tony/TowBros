/* Planar rigid body: position, angle, velocity, spin, and forces applied AT A POINT.
 *
 * GDD §6 asks for "fixed-step planar rigid-body integration". The reason it has to be a
 * rigid body rather than the circle-and-friction arcade model used in
 * AirportBaggageCrew\src\systems\physics.js is one line of the design: "equal-and-opposite
 * winch force applied at physical attachment offsets, INCLUDING TORQUE". A cable hooked to
 * the corner of a bumper has to twist the car. Without angular dynamics there is no
 * difference between hooking the tow eye and hooking a door, and the whole rigging
 * decision collapses.
 *
 * Semi-implicit Euler at a fixed step. No solver, no constraints, no stacking — contacts
 * are resolved as single-point impulses in src/sim/collision.js. That is the level of
 * fidelity the GDD's simplification contract asks for and no more.
 *
 * Convention (src/core/vec.js): +x east, +y south, angle 0 faces +x, positive angle and
 * positive torque both turn clockwise on screen.
 */

import { CONFIG } from '../config.js';
import { rot, unrot, cross, capMag } from '../core/vec.js';

export class Body {
  /**
   * @param {object} o
   * @param {number} o.massKg     use Infinity for immovable scenery (not used yet)
   * @param {number} o.inertia    kg·m² about the centre
   * @param {number} o.halfL      half length along local +x
   * @param {number} o.halfW      half width along local +y
   */
  constructor({ id, x = 0, y = 0, angle = 0, massKg = 1, inertia = 1, halfL = 0.5, halfW = 0.5 }) {
    this.id = id;
    this.x = x; this.y = y; this.angle = angle;
    this.vx = 0; this.vy = 0; this.omega = 0;

    this.massKg = massKg;
    this.inertia = inertia;
    this.invMass = massKg > 0 && massKg < Infinity ? 1 / massKg : 0;
    this.invInertia = inertia > 0 && inertia < Infinity ? 1 / inertia : 0;

    this.halfL = halfL; this.halfW = halfW;

    // Accumulators, cleared once per step by clearForces().
    this.fx = 0; this.fy = 0; this.torque = 0;

    // Last step's linear acceleration, kept for load transfer in the tire model. Reading
    // the previous step avoids a circular dependency between load and the forces that
    // depend on load, at the cost of one step of lag nobody can perceive.
    this.axPrev = 0; this.ayPrev = 0;

    /** Diagnostics the debug overlay and the tests read. Never gameplay inputs. */
    this.appliedForces = [];   // {x,y,fx,fy,tag} — cleared with the accumulators
  }

  /* ── frames ───────────────────────────────────────────────────────────── */

  /** Body-local point -> world point. */
  toWorld(lx, ly) {
    const r = rot(lx, ly, this.angle);
    return { x: this.x + r.x, y: this.y + r.y };
  }

  /** World point -> body-local point. */
  toLocal(wx, wy) { return unrot(wx - this.x, wy - this.y, this.angle); }

  /** Local direction -> world direction (no translation). */
  dirToWorld(lx, ly) { return rot(lx, ly, this.angle); }

  /** Unit vector along the body's nose. */
  get forward() { return { x: Math.cos(this.angle), y: Math.sin(this.angle) }; }
  /** Unit vector out of the body's right flank. */
  get right() { return { x: -Math.sin(this.angle), y: Math.cos(this.angle) }; }

  /** Velocity of the material point currently at world (wx,wy): v + ω × r. */
  velocityAt(wx, wy) {
    const rx = wx - this.x, ry = wy - this.y;
    return { x: this.vx - this.omega * ry, y: this.vy + this.omega * rx };
  }

  get speed() { return Math.hypot(this.vx, this.vy); }

  /** The four corners, world space, in order FL, FR, RR, RL. */
  corners() {
    const c = Math.cos(this.angle), s = Math.sin(this.angle);
    const L = this.halfL, W = this.halfW;
    const out = [];
    const pts = [[L, -W], [L, W], [-L, W], [-L, -W]];
    for (const [lx, ly] of pts) {
      out.push({ x: this.x + lx * c - ly * s, y: this.y + lx * s + ly * c });
    }
    return out;
  }

  /** Is a world point inside the footprint? Cheap: transform, then compare in local space. */
  containsPoint(wx, wy, pad = 0) {
    const p = this.toLocal(wx, wy);
    return Math.abs(p.x) <= this.halfL + pad && Math.abs(p.y) <= this.halfW + pad;
  }

  /** Circumscribed radius, for broad-phase rejection. */
  get boundRadius() { return Math.hypot(this.halfL, this.halfW); }

  /* ── forces ───────────────────────────────────────────────────────────── */

  clearForces() {
    this.fx = 0; this.fy = 0; this.torque = 0;
    if (this.appliedForces.length) this.appliedForces.length = 0;
  }

  /** Force through the centre of mass: no torque. */
  applyForce(fx, fy, tag = '') {
    this.fx += fx; this.fy += fy;
    if (tag) this.appliedForces.push({ x: this.x, y: this.y, fx, fy, tag });
  }

  /**
   * Force applied at a world point. THE function this class exists for: the offset from
   * the centre of mass turns part of the force into torque, which is why hooking the
   * corner of a bumper spins the car and hooking the tow eye does not.
   */
  applyForceAt(fx, fy, wx, wy, tag = '') {
    this.fx += fx; this.fy += fy;
    this.torque += cross(wx - this.x, wy - this.y, fx, fy);
    if (tag) this.appliedForces.push({ x: wx, y: wy, fx, fy, tag });
  }

  /** Instant velocity change at a point — collisions and the cable-snap recoil. */
  applyImpulseAt(ix, iy, wx, wy) {
    this.vx += ix * this.invMass;
    this.vy += iy * this.invMass;
    this.omega += cross(wx - this.x, wy - this.y, ix, iy) * this.invInertia;
  }

  applyTorque(t) { this.torque += t; }

  /** The accumulated force resolved along a unit direction. The resistance model needs
   *  this to tell "held in place" from "creeping", so it is worth its own method. */
  forceAlong(ux, uy) { return this.fx * ux + this.fy * uy; }

  /* ── integration ──────────────────────────────────────────────────────── */

  /**
   * Advance one fixed step. Semi-implicit: velocity first, then position from the NEW
   * velocity, which is what makes a stiff spring behave instead of ringing.
   */
  integrate(dtSec) {
    if (this.invMass === 0) { this.clearForces(); return; }

    const ax = this.fx * this.invMass;
    const ay = this.fy * this.invMass;
    this.axPrev = ax; this.ayPrev = ay;

    this.vx += ax * dtSec;
    this.vy += ay * dtSec;
    this.omega += this.torque * this.invInertia * dtSec;

    // Numerical safety net, not aerodynamics. See CONFIG.sim.linearDamping.
    const lin = Math.exp(-CONFIG.sim.linearDamping * dtSec);
    const ang = Math.exp(-CONFIG.sim.angularDamping * dtSec);
    this.vx *= lin; this.vy *= lin; this.omega *= ang;

    const cap = capMag(this.vx, this.vy, CONFIG.sim.maxSpeed);
    this.vx = cap.x; this.vy = cap.y;
    if (this.omega > CONFIG.sim.maxSpin) this.omega = CONFIG.sim.maxSpin;
    if (this.omega < -CONFIG.sim.maxSpin) this.omega = -CONFIG.sim.maxSpin;

    // Kill the last millimetre of creep so a settled vehicle is actually settled and the
    // success timer is not reset forever by a body drifting at 3 mm/s.
    if (Math.abs(this.vx) < 0.004) this.vx = 0;
    if (Math.abs(this.vy) < 0.004) this.vy = 0;
    if (Math.abs(this.omega) < 0.004) this.omega = 0;

    this.x += this.vx * dtSec;
    this.y += this.vy * dtSec;
    this.angle += this.omega * dtSec;

    this.clearForces();
  }

  /** Compact snapshot. Rounded, because tests compare two runs of one seed and a
   *  last-bit float difference is not a divergence. */
  describe() {
    const r4 = (v) => Math.round(v * 10000) / 10000;
    return {
      id: this.id,
      x: r4(this.x), y: r4(this.y), angle: r4(this.angle),
      vx: r4(this.vx), vy: r4(this.vy), omega: r4(this.omega),
      speed: r4(this.speed),
    };
  }
}

/** Force needed to arrest a body's motion within one step, along its own velocity.
 *  The ceiling for any resistance force: friction that exceeds this would push the body
 *  backwards, which is how a "friction" model ends up jittering. */
export function stoppingForce(body, dtSec) {
  return body.massKg * body.speed / dtSec;
}
