/* Vehicle and attachment-zone definitions. Data only — no forces, no state, no canvas.
 *
 * Body-local axes: +x is FORWARD (out of the nose), +y is the vehicle's RIGHT. World +y is
 * south/screen-down, so at angle 0 a vehicle faces east and its local +y points south.
 * Every wheel offset, zone offset and winch fairlead below is in that frame, and
 * src/core/vec.js `rot` is the only thing allowed to leave it.
 *
 * ── ATTACHMENT ZONES ARE THE HEART OF THIS FILE ───────────────────────────────────────
 * GDD §4: "Forgiving attachment zones: frame, axle, tow hook, wheel, bumper, and body.
 * Almost any plausible choice works until its strength does not." So there is no valid /
 * invalid flag anywhere here. Every zone accepts the hook. Each one simply has a rating,
 * and a way of failing when the load passes it.
 *
 * `inspect` is what the player is told when they look. It states a FACT and never a
 * recommendation — GDD §5: "Inspection provides useful facts ('weak bumper', 'locked
 * wheel') without prescribing a solution." If a line here ever starts with "you should",
 * delete it.
 *
 * Zone ratings are multiplied by the rigging (CONFIG.rigging: bare 1.0, strap 1.4, chain
 * 1.75) at attach time, which is the mechanism behind the whole strap-or-chain decision.
 * See the force budget at the top of src/config.js before changing any number here.
 */

import { CONFIG } from '../config.js';

/** Box inertia about the centre — the only rigid-body number that is not authored. */
export function boxInertia(massKg, lengthM, widthM) {
  return (massKg * (lengthM * lengthM + widthM * widthM)) / 12;
}

/* ── failure modes ─────────────────────────────────────────────────────────── */
// What happens to the vehicle when a zone's rating is exceeded. The GDD is explicit that
// none of these end the job: "no instant fail for damage or a worsening scene".
export const FAIL = Object.freeze({
  HOLD:   'hold',    // stronger than the cable. The cable goes first.
  BEND:   'bend',    // survives as a part, but permanently adds drag
  DETACH: 'detach',  // leaves the vehicle and becomes a physical object in the scene
});

/**
 * Sedan attachment zones. Ratings in newtons, BEFORE the rigging multiplier.
 * Order matters only for the "nearest zone" tie-break, which prefers earlier entries.
 */
const SEDAN_ZONES = [
  { id: 'towHook', label: 'front tow hook', local: { x: 2.05, y: -0.42 }, strengthN: 46000,
    fail: FAIL.HOLD, part: null,
    inspect: 'Factory recovery eye, bolted to the subframe. Rated well past this cable.' },

  { id: 'frameFront', label: 'front frame rail', local: { x: 1.55, y: 0.00 }, strengthN: 44000,
    fail: FAIL.HOLD, part: null,
    inspect: 'Structural. Takes load straight into the shell without deforming.' },

  { id: 'frameRear', label: 'rear frame rail', local: { x: -1.55, y: 0.00 }, strengthN: 44000,
    fail: FAIL.HOLD, part: null,
    inspect: 'Structural, but at the wrong end for pulling it up the slope nose-first.' },

  { id: 'axleFront', label: 'front axle', local: { x: 1.34, y: 0.00 }, strengthN: 26000,
    fail: FAIL.BEND, part: 'axleFront',
    inspect: 'Strong, and low enough to pull from. Will bend before the frame does.' },

  { id: 'axleRear', label: 'rear axle', local: { x: -1.34, y: 0.00 }, strengthN: 26000,
    fail: FAIL.BEND, part: 'axleRear',
    inspect: 'Strong. Behind the wheels that are locked, so it drags what it pulls.' },

  { id: 'wheelFL', label: 'front left wheel', local: { x: 1.34, y: -0.88 }, strengthN: 14000,
    fail: FAIL.DETACH, part: 'wheelFL',
    inspect: 'A wheel is a lever on a hub. Enough sideways load and the hub loses.' },
  { id: 'wheelFR', label: 'front right wheel', local: { x: 1.34, y: 0.88 }, strengthN: 14000,
    fail: FAIL.DETACH, part: 'wheelFR',
    inspect: 'A wheel is a lever on a hub. Enough sideways load and the hub loses.' },
  { id: 'wheelRL', label: 'rear left wheel', local: { x: -1.34, y: -0.88 }, strengthN: 14000,
    fail: FAIL.DETACH, part: 'wheelRL',
    inspect: 'Locked by the parking brake. Pulling on it drags the brake with it.' },
  { id: 'wheelRR', label: 'rear right wheel', local: { x: -1.34, y: 0.88 }, strengthN: 14000,
    fail: FAIL.DETACH, part: 'wheelRR',
    inspect: 'Locked by the parking brake. Pulling on it drags the brake with it.' },

  { id: 'bumperFront', label: 'front bumper', local: { x: 2.28, y: 0.00 }, strengthN: 9000,
    fail: FAIL.DETACH, part: 'bumperFront',
    inspect: 'Plastic cover on two crush cans. Weak bumper — it will come off first.' },
  { id: 'bumperRear', label: 'rear bumper', local: { x: -2.28, y: 0.00 }, strengthN: 9000,
    fail: FAIL.DETACH, part: 'bumperRear',
    inspect: 'Weak bumper. Two brackets and some optimism.' },

  { id: 'doorL', label: 'left door pillar', local: { x: 0.10, y: -0.90 }, strengthN: 4500,
    fail: FAIL.DETACH, part: 'doorL',
    inspect: 'Sheet metal and a hinge. Very weak — this tears, it does not pull.' },
  { id: 'doorR', label: 'right door pillar', local: { x: 0.10, y: 0.90 }, strengthN: 4500,
    fail: FAIL.DETACH, part: 'doorR',
    inspect: 'Sheet metal and a hinge. Very weak — this tears, it does not pull.' },
];

/* The tow truck can also be rigged to, which matters the moment a player decides the
 * truck is the thing that needs recovering. Its zones are deliberately sparse and strong:
 * a wrecker is built to be pulled on. */
const TRUCK_ZONES = [
  { id: 'truckFrameRear', label: 'rear frame', local: { x: -3.15, y: 0.00 }, strengthN: 90000,
    fail: FAIL.HOLD, part: null, inspect: 'Wrecker frame. Nothing here is going to let go.' },
  { id: 'truckFrameFront', label: 'front frame', local: { x: 3.15, y: 0.00 }, strengthN: 90000,
    fail: FAIL.HOLD, part: null, inspect: 'Front recovery point. Rated for the whole truck.' },
];

/**
 * Wheel layout. `steer` marks a wheel the steering box turns; `drive` marks a driven one;
 * `park` marks a wheel the parking brake locks.
 *
 * The tire model reads nothing else — a wheel is an offset plus three booleans, which is
 * exactly enough to make a rear-wheel-drive wrecker behave differently from a
 * handbrake-locked sedan being dragged sideways.
 */
const SEDAN_WHEELS = [
  { id: 'wheelFL', local: { x: 1.34, y: -0.75 }, steer: false, drive: false, park: false, radiusM: 0.31 },
  { id: 'wheelFR', local: { x: 1.34, y: 0.75 }, steer: false, drive: false, park: false, radiusM: 0.31 },
  { id: 'wheelRL', local: { x: -1.34, y: -0.75 }, steer: false, drive: false, park: true, radiusM: 0.31 },
  { id: 'wheelRR', local: { x: -1.34, y: 0.75 }, steer: false, drive: false, park: true, radiusM: 0.31 },
];

const TRUCK_WHEELS = [
  { id: 'wheelFL', local: { x: 2.10, y: -1.00 }, steer: true, drive: false, park: false, radiusM: 0.48 },
  { id: 'wheelFR', local: { x: 2.10, y: 1.00 }, steer: true, drive: false, park: false, radiusM: 0.48 },
  { id: 'wheelRL', local: { x: -1.65, y: -1.02 }, steer: false, drive: true, park: true, radiusM: 0.50 },
  { id: 'wheelRR', local: { x: -1.65, y: 1.02 }, steer: false, drive: true, park: true, radiusM: 0.50 },
];

export const SEDAN_DEF = Object.freeze({
  id: 'sedan',
  label: 'disabled sedan',
  massKg: CONFIG.sedan.massKg,
  lengthM: CONFIG.sedan.lengthM,
  widthM: CONFIG.sedan.widthM,
  wheels: SEDAN_WHEELS,
  zones: SEDAN_ZONES,
  driven: false,
  winchLocal: null,
  // Parts that can be damaged or lost. `drag` is how much rolling resistance the part's
  // loss or deformation adds, as a multiplier applied at that corner.
  parts: ['bumperFront', 'bumperRear', 'doorL', 'doorR',
          'wheelFL', 'wheelFR', 'wheelRL', 'wheelRR', 'axleFront', 'axleRear'],
});

export const TRUCK_DEF = Object.freeze({
  id: 'truck',
  label: 'tow truck',
  massKg: CONFIG.truck.massKg,
  lengthM: CONFIG.truck.lengthM,
  widthM: CONFIG.truck.widthM,
  wheels: TRUCK_WHEELS,
  zones: TRUCK_ZONES,
  driven: true,
  /** The fairlead: where the cable leaves the truck, at the back of the bed. Force is
   *  applied HERE, not at the centre of mass, which is why a hard pull at an angle tries
   *  to swing the truck's tail around. That torque is most of the game's drama. */
  winchLocal: { x: -3.05, y: 0.00 },
  parts: ['bumperFront', 'bumperRear', 'wheelFL', 'wheelFR', 'wheelRL', 'wheelRR'],
});

/** Look up a zone definition by id on either vehicle. */
export function findZone(def, zoneId) {
  return def.zones.find((z) => z.id === zoneId) || null;
}

/** The zone nearest a world point, with its world position. Used by the attach action:
 *  the player walks the hook to a place on the car and the nearest zone wins. There is no
 *  "correct answer" highlight — GDD §4 forbids one.
 *  @returns {{zone:object, x:number, y:number, dist:number}|null} */
export function nearestZone(def, body, wx, wy, maxDist = 1.6) {
  let best = null;
  for (const z of def.zones) {
    const p = body.toWorld(z.local.x, z.local.y);
    const d = Math.hypot(p.x - wx, p.y - wy);
    if (d <= maxDist && (!best || d < best.dist - 1e-6)) best = { zone: z, x: p.x, y: p.y, dist: d };
  }
  return best;
}
