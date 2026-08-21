/* The wheel lift. GDD §7 Milestone 3: "a flatbed or wheel-lift workflow, physical load
 * securement".
 *
 * ── WHY A WHEEL LIFT AND NOT A FLATBED ───────────────────────────────────────────────
 * A flatbed is a tilting deck and a winch pulling a car up a ramp — which is, mechanically, the
 * winch that already exists plus an animation. A wheel lift is a genuinely different machine: a
 * yoke swings out under one axle, lifts it, and from then on the two vehicles are ONE articulated
 * thing that pivots about the yoke. That is a new constraint, a new failure mode, and a completely
 * different problem to reverse into a bay. It is also the machine on the truck this game already
 * has, which has a boom and a drum rather than a deck.
 *
 * ── THE CONSTRAINT ───────────────────────────────────────────────────────────────────
 * A hitch is a hinge: the yoke point on the truck and the lifted axle's midpoint on the car are
 * the SAME point, and the angle between the two bodies is free. Modelled the same way everything
 * else in this game is modelled — a damped spring applied equal-and-opposite at two offsets, so
 * both ends get torque and nothing anywhere has to know which one is the load. `stepTowBar` below
 * is `stepCable` (src/recovery/cable.js) with a rest length of zero and no drum.
 *
 * It has to be much stiffer than the cable: 42 kN of rope is meant to stretch, and a steel yoke is
 * not. Stability sets the ceiling — a spring at stiffness k on reduced mass m rings at
 * sqrt(k/m) rad/s, and semi-implicit Euler needs that under ~2/dt. With a 1400 kg car half-carried
 * that puts the limit near 2.8 MN/m at 60 Hz, so 1.2 MN/m is stiff enough to look rigid (7 mm of
 * sag under a 8 kN drag) with room to spare.
 *
 * ── WHY SECUREMENT IS A FORCE AND NOT A CHECKBOX ─────────────────────────────────────
 * The yoke alone holds the axle down with its own weight and a couple of chains' worth of nothing.
 * Straps are what stop a lifted car walking sideways out of the cradle under lateral load. So the
 * connection has a CAPACITY that straps raise, the constraint force is measured against it every
 * step, and exceeding it drops the car in the road. Drive round the yard entrance at speed with an
 * unstrapped load and you will find out; strap it and you will not.
 *
 * ── TWO MACHINES, ONE CONSTRAINT (Milestone 8) ───────────────────────────────────────
 * The heavy wrecker carries an underlift rather than a car yoke, and for two milestones it did
 * not: an 11 kN cradle against a box truck's 35 kN axle meant the biggest casualty in the game
 * was dragged home on the line, and the securement decision this file exists to produce was
 * unavailable on the machine that needs it most.
 *
 * An underlift is not a second mechanism. It is this hinge with a bigger cradle, a longer arm and
 * CHAINS instead of straps — so the difference is a table of numbers rather than a branch, and
 * `liftSpec` below is the only place the two machines are told apart. Everything the hinge itself
 * is made of — stiffness, damping, the articulation limit, the weight transfer — is shared and
 * cannot drift between them.
 */

import { CONFIG } from '../config.js';
import { EVENTS } from '../core/eventBus.js';
import { clamp, clamp01, unit } from '../core/vec.js';

/* CONFIG.lift.heavy overrides only what differs, so the two specs are built by merging rather
 * than authored twice — `YOKE` is CONFIG.lift itself, to the decimal, and a light wrecker cannot
 * be retuned by anything done to the heavy's block. The noun is here rather than in config
 * because it is not a tunable: it is what the gear across the load is CALLED on each machine. */
const { heavy: HEAVY_NUMBERS, ...YOKE_NUMBERS } = CONFIG.lift;
const YOKE = Object.freeze({ ...YOKE_NUMBERS, gearNoun: 'strap', gearVerb: 'strapping' });
const UNDERLIFT = Object.freeze({
  ...YOKE_NUMBERS,
  /* ── WHY THE UNDERLIFT IS STIFFER, AND WHY IT IS A RATIO ──────────────────────────
   * A cradle's travel and its rating are the same fact: the spring IS the steel. At the car
   * yoke's 300 kN/m an 11 kN cradle is at its rating after 37 mm, comfortably inside the 90 mm
   * at which the axle is declared out of the cradle — so a car yoke can be genuinely OVERLOADED,
   * which is the whole Milestone 3 mechanic.
   *
   * MEASURED: give a 46 kN cradle that same 300 kN/m and its rating is 153 mm of travel, past
   * `maxGapM`. The load then jumps out of the cradle before the force can ever exceed capacity —
   * a box truck swerved bare peaked at 45.8 kN against a 46.0 kN cap and accumulated 0 N·s, so
   * `dropNs` was a number nothing in the game could reach and securement bought nothing.
   *
   * So the underlift reaches its rated hold at the same displacement the car yoke does, which
   * makes it stiffer in exactly the proportion it is stronger. Authoring `springK` in
   * CONFIG.lift.heavy overrides this, because the config spread below wins. */
  springK: YOKE_NUMBERS.springK * (HEAVY_NUMBERS.yokeHoldN / YOKE_NUMBERS.yokeHoldN),
  ...HEAVY_NUMBERS,
  gearNoun: 'chain',
  gearVerb: 'chaining',
});

/** Where the lift is in its cycle. Ownership of the load lives on the lift, not on the car. */
export const LIFT = Object.freeze({
  STOWED:    'stowed',      // folded under the tail
  EXTENDED:  'extended',    // swung out, empty, ready to go under an axle
  CARRYING:  'carrying',    // an axle is up
});

export function createLift() {
  return {
    state: LIFT.STOWED,
    /** How far the yoke reaches past the tail. Fixed per state; not a continuous control. */
    reachM: 0,
    /** Vehicle id whose axle is up, or null. THE record of what is loaded — see crew/authority.js:
     *  one fact, one place. */
    carryingId: null,
    /** Which end of it is up: 'front' or 'rear'. Changes nothing mechanically except geometry. */
    end: 'front',
    /** Gear ids strapped across the load. Each raises the capacity. */
    straps: [],
    /** Accumulated overload, in newton-seconds. The thing that eventually drops a load. */
    overNs: 0,
    /** How far the load is swung round on the cradle, in radians. Presentation and tests. */
    articulationRad: 0,
    /** Live readouts for the HUD and the tests. */
    forceN: 0,
    capacityN: 0,
    loadFrac: 0,
    /** Which machine's numbers this lift is running on — refreshed from the truck every step by
     *  `liftSpec`, alongside capacityN and forceN. A readout, not a record: see liftSpec. */
    spec: YOKE,
  };
}

/**
 * The numbers THIS machine's lift runs on.
 *
 * Selected from the truck doing the lifting and never from a global, which is the whole of the
 * per-machine behaviour: a light wrecker reads CONFIG.lift to the decimal and the heavy reads
 * CONFIG.lift.heavy on top of it.
 *
 * The chosen block is also left on the lift, because `liftCapacityN` is handed a lift rather than
 * a truck. That is a derived readout refreshed every step, in the same slot as `capacityN` and
 * `forceN` — never the record of anything. The fact that a machine HAS an underlift lives on its
 * definition (data/vehicles.js) and nowhere else, so there is only ever one thing to change.
 */
export function liftSpec(truck) {
  const spec = truck && truck.def && truck.def.underlift ? UNDERLIFT : YOKE;
  if (truck && truck.lift) truck.lift.spec = spec;
  return spec;
}

/** What the gear across the load is called on this machine. Chains on an underlift, straps on a
 *  car yoke — the player is told about it in the HUD, in the prompt and in the recap, and all
 *  three ask here rather than each deciding for themselves. */
export function liftGearNoun(truck, n = 1) {
  const noun = liftSpec(truck).gearNoun;
  return n === 1 ? noun : `${noun}s`;
}

/** ...and what putting it there is called: "nothing STRAPPING it on" on a car yoke, "nothing
 *  CHAINING it on" on the heavy. Here so that no interface file has to own a gerund. */
export function liftGearVerb(truck) {
  return liftSpec(truck).gearVerb;
}

/** How fast this machine is governed to with a load on. Read by the tire model. */
export function towSpeedMaxMps(truck) {
  return liftSpec(truck).towSpeedMaxMps;
}

/** The yoke's world position: straight out behind the truck, past the fairlead. */
export function yokePos(truck) {
  const L = truck.def.lengthM / 2;
  return truck.body.toWorld(-(L + truck.lift.reachM + liftSpec(truck).yokeOffsetM), 0);
}

/** Midpoint of a vehicle's front or rear axle, in world space. */
export function axleMid(veh, end = 'front') {
  const wheels = veh.def.wheels.filter((w) => (end === 'front' ? w.local.x > 0 : w.local.x < 0));
  let lx = 0, ly = 0;
  for (const w of wheels) { lx += w.local.x; ly += w.local.y; }
  return veh.body.toWorld(lx / wheels.length, ly / wheels.length);
}

/** Indices into `veh.def.wheels` for one end. The lifted pair carry nothing. */
export function axleWheelIndices(veh, end = 'front') {
  const out = [];
  veh.def.wheels.forEach((w, i) => {
    if (end === 'front' ? w.local.x > 0 : w.local.x < 0) out.push(i);
  });
  return out;
}

/** How much the connection can hold before the car comes off it. */
export function liftCapacityN(lift) {
  const L = lift.spec || YOKE;
  return L.yokeHoldN + lift.straps.length * L.strapHoldN;
}

/* ── the workflow ──────────────────────────────────────────────────────────── */

/** Swing the yoke out. Only from stowed, and only when nothing is on it. */
export function extendLift(st, bus, simTimeMs) {
  const truck = st.vehicles.truck;
  const lift = truck.lift;
  if (lift.state !== LIFT.STOWED) return false;
  lift.state = LIFT.EXTENDED;
  lift.reachM = liftSpec(truck).reachM;
  bus.emit(EVENTS.LIFT_EXTENDED, {}, simTimeMs);
  return true;
}

/** Fold it back under the tail. Refused while carrying, for the obvious reason. */
export function stowLift(st, bus, simTimeMs) {
  const lift = st.vehicles.truck.lift;
  if (lift.state !== LIFT.EXTENDED) return false;
  lift.state = LIFT.STOWED;
  lift.reachM = 0;
  bus.emit(EVENTS.LIFT_STOWED, {}, simTimeMs);
  return true;
}

/**
 * Which axle, if any, the yoke is under right now.
 *
 * Geometry, not a flag. The yoke has to be within `engageM` of an axle midpoint AND the two
 * vehicles roughly in line — you cannot pick a car up sideways, and a player who has parked at
 * 40 degrees to it should be told to try again rather than quietly succeeding.
 */
export function liftTarget(st) {
  const truck = st.vehicles.truck;
  const lift = truck.lift;
  if (lift.state !== LIFT.EXTENDED) return null;
  const L = liftSpec(truck);
  const y = yokePos(truck);

  let best = null;
  for (const id of Object.keys(st.vehicles)) {
    const veh = st.vehicles[id];
    if (veh === truck) continue;
    for (const end of ['front', 'rear']) {
      const a = axleMid(veh, end);
      const d = Math.hypot(a.x - y.x, a.y - y.y);
      if (d > L.engageM) continue;
      // Angle between the two vehicles, folded into 0..pi/2 — a car facing either way is fine,
      // it is a car lying ACROSS the yoke that is not.
      let da = Math.abs(((veh.body.angle - truck.body.angle + Math.PI) % (Math.PI * 2)) - Math.PI);
      if (da > Math.PI / 2) da = Math.PI - da;
      if (da > L.engageAlignRad) continue;
      if (!best || d < best.d) best = { veh, end, d, misalignRad: da };
    }
  }
  return best;
}

/** Raise an axle. The car is carried from here until it is set down or it comes off. */
export function engageLift(st, bus, simTimeMs) {
  const truck = st.vehicles.truck;
  const lift = truck.lift;
  const t = liftTarget(st);
  if (!t) return false;

  /* SNAP THE GEOMETRY CLOSED FIRST.
   *
   * `engageM` is a reach tolerance — how near the yoke has to be to get under an axle — and it is
   * deliberately generous, because parking a truck to the centimetre is not the game. But leaving
   * that metre of slack for a 1 200 kN/m spring to resolve is 1.1 MEGANEWTONS on the first step.
   * MEASURED: engaging across a 0.94 m gap threw the car three metres down the road and dropped it
   * again inside 180 ms, which read as the lift being broken and was really the lift being asked to
   * close a gap a real yoke never has.
   *
   * A yoke that has picked an axle up has the axle IN it. So place the load there, rigidly, and
   * kill the relative velocity — the same one-off kinematic placement `attachHook` does when it
   * puts the hook exactly on the zone. It is a teleport, and it is legitimate precisely because it
   * happens once, at the player's request, rather than every step.
   */
  const y0 = yokePos(truck);
  const a0 = axleMid(t.veh, t.end);
  t.veh.body.x += y0.x - a0.x;
  t.veh.body.y += y0.y - a0.y;
  t.veh.body.vx = truck.body.vx;
  t.veh.body.vy = truck.body.vy;
  t.veh.body.omega = 0;

  lift.state = LIFT.CARRYING;
  lift.carryingId = t.veh.id;
  lift.end = t.end;
  lift.straps.length = 0;
  lift.overNs = 0;
  /* The lifted end carries nothing, and the rest of the car carries less. Both are recorded on
   * the VEHICLE, because that is where the tire model will ask — see the note at the top of
   * crew/authority.js about not keeping a second copy of a fact. */
  for (const i of axleWheelIndices(t.veh, t.end)) t.veh.wheelState[i].airborne = true;
  const transfer = liftSpec(truck).weightTransfer;
  t.veh.groundLoadMul = 1 - transfer;
  truck.extraLoadKg = t.veh.body.massKg * transfer;

  // A car being carried is not a car being winched. Leaving the line on would have the cable and
  // the yoke fighting each other over the same body, which is neither realistic nor debuggable.
  bus.emit(EVENTS.LIFT_ENGAGED, {
    vehicle: t.veh.id, end: t.end,
    misalignDeg: Math.round(t.misalignRad * 57.3),
  }, simTimeMs);
  return true;
}

/** Set it down deliberately. */
export function releaseLift(st, bus, simTimeMs, reason = 'player') {
  const truck = st.vehicles.truck;
  const lift = truck.lift;
  if (lift.state !== LIFT.CARRYING) return false;
  const veh = st.vehicles[lift.carryingId];

  if (veh) {
    for (const i of axleWheelIndices(veh, lift.end)) veh.wheelState[i].airborne = false;
    veh.groundLoadMul = 1;
  }
  truck.extraLoadKg = 0;

  const dropped = reason !== 'player';
  bus.emit(EVENTS.LIFT_RELEASED, {
    vehicle: lift.carryingId, reason, dropped,
    x: veh ? Math.round(veh.body.x * 10) / 10 : 0,
    y: veh ? Math.round(veh.body.y * 10) / 10 : 0,
  }, simTimeMs);

  lift.state = LIFT.EXTENDED;
  lift.carryingId = null;
  lift.straps.length = 0;
  lift.forceN = 0;
  return true;
}

/** Strap the load down. One gear item per strap — or per chain on the heavy, where there are two
 *  of them rather than three and each is worth better than three times as much. */
export function strapLoad(st, item, bus, simTimeMs) {
  const truck = st.vehicles.truck;
  const lift = truck.lift;
  if (lift.state !== LIFT.CARRYING) return false;
  if (lift.straps.length >= liftSpec(truck).maxStraps) return false;
  if (lift.straps.includes(item.id)) return false;
  lift.straps.push(item.id);
  item.carriedBy = null;
  item.placed = true;
  item.attachedTo = 'lift';
  bus.emit(EVENTS.LOAD_SECURED, {
    gear: item.id, kind: item.kind, straps: lift.straps.length,
    /* What this machine calls the gear across the load — 'strap' or 'chain', SINGULAR, so a
     * reader can form its own past tense. The count is `straps`. */
    noun: liftGearNoun(truck),
    capacityN: Math.round(liftCapacityN(lift)),
  }, simTimeMs);
  return true;
}

/* ── the physics ───────────────────────────────────────────────────────────── */

/**
 * Hold the lifted axle at the yoke.
 *
 * ADAPTED from `stepCable` (src/recovery/cable.js), keeping its shape so the two constraints
 * cannot drift apart: one displacement, one damped spring along it, applied equal-and-opposite at
 * two physical offsets, damping clamped to a fraction of the spring term so a velocity spike
 * cannot break a connection that is barely displaced. The differences are that the rest length is
 * zero and that exceeding capacity drops the load rather than parting anything.
 *
 * Must run in the same slot in the step order as the cable: BEFORE the tire model, because the
 * tires size their static resistance against the force already in the accumulator.
 */
export function stepLift(st, dtSec, bus, simTimeMs) {
  const truck = st.vehicles.truck;
  const lift = truck.lift;
  /* FIRST, every step, carrying or not: which machine's numbers this lift is on. Everything
   * below — the capacity, the reach, the drop threshold — comes from here rather than from
   * CONFIG.lift, and a lift that has never been touched still reports the right capacity. */
  const L = liftSpec(truck);
  lift.capacityN = liftCapacityN(lift);
  if (lift.state !== LIFT.CARRYING) { lift.forceN = 0; lift.loadFrac = 0; return 0; }

  const veh = st.vehicles[lift.carryingId];
  if (!veh) { releaseLift(st, bus, simTimeMs, 'vanished'); return 0; }

  const y = yokePos(truck);
  const a = axleMid(veh, lift.end);
  const dx = y.x - a.x, dy = y.y - a.y;
  const gap = Math.hypot(dx, dy);

  const u = gap > 1e-6 ? { x: dx / gap, y: dy / gap } : { x: 0, y: 0 };

  /* Rate at which the gap is OPENING. `u` points from the axle to the yoke, so
   * d(gap)/dt = u · (v_yoke - v_axle) — positive means they are separating, which is exactly the
   * sign convention the cable's `rate` uses, and the damping has to ADD to the restoring force in
   * that case rather than subtract from it.
   *
   * It was subtracting. Called `closing` and negated, the damper cancelled the spring for the
   * first ten steps of every tow: MEASURED, the gap opened to 27 mm with the reported force still
   * at zero, then the spring caught up all at once and the pair rang between 0 and the 120 kN
   * solver cap for the rest of the run. A sign, and it looked exactly like an instability. */
  const vT = truck.body.velocityAt(y.x, y.y);
  const vL = veh.body.velocityAt(a.x, a.y);
  const sepRate = (vT.x - vL.x) * u.x + (vT.y - vL.y) * u.y;

  const mEff = (truck.body.massKg * veh.body.massKg) / (truck.body.massKg + veh.body.massKg);
  /* ── WHY THE DAMPING CLAMP IS ABSOLUTE HERE AND PROPORTIONAL IN THE CABLE ──────────
   *
   * The cable clamps its damping to a fraction of its spring term, and that is right for a rope:
   * damping is a stabiliser, not a force the player should be able to break a barely-stretched
   * line with. Copying that rule onto a rigid hinge was wrong in a way that took a measurement to
   * see. At small displacement the clamp leaves almost NO damping — exactly when it is needed — so
   * the constraint accumulates gap before any force opposes it, overshoots, and rings.
   *
   * MEASURED: towing a 1400 kg car that needed about 2.8 kN through the yoke, the force ramped
   * 0.3 -> 0.9 -> 1.7 -> 2.9 -> 5.2 -> 7.8 -> 10.1 -> 11.2 kN over nine steps and then peaked at
   * 106 kN — four times the load, from nothing but the clamp suppressing the damper.
   *
   * So: near-critical damping, capped at an ABSOLUTE force well above the working range. The gap
   * then never opens far enough to matter and the steady force is what the tow actually needs. */
  const c = L.damp * 2 * Math.sqrt(L.springK * mEff);
  const springT = L.springK * gap;
  const dampT = clamp(c * sepRate, -L.dampCapN, L.dampCapN);
  let T = springT + dampT;
  if (T < 0) T = 0;
  if (T > L.maxForceN) T = L.maxForceN;

  lift.forceN = T;
  lift.loadFrac = clamp01(T / lift.capacityN);

  // The car is pulled toward the yoke and the truck toward the car, at their own offsets, so
  // both get torque. This is what makes a loaded truck feel like it has something hanging off it.
  veh.body.applyForceAt(u.x * T, u.y * T, a.x, a.y,
                        CONFIG.debug.showForces ? 'liftLoad' : '');
  truck.body.applyForceAt(-u.x * T, -u.y * T, y.x, y.y,
                          CONFIG.debug.showForces ? 'liftTruck' : '');

  /* ── ARTICULATION ─────────────────────────────────────────────────────────────────
   * A wheel-lift cradle GRIPS the wheels. The load cannot yaw freely about the yoke — it can
   * articulate through a limited angle, the way any hitch does, and the cradle resists the rest.
   *
   * Without this the pair is a two-wheeled trailer on a frictionless pin, and at road speed it
   * snakes. MEASURED: a straight tow was perfect at 2.65 kN and 4.4 mm of sag, and a single swerve
   * at 12.6 m/s diverged two hundred steps LATER — the gap opening to 679 mm and the constraint
   * pinned at its 120 kN solver cap. Not a stiffness problem and not a capacity problem: a yaw
   * mode with nothing damping it.
   *
   * Applied equal-and-opposite, so the load leaning on the cradle is felt as steering weight in
   * the cab rather than being free momentum from nowhere. */
  let rel = (veh.body.angle - truck.body.angle) % (Math.PI * 2);
  if (rel > Math.PI) rel -= Math.PI * 2;
  if (rel < -Math.PI) rel += Math.PI * 2;
  const over = Math.abs(rel) > L.articulationRad
    ? Math.sign(rel) * (Math.abs(rel) - L.articulationRad)
    : 0;
  const relOmega = veh.body.omega - truck.body.omega;
  const align = clamp(-L.alignK * over - L.alignDamp * relOmega, -L.alignMaxNm, L.alignMaxNm);
  veh.body.applyTorque(align);
  truck.body.applyTorque(-align);
  lift.articulationRad = rel;

  /* ── TWO WAYS TO LOSE IT, BOTH PHYSICAL ───────────────────────────────────────────
   *
   * 1. TOO MUCH FORCE, sustained. A strap or a cradle gives up. Sustained rather than instant,
   *    for the same reason rollovers need `rollSustainMs`: one step of numerical noise over a
   *    threshold is not an event.
   *
   * 2. TOO MUCH TRAVEL, immediately. No cradle lets an axle move a foot out of it — if the gap is
   *    that big the wheels are simply not in the yoke any more. Straps hold them in, so the
   *    tolerance grows with them.
   *
   * The second one is also what keeps this bounded. A stiff constraint on two rigid bodies with a
   * long offset has a yaw mode, and at road speed with the load riding the articulation limit it
   * can diverge — MEASURED at 473 mm of gap and the 120 kN solver cap, from a second hard swerve
   * at 10.7 m/s. Stiffness tuning does not fix that; it only changes how fast it happens. A hard
   * displacement limit does, and it turns "the numbers exploded" into "you threw the car off the
   * back", which is what was happening anyway. */
  const gapLimit = L.maxGapM + lift.straps.length * L.strapGapM;
  if (gap > gapLimit) {
    lift.straps.length = 0;
    releaseLift(st, bus, simTimeMs, 'jumped');
    return T;
  }

  /* Overload is judged as an accumulated IMPULSE over capacity, in newton-seconds — not as a
   * force over a threshold, and not as a duration above one.
   *
   * A duration cannot work here, and measuring showed why: towing a car round a bend puts the
   * yoke over its 11 kN bare capacity for 33 ms at a time, every time, with a 22 kN peak. Any
   * sustain long enough to ignore that is long enough to ignore everything. The guardrail already
   * had this shape (collision.js: a shunt breaks it, a lean only bends it) and it is the same
   * question — how hard, for how long — so it gets the same answer.
   *
   * The numbers then say something a player can feel. MEASURED, on one hard swerve — a tap of
   * lock and a counter-tap — with the same drive at both scales:
   *
   *   sedan, bare car yoke        11 kN cap, 16.3 kN peak   185 N·s   the car comes off
   *   sedan, one strap            20 kN cap, 22.1 kN peak    35 N·s   arrives
   *   sedan, two straps           29 kN cap                   0 N·s   never exceeds at all
   *   box truck, bare underlift   46 kN cap, 64.0 kN peak   299 N·s
   *   box truck, one chain        76 kN cap, 64.0 kN peak     0 N·s   arrives
   *
   * Note what the two bare rows say together: the excess a swerve produces is a fact about the
   * MACHINE's dynamics, not about the cradle's rating. Four times the cradle bought 1.6 times the
   * overload, so this threshold cannot be scaled off the hold — see the report. */
  const excess = T - lift.capacityN;
  if (excess > 0) {
    lift.overNs = (lift.overNs || 0) + excess * dtSec;
    if (lift.overNs >= L.dropNs) {
      lift.overNs = 0;
      lift.straps.length = 0;      // whatever was holding it is not holding it any more
      releaseLift(st, bus, simTimeMs, 'overload');
      return T;
    }
  } else {
    // Decays, so a long gentle drive with the occasional bump never adds up to a dropped car.
    lift.overNs = Math.max(0, (lift.overNs || 0) - L.overDecayNsPerSec * dtSec);
  }

  return T;
}

/** For the HUD, the debug overlay and the tests. */
export function describeLift(lift) {
  return {
    state: lift.state,
    carrying: lift.carryingId,
    end: lift.end,
    straps: lift.straps.length,
    forceN: Math.round(lift.forceN),
    capacityN: Math.round(lift.capacityN),
    loadFrac: Math.round(lift.loadFrac * 100) / 100,
  };
}
