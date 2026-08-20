/* Central tuning. Pattern taken from AirportBaggageCrew\src\config.js: every tunable
 * number lives here or in src/data/, and no system may hard-code a magic constant.
 *
 * Units: metres, kilograms, seconds, NEWTONS, radians. Milliseconds only in `sim` and in
 * UI timers. The scene is authored at real-world scale, because the GDD's whole premise
 * is that mass, slope and traction decide outcomes — and none of those arguments can be
 * had in arbitrary units.
 *
 * ── THE FORCE BUDGET ──────────────────────────────────────────────────────────────────
 * These numbers are one system, not a list. Every interesting decision in Milestone 1
 * exists because of how they compare, so the comparison is written down here rather than
 * left to be rediscovered:
 *
 *   sedan downslope pull, mid-embankment      ~6.2 kN   (1400 kg on 27°)
 *   sedan skid friction on wet grass          ~4.2 kN
 *   sedan bogged-in breakaway, fresh          ~5.2 kN   decays once it moves
 *   => a straight up-slope recovery needs     ~15 kN at breakaway, ~10 kN once free
 *   => a pull ALONG the contour needs          ~9 kN, and ~4.7 kN if jacked and cribbed
 *
 *   bumper tears at                             9 kN   (12.6 strapped, 15.8 chained)
 *   wheel tears at                             14 kN
 *   axle bends at                              26 kN
 *   cable parts at                             42 kN
 *   tow hook / frame let go at                 44+ kN  -> "outlasts the starter cable"
 *   winch motor stalls at                      26 kN
 *
 *   truck grip parked on pavement              ~63 kN  -> the truck wins
 *   truck grip parked on wet grass             ~23 kN  -> the truck barely wins
 *   truck grip on grass, nose down the slope    ~14 kN  -> the truck loses, and slides
 *
 * That last line is the game. Nothing enforces it: it falls out of the same tire model
 * the truck uses to drive. Retune anything above and re-read the whole block.
 */

/* The world's SIZE is imported rather than restated.
 *
 * It was written out again here, and Milestone 3 found out why that is a bad idea: widening the
 * world to 168 m for the transport leg left CONFIG's copy at 92, so the camera — its only reader —
 * clamped its centre to the old world and refused to follow the truck into the yard. It showed up
 * as a screenshot of the recovery site with a HUD describing the yard.
 *
 * Two records of one fact, one more time. terrain.js owns the number; this points at it. */
import { WORLD } from './data/terrain.js';

export const CONFIG = {

  /* ── simulation ─────────────────────────────────────────────────────────── */
  sim: {
    stepMs: 1000 / 60,     // every force below is tuned against this. See core/clock.js.
    maxFrameMs: 250,       // frame gaps above this are DISCARDED, not banked
    defaultSeed: 20260818,
    seedLabel: 'ditch_one',
    gravity: 9.81,
    // Global velocity damping, per second. Not air resistance — a numerical safety net so
    // a body that gains energy in a contact bleeds it off instead of launching. Small
    // enough that a coasting vehicle still coasts.
    linearDamping: 0.06,
    angularDamping: 1.6,   // vehicles do not spin freely; tires resist yaw hard
    maxSpeed: 26,          // m/s hard clamp (~94 km/h). Nothing here should ever reach it.
    maxSpin: 4.0,          // rad/s hard clamp
  },

  /* ── scene ──────────────────────────────────────────────────────────────── */
  world: WORLD,

  /* ── presentation ───────────────────────────────────────────────────────── */
  render: {
    // A READABILITY budget, not a taste one. A 30 m cable has to be visible end to end
    // while a 0.65 m wheel chock is still findable, so the default sits between them and
    // the player zooms with - and =.
    viewWidthM: 48,
    minViewM: 20,
    maxViewM: 104,
    followLerp: 6,
    fitPaddingM: 2,
    maxPixelRatio: 2,
    // Terrain contour interval. THE slope-legibility device — but at 0.5 m on a 28-degree bank
    // the lines land every 0.9 m and the hillside reads as corduroy rather than as terrain. At
    // 0.75 m, with every second line drawn heavy, it reads as a map.
    contourM: 0.75,
    trackFadePerSec: 0.05,  // tire tracks on soft ground fade this fast
    maxParticles: 520,
  },

  /* ── the player on foot ─────────────────────────────────────────────────── */
  player: {
    radiusM: 0.32,
    maxSpeed: 3.4,          // brisk walk; the scene crosses in ~25 s
    accel: 24,
    friction: 20,
    reachM: 2.1,            // context actions: pick up, attach, mount, pump
    // Walking up the embankment is slower than walking down it. A small effect, but the
    // cheapest possible way to make the player FEEL the slope they are reading.
    slopeSpeedPenalty: 0.55,
    carryHookDrag: 0.72,    // dragging cable off the drum slows you
    hookCarryOffsetM: 0.5,
  },

  /* ── the crew ───────────────────────────────────────────────────────────── */
  // GDD §7 Milestone 2: "2-4 player networking, player stumble/ragdoll punctuation, shared
  // equipment ... and robust object authority."
  /* Traffic. GDD §7 Milestone 5: "traffic/work zones".
   *
   * A passing car is a rigid body with a velocity, not a vehicle with a tire model — see
   * world/traffic.js for why. What matters here is the numbers a player feels:
   *
   *   1400 kg at 22 m/s is 30 800 kg·m/s of momentum arriving at a 6 800 kg wrecker. It moves it.
   *   `brakeMps2` at 6.5 is a firm but ordinary stop, so a driver who SEES you stops in about 37 m.
   *   `sightM` is what the weather takes away: in fog it drops to about half, and a driver who
   *   commits late is the whole reason a work zone is worth setting out.
   *
   * Each cone slows traffic through the zone by `zoneSlowPerCone`, down to `zoneSlowFloor`. Three
   * cones bring a 22 m/s road to about 9 m/s, which is the difference between an incident and a
   * near miss. */
  traffic: {
    massKg: 1400,
    lengthM: 4.4, widthM: 1.78,
    speedMps: 22,           // about 50 mph on a rural two-lane
    accelMps2: 2.2,
    brakeMps2: 6.5,
    sightM: 46,             // in the dry. Scaled by the weather's light level.
    laneHalfW: 2.1,         // how far off the lane centre something has to be to be "in the way"
    stopGapM: 6.0,
    maxCars: 3,
    gapMinMs: 5200,
    gapRangeMs: 9000,
    zoneLeadM: 24,          // a driver starts slowing this far before the first cone
    zoneSlowPerCone: 0.22,
    zoneSlowFloor: 0.4,
    creepAfterMs: 3500,     // stationary this long and a driver starts working their way round
    creepMps: 2.2,          // at walking pace, which is what people actually do
    creepPastM: 16,         // once edging, keep edging for this far rather than re-deciding
    overtakeM: 30,          // start thinking about going round once this close
    overtakeClearM: 70,     // and only if nothing is coming within this
    laneSpring: 3.2,        // how hard a car steers back into its lane after being shoved
    laneDamp: 0.90,
    tints: ['#9aa6b4', '#7d8a72', '#a88a6a', '#8a7b96', '#6f8496'],
  },

  /* The company. GDD §7 Milestone 4.
   *
   * ── EVERY NUMBER HERE HAS TO REACH THE SIMULATION ─────────────────────────────────
   * Otherwise it is bookkeeping with a user interface. Condition scales real forces, stock decides
   * what gear is on site, reputation decides which jobs exist. The wear references below are the
   * interesting ones: `bodyWearRefNs` is "the impulse that would write off a truck in one job", so
   * an ordinary knock costs a percent or two and reversing into the guardrail costs real money.
   *
   * The penalties are deliberately mild and deliberately not total. GDD §4 says no instant fail; a
   * neglected wrecker should make a job harder to do well, never impossible to attempt. At zero
   * condition the truck still drives at 65% and the cable still holds 30 kN. */
  company: {
    startingMoney: 900,
    startingReputation: 20,
    ledgerSize: 12,
    offerCount: 3,

    bodyDrivePenalty: 0.35,     // fraction of drive force lost at zero condition
    bodyBrakePenalty: 0.30,
    winchStrengthPenalty: 0.30, // fraction of cable strength lost at zero winch condition

    bodyWearRefNs: 260000,      // impulse absorbed that would write the body off in one job
    winchWearRefN: 900000,      // peak tension x this many jobs before the drum needs a service
    winchWearPerSnap: 0.22,     // a parted cable is most of a winch service on its own

    bodyRepairFull: 1200,       // to put a written-off body back to new
    winchRepairFull: 900,

    repClean: 6,                // delivered without a mark on it
    repDelivered: 3,
    repAbandoned: -4,           // took the job, did not deliver
    repPerPartLost: 2,
    repPerDrop: 5,              // dropping a customer's car in the road is the worst thing here
    repPerSnap: 1,

    gearPrices: {
      strap: 70, chain: 120, chock: 45, cribbing: 30, jack: 260, snatchBlock: 340,
      cone: 18, groundAnchor: 210,
      default: 90,
    },
  },

  /* What the job pays. GDD §7 Milestone 3: "damage-based payout".
   *
   * A payout, not a grade — see computePayout in world/scene.js. The numbers are chosen so that
   * the deductions are legible against the fee rather than dominant: a clean recovery pays 1400,
   * a torn bumper costs a tenth of that, and it takes a genuinely bad day to reach the floor.
   * `minimumFee` exists because a job that pays nothing teaches nothing; a job that pays badly and
   * says why teaches a lot.
   *
   * There is no time bonus and no par time, deliberately. GDD §8 defers scoring and §9's north star
   * is whether the player describes what THEY did — a clock at the top of a results card answers
   * that question for them. */
  job: {
    baseFee: 1400,
    minimumFee: 150,
    settleMs: 900,          // standing still in the bay this long counts as delivered
    dentCost: 40,
    partBentCost: 90,
    partLostCost: 160,
    cableCost: 250,         // a winch rope is not cheap and it was yours
    railCost: 300,          // the county will be in touch
    dropCost: 220,          // per time the load came off the lift in transit
    rollCost: 400,
  },

  /* The wheel lift. GDD §7 Milestone 3.
   *
   * ── THE FORCE BUDGET, EXTENDED ────────────────────────────────────────────────────
   * The lift is the stiffest constraint in the game and it sits beside the softest one. For
   * scale, at a 1400 kg car half-carried:
   *
   *   cable, chain rig      520 kN/m     meant to stretch; parts at 42 kN
   *   wheel lift          1 200 kN/m     meant not to; drops its load at capacity
   *   stability ceiling  ~2 800 kN/m     sqrt(k/m) < 2/dt at 60 Hz on 700 kg of reduced mass
   *
   * `yokeHoldN` is what the cradle holds on its own — enough for a straight tow on a flat road
   * and not enough for a corner taken at speed. Each strap adds `strapHoldN`, and two of them put
   * the connection comfortably above anything short of hitting something. That is the whole
   * securement mechanic: it is a number the player raises, measured against a force the driving
   * produces.
   */
  lift: {
    reachM: 1.05,           // how far the yoke swings out past the tail
    yokeOffsetM: 0.55,      // and how far past THAT the cradle sits
    engageM: 1.15,          // an axle has to be about this close to be picked up
    engageAlignRad: 0.60,   // ~34°: you cannot pick a car up sideways
    springK: 300000,        // N/m. A 2.6 kN tow load is 9 mm of sag — rigid to look at
    damp: 0.90,             // near-critical: a hinge must not ring, and this one is stiff
    dampCapN: 40000,        // ABSOLUTE cap, not a fraction of the spring term. See stepLift.
    maxForceN: 120000,     // solver safety cap, the same as the cable's
    weightTransfer: 0.45,   // of the load's mass, moved onto the truck when lifted
    yokeHoldN: 11000,       // the cradle on its own
    strapHoldN: 9000,       // each strap or chain across the load
    maxStraps: 3,
    /* Accumulated overload that costs you the load, in newton-seconds. Measured: one hard swerve
     * on a bare cradle accumulates 185 N·s of excess and ONE strap brings the same swerve to 35, so
     * 160 makes a single strap the difference between keeping the car and not. */
    dropNs: 160,
    overDecayNsPerSec: 900,
    /* How far the axle may travel out of the cradle before it is simply not in it any more.
     * Also the hard bound that keeps the constraint from diverging — see stepLift. */
    maxGapM: 0.09,
    strapGapM: 0.05,        // each strap holds the wheels in that much harder

    /* Articulation. A cradle grips the wheels, so the load yaws with the truck up to a limit and
     * is resisted past it. alignDamp is the important one — it is what stops the pair snaking, and
     * it is sized near critical for the sedan's 2 790 kg·m² of yaw inertia at road speed. */
    articulationRad: 0.55,  // ~32° of free swing, which is enough to reverse round a bay
    alignK: 240000,         // N·m per radian past that
    alignDamp: 34000,       // N·m per rad/s of RELATIVE yaw rate
    alignMaxNm: 90000,
    /** A wrecker with a car hanging off the back does not do fifty. A governor, not a wall. */
    towSpeedMaxMps: 9.0,
  },

  /* Networking. GDD §7 Milestone 2.
   *
   * `stepDelay` is input delay in fixed steps, and it is the only knob lockstep really has: a frame
   * sampled while running step N is scheduled for step N + this, which is how long the network gets
   * to deliver it before anybody needs it. Four steps is 67 ms of headroom and about one frame of
   * felt lag on your own actions — the point where a LAN connection never stalls and you cannot
   * feel the delay. Raise it for a worse connection; every step of it is 17 ms of input lag.
   *
   * `seats` is the wire's seat count and stays at maxCount even in a two-crew game, so a third
   * person joining does not renumber anybody. */
  net: {
    stepDelay: 4,
    room: 'lobby',
  },

  crew: {
    // How many people are on site. Two is the interesting number: it is the smallest crew where
    // one can drive while the other rigs, and where two hands can want one hook.
    count: 2,
    maxCount: 4,
    // Being clipped by a moving vehicle. PUNCTUATION, not damage — there is no health here, and
    // the mechanical cost is that you drop what you were holding.
    knockdownMps: 1.6,     // slower than this and a vehicle is just something you bumped into
    stumbleMs: 900,        // base time on the ground, scaled by how fast it hit you
    stumbleMaxMs: 2400,
  },

  /* ── vehicle dynamics, shared ───────────────────────────────────────────── */
  vehicle: {
    // Lateral grip is applied as an impulse cancelling sideways wheel velocity, clamped
    // to the friction circle. This fraction softens it: 1.0 is a rail, and a recovery
    // vehicle that never slides sideways would delete half the game.
    lateralGrip: 0.86,
    // Longitudinal slip at which a tire starts smoking and spraying. Purely a
    // presentation threshold; the force model has no slip curve.
    slipVisibleMps: 0.9,
    slipHeavyMps: 2.6,
    // How much load shifts rearward under acceleration and forward under braking. Crude,
    // but it is why a hard pull on a slope lightens one end and lets the nose wander.
    loadTransfer: 0.22,
    minNormalFrac: 0.15,    // a corner never goes fully weightless; keeps forces finite
    // Share of the tires' friction budget reserved for resisting YAW rather than sliding. See
    // applyYawResistance in sim/vehicle.js: without it, an off-centre pull slowly swings a
    // parked vehicle even on dry pavement. Higher locks vehicles against being turned; lower
    // and the wrecker's tail wanders. 0.45 holds a truck on pavement and still lets one on wet
    // grass be pulled around, which is the distinction that matters.
    yawFrictionShare: 0.45,
    // ...and it fades out above these, because it is a STATIC effect. Past them the per-wheel
    // lateral forces are already resisting the same scrub, and doubling up stops a dragged load
    // from swinging its nose toward the pull. See the note on applyYawResistance.
    yawStaticMps: 0.40,
    yawStaticRadps: 0.50,
    rollThresholdG: 1.9,    // lateral g at which a vehicle starts going over
    rollSustainMs: 220,     // ...and how long it has to stay there. A rollover is a rotation,
                            // not an instant: see the note in sim/vehicle.js.
  },

  truck: {
    massKg: 6800,
    lengthM: 6.6, widthM: 2.45,
    driveForceN: 16000,     // ~0.24 g. A wrecker is heavy, not fast.
    reverseForceN: 11000,
    brakeForceN: 26000,
    parkBrakeForceN: 30000,
    maxSteerRad: 0.60,      // ~34°
    steerRateRad: 2.4,
    steerReturnRad: 3.4,    // self-centring when the wheel is released
  },

  /* ── the heavy wrecker ──────────────────────────────────────────────────────
   * GDD §7 Milestone 6: "heavy wreckers/rotators, multiple winches and outriggers".
   *
   * Not a better tow truck. A DIFFERENT machine, and every number here is chosen so the trade is
   * visible from the cab:
   *
   *   15 t instead of 6.8  it holds against loads the light truck slides under, and it is a barge
   *                        to place — 9.2 m long, and it will not thread the gap in the rail
   *   two drums            two people can pull two lines at once, from two fairleads a metre and a
   *                        half apart, which is a different geometry and not just more force
   *   outriggers           legs down and it is anchored to the planet; legs down and it cannot
   *                        move. That is the whole decision
   *   a slewing boom       the fairleads move, so the pull direction stops being a fact about
   *                        where you parked
   *
   * The light truck is still the right answer for a car in a ditch, because it can get near one.
   */
  heavy: {
    massKg: 15000,
    lengthM: 9.20, widthM: 2.55,
    driveForceN: 27000,     // ~0.18 g. Slower than the light truck, and it feels it.
    reverseForceN: 18000,
    brakeForceN: 52000,
    parkBrakeForceN: 60000,
    maxSteerRad: 0.42,      // a long wheelbase turns like a long wheelbase
    steerRateRad: 1.7,
    steerReturnRad: 2.6,
    /** Per drum. Two of these is 84 kN of line pull, which is what a box truck needs. */
    motorMaxN: 42000,
    cableBreakN: 68000,
    /* Outriggers. Legs on the ground spread the load over four pads instead of four tyres, so the
     * truck stops caring what its own grip budget is — and it cannot drive a centimetre. */
    outriggerHoldN: 260000,
    outriggerSpinResistN: 190000,
    outriggerDeployMs: 2600,
    /* The boom. Slew is in the truck's own frame: 0 is straight back over the tail.
     *
     * `boomPivotX` is where it turns, and it matters more than it looks: the fairleads swing on an
     * arc of `fairlead.x - boomPivotX`, so a pivot close to them barely moves them. Measured with
     * the pivot 0.6 m ahead of the drums, a full 60° slew moved a fairlead 0.94 m and almost all of
     * it ALONG the truck — which changes the pull direction by nothing worth having. At 2.3 m the
     * fairleads sweep a real arc and the pull direction genuinely becomes something you steer. */
    boomPivotX: -2.30,
    boomLengthM: 2.30,      // how far the fairleads sit behind the pivot
    boomSlewMaxRad: 1.05,   // ~60° either side
    boomSlewRateRad: 0.45,  // and it takes about two and a half seconds to reach full lock
  },

  sedan: {
    massKg: 1400,
    lengthM: 4.55, widthM: 1.80,
    brakeForceN: 9000,      // the parking brake holding its rear wheels
    // M2: somebody can now sit in the casualty and steer it while it is dragged (GDD §7,
    // "an occupiable recovered vehicle for steering/braking"). A car steers further than a
    // 7-tonne truck does, and the point of the feature is to keep it tracking up the bank
    // rather than slewing, so it needs the lock to actually correct with.
    maxSteerRad: 0.62,      // ~36°
    // "Bogged in": the resistance of a nose buried in wet ground. It is a real force in a
    // real recovery and it is why the first metre is the hard one. Decays with distance
    // travelled, so breaking a vehicle free genuinely frees it.
    boggedBaseN: 5200,
    boggedRangeN: 1300,     // ± seeded spread, so no two attempts share the same hump
    boggedFreeM: 0.62,      // e-folding distance: halves every ~0.43 m of travel
  },

  /* ── the bigger casualties ──────────────────────────────────────────────────
   * GDD §7 Milestone 6: "large vehicles".
   *
   * The point of a heavier casualty is NOT that its numbers are bigger. It is that the numbers the
   * player already knows stop being enough, all at once and for reasons they can name:
   *
   *   downslope pull   scales with mass, so the 6.2 kN the sedan pulls becomes 11.5 for the van
   *                    and 31.9 for the box truck, against a 26 kN winch stall
   *   bogged           scales with mass too — the first metre of a 7.2 t truck is a different
   *                    proposition from the first metre of a hatchback
   *   the wheel lift   is rated in newtons and always was. A box truck's axle is past it, which is
   *                    what the heavy wrecker's lift exists for
   *
   * So the light wrecker can still recover a van, on a good day and with the block out — and it
   * cannot get a box truck up the bank at all. That is a fact the player discovers by trying it,
   * not a lock on a menu.
   *
   * `boggedBaseN` is per-tonne here rather than absolute, because "how deep is it in" is a fact
   * about the ground and the weight, not about the model of vehicle. */
  bigCasualty: {
    boggedPerTonneN: 3700,
    boggedRangePerTonneN: 900,
  },
  van: {
    massKg: 2600,
    lengthM: 5.40, widthM: 2.00,
    brakeForceN: 15000,
    maxSteerRad: 0.54,
    boggedFreeM: 0.70,
  },
  boxTruck: {
    massKg: 7200,
    lengthM: 7.40, widthM: 2.42,
    brakeForceN: 34000,
    maxSteerRad: 0.44,
    boggedFreeM: 0.86,      // more of it to drag out, so it frees more slowly
  },

  /* ── the winch and its line ─────────────────────────────────────────────── */
  winch: {
    spoolLengthM: 30,       // total cable on the drum
    // Above this the motor stalls and the drum stops. Dropped from 34 kN once the drum interlock
    // (see stepCable) removed the grinding phase: with the load no longer being pressed into the
    // truck, the peak on a normal recovery fell from ~38 kN to 14-17 kN, so a 34 kN stall was
    // never being reached by anything except a jam. At 26 kN the limit sits ~1.6x a working pull
    // and the 42 kN cable sits ~2.6x, which means both numbers describe something again.
    motorMaxN: 26000,
    // No-load line speed. A real 8-tonne recovery winch does 0.15-0.20 m/s, and this is already
    // generous; it stays slow on purpose, because the length of a pull is the cost of parking
    // far enough away to get the geometry right. A 20 m rig is 48 seconds of holding the key.
    reelInMps: 0.42,
    reelOutMps: 0.85,
    // How fast the drum pays out to someone walking the hook away. MUST exceed the 3.4 m/s walk
    // speed, or the line becomes a leash during ordinary play: the drum is free-spooling, and the
    // effort of dragging cable off it is modelled as player.carryHookDrag instead. It is still a
    // rate rather than "instant" so the pathological cases stay bounded.
    freeSpoolMps: 4.6,
    minLineM: 0.45,         // cannot reel the hook into the drum
    stallMarginN: 2000,     // the motor eases off this far below the stall force
    // How fast the drum gives line back when the load is over the motor's limit. This is what
    // stops a slow jam from destroying the cable — see the overload relief note in
    // recovery/cable.js. Keep it MODEST: it has to be slower than a real snatch load, or nothing
    // could ever part the line and the most dramatic failure in the game would be unreachable.
    reliefMps: 0.55,
    // How much faster the drum slips as the overload grows (a brake band, not a clutch). At 8, a
    // line near its breaking point pays out ~1.6 m/s, which is enough to TOW on and not enough to
    // survive a snatch. See the overload relief note in recovery/cable.js.
    // Force scale for how much faster the drum slips as the overload grows. The payout rate is
    // reliefMps * (1 + over / reliefRefN), so at the cable's breaking point — 16 kN past a 26 kN
    // motor — it slips ~1.6 m/s. That is the number that matters: a truck at half throttle takes
    // long enough to reach 1.6 m/s that the load starts moving first and the line survives, and a
    // truck at full throttle gets there in under a second and parts it.
    reliefRefN: 8400,
    cableBreakN: 42000,
    // The cable is a damped spring, NOT a rope simulation (GDD §4 simplification
    // contract). Stiffness comes from the rigging below; this is the shared safety cap.
    maxForceN: 120000,      // per-step clamp so no contact can explode the solver
    slackSagM: 0.9,         // visual sag of an unloaded line
    tensionWarnFrac: 0.62,  // HUD turns amber
    tensionDangerFrac: 0.85,// HUD turns red and the line starts singing
    breakRecoilMps: 3.4,    // how hard a parted line whips back
  },

  /* ── rigging: what sits between the hook and the vehicle ────────────────── */
  // GDD §4 equipment table. strengthMul multiplies the attachment zone's rating; springK
  // and damp decide how the load ARRIVES, which is what "cushions shock" has to mean if
  // it is to mean anything mechanical.
  //
  // `damp` is a fraction of critical damping for the reduced mass of the two bodies. Keep it
  // SMALL. It started at 0.42 and that put ~20 kN of tension into the line for every 1 m/s of
  // closing speed — so a sedan breaking free and sliding 2 m/s parted a 42 kN cable every time,
  // and the straightforward recovery was impossible. Measured by m1 Ha: peak line 52.7 kN on a
  // pull whose steady-state load was 11 kN. At 0.16 the same shock is worth ~7 kN, which reads
  // as a cable snatching rather than a cable exploding.
  rigging: {
    bare:  { label: 'bare hook', strengthMul: 1.00, springK: 520000, damp: 0.16, shockMul: 1.00 },
    strap: { label: 'strap',     strengthMul: 1.40, springK: 240000, damp: 0.26, shockMul: 0.60 },
    chain: { label: 'chain',     strengthMul: 1.75, springK: 700000, damp: 0.11, shockMul: 1.50 },
  },

  /* ── the boring equipment that makes the game ───────────────────────────── */
  gear: {
    pickupReachM: 2.1,
    placeAheadM: 1.15,

    chock: {
      // A chock only helps if it sits behind a wheel with respect to the direction the
      // load is trying to drag the truck. Judged by DIRECTION, never by proximity alone —
      // GDD §4: "poor placement has little effect".
      resistN: 9000,
      reachM: 1.35,         // how near a wheel it must sit to count
      alignDot: 0.34,       // cos of the worst usable angle
    },
    cribbing: {
      dragMul: 0.62,        // multiplies ground drag under the vehicle it supports
      boggedMul: 0.55,      // and helps that vehicle climb out of its own hole
      spinResist: 2600,     // N·m of yaw resistance: blocks stop the body pivoting away
      reachM: 2.3,
      scatterNs: 1600,      // a contact above this impulse kicks the blocks out from under
    },
    jack: {
      liftSteps: 4,         // pumps to full height
      pumpMs: 420,          // per pump
      liftDragMul: 0.42,    // a lifted chassis drags far less
      liftBoggedMul: 0.30,
      // A jack under sideways load is a bad idea, and the game should say so with a
      // consequence rather than with a warning label.
      slipLateralN: 5200,
      reachM: 2.2,
    },
    snatchBlock: {
      forceMul: 1.70,       // ACKNOWLEDGED CHEAT — GDD §4: "intentionally simplified
                            // mechanical advantage". A tree-mounted redirect gives no real
                            // advantage; the GDD asks for one anyway, so here it is, as one
                            // named number instead of smeared through the solver.
      reelMul: 0.55,        // paid for in line speed, which is at least honest
      anchorReachM: 1.9,    // how close to a tree it must be mounted
      minAngleRad: 0.22,    // a block in a straight line does nothing
    },
    /* A driven ground anchor. Milestone 6's "richer anchors": a portable anchor point for the
     * places with no tree worth rigging to. It is not a better tree — a tree holds 52-60 kN and
     * this holds 22 on the best ground it will bite into — it is an anchor you can carry to where
     * you need one, which is a different thing. */
    groundAnchor: {
      holdN: 22000,         // on ground with an anchorHoldMul of 1 (wet grass)
      reachM: 1.6,          // how close the block has to be mounted to it
    },
  },

  /* ── anchors ────────────────────────────────────────────────────────────────
   * GDD §4 listed "small/weak anchors can fail" and Milestone 1 deferred it, authoring
   * `anchorStrengthN` on the trees and reading it nowhere. Milestone 6 turns it on.
   *
   * Judged in NEWTON-SECONDS, like the guardrail and the wheel lift before it, for the same
   * reason: a redirect through a block puts up to 2x the line tension on the anchor and the peak
   * arrives in single steps. "How hard, and for how long" is the only question that produces a
   * tree that leans, holds, and then goes over rather than one that snaps at a threshold. */
  anchors: {
    /** Accumulated overload before it lets go. A tree at 10 kN over its rating has ~2.4 s. */
    failNs: 24000,
    /** How fast the accumulated overload bleeds off once the pull comes back under the rating. */
    recoverPerSec: 9000,
    /** Below this fraction of its rating nothing accumulates at all — a loaded anchor is normal. */
    creepFrac: 1.0,
    /** What an uprooted tree leaves behind: it stops being an anchor and it stops being solid. */
    fallenDragMul: 1.0,
  },

  /* ── damage ─────────────────────────────────────────────────────────────── */
  // Component- and threshold-based, not soft-body (GDD §4).
  //
  // CONTACTS ARE JUDGED IN NEWTON-SECONDS, NOT NEWTONS. These were originally forces, with a
  // collision's impulse divided by the step to make an "equivalent force" so that one table
  // could judge both a cable tension and a crash. That is not a real quantity: dividing by
  // 1/60 s turns a 1400 kg car brushing a guardrail post at 0.4 m/s into 34 kN, so the sedan
  // shed its bumper every time it touched anything. Impulse is the honest measure of a bump —
  // it is mass times the speed that got taken away.
  //
  // Reference points, all for the 1400 kg sedan:
  //   1 m/s stopped  = 1400 N·s   a scuff, and nothing more
  //   2.3 m/s        = 3200 N·s   dents
  //   5.4 m/s        = 7500 N·s   something comes off
  // The 6800 kg truck reaches the same numbers at a fifth of the speed, which is why letting
  // the wrecker roll into the casualty is expensive.
  damage: {
    impactMinNs: 900,        // below this, a nudge is just a nudge
    impactDentNs: 3200,      // visible damage
    impactDetachNs: 7500,    // something comes off
    wheelLostDragMul: 3.4,   // a wheel-less corner ploughs
    bentAxleDragMul: 1.9,
    guardrailYieldNs: 1800,  // "a weak guardrail" — GDD §4 scenario. A car at 1.3 m/s bends it.
    guardrailBreakNs: 5200,  // and at 3.7 m/s takes the section out.
  },

  /* ── the one objective ──────────────────────────────────────────────────── */
  success: {
    // "Get the sedan onto the road" — all four chassis corners over pavement, settled.
    // Corners, not centre: a sedan hanging half off the shoulder has not been recovered,
    // and the player can see that difference without being told.
    requireAllCorners: true,
    maxSpeedMps: 1.0,
    settleMs: 1000,
  },

  /* ── audio ──────────────────────────────────────────────────────────────── */
  // Synthesised, no files, no CDN. `tone` is taken from Chameleon:2190 (Dev\INDEX.md
  // "Audio"). GDD pillar 5 lists sound among the ways force is made readable, so this is
  // Milestone 1 work rather than polish.
  audio: {
    enabled: true,
    masterVol: 0.55,
    engineVol: 0.30,
    winchVol: 0.34,
    // The line sings as it loads: pitch tracks tension fraction directly, which makes the
    // most important number in the game audible without looking at the HUD.
    cableHzLow: 90, cableHzHigh: 620,
  },

  /* ── debug ──────────────────────────────────────────────────────────────── */
  debug: {
    enabled: false,         // F3
    showForces: false,      // force arrows at every application point
    showZones: false,
    timeScales: [0.25, 0.5, 1, 2],
    eventLogSize: 256,
    recentEvents: 7,
  },

  /* ── deliberately absent ────────────────────────────────────────────────── */
  // GDD §8: economy, payout, transport, garage, dispatch and networking are not
  // Milestone 1. They get their own blocks when they get their own milestones. An empty
  // boundary is honest; a half-built feature is not.
};

/** Deep-frozen so no system can quietly retune the game at runtime. Difficulty presets,
 *  when they arrive, must be MULTIPLIERS applied at the read site — never an assignment
 *  into CONFIG. (Pattern and the lesson both from AirportBaggageCrew.) */
function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}
deepFreeze(CONFIG);
