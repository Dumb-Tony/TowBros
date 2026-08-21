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
  { id: 'wheelFL', local: { x: 1.34, y: -0.75 }, steer: true,  drive: false, park: false, radiusM: 0.31 },
  { id: 'wheelFR', local: { x: 1.34, y: 0.75 }, steer: true,  drive: false, park: false, radiusM: 0.31 },
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
  /* What this vehicle's own brakes are worth. On the definition rather than looked up from
   * CONFIG by 'is it a truck', because from Milestone 6 there are five vehicles and two of the
   * casualties weigh more than the wrecker that came for them. */
  brakeForceN: CONFIG.sedan.brakeForceN,
  parkBrakeForceN: CONFIG.sedan.brakeForceN,
  winchLocal: null,
  // Parts that can be damaged or lost. `drag` is how much rolling resistance the part's
  // loss or deformation adds, as a multiplier applied at that corner.
  parts: ['bumperFront', 'bumperRear', 'doorL', 'doorR',
          'wheelFL', 'wheelFR', 'wheelRL', 'wheelRR', 'axleFront', 'axleRear'],
});

/* ── the bigger casualties (Milestone 6) ───────────────────────────────────────
 *
 * A van and a 7.5-tonne box truck. Same schema, same forgiving-zone rule, and deliberately NOT a
 * new set of mechanics: what makes them different is mass, length and where the strong points are.
 *
 * The ratings are the interesting part. A van's frame rails are stronger than a car's and its
 * bumper is not — a plastic valance is a plastic valance whatever it is bolted to — so the SPREAD
 * between the good choice and the lazy one widens with the vehicle. On a sedan, hooking the bumper
 * costs you a bumper. On a box truck, at the loads a box truck needs, it is not a choice at all.
 */
const VAN_ZONES = [
  { id: 'towHook', label: 'front recovery eye', local: { x: 2.42, y: -0.50 }, strengthN: 62000,
    fail: FAIL.HOLD, part: null,
    inspect: 'Screw-in eye into the chassis leg. Rated for the whole van and then some.' },
  { id: 'frameFront', label: 'front chassis leg', local: { x: 1.90, y: 0.00 }, strengthN: 60000,
    fail: FAIL.HOLD, part: null,
    inspect: 'Ladder chassis. This is the vehicle, structurally speaking.' },
  { id: 'frameRear', label: 'rear crossmember', local: { x: -2.10, y: 0.00 }, strengthN: 54000,
    fail: FAIL.HOLD, part: null,
    inspect: 'Solid, and where the towbar would bolt. Wrong end for a nose-first pull.' },
  { id: 'axleFront', label: 'front axle', local: { x: 1.62, y: 0.00 }, strengthN: 34000,
    fail: FAIL.BEND, part: 'axleFront',
    inspect: 'Beam axle. Strong, low, and it bends before the chassis does.' },
  { id: 'axleRear', label: 'rear axle', local: { x: -1.62, y: 0.00 }, strengthN: 38000,
    fail: FAIL.BEND, part: 'axleRear',
    inspect: 'The heavy end. Carries the load and pulls like it.' },
  { id: 'wheelFL', label: 'front left wheel', local: { x: 1.62, y: -0.96 }, strengthN: 19000,
    fail: FAIL.DETACH, part: 'wheelFL', inspect: 'Six studs instead of four. Still a lever on a hub.' },
  { id: 'wheelFR', label: 'front right wheel', local: { x: 1.62, y: 0.96 }, strengthN: 19000,
    fail: FAIL.DETACH, part: 'wheelFR', inspect: 'Six studs instead of four. Still a lever on a hub.' },
  { id: 'wheelRL', label: 'rear left wheel', local: { x: -1.62, y: -0.96 }, strengthN: 19000,
    fail: FAIL.DETACH, part: 'wheelRL', inspect: 'Braked. Pulling on it drags the brake with it.' },
  { id: 'wheelRR', label: 'rear right wheel', local: { x: -1.62, y: 0.96 }, strengthN: 19000,
    fail: FAIL.DETACH, part: 'wheelRR', inspect: 'Braked. Pulling on it drags the brake with it.' },
  { id: 'bumperFront', label: 'front bumper', local: { x: 2.66, y: 0.00 }, strengthN: 9500,
    fail: FAIL.DETACH, part: 'bumperFront',
    inspect: 'A plastic valance on a big van. Weak — and it does not know how big the van is.' },
  { id: 'doorL', label: 'left sliding door rail', local: { x: -0.20, y: -1.00 }, strengthN: 5200,
    fail: FAIL.DETACH, part: 'doorL',
    inspect: 'A runner in a channel. Very weak — this tears out of the side of the body.' },
];

const VAN_WHEELS = [
  { id: 'wheelFL', local: { x: 1.62, y: -0.84 }, steer: true, drive: false, park: false, radiusM: 0.36 },
  { id: 'wheelFR', local: { x: 1.62, y: 0.84 }, steer: true, drive: false, park: false, radiusM: 0.36 },
  { id: 'wheelRL', local: { x: -1.62, y: -0.86 }, steer: false, drive: false, park: true, radiusM: 0.36 },
  { id: 'wheelRR', local: { x: -1.62, y: 0.86 }, steer: false, drive: false, park: true, radiusM: 0.36 },
];

export const VAN_DEF = Object.freeze({
  id: 'van',
  label: 'panel van',
  massKg: CONFIG.van.massKg,
  lengthM: CONFIG.van.lengthM,
  widthM: CONFIG.van.widthM,
  wheels: VAN_WHEELS,
  zones: VAN_ZONES,
  driven: false,
  brakeForceN: CONFIG.van.brakeForceN,
  parkBrakeForceN: CONFIG.van.brakeForceN,
  winchLocal: null,
  casualty: true,
  parts: ['bumperFront', 'doorL', 'wheelFL', 'wheelFR', 'wheelRL', 'wheelRR', 'axleFront', 'axleRear'],
});

/* A 7.5-tonner. Six wheels, because the rear axle is on twins — which matters: the tire model
 * gives each wheel a share of the mass, so four rear patches instead of two is genuinely more grip
 * and genuinely more to drag. */
const BOX_ZONES = [
  { id: 'towHook', label: 'front towing jaw', local: { x: 3.34, y: 0.00 }, strengthN: 140000,
    fail: FAIL.HOLD, part: null,
    inspect: 'A cast jaw bolted through the chassis rails. It is not the thing that will fail.' },
  { id: 'frameFront', label: 'front chassis rail', local: { x: 2.60, y: -0.42 }, strengthN: 130000,
    fail: FAIL.HOLD, part: null,
    inspect: 'Channel-section steel, 6 mm wall. Nothing here is going to let go.' },
  { id: 'frameRear', label: 'rear chassis rail', local: { x: -2.90, y: -0.42 }, strengthN: 120000,
    fail: FAIL.HOLD, part: null,
    inspect: 'Just as strong, and at the wrong end to pull it up a bank with.' },
  { id: 'axleFront', label: 'front beam axle', local: { x: 2.30, y: 0.00 }, strengthN: 72000,
    fail: FAIL.BEND, part: 'axleFront',
    inspect: 'Forged beam. Strong enough that bending it takes a serious mistake.' },
  { id: 'axleRear', label: 'rear drive axle', local: { x: -2.30, y: 0.00 }, strengthN: 88000,
    fail: FAIL.BEND, part: 'axleRear',
    inspect: 'The heavy end of a heavy vehicle. Four tyres on the ground under it.' },
  { id: 'wheelFL', label: 'front left wheel', local: { x: 2.30, y: -1.16 }, strengthN: 30000,
    fail: FAIL.DETACH, part: 'wheelFL', inspect: 'Ten studs. It is still a lever on a hub.' },
  { id: 'wheelFR', label: 'front right wheel', local: { x: 2.30, y: 1.16 }, strengthN: 30000,
    fail: FAIL.DETACH, part: 'wheelFR', inspect: 'Ten studs. It is still a lever on a hub.' },
  /* `part` names the OUTER twin, because that is the one a hook is round and the one that comes
   * off its studs. It said `wheelRL` for a while, which is not the id of any wheel this vehicle
   * has (they are RLi/RLo, inner and outer) — so `detachPart`'s `findIndex` returned -1, the
   * `attached = false` and `wheelLostDragMul` never fired, and a box truck that had just lost its
   * rear wheels drove as though nothing had happened. A zone's `part` must always resolve to
   * something in the vehicle's own `wheels` list. */
  { id: 'wheelRL', label: 'rear left twins', local: { x: -2.30, y: -1.16 }, strengthN: 34000,
    fail: FAIL.DETACH, part: 'wheelRLo',
    inspect: 'Twin wheels on one hub. A hook is round the outer one, and the brake is on.' },
  { id: 'wheelRR', label: 'rear right twins', local: { x: -2.30, y: 1.16 }, strengthN: 34000,
    fail: FAIL.DETACH, part: 'wheelRRo',
    inspect: 'Twin wheels on one hub. A hook is round the outer one, and the brake is on.' },
  { id: 'bumperFront', label: 'front bumper', local: { x: 3.60, y: 0.00 }, strengthN: 12000,
    fail: FAIL.DETACH, part: 'bumperFront',
    inspect: 'A steel bumper on a seven-tonne truck. Strong for a bumper. Not strong for this.' },
  { id: 'bodyRear', label: 'rear body frame', local: { x: -3.55, y: 0.00 }, strengthN: 16000,
    fail: FAIL.DETACH, part: 'bodyRear',
    inspect: 'The box, not the chassis. It is bolted to the truck rather than part of it.' },
];

const BOX_WHEELS = [
  { id: 'wheelFL', local: { x: 2.30, y: -1.02 }, steer: true, drive: false, park: false, radiusM: 0.45 },
  { id: 'wheelFR', local: { x: 2.30, y: 1.02 }, steer: true, drive: false, park: false, radiusM: 0.45 },
  { id: 'wheelRLi', local: { x: -2.30, y: -0.78 }, steer: false, drive: false, park: true, radiusM: 0.45 },
  { id: 'wheelRLo', local: { x: -2.30, y: -1.10 }, steer: false, drive: false, park: true, radiusM: 0.45 },
  { id: 'wheelRRi', local: { x: -2.30, y: 0.78 }, steer: false, drive: false, park: true, radiusM: 0.45 },
  { id: 'wheelRRo', local: { x: -2.30, y: 1.10 }, steer: false, drive: false, park: true, radiusM: 0.45 },
];

export const BOX_TRUCK_DEF = Object.freeze({
  id: 'boxTruck',
  label: 'box truck',
  massKg: CONFIG.boxTruck.massKg,
  lengthM: CONFIG.boxTruck.lengthM,
  widthM: CONFIG.boxTruck.widthM,
  wheels: BOX_WHEELS,
  zones: BOX_ZONES,
  driven: false,
  brakeForceN: CONFIG.boxTruck.brakeForceN,
  parkBrakeForceN: CONFIG.boxTruck.brakeForceN,
  winchLocal: null,
  casualty: true,
  parts: ['bumperFront', 'bodyRear', 'wheelFL', 'wheelFR', 'wheelRLo', 'wheelRRo',
          'axleFront', 'axleRear'],
});

/* ── the motorcycle (Milestone 7) ────────────────────────────────────────────────
 * GDD §7: "a motorcycle" — one of two casualties "the existing rig cannot simply out-pull,
 * because ... [it] weighs less than the cable's breaking strain."
 *
 * 230 kg. Every zone below is rated lower than the WEAKEST zone on any other vehicle in this
 * file — the sedan's door pillars, at 4500 N — including the frame, which is the one zone here
 * that holds. That is deliberate, and it is the whole point: the honest danger of hooking a
 * 26 kN drum to a 230 kg object is not that a zone tears, though a careless one will. It is that
 * nothing on this bike is heavy enough to make the winch WORK for the pull. Downslope and bogged
 * resistance both scale with mass the same way they do for the sedan (downslopeN in
 * sim/tires.js; the bigCasualty formula in world/scene.js) — at 230 kg they come out in the
 * hundreds of newtons where the sedan's come out in the thousands. A pull that takes thirty
 * seconds of held tension to walk a sedan up the bank puts a motorcycle in motion the moment the
 * line comes tight, and nothing stops it accelerating just because the line does.
 *
 * And once it is moving, it has nothing holding it upright. A car's stability, in this sim, is
 * the tire model's static resistance spread across four contact patches on a wide rectangular
 * footprint. This bike's two wheels sit on the CENTRELINE — see MOTORCYCLE_WHEELS, both y: 0 —
 * so there is no side-to-side base to resist a pull that is not dead straight down the bike's
 * own length. `rollThresholdG` / `rollSustainMs` below are literals for exactly that reason:
 * this bike should go over at a fraction of the lateral g a car shrugs off, and
 * CONFIG.vehicle's shared 1.9g is a car's number, not this one's. They do nothing until
 * sim/vehicle.js reads them — see the report.
 *
 * So the different plan is not a stronger rig. Every zone here already forgives the hook, and
 * the frame will outlast the cable whatever it is tied to. The plan is a gentle motor and a
 * short pull: fan the reel-in key rather than holding it down, keep the line as close to
 * straight behind the bike as the ground allows, and expect to be moving it in seconds, not
 * minutes. A plan that works on a sedan by being patient fails a motorcycle by being
 * enthusiastic.
 */
const MOTORCYCLE_WHEELS = [
  { id: 'wheelF', local: { x: 0.68, y: 0.00 }, steer: true,  drive: false, park: false, radiusM: 0.30 },
  { id: 'wheelR', local: { x: -0.65, y: 0.00 }, steer: false, drive: false, park: true,  radiusM: 0.30 },
];

const MOTORCYCLE_ZONES = [
  { id: 'frame', label: 'backbone frame', local: { x: 0.00, y: 0.00 }, strengthN: 3400,
    fail: FAIL.HOLD, part: null,
    inspect: 'Tubular steel backbone under the tank. Everything else on this bike lets go before this does.' },

  { id: 'axleFront', label: 'front wheel spindle', local: { x: 0.50, y: 0.00 }, strengthN: 2100,
    fail: FAIL.BEND, part: 'axleFront',
    inspect: 'The front spindle, through the fork legs. Bends the forks before it lets go of anything.' },
  { id: 'axleRear', label: 'rear wheel spindle', local: { x: -0.55, y: 0.00 }, strengthN: 2400,
    fail: FAIL.BEND, part: 'axleRear',
    inspect: 'Through the swingarm pivot. Slightly better placed than the front end, and still not much.' },

  { id: 'handlebars', label: 'handlebars', local: { x: 0.85, y: 0.00 }, strengthN: 850,
    fail: FAIL.DETACH, part: 'handlebars',
    inspect: 'Clamped to the top yoke. A hook here comes away with the bars.' },
  { id: 'footpegL', label: 'left footpeg', local: { x: -0.22, y: -0.26 }, strengthN: 700,
    fail: FAIL.DETACH, part: 'footpegL',
    inspect: 'Bolted to a spring-loaded bracket. It folds flat before it does anything else.' },
  { id: 'footpegR', label: 'right footpeg', local: { x: -0.22, y: 0.26 }, strengthN: 700,
    fail: FAIL.DETACH, part: 'footpegR',
    inspect: 'Bolted to a spring-loaded bracket. It folds flat before it does anything else.' },
  { id: 'grabRail', label: 'rear grab rail', local: { x: -0.98, y: 0.00 }, strengthN: 950,
    fail: FAIL.DETACH, part: 'grabRail',
    inspect: 'Thin tube welded to the tail, sized for a bungee cord.' },
];

export const MOTORCYCLE_DEF = Object.freeze({
  id: 'motorcycle',
  label: 'motorcycle',
  massKg: CONFIG.motorcycle.massKg,
  lengthM: CONFIG.motorcycle.lengthM,
  widthM: CONFIG.motorcycle.widthM,
  wheels: MOTORCYCLE_WHEELS,
  zones: MOTORCYCLE_ZONES,
  driven: false,
  brakeForceN: CONFIG.motorcycle.brakeForceN,
  parkBrakeForceN: CONFIG.motorcycle.brakeForceN,
  maxSteerRad: CONFIG.motorcycle.maxSteerRad,
  boggedFreeM: CONFIG.motorcycle.boggedFreeM,
  /* Its own rollover thresholds rather than CONFIG.vehicle's shared pair: two wheels on the
   * centreline is exactly the case those were never chosen for. Read by sim/vehicle.js. */
  rollThresholdG: CONFIG.motorcycle.rollThresholdG,
  rollSustainMs: CONFIG.motorcycle.rollSustainMs,
  winchLocal: null,
  casualty: true,
  parts: ['handlebars', 'footpegL', 'footpegR', 'grabRail', 'axleFront', 'axleRear', 'wheelF', 'wheelR'],
});

/* ── a casualty that arrived on its roof (Milestone 7) ──────────────────────────
 * GDD §7: "a vehicle that arrived on its roof" — the other of the two casualties "the existing
 * rig cannot simply out-pull, because one has to be righted".
 *
 * Same shell as SEDAN_DEF — same mass, length, width and wheels, reused directly below, because
 * a car on its roof is not a different car. What differs is which zones a hook can usefully
 * reach, what they are rated at now, and the state the vehicle spawns in.
 *
 * Upside down, the structural underside — both frame rails and both axles — faces straight up
 * and is completely clear, so SEDAN_ROOF_ZONES rates them exactly what they are on the sedan:
 * they were always the right answer, and now they are also the obvious one. The tow hook and
 * both bumpers took whatever put the car on its roof in the first place and are rated down for
 * it. And there is one zone that does not exist the right way up at all: the roof, bearing the
 * whole vehicle's weight against the ground on the thinnest, least supported panel on the car —
 * rated below every zone the upright sedan has, door pillars included.
 *
 * `arrivesRolled: true` is not read anywhere yet — see the report for the small patch to
 * world/scene.js that spawns this casualty with the same `rolled` state sim/vehicle.js already
 * gives any car that rolls over mid-recovery (0.55x grip, nominally 1.6x drag). That is not a
 * new mechanic, just the existing one applied from the first frame instead of partway through
 * one, and it is the mechanical heart of "a different plan, not a longer pull": at 0.55x grip
 * this car has much less static resistance to being pulled OFF the line the hook defines than an
 * upright sedan does, so the same confident straight pull that walks a sedan up the bank instead
 * skates this one broadside the moment the line is not dead straight ahead of the zone it is
 * hooked to. The winch still stalls at the same 26 kN it always did — the plan is "keep the line
 * straight", which four planted tyres forgive on the sedan and this does not.
 */
const SEDAN_ROOF_ZONES = [
  { id: 'towHook', label: 'front tow hook', local: { x: 2.05, y: -0.42 }, strengthN: 7000,
    fail: FAIL.DETACH, part: 'towHook',
    inspect: 'Bent in whatever put the car on its roof. It is not rated for much any more.' },

  { id: 'frameFront', label: 'front frame rail', local: { x: 1.55, y: 0.00 }, strengthN: 44000,
    fail: FAIL.HOLD, part: null,
    inspect: 'Facing straight up and completely clear. As structural as it ever was.' },
  { id: 'frameRear', label: 'rear frame rail', local: { x: -1.55, y: 0.00 }, strengthN: 44000,
    fail: FAIL.HOLD, part: null,
    inspect: 'The other rail, exposed the same way. Still takes load straight into the shell.' },

  { id: 'axleFront', label: 'front axle', local: { x: 1.34, y: 0.00 }, strengthN: 26000,
    fail: FAIL.BEND, part: 'axleFront',
    inspect: 'Low, strong, and out in the open now instead of tucked under the car.' },
  { id: 'axleRear', label: 'rear axle', local: { x: -1.34, y: 0.00 }, strengthN: 26000,
    fail: FAIL.BEND, part: 'axleRear',
    inspect: 'Same story as the front axle. Nothing about being upside down weakens it.' },

  { id: 'wheelFL', label: 'front left wheel', local: { x: 1.34, y: -0.88 }, strengthN: 14000,
    fail: FAIL.DETACH, part: 'wheelFL',
    inspect: 'Off the ground and free to spin. Nothing is holding this one still.' },
  { id: 'wheelFR', label: 'front right wheel', local: { x: 1.34, y: 0.88 }, strengthN: 14000,
    fail: FAIL.DETACH, part: 'wheelFR',
    inspect: 'Off the ground and free to spin. Nothing is holding this one still.' },
  { id: 'wheelRL', label: 'rear left wheel', local: { x: -1.34, y: -0.88 }, strengthN: 14000,
    fail: FAIL.DETACH, part: 'wheelRL',
    inspect: 'The parking brake is still on. It is not gripping anything from up here.' },
  { id: 'wheelRR', label: 'rear right wheel', local: { x: -1.34, y: 0.88 }, strengthN: 14000,
    fail: FAIL.DETACH, part: 'wheelRR',
    inspect: 'The parking brake is still on. It is not gripping anything from up here.' },

  { id: 'bumperFront', label: 'front bumper', local: { x: 2.28, y: 0.00 }, strengthN: 6000,
    fail: FAIL.DETACH, part: 'bumperFront',
    inspect: 'Already cracked. Whatever put the car on its roof went through here first.' },
  { id: 'bumperRear', label: 'rear bumper', local: { x: -2.28, y: 0.00 }, strengthN: 6000,
    fail: FAIL.DETACH, part: 'bumperRear',
    inspect: 'The other bumper. Better than the front only in being further from what happened.' },

  { id: 'doorL', label: 'left door pillar', local: { x: 0.10, y: -0.90 }, strengthN: 3200,
    fail: FAIL.DETACH, part: 'doorL',
    inspect: 'Sheet metal and a hinge, now loaded from an angle it was never fitted for.' },
  { id: 'doorR', label: 'right door pillar', local: { x: 0.10, y: 0.90 }, strengthN: 3200,
    fail: FAIL.DETACH, part: 'doorR',
    inspect: 'Sheet metal and a hinge, now loaded from an angle it was never fitted for.' },

  { id: 'roof', label: 'roof panel', local: { x: -0.10, y: 0.00 }, strengthN: 3000,
    fail: FAIL.DETACH, part: 'roofPanel',
    inspect: 'Crushed sheet steel with nothing behind it, sliding along the ground right now.' },
];

export const SEDAN_ROOF_DEF = Object.freeze({
  id: 'sedanRoof',
  label: 'sedan on its roof',
  massKg: CONFIG.sedan.massKg,
  lengthM: CONFIG.sedan.lengthM,
  widthM: CONFIG.sedan.widthM,
  wheels: SEDAN_WHEELS,
  zones: SEDAN_ROOF_ZONES,
  driven: false,
  brakeForceN: CONFIG.sedan.brakeForceN,
  parkBrakeForceN: CONFIG.sedan.brakeForceN,
  boggedFreeM: CONFIG.sedan.boggedFreeM,
  winchLocal: null,
  casualty: true,
  /* Spawns already in the state sim/vehicle.js gives a car that rolls over mid-recovery. Inert
   * until world/scene.js sets it from this flag — see the report. */
  arrivesRolled: true,
  parts: ['towHook', 'bumperFront', 'bumperRear', 'doorL', 'doorR',
          'wheelFL', 'wheelFR', 'wheelRL', 'wheelRR', 'axleFront', 'axleRear', 'roofPanel'],
});

/* ── the artic: a tractor unit and a semitrailer (Milestone 10) ─────────────────
 * GDD §7 Milestone 10: "A tractor unit and a semitrailer on a fifth wheel, jack-knifed off the
 * road. It is not one long vehicle with more mass — it is the pair the game already builds
 * (Milestone 9's two casualty slots), with a constraint between them."
 *
 * Two definitions and ONE design. Neither mass means anything except read beside the other one
 * and beside the drum that has to move both, so they are authored here next to the geometry they
 * were chosen with rather than split across two CONFIG blocks — config.js's own header allows
 * src/data/ for authored content, and the argument below only reads as an argument in one piece.
 *
 * ── THE PAIR AGAINST THE FORCE BUDGET ──────────────────────────────────────────
 * The heavy wrecker has two drums at 42 kN each. Everything below was chosen against that and
 * then measured on the bend, where the casualty lies on a 28.6° bank — 4.701 N of downslope pull
 * per kg, against the 27° / 4.45 nominal config.js's budget block quotes. Measured, seed 4242,
 * heavy wrecker parked on the shoulder 11 m along the road, rigged to the front-most strong zone,
 * reeling until the thing is on the road:
 *
 *                    mass    downslope   bogged   resistance   ONE drum
 *   tractor unit   3 500 kg    16.5 kN   10.1 kN     26.6 kN   30.5 kN peak, 16.9 held, 41 s, 1 park
 *   semitrailer    3 200 kg    15.0 kN    9.3 kN     24.3 kN   32.5 kN peak, 12.4 held, 75 s, 2 parks
 *   THE PAIR       6 700 kg    31.5 kN   19.4 kN     50.9 kN   63.1 kN COMPUTED, both drums
 *   (box truck)    7 200 kg    33.8 kN   20.8 kN     54.7 kN   pinned at 41.9, 21 stalls, 0/4
 *
 * That contrast is the milestone, and the last row is what it is measured against. Split, each
 * half asks 73% and 77% of ONE drum at its worst instant and about 40% and 30% of it sustained,
 * stalls the motor zero times, and comes up on one line — while the box truck, on the same drum,
 * sits pinned at the motor limit, stalls twenty-one times and does not move at all. Coupled, the
 * pair is 63.1 kN: half again what one drum can do, so one line used twice is not a plan, and 75%
 * of what the whole machine has BEFORE the jack-knife takes its cut. That leaves 20.9 kN of the
 * machine for the fold to spend, which is the budget the fifth-wheel constraint is written into.
 *
 * Checked across eight seeds, because the bogged-in force carries a ±900 N-per-tonne seeded
 * spread and seed 4242 is a light one: the unit peaks 30.5-40.8 kN and holds 16.8-17.7, the
 * trailer peaks 32.5-40.1 and holds 12.3-12.5, both come up every time, and between them they
 * stall the motor zero times and part zero ropes. The peaks are the line snatching as the load
 * breaks free; what a drum has to LIVE at is the held figure, and that never reaches half a drum.
 *
 * ── AND WHY THESE ARE NOT WHAT A REAL ARTIC WEIGHS ─────────────────────────────
 * A 6x2 tractor unit is about 7 500 kg empty, a short two-axle trailer about 4 500, and a LOADED
 * semitrailer is 25 t. None of those is recoverable by anything in this game: at 4.701 N/kg a
 * 25 t trailer pulls 118 kN down this bank against 84 kN of drum, so an empty or part-loaded
 * outfit is the only honest choice and this is where that is said out loud instead of being
 * implied by a number nobody can check. Even empty the real pair is 12 t, which is 100 kN of
 * standing resistance and past the machine before anything is asked of the fold.
 *
 * So these two are about 55% of a real empty outfit, and what they were sized against is the
 * drum. 3 500 + 3 200 = 6 700 kg is 500 kg LIGHTER than the box truck and a harder recovery than
 * it — which is the milestone's own claim ("it is not one long vehicle with more mass") stated as
 * a pair of numbers rather than as an opinion. Each half lands between a panel van (2 600) and
 * that box truck (7 200), and is a one-drum job by measurement.
 *
 * The trailer is the LIGHTER half and still the more expensive one to move, which is the whole
 * point of it: 1.34 kN of peak line per kN of standing resistance against the unit's 1.15, and
 * two parks against the unit's one. All of its mass is behind its axle line and all of its wheels
 * are at the very back, so at 8.20 m it carries 19 665 kg·m² of yaw inertia against the tractor's
 * 12 323 — 1.60x the inertia on 91% of the mass. Pulled from the kingpin it is a 4.90 m lever
 * with nothing under the end you are pulling.
 *
 * ── AND WHY IT IS 6.00 m AND 8.20 m AND NOT 6.5 AND 13.6 ───────────────────────
 * meta/situations.js will not put a pair through a gap in the rail it does not fit, and it counts
 * a pair nose to tail: 6.00 + 0.60 of clearance + 8.20 = 14.80 m against the county's 15.0 m gap.
 * A 13.6 m curtainsider makes that 20.2 m and is refused at every site in the county, which is a
 * correct answer to the wrong question — so the trailer is a short two-axle city van-trailer,
 * which is a real thing you see on real roads. The pair fits the bend and the ford (15.00 m) and
 * not the quarry (11.25) or the bridge (8.25): measured over 400 rolls, an artic turns up at two
 * of the four sites and never at the other two.
 */

/* Three axles: a steer axle, a drive axle on twins and a tag axle on singles. The fifth wheel
 * sits 0.10 m behind the drive axle, which is where the trailer's nose weight wants to go. */
const TRACTOR_WHEELS = [
  { id: 'wheelFL', local: { x: 1.70, y: -1.06 }, steer: true, drive: false, park: false, radiusM: 0.52 },
  { id: 'wheelFR', local: { x: 1.70, y: 1.06 }, steer: true, drive: false, park: false, radiusM: 0.52 },
  { id: 'wheelDLi', local: { x: -1.10, y: -0.80 }, steer: false, drive: false, park: true, radiusM: 0.52 },
  { id: 'wheelDLo', local: { x: -1.10, y: -1.12 }, steer: false, drive: false, park: true, radiusM: 0.52 },
  { id: 'wheelDRi', local: { x: -1.10, y: 0.80 }, steer: false, drive: false, park: true, radiusM: 0.52 },
  { id: 'wheelDRo', local: { x: -1.10, y: 1.12 }, steer: false, drive: false, park: true, radiusM: 0.52 },
  { id: 'wheelTL', local: { x: -2.40, y: -1.06 }, steer: false, drive: false, park: true, radiusM: 0.52 },
  { id: 'wheelTR', local: { x: -2.40, y: 1.06 }, steer: false, drive: false, park: true, radiusM: 0.52 },
];

/* The strongest point on this vehicle is the fifth wheel, and that is not a flourish: the plate
 * is the one fitting on a tractor unit designed to drag forty tonnes through, so it outrates the
 * front towing jaw and everything else in the county. A crew that works that out has found the
 * best rigging point in the game — on the half of the artic that is easiest to move anyway. */
const TRACTOR_ZONES = [
  { id: 'towHook', label: 'front towing jaw', local: { x: 2.80, y: 0.00 }, strengthN: 150000,
    fail: FAIL.HOLD, part: null,
    inspect: 'A cast jaw through the chassis rails, rated to tow another one of these.' },
  { id: 'fifthWheel', label: 'fifth wheel plate', local: { x: -1.20, y: 0.00 }, strengthN: 185000,
    fail: FAIL.HOLD, part: null,
    inspect: 'The coupling plate and its two mounting brackets. Everything this unit ever towed went through here.' },
  { id: 'frameFront', label: 'front chassis rail', local: { x: 2.20, y: -0.44 }, strengthN: 135000,
    fail: FAIL.HOLD, part: null,
    inspect: 'Channel-section steel with the front spring hanger bolted through it.' },
  { id: 'frameRear', label: 'rear crossmember', local: { x: -2.85, y: 0.00 }, strengthN: 118000,
    fail: FAIL.HOLD, part: null,
    inspect: 'Structural, and behind the coupling — a pull from here drags the trailer as well.' },

  { id: 'axleFront', label: 'steer beam axle', local: { x: 1.70, y: 0.00 }, strengthN: 76000,
    fail: FAIL.BEND, part: 'axleFront',
    inspect: 'Forged beam under the cab. It bends before the chassis does, and then it steers crooked.' },
  { id: 'axleDrive', label: 'drive axle', local: { x: -1.10, y: 0.00 }, strengthN: 98000,
    fail: FAIL.BEND, part: 'axleDrive',
    inspect: 'The heavy end. A hypoid casing on twin wheels, directly under the coupling.' },
  { id: 'axleTag', label: 'tag axle', local: { x: -2.40, y: 0.00 }, strengthN: 52000,
    fail: FAIL.BEND, part: 'axleTag',
    inspect: 'A liftable trailing axle. It carries load and drives nothing, and it is the lightest of the three.' },

  { id: 'wheelFL', label: 'front left wheel', local: { x: 1.70, y: -1.14 }, strengthN: 30000,
    fail: FAIL.DETACH, part: 'wheelFL',
    inspect: 'Ten studs on a steer hub. It is still a lever on a bearing.' },
  { id: 'wheelFR', label: 'front right wheel', local: { x: 1.70, y: 1.14 }, strengthN: 30000,
    fail: FAIL.DETACH, part: 'wheelFR',
    inspect: 'Ten studs on a steer hub. It is still a lever on a bearing.' },
  /* `part` names the OUTER twin on both drive corners, for the reason spelled out on BOX_ZONES:
   * a zone whose `part` is not the id of a wheel this vehicle has detaches nothing and says
   * nothing about it. These resolve to wheelDLo / wheelDRo in TRACTOR_WHEELS above. */
  { id: 'wheelDL', label: 'left drive twins', local: { x: -1.10, y: -1.18 }, strengthN: 36000,
    fail: FAIL.DETACH, part: 'wheelDLo',
    inspect: 'Twin wheels on one hub, brake on. A hook goes round the outer one.' },
  { id: 'wheelDR', label: 'right drive twins', local: { x: -1.10, y: 1.18 }, strengthN: 36000,
    fail: FAIL.DETACH, part: 'wheelDRo',
    inspect: 'Twin wheels on one hub, brake on. A hook goes round the outer one.' },
  { id: 'wheelTL', label: 'left tag wheel', local: { x: -2.40, y: -1.14 }, strengthN: 24000,
    fail: FAIL.DETACH, part: 'wheelTL',
    inspect: 'A single on a trailing axle — the lightest hub on the unit, and it is braked.' },
  { id: 'wheelTR', label: 'right tag wheel', local: { x: -2.40, y: 1.14 }, strengthN: 24000,
    fail: FAIL.DETACH, part: 'wheelTR',
    inspect: 'A single on a trailing axle — the lightest hub on the unit, and it is braked.' },

  { id: 'bumperFront', label: 'front bumper', local: { x: 3.05, y: 0.00 }, strengthN: 11000,
    fail: FAIL.DETACH, part: 'bumperFront',
    inspect: 'A moulded three-piece bumper with a step in the middle of it. Weak — it is a step.' },
  { id: 'catwalk', label: 'catwalk behind the cab', local: { x: 0.15, y: 0.00 }, strengthN: 6000,
    fail: FAIL.DETACH, part: 'catwalk',
    inspect: 'A chequer plate on two brackets, carrying the air lines. Rated for a driver standing on it.' },
];

export const TRACTOR_UNIT_DEF = Object.freeze({
  id: 'tractorUnit',
  label: 'tractor unit',
  /* See the block above for how these two masses were chosen, and what they cost in realism.
   * Measured on one drum: 30.5 kN peak, 16.9 kN held, up in 41 s from one park, no stalls. */
  massKg: 3500,
  lengthM: 6.00, widthM: 2.50,
  wheels: TRACTOR_WHEELS,
  zones: TRACTOR_ZONES,
  driven: false,
  brakeForceN: 18000,
  parkBrakeForceN: 18000,
  /* Between the van's 0.54 and the box truck's 0.44: a short wheelbase turns tightly for its
   * size, which is the one thing a tractor unit is good at and the reason it is short. */
  maxSteerRad: 0.50,
  boggedFreeM: 0.78,
  winchLocal: null,
  casualty: true,
  /** Where the trailer's kingpin sits when the pair is coupled. 0.10 m behind the drive axle. */
  fifthWheelLocal: { x: -1.20, y: 0.00 },
  /** Which trailer this unit couples to. An id in CASUALTY_DEFS, checked by the m10 probe,
   *  because an id in one data table naming a row in another is the thing nothing else checks. */
  couplesTo: 'semitrailer',
  parts: ['bumperFront', 'catwalk', 'axleFront', 'axleDrive', 'axleTag',
          'wheelFL', 'wheelFR', 'wheelDLo', 'wheelDRo', 'wheelTL', 'wheelTR'],
});

/* Two axles, both at the very back, and eight tyres in 1.25 m of the vehicle's 8.20. THIS is the
 * geometry the milestone is about: the kingpin is 1.50 m from the nose and the rear axle is 5.65 m
 * behind that, so a line on the front of a semitrailer is pulling a six-metre lever with every
 * wheel and almost all of the mass out at the far end of it. Nothing about that is expressed as a
 * number anywhere — it falls out of these offsets and the box inertia they produce. */
const SEMITRAILER_WHEELS = [
  { id: 'wheelALi', local: { x: -2.30, y: -0.80 }, steer: false, drive: false, park: true, radiusM: 0.50 },
  { id: 'wheelALo', local: { x: -2.30, y: -1.14 }, steer: false, drive: false, park: true, radiusM: 0.50 },
  { id: 'wheelARi', local: { x: -2.30, y: 0.80 }, steer: false, drive: false, park: true, radiusM: 0.50 },
  { id: 'wheelARo', local: { x: -2.30, y: 1.14 }, steer: false, drive: false, park: true, radiusM: 0.50 },
  { id: 'wheelBLi', local: { x: -3.55, y: -0.80 }, steer: false, drive: false, park: true, radiusM: 0.50 },
  { id: 'wheelBLo', local: { x: -3.55, y: -1.14 }, steer: false, drive: false, park: true, radiusM: 0.50 },
  { id: 'wheelBRi', local: { x: -3.55, y: 0.80 }, steer: false, drive: false, park: true, radiusM: 0.50 },
  { id: 'wheelBRo', local: { x: -3.55, y: 1.14 }, steer: false, drive: false, park: true, radiusM: 0.50 },
];

/* The kingpin and the landing legs are 1.25 m apart and they are not the same kind of thing at
 * all, which is the whole reason both are here. The pin is the strongest point on either half of
 * the artic — it is a solid 50 mm shank in a 12 mm bolster plate, and the entire trailer hangs
 * off it every day. The legs are two screw jacks whose job is to hold a parked nose up in still
 * air; they are the second weakest zone in the county and a crew that reaches for them because
 * they are the obvious handle under the front of the trailer will find out by number. */
const SEMITRAILER_ZONES = [
  { id: 'kingpin', label: 'kingpin', local: { x: 2.60, y: 0.00 }, strengthN: 175000,
    fail: FAIL.HOLD, part: null,
    inspect: 'A 50 mm pin in a bolted bolster plate. The whole trailer hangs off it whenever it is coupled.' },
  { id: 'frameFront', label: 'front bolster', local: { x: 3.30, y: 0.00 }, strengthN: 122000,
    fail: FAIL.HOLD, part: null,
    inspect: 'The plate the pin is bolted through, spread across both main beams.' },
  { id: 'chassisMid', label: 'left main beam', local: { x: 0.00, y: -0.55 }, strengthN: 108000,
    fail: FAIL.HOLD, part: null,
    inspect: 'A welded I-beam running the length of the trailer. Structural, and halfway to nowhere.' },
  { id: 'frameRear', label: 'rear crossmember', local: { x: -3.95, y: 0.00 }, strengthN: 96000,
    fail: FAIL.HOLD, part: null,
    inspect: 'Solid, over the back axle, and at the wrong end to drag it up a bank by.' },

  { id: 'axleFront', label: 'front bogie axle', local: { x: -2.30, y: 0.00 }, strengthN: 70000,
    fail: FAIL.BEND, part: 'axleFront',
    inspect: 'A straight beam on air bags. Nothing drives it and nothing steers it.' },
  { id: 'axleRear', label: 'rear bogie axle', local: { x: -3.55, y: 0.00 }, strengthN: 70000,
    fail: FAIL.BEND, part: 'axleRear',
    inspect: 'The same axle again, 1.25 m further back, and the last thing on the trailer.' },

  { id: 'wheelAL', label: 'left front twins', local: { x: -2.30, y: -1.22 }, strengthN: 32000,
    fail: FAIL.DETACH, part: 'wheelALo',
    inspect: 'Twins on one hub with the spring brake wound on. A hook goes round the outer one.' },
  { id: 'wheelAR', label: 'right front twins', local: { x: -2.30, y: 1.22 }, strengthN: 32000,
    fail: FAIL.DETACH, part: 'wheelARo',
    inspect: 'Twins on one hub with the spring brake wound on. A hook goes round the outer one.' },
  { id: 'wheelBL', label: 'left rear twins', local: { x: -3.55, y: -1.22 }, strengthN: 32000,
    fail: FAIL.DETACH, part: 'wheelBLo',
    inspect: 'The back corner of the trailer, and the last wheel to leave the bank.' },
  { id: 'wheelBR', label: 'right rear twins', local: { x: -3.55, y: 1.22 }, strengthN: 32000,
    fail: FAIL.DETACH, part: 'wheelBRo',
    inspect: 'The back corner of the trailer, and the last wheel to leave the bank.' },

  { id: 'rearUnderrun', label: 'rear underrun bar', local: { x: -4.30, y: 0.00 }, strengthN: 22000,
    fail: FAIL.BEND, part: 'rearUnderrun',
    inspect: 'A square bar on two drop brackets, built to stop a car going under. It bends downward.' },
  { id: 'landingLegs', label: 'landing legs', local: { x: 1.35, y: 0.00 }, strengthN: 11000,
    fail: FAIL.DETACH, part: 'landingLegs',
    inspect: 'Two screw jacks and a crank handle, rated to hold the nose up while it is parked.' },
  { id: 'curtainRail', label: 'curtain top rail', local: { x: 0.60, y: 1.24 }, strengthN: 4200,
    fail: FAIL.DETACH, part: 'curtainRail',
    inspect: 'An aluminium rail with the curtain buckles hanging off it. The weakest thing on either half.' },
];

export const SEMITRAILER_DEF = Object.freeze({
  id: 'semitrailer',
  label: 'semitrailer',
  /* Measured on one drum: 32.5 kN peak, 12.4 kN held, up in 75 s — and it takes TWO parks, for
   * the reason a box truck takes two. A winch pulls its load to the drum, and 8.20 m of trailer
   * does not arrive lying along the road. */
  massKg: 3200,
  lengthM: 8.20, widthM: 2.55,
  wheels: SEMITRAILER_WHEELS,
  zones: SEMITRAILER_ZONES,
  driven: false,
  brakeForceN: 16500,
  parkBrakeForceN: 16500,
  /* NO `maxSteerRad`, and no `drive` on any wheel above. A semitrailer has no engine and no
   * steering box: a driver sitting in it — there is no seat, but the tire model does not know
   * that — turns nothing, because sim/vehicle.js applies the steer angle per wheel and every
   * wheel here is `steer: false`. Authoring a 0 would read as a value; the absence is the fact. */
  boggedFreeM: 0.80,
  winchLocal: null,
  casualty: true,
  /** Where this trailer's pin sits, in its own body frame. 1.50 m back from the nose.
   *  SPELT `kingPinLocal`, with the capital P, because that is the name recovery/coupling.js
   *  reads — and its fallback when the name does not match is `axleLocal(def, 'front')`, which
   *  for a trailer with no front axle at all is the nose. A quiet 1.50 m error in the one piece
   *  of geometry the whole constraint is built on. Same class of bug as the box truck's
   *  `part: 'wheelRL'`, and caught the same way: by checking. */
  kingPinLocal: { x: 2.60, y: 0.00 },
  /** Which unit it came off. Checked against CASUALTY_DEFS by the m10 probe. */
  couplesFrom: 'tractorUnit',
  /* Where a short outfit folds SOLID — about 80°. AUTHORED rather than derived, and the reason is
   * a measurement: a plan view cannot derive it. Coupled at these offsets the trailer's nose
   * reaches 0.30 m PAST the tractor's own centre, so the two rectangles overlap the whole time.
   * Measured with sim/collision.js's own obbOverlap, at folds of 0°, 7°, 17°, 32°, 46° and 60°:
   * 2.53, 2.70, 2.91, 3.12, 3.21 and 3.19 m of penetration. In three dimensions the nose is
   * simply above the chassis until its corner reaches the back of the cab; in two there is no
   * "above", which is why a coupled pair has to be filtered out of the contact pass exactly the
   * way `joinedByLift` already filters a wheel-lift pair — see the report. */
  jackKnifeMaxRad: 1.40,
  parts: ['landingLegs', 'curtainRail', 'rearUnderrun', 'axleFront', 'axleRear',
          'wheelALo', 'wheelARo', 'wheelBLo', 'wheelBRo'],
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
  driveForceN: CONFIG.truck.driveForceN,
  reverseForceN: CONFIG.truck.reverseForceN,
  brakeForceN: CONFIG.truck.brakeForceN,
  parkBrakeForceN: CONFIG.truck.parkBrakeForceN,
  /** The fairlead: where the cable leaves the truck, at the back of the bed. Force is
   *  applied HERE, not at the centre of mass, which is why a hard pull at an angle tries
   *  to swing the truck's tail around. That torque is most of the game's drama. */
  winchLocal: { x: -3.05, y: 0.00 },
  /** One drum. `drums` is the general case and `winchLocal` is the first of them — see
   *  HEAVY_DEF below, where there are two. */
  drums: [{ id: 'A', label: 'the drum', local: { x: -3.05, y: 0.00 } }],
  parts: ['bumperFront', 'bumperRear', 'wheelFL', 'wheelFR', 'wheelRL', 'wheelRR'],
});

/* ── the heavy wrecker (Milestone 6) ───────────────────────────────────────────
 *
 * Two drums on a slewing boom, four outriggers, and fifteen tonnes of truck under them. The zones
 * are two and both are rated past anything in the game, because a machine this size being the thing
 * that needs recovering is a Milestone 7 problem.
 */
const HEAVY_ZONES = [
  { id: 'truckFrameRear', label: 'rear frame', local: { x: -4.40, y: 0.00 }, strengthN: 220000,
    fail: FAIL.HOLD, part: null, inspect: 'Recovery frame on a rotator. This is the strong point.' },
  { id: 'truckFrameFront', label: 'front frame', local: { x: 4.40, y: 0.00 }, strengthN: 220000,
    fail: FAIL.HOLD, part: null, inspect: 'Rated to drag the whole machine, which is the idea.' },
];

const HEAVY_WHEELS = [
  { id: 'wheelFL', local: { x: 3.10, y: -1.06 }, steer: true, drive: false, park: false, radiusM: 0.55 },
  { id: 'wheelFR', local: { x: 3.10, y: 1.06 }, steer: true, drive: false, park: false, radiusM: 0.55 },
  { id: 'wheelML', local: { x: -1.70, y: -1.10 }, steer: false, drive: true, park: true, radiusM: 0.55 },
  { id: 'wheelMR', local: { x: -1.70, y: 1.10 }, steer: false, drive: true, park: true, radiusM: 0.55 },
  { id: 'wheelRL', local: { x: -3.00, y: -1.10 }, steer: false, drive: true, park: true, radiusM: 0.55 },
  { id: 'wheelRR', local: { x: -3.00, y: 1.10 }, steer: false, drive: true, park: true, radiusM: 0.55 },
];

/** Where the legs come down. Four corners, and the box they make is what the truck stands on. */
export const HEAVY_OUTRIGGERS = Object.freeze([
  { id: 'frontL', local: { x: 1.10, y: -1.75 } },
  { id: 'frontR', local: { x: 1.10, y: 1.75 } },
  { id: 'rearL', local: { x: -2.60, y: -1.75 } },
  { id: 'rearR', local: { x: -2.60, y: 1.75 } },
]);

export const HEAVY_DEF = Object.freeze({
  id: 'heavy',
  label: 'heavy wrecker',
  massKg: CONFIG.heavy.massKg,
  lengthM: CONFIG.heavy.lengthM,
  widthM: CONFIG.heavy.widthM,
  wheels: HEAVY_WHEELS,
  zones: HEAVY_ZONES,
  driven: true,
  heavy: true,
  driveForceN: CONFIG.heavy.driveForceN,
  reverseForceN: CONFIG.heavy.reverseForceN,
  brakeForceN: CONFIG.heavy.brakeForceN,
  parkBrakeForceN: CONFIG.heavy.parkBrakeForceN,
  winchLocal: { x: -4.60, y: 0.00 },
  /* TWO drums, a metre and a half apart. That gap is the mechanic: two lines from two points pull
   * a load straight where one line from one point pulls it round. */
  drums: [
    { id: 'A', label: 'the left drum', local: { x: -4.60, y: -0.72 } },
    { id: 'B', label: 'the right drum', local: { x: -4.60, y: 0.72 } },
  ],
  outriggers: HEAVY_OUTRIGGERS,
  boom: true,
  /* An UNDERLIFT rather than a car yoke (Milestone 8). One flag, because the difference between
   * the two machines is a table of numbers — CONFIG.lift.heavy — and not a second mechanism: the
   * same hinge, a cradle that holds four times as much, a longer arm to clear a seven-tonner's
   * overhang, and two chains across the load instead of three straps. Read by
   * src/recovery/lift.js `liftSpec`, which is the only place the two are told apart. */
  underlift: true,
  parts: ['bumperFront', 'wheelFL', 'wheelFR', 'wheelML', 'wheelMR', 'wheelRL', 'wheelRR'],
});

/** The wreckers an outfit can own. Milestone 6's fleet is two entries and one real decision. */
export const TRUCK_DEFS = Object.freeze({ truck: TRUCK_DEF, heavy: HEAVY_DEF });
export const truckDefById = (id) => TRUCK_DEFS[id] || TRUCK_DEF;

/**
 * Every vehicle that can turn up as the casualty. Milestone 6 started this small on purpose —
 * three entries that each ask a different question of the same winch. Milestone 7 (GDD §7,
 * "a wider casualty library") adds two more that ask questions mass alone cannot: a motorcycle
 * that the winch can only ever gently overpower, and a sedan that arrived already on its roof.
 *
 * Milestone 10 adds the two halves of an artic. They are ordinary entries here and each is a
 * perfectly good casualty on its own — which is not a convenience, it is the milestone: once the
 * pin is pulled, a tractor unit IS a casualty on its own, and so is the trailer it left behind.
 */
export const CASUALTY_DEFS = Object.freeze({
  sedan: SEDAN_DEF,
  van: VAN_DEF,
  boxTruck: BOX_TRUCK_DEF,
  motorcycle: MOTORCYCLE_DEF,
  sedanRoof: SEDAN_ROOF_DEF,
  tractorUnit: TRACTOR_UNIT_DEF,
  semitrailer: SEMITRAILER_DEF,
});

/** The casualty a job asks for, or the sedan. Never throws — an unknown id is a bad save. */
export const casualtyDefById = (id) => CASUALTY_DEFS[id] || SEDAN_DEF;

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
