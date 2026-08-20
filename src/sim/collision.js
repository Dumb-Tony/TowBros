/* Contacts: box-vs-box, box-vs-tree, box-vs-guardrail.
 *
 * Separating-axis test for the overlap, then ONE impulse at the deepest point. No manifold,
 * no warm starting, no stacking. GDD §4 simplification contract: "damped planar rigid
 * bodies", and this is the contact model that matches that promise.
 *
 * One point of contact is enough because of what contacts are FOR in this game. They are
 * not a physics showcase; they are the moment a recovery goes wrong — a sedan swinging into
 * the guardrail, a truck sliding into the vehicle it came to collect, a torn-off bumper
 * getting run over. Each of those needs a believable shove, a rotation, and an IMPULSE
 * NUMBER that the damage system can compare against a threshold. It does not need
 * penetration-free stacking.
 *
 * Everything static (trees, rail) is expressed as a Body with invMass 0, so there is one
 * code path rather than three.
 */

import { CONFIG } from '../config.js';
import { cross, clamp } from '../core/vec.js';

/** Half-thickness used to turn a guardrail segment into a thin box. */
const RAIL_HALF_W = 0.09;

/** Per-step decay of a rail segment's accumulated load, for a ~0.5 s time constant at 60 Hz.
 *  A steady push of p N·s per step settles at p/(1-decay) ≈ 30p, so a sustained 3.6 kN bends the
 *  rail within half a second and a sustained 10 kN takes the section out. */
const RAIL_LOAD_DECAY = Math.exp(-(CONFIG.sim.stepMs / 1000) / 0.5);

/**
 * Separating-axis overlap test between two oriented boxes.
 * @returns {{nx:number, ny:number, depth:number, cx:number, cy:number}|null}
 *   normal points from a toward b; (cx,cy) is the contact point.
 */
export function obbOverlap(a, b) {
  // Broad phase first: two circumscribed circles. Most pairs die here.
  const dx = b.x - a.x, dy = b.y - a.y;
  const rr = a.boundRadius + b.boundRadius;
  if (dx * dx + dy * dy > rr * rr) return null;

  const axes = [];
  const ca = Math.cos(a.angle), sa = Math.sin(a.angle);
  const cb = Math.cos(b.angle), sb = Math.sin(b.angle);
  axes.push({ x: ca, y: sa }, { x: -sa, y: ca }, { x: cb, y: sb }, { x: -sb, y: cb });

  const ac = a.corners(), bc = b.corners();
  let best = null;

  for (const ax of axes) {
    let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
    for (const p of ac) { const d = p.x * ax.x + p.y * ax.y; if (d < aMin) aMin = d; if (d > aMax) aMax = d; }
    for (const p of bc) { const d = p.x * ax.x + p.y * ax.y; if (d < bMin) bMin = d; if (d > bMax) bMax = d; }
    if (aMax < bMin || bMax < aMin) return null;          // a separating axis: done
    const overlap = Math.min(aMax - bMin, bMax - aMin);
    if (!best || overlap < best.depth) {
      // Orient the axis from a to b so callers never have to guess the sign.
      const sign = (dx * ax.x + dy * ax.y) < 0 ? -1 : 1;
      best = { nx: ax.x * sign, ny: ax.y * sign, depth: overlap };
    }
  }
  if (!best) return null;

  // Contact point: b's corner furthest along -n, which is its deepest point inside a.
  let deep = bc[0], deepD = Infinity;
  for (const p of bc) {
    const d = p.x * best.nx + p.y * best.ny;
    if (d < deepD) { deepD = d; deep = p; }
  }
  best.cx = deep.x; best.cy = deep.y;
  return best;
}

/** Closest point on an oriented box to a world point, plus whether it was inside. */
export function closestOnBox(box, wx, wy) {
  const l = box.toLocal(wx, wy);
  const cx = clamp(l.x, -box.halfL, box.halfL);
  const cy = clamp(l.y, -box.halfW, box.halfW);
  const inside = cx === l.x && cy === l.y;
  const w = box.toWorld(cx, cy);
  return { x: w.x, y: w.y, inside, localX: cx, localY: cy };
}

/**
 * Resolve one contact with a single impulse plus positional correction.
 *
 * @param {number} restitution  0 is a dead thud, which is what two vehicles at 3 m/s are
 * @param {number} friction     tangential impulse as a fraction of the normal one
 * @returns {number} normal impulse magnitude in N·s — the number the damage system reads
 */
export function resolveContact(a, b, hit, restitution = 0.12, friction = 0.45) {
  const { nx, ny, depth, cx, cy } = hit;
  const invSum = a.invMass + b.invMass;
  if (invSum <= 0) return 0;

  const raX = cx - a.x, raY = cy - a.y;
  const rbX = cx - b.x, rbY = cy - b.y;

  const va = a.velocityAt(cx, cy);
  const vb = b.velocityAt(cx, cy);
  const rvx = vb.x - va.x, rvy = vb.y - va.y;
  const vn = rvx * nx + rvy * ny;

  // Separating already: no impulse, but still push them apart below.
  let jn = 0;
  if (vn < 0) {
    const rnA = cross(raX, raY, nx, ny);
    const rnB = cross(rbX, rbY, nx, ny);
    const denom = invSum + rnA * rnA * a.invInertia + rnB * rnB * b.invInertia;
    jn = -(1 + restitution) * vn / denom;
    a.applyImpulseAt(-jn * nx, -jn * ny, cx, cy);
    b.applyImpulseAt(jn * nx, jn * ny, cx, cy);

    // Tangential friction, Coulomb-clamped to the normal impulse. This is what makes a
    // glancing hit spin a vehicle instead of sliding it cleanly along.
    const tx = -ny, ty = nx;
    const va2 = a.velocityAt(cx, cy), vb2 = b.velocityAt(cx, cy);
    const vt = (vb2.x - va2.x) * tx + (vb2.y - va2.y) * ty;
    const rtA = cross(raX, raY, tx, ty);
    const rtB = cross(rbX, rbY, tx, ty);
    const denomT = invSum + rtA * rtA * a.invInertia + rtB * rtB * b.invInertia;
    let jt = -vt / denomT;
    const maxT = friction * Math.abs(jn);
    jt = clamp(jt, -maxT, maxT);
    a.applyImpulseAt(-jt * tx, -jt * ty, cx, cy);
    b.applyImpulseAt(jt * tx, jt * ty, cx, cy);
  }

  // Positional correction, with SLOP and a gentle coefficient (Baumgarte). Both matter here for
  // a reason that has nothing to do with contacts looking right:
  //
  // A positional correction is not physics. It teleports a body. Anything reading POSITIONS with
  // a stiff constraint sees that teleport as instantaneous deformation — and this game has a
  // 520 kN/m cable doing exactly that. At 80% correction, a 2 cm overlap resolved in one step
  // handed the cable 2 cm of stretch it had not earned, which is 10 kN in a single step. That
  // outran the winch's overload relief and parted the line at 42 kN every time a car was winched
  // into something solid. Measured across a 15-park grid: fifteen jams, fifteen snapped cables.
  //
  // So: leave 1 cm of overlap alone entirely (invisible on a 4.5 m car) and resolve the rest at
  // 25% per step. Contacts settle over a handful of steps instead of one, and the cable only ever
  // sees speeds a body actually had.
  const corr = Math.max(0, depth - 0.01) * 0.25;
  a.x -= nx * corr * (a.invMass / invSum);
  a.y -= ny * corr * (a.invMass / invSum);
  b.x += nx * corr * (b.invMass / invSum);
  b.y += ny * corr * (b.invMass / invSum);

  return jn;
}

/** A static Body-shaped stand-in for scenery, built once per attempt and reused. */
function staticBox(id, x, y, angle, halfL, halfW) {
  return {
    id, x, y, angle, halfL, halfW,
    vx: 0, vy: 0, omega: 0, invMass: 0, invInertia: 0, massKg: Infinity,
    get boundRadius() { return Math.hypot(this.halfL, this.halfW); },
    corners() {
      const c = Math.cos(this.angle), s = Math.sin(this.angle);
      const L = this.halfL, W = this.halfW;
      return [[L, -W], [L, W], [-L, W], [-L, -W]].map(([lx, ly]) => ({
        x: this.x + lx * c - ly * s, y: this.y + lx * s + ly * c,
      }));
    },
    toLocal(wx, wy) {
      const c = Math.cos(-this.angle), s = Math.sin(-this.angle);
      const dx = wx - this.x, dy = wy - this.y;
      return { x: dx * c - dy * s, y: dx * s + dy * c };
    },
    toWorld(lx, ly) {
      const c = Math.cos(this.angle), s = Math.sin(this.angle);
      return { x: this.x + lx * c - ly * s, y: this.y + lx * s + ly * c };
    },
    velocityAt() { return { x: 0, y: 0 }; },
    applyImpulseAt() {},
  };
}

/** Build the static collision set for a scene. Trees become square boxes (a round trunk in
 *  a box world is close enough at this scale); rail segments become thin ones. */
export function buildScenery(terrain) {
  const items = [];
  for (const t of terrain.trees) {
    items.push({ kind: 'tree', ref: t, box: staticBox(t.id, t.x, t.y, 0, t.r, t.r) });
  }
  for (const s of terrain.railSegments) {
    const mx = (s.ax + s.bx) / 2, my = (s.ay + s.by) / 2;
    const ang = Math.atan2(s.by - s.ay, s.bx - s.ax);
    const half = Math.hypot(s.bx - s.ax, s.by - s.ay) / 2;
    items.push({ kind: 'rail', ref: s, box: staticBox(s.id, mx, my, ang, half, RAIL_HALF_W) });
  }
  return items;
}

/**
 * All contacts for one step: dynamic-vs-dynamic, then dynamic-vs-scenery.
 *
 * @param {Array<{body:Body, id:string}>} dynamics  vehicles and debris, in a stable order
 * @param {Array} scenery  from buildScenery
 * @param {object} bus
 * @param {number} simTimeMs
 * @param {(a,b,impulse,hit)=>void} [onImpact]  damage hook; kept out of here on purpose
 * @returns {number} the largest impulse of the step, for camera kick and audio
 */
/** Is one of these two carrying the other on its wheel lift? */
function joinedByLift(A, B) {
  return (A.lift && A.lift.carryingId === B.id) || (B.lift && B.lift.carryingId === A.id);
}

export function stepCollisions(dynamics, scenery, bus, simTimeMs, onImpact) {
  let peak = 0;

  for (let i = 0; i < dynamics.length; i++) {
    for (let j = i + 1; j < dynamics.length; j++) {
      const A = dynamics[i], B = dynamics[j];
      /* Two bodies held together by the wheel lift do NOT also collide.
       *
       * Not an optimisation — a correctness fix, and one this codebase had already learned the
       * hard way in a different place: a positional correction is a TELEPORT, and any stiff
       * constraint reading positions sees it as instantaneous deformation. An articulated car can
       * bring its nose within a few centimetres of the truck carrying it, and every contact
       * correction there was fed straight back into the hitch. MEASURED: the pair stayed at 3 kN
       * for a hundred metres of straight towing and then jumped to 94 kN in a single step during a
       * swerve. Filtering constrained pairs is what every solver does, for this reason. */
      if (joinedByLift(A, B)) continue;
      const hit = obbOverlap(A.body, B.body);
      if (!hit) continue;
      const jn = resolveContact(A.body, B.body, hit, 0.12, 0.45);
      if (jn > peak) peak = jn;
      if (onImpact) onImpact(A, B, jn, hit);
    }
  }

  for (const A of dynamics) {
    for (const S of scenery) {
      if (S.kind === 'rail' && (S.ref.broken || S.ref.flat)) continue;   // a folded rail is not a wall
      const hit = obbOverlap(A.body, S.box);
      if (!hit) continue;
      // A tree does not move and does not care. The rail is the opposite of that.
      const rest = S.kind === 'tree' ? 0.22 : 0.05;
      const jn = resolveContact(A.body, S.box, hit, rest, 0.55);
      if (jn > peak) peak = jn;

      if (S.kind === 'rail') {
        // The rail is weak on purpose — GDD §4 lists it among the things that "create options".
        // It yields first, sagging out of the way and getting easier to push, and only then lets
        // go. Judged on impulse, for the reason in CONFIG.damage.
        //
        // TWO SEPARATE TESTS, because there are two ways to defeat a guardrail and they are not
        // the same event.
        //
        //  - A SHUNT breaks it: one big impulse, judged on its own. Hitting a rail at 4 m/s takes
        //    the section out.
        //  - A LEAN bends it: many small impulses, judged on an accumulator with a 0.5 s time
        //    constant, and it can only ever BEND — steel folds under sustained load, it does not
        //    shatter. Once it is folded flat it stops being a wall and the car goes over it.
        //
        // Both halves were wrong in turn. Per-step only made the rail immovable against a slow
        // push, so a winch dragging a car into it at 0.4 m/s went to 34 kN and parted the line
        // against something the design calls weak. Accumulating for BOTH then let a slow push
        // break the rail outright, and the car ploughed through and kept going. A lean flattens
        // it; only a hit removes it.
        const single = Math.abs(jn);
        S.ref.load = (S.ref.load || 0) * RAIL_LOAD_DECAY + single;

        if (single > CONFIG.damage.guardrailBreakNs && !S.ref.broken) {
          S.ref.broken = true;
          bus.emit('GUARDRAIL_BENT', { id: S.ref.id, broken: true, impulseNs: Math.round(single) }, simTimeMs);
        } else if (S.ref.load > CONFIG.damage.guardrailYieldNs && !S.ref.flat) {
          const over = (S.ref.load - CONFIG.damage.guardrailYieldNs) / CONFIG.damage.guardrailYieldNs;
          const add = Math.min(0.05, over * 0.010);
          if (add > 0.0004) {
            S.ref.bend = Math.min(1, S.ref.bend + add);
            S.box.y += add * 0.35;             // it sags south, out of the recovery lane
            S.ref.ay += add * 0.35; S.ref.by += add * 0.35;
            if (S.ref.bend > 0.12 && !S.ref._reported) {
              S.ref._reported = true;
              bus.emit('GUARDRAIL_BENT', { id: S.ref.id, broken: false, impulseNs: Math.round(S.ref.load) }, simTimeMs);
            }
            // Folded flat. Still there, still visible, no longer an obstacle.
            if (S.ref.bend >= 1) {
              S.ref.flat = true;
              bus.emit('GUARDRAIL_BENT', { id: S.ref.id, broken: false, flattened: true }, simTimeMs);
            }
          }
        }
      }
      if (onImpact) onImpact(A, { id: S.box.id, kind: S.kind, ref: S.ref }, jn, hit);
    }
  }

  return peak;
}
