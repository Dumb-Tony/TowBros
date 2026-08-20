/* Planar vector helpers. Pure functions, no allocation-heavy class wrapper.
 *
 * Tow Bros is a 2D rigid-body game, so the two operations that matter most are ROTATE
 * (local offset -> world offset) and CROSS (offset x force -> torque). Every winch pull,
 * tire force and impact in the game is one of those two calls; they live here so no
 * system re-derives the sign convention and gets a torque backwards.
 *
 * Convention: +x east, +y SOUTH (screen-down, matching canvas). Angle 0 points +x, and
 * increases CLOCKWISE on screen because y is flipped. Positive torque therefore spins a
 * body clockwise on screen. Everything obeys this or nothing does.
 */

export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => { const x = clamp01(t); return x * x * (3 - 2 * x); };
/** Inverse-lerp: where does v sit between a and b, clamped to 0..1 */
export const norm = (v, a, b) => (b === a ? 0 : clamp01((v - a) / (b - a)));

/** Rotate (x,y) by `ang`. This is body-local -> world for a body at angle `ang`. */
export function rot(x, y, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return { x: x * c - y * s, y: x * s + y * c };
}

/** Rotate (x,y) by -ang. World offset -> body-local. */
export function unrot(x, y, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return { x: x * c + y * s, y: -x * s + y * c };
}

/** 2D cross product r x f — the scalar torque a force f makes about a pivot at r=0. */
export const cross = (rx, ry, fx, fy) => rx * fy - ry * fx;

export const dot = (ax, ay, bx, by) => ax * bx + ay * by;
export const len = (x, y) => Math.hypot(x, y);

/** Unit vector, or {x:0,y:0} for a zero vector — never NaN. */
export function unit(x, y) {
  const d = Math.hypot(x, y);
  return d < 1e-9 ? { x: 0, y: 0 } : { x: x / d, y: y / d };
}

/** Shortest signed angle from a to b, in (-PI, PI]. */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

/** Move `v` toward `target` by at most `maxDelta`. From ABC systems/physics.js. */
export function approach(v, target, maxDelta) {
  const d = target - v;
  if (d > maxDelta) return v + maxDelta;
  if (d < -maxDelta) return v - maxDelta;
  return target;
}

/** Clamp a vector's magnitude, preserving direction. Used for every force cap. */
export function capMag(x, y, max) {
  const d = Math.hypot(x, y);
  if (d <= max || d < 1e-9) return { x, y, mag: d, capped: false };
  const k = max / d;
  return { x: x * k, y: y * k, mag: max, capped: true };
}

/** Closest point to (px,py) on segment (ax,ay)-(bx,by), plus the parameter t. */
export function closestOnSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-12) return { x: ax, y: ay, t: 0 };
  const t = clamp01(((px - ax) * dx + (py - ay) * dy) / l2);
  return { x: ax + dx * t, y: ay + dy * t, t };
}
