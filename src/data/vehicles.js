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
 */
export const CASUALTY_DEFS = Object.freeze({
  sedan: SEDAN_DEF,
  van: VAN_DEF,
  boxTruck: BOX_TRUCK_DEF,
  motorcycle: MOTORCYCLE_DEF,
  sedanRoof: SEDAN_ROOF_DEF,
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
