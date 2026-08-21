/* Traffic, and the cones you put out to keep it off you. GDD §7 Milestone 5.
 *
 * ── THE ONE THING THAT MAKES A ROADSIDE A ROADSIDE ───────────────────────────────────
 * You are working in a live carriageway. Everything in Milestones 1-4 happened on a road that
 * nothing else ever used, and that is the single least true thing about the fantasy — the whole
 * reason recovery operators put cones out, wear hi-vis and watch the traffic is that the road does
 * not stop for them.
 *
 * So: cars come along it. They are real bodies in the contact solver, they will hit a truck parked
 * across the lane, they will hit a cable strung across it, and they will hit YOU. And they slow
 * down for a work zone, which is what the cones are for.
 *
 * ── WHY THEY ARE KINEMATIC AND NOT DRIVEN ────────────────────────────────────────────
 * A passing car is a rigid body with a velocity, not a vehicle with a tire model. It has no
 * decisions to make beyond "how fast, given what is ahead", so giving it four friction circles
 * would be four times the cost for none of the behaviour. What it DOES have is a real box in the
 * collision pass, so a contact with it is the same contact as any other — with a mass and a closing
 * speed that will move a 6.8 tonne wrecker if you leave it in the way.
 *
 * ── AND WHY THEY BRAKE ───────────────────────────────────────────────────────────────
 * Because a game where traffic ploughs into a parked truck at 22 m/s regardless is a game about
 * one mistake, and GDD §4 is explicit that consequences should continue the story rather than end
 * it. A driver who can see an obstruction slows for it. A driver who cannot — fog, night, or one
 * that is already too close — does not, and that is the failure worth keeping.
 *
 * ── AND FOR EACH OTHER (Milestone 8) ─────────────────────────────────────────────────
 * For three milestones a driver looked ahead for the recovery vehicles, the crew, the cones and the
 * cable, and for other traffic not at all: two cars in one lane were held apart by the contact
 * solver rather than by anybody lifting off. So a blocked road produced a scrum — cars grinding
 * into each other's flanks around the obstruction — rather than a tailback. That matters beyond
 * looking right: a queue is what an unclosed scene actually creates, the queue is itself the second
 * hazard, and Milestone 7's road closure is the thing that stops it forming. Without a queue, the
 * closure protects you from a picture.
 */

import { CONFIG } from '../config.js';
import { EVENTS } from '../core/eventBus.js';
import { Body } from '../sim/body.js';
import { boxInertia } from '../data/vehicles.js';
import { obbOverlap } from '../sim/collision.js';
import { drumsOf, fairleadPos, hookPos } from '../recovery/cable.js';

/** How much light there is: the forecast times the time of day. ONE number — see world/scene.js. */
const lightOf = (t) => (typeof t.light === 'number' ? t.light : (t.weather ? t.weather.light : 1));

/** Which way a car is going. Eastbound uses the south lane, westbound the north, as they should. */
export const EAST = 1;
export const WEST = -1;

export function createTraffic() {
  return {
    cars: [],
    nextId: 1,
    /** Simulation ms until the next one appears. Seeded at scene build; never a wall clock. */
    nextInMs: 0,
    /** Counters the HUD and the recap read. */
    passed: 0,
    slowed: 0,
    hits: 0,
  };
}

/** Where a car of this direction drives, in y. */
export function laneY(terrain, dir) {
  const r = terrain.road;
  const quarter = (r.y1 - r.y0) / 4;
  return dir === EAST ? r.y1 - quarter : r.y0 + quarter;
}

function spawnCar(st, dir, rng, simTimeMs) {
  const T = CONFIG.traffic;
  const terrain = st.terrain;
  const y = laneY(terrain, dir);
  const x = dir === EAST ? -3 : terrain.world.widthM + 3;
  const body = new Body({
    id: `traffic_${st.traffic.nextId}`,
    x, y, angle: dir === EAST ? 0 : Math.PI,
    halfL: T.lengthM / 2, halfW: T.widthM / 2,
    massKg: T.massKg,
    inertia: boxInertia(T.massKg, T.lengthM, T.widthM),
  });
  const want = T.speedMps * (0.85 + rng.range(0, 0.3));
  body.vx = dir * want;
  const car = {
    id: `traffic_${st.traffic.nextId++}`,
    body, dir,
    wantMps: want,
    /** Presentation only — a tint so two cars in shot are two cars. */
    tint: T.tints[Math.floor(rng.range(0, T.tints.length)) % T.tints.length],
    braking: false,
    onOtherSide: false,
    stuckMs: 0,
    creepUntilX: null,
    creepAwayFromY: 0,
    honkedAtMs: -9999,
  };
  st.traffic.cars.push(car);
  return car;
}

/**
 * Is there anything in this car's way, and how far ahead?
 *
 * Looks along the lane for the two recovery vehicles, the crew, the winch line — and, since
 * Milestone 8, the car in front. The cable is the interesting one: a rope across a carriageway is
 * invisible at speed and it is exactly the thing a real operator is terrified of, so a car that
 * hits one takes the cable with it.
 *
 * Everything ahead is measured the same way and returned as one answer, because there is one
 * braking curve downstream. What a candidate carries with it is the two facts that genuinely differ
 * between a parked wrecker and a moving car: how much room to leave short of it (`gapM`) and how
 * fast the thing itself is going (`thingMps`). Both default to what a stationary obstruction has
 * always meant, so nothing but the car in front reads any differently than it did.
 */
function lookAhead(st, car) {
  const T = CONFIG.traffic;
  const ahead = car.dir === EAST ? 1 : -1;
  let nearest = Infinity, what = null, kind = null, blockY = 0;
  let gapM = T.stopGapM, thingMps = 0;

  const consider = (x, y, label, k, gap = T.stopGapM, mps = 0) => {
    const dx = (x - car.body.x) * ahead;
    if (dx <= 0 || dx > T.sightM) return;
    if (Math.abs(y - car.body.y) > T.laneHalfW) return;
    if (dx < nearest) {
      nearest = dx; what = label; kind = k; blockY = y; gapM = gap; thingMps = mps;
    }
  };

  for (const id of Object.keys(st.vehicles)) {
    const v = st.vehicles[id];
    for (const c of v.body.corners()) consider(c.x, c.y, id, 'vehicle');
  }
  for (const p of st.crew) consider(p.x, p.y, 'crew', 'crew');
  for (const it of st.gear) if (it.placed && it.kind === 'cone') consider(it.x, it.y, 'cone', 'cone');

  /* The cable, sampled along its span. A line across the road is not a point, and testing only its
   * endpoints would let a car drive straight through the middle of it. */
  for (const w of drumsOf(st)) {
    if (w.state !== 'attached') continue;
    /* BOTH ENDS ASKED FOR, not guessed at. This sampled `w.hook` for the far end and a hand-written
     * offset off the truck's tail for the near one, and both were wrong.
     *
     * `w.hook` is only WRITTEN while the hook is being carried, at the moment it is attached, and
     * when the cable parts — once it is on a vehicle the live end is `hookPos`, which every other
     * reader in this codebase already uses. MEASURED on the ordinary Milestone 1 recovery: the real
     * hook end walked 2.4, then 8.4, then 16.5 m away from the point this was sampling, crossed
     * onto the carriageway at about 25 s and stayed there for the last fifteen seconds of the pull
     * — while the frozen point sat down the bank, off the road, the whole time. So a line across a
     * live lane stopped being an obstruction to traffic the instant it was rigged, and this rule
     * quietly collapsed to "brake for the truck".
     *
     * The near end was wrong by 0.85 m and, on the heavy, ignored the boom entirely: `fairleadPos`
     * is boom-aware and a full slew moves a fairlead 2.35 m off the centreline. */
    const a = fairleadPos(st.vehicles.truck, w);
    const b = hookPos(w, st.vehicles);
    for (let t = 0; t <= 1.001; t += 0.1) {
      consider(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, 'cable', 'cable');
    }
  }

  /* ── the car in front (Milestone 8) ────────────────────────────────────────────────
   * SAME DIRECTION ONLY. A car on the other carriageway is closing on you, not blocking you, and
   * putting it on a stopping-distance curve stops the pair of them nose to nose in the middle of
   * the road and never lets either go — which is a deadlock, not a driver. The lateral window
   * `consider` already applies does the rest: a driver who has pulled out to go round the wrecker
   * stops seeing the queue they just left, which is exactly what overtaking is.
   *
   * Corners rather than centres, the same as the recovery vehicles, so a car shoved out of square
   * is seen where it actually sticks out. That puts the measurement bumper-to-bumper: MEASURED,
   * two stopped cars settle 9.2 m centre to centre, which is 4.8 m of clear tarmac between them.
   *
   * And the gap grows with speed because a real one does — `queueGapM` standing still, plus
   * `queueHeadwaySec` of your own travel on top. MEASURED, centre to centre: 9.2 m stopped, 16.4 at
   * 8 m/s, 20.0 at 12, 26.3 at 19 and 29.0 at road speed. */
  /* SIGNED, like `theirs` below. A magnitude here is the mistake this file has already made once
   * and documents at the top of stepTraffic: a car shoved backwards by a wrecker reads as
   * travelling forwards, and demands MORE headway while it retreats. Small in effect, and exactly
   * the shape of the bug that made traffic an immovable wall for a whole milestone. */
  const gap = T.queueGapM + T.queueHeadwaySec * Math.max(0, car.body.vx * car.dir);
  for (const o of st.traffic.cars) {
    if (o === car || o.dir !== car.dir) continue;
    /* Their speed along MY direction, floored at zero: a car being shoved backwards towards me is
     * not a speed I can safely match, it is a shorter stop. */
    const theirs = Math.max(0, o.body.vx * car.dir);
    for (const c of o.body.corners()) consider(c.x, c.y, o.id, 'traffic', gap, theirs);
  }

  return { distM: nearest, what, kind, blockY, gapM, thingMps };
}

/** Is the opposite carriageway clear enough ahead to pull out into? */
function oncomingClear(st, car) {
  const T = CONFIG.traffic;
  for (const o of st.traffic.cars) {
    if (o === car || o.dir === car.dir) continue;
    const gap = (o.body.x - car.body.x) * car.dir;
    if (gap > -T.lengthM && gap < T.overtakeClearM) return false;
  }
  return true;
}

/** How many cones are out, and where the work zone starts. Cones are the whole mechanic here. */
export function workZone(st) {
  const cones = st.gear.filter((g) => g.kind === 'cone' && g.placed);
  if (!cones.length) return { cones: 0, x0: 0, x1: 0 };
  let x0 = Infinity, x1 = -Infinity;
  for (const c of cones) { x0 = Math.min(x0, c.x); x1 = Math.max(x1, c.x); }
  return { cones: cones.length, x0, x1 };
}

/**
 * One step of traffic.
 *
 * Runs with the rest of the world, before the contact pass, so a car that has decided to brake has
 * already had its velocity changed by the time anything touches it.
 */
export function stepTraffic(st, dtSec, rng, bus, simTimeMs) {
  const T = CONFIG.traffic;
  const tr = st.traffic;
  if (!tr) return;

  /* Spawning. Interval scales with how many are already out, so a road never fills up, and it is
   * counted in SIMULATION ms — a wall clock here would break every determinism assertion in four
   * suites. */
  tr.nextInMs -= CONFIG.sim.stepMs;
  if (tr.nextInMs <= 0 && tr.cars.length < T.maxCars) {
    spawnCar(st, rng.chance(0.5) ? EAST : WEST, rng, simTimeMs);
    tr.nextInMs = T.gapMinMs + rng.range(0, T.gapRangeMs);
  }

  const zone = workZone(st);

  for (let i = tr.cars.length - 1; i >= 0; i--) {
    const car = tr.cars[i];
    const b = car.body;

    const seen = lookAhead(st, car);
    /* Sight is what the weather takes away, and it is the only place the light level touches a
     * decision. In fog a driver commits later, which is exactly what fog does. */
    const sight = T.sightM * (0.45 + 0.55 * lightOf(st.terrain));
    const blocked = seen.distM < sight;

    // A work zone is a request, not a wall: a driver slows through it whether or not they can see
    // anything in it yet. That is what the cones buy you.
    const inZone = zone.cones > 0 && b.x > zone.x0 - T.zoneLeadM && b.x < zone.x1 + T.zoneLeadM;
    const zoneMul = inZone ? Math.max(T.zoneSlowFloor, 1 - zone.cones * T.zoneSlowPerCone) : 1;

    let target = car.wantMps * zoneMul;
    if (blocked) {
      /* Stop short of it if there is room; otherwise this is going to be an incident.
       *
       * v² = u² + 2as — the same curve this has always been, now finishing at the speed of the
       * thing ahead instead of always at zero. `thingMps` is 0 for a wrecker, a cone, a crew member
       * and a cable, so every number four suites have measured is arithmetically unchanged.
       *
       * It has to be there for the car in front, though. Treated as a wall, a leader doing 22 m/s
       * would need its whole stopping distance on top of the gap — 22²/2a is 37 m — so nobody could
       * hold road speed within 64 m of anybody, and `sightM` is 46: a driver would brake from the
       * moment another car came into view and never get back up to speed. Finishing at the leader's
       * speed instead, MEASURED, a follower settles 29.0 m back and holds 22.0 m/s, which is what
       * following a car is. */
      const room = Math.max(0, seen.distM - seen.gapM);
      target = Math.min(target, Math.sqrt(seen.thingMps * seen.thingMps + 2 * T.brakeMps2 * room));
    }

    /* Edging past. A driver who has been sitting still for long enough works their way round
     * whatever it is at walking pace.
     *
     * Without it the road silts up permanently: a crew member standing on the pavement — which is
     * where they START — stops every car that arrives, the queue fills `maxCars`, and no traffic
     * ever appears again. MEASURED at zero cars past in two minutes. It is also just what happens:
     * nobody sits behind a recovery truck indefinitely, they creep round it. */
    if (Math.abs(b.vx) < 0.5) car.stuckMs += CONFIG.sim.stepMs;
    else car.stuckMs = 0;
    if (car.stuckMs > T.creepAfterMs && car.creepUntilX === null) {
      // LATCH it, over a fixed distance. Un-latching the moment the car starts moving made it
      // pulse: creep, exceed 0.5 m/s, reset the timer, brake for the obstruction, stop, wait 3.5 s
      // again. Measured at nothing getting past in two and a half minutes.
      car.creepUntilX = b.x + car.dir * T.creepPastM;
      car.creepAwayFromY = seen.blockY;
    }
    const creeping = car.creepUntilX !== null;
    if (creeping) {
      target = T.creepMps;
      if ((b.x - car.creepUntilX) * car.dir >= 0) { car.creepUntilX = null; car.stuckMs = 0; }
    }

    /* SIGNED along the direction of travel, and not a magnitude.
     *
     * A traffic car is driven along x by its driver and pushed along y by the contact solver, and
     * that split is deliberate (see the lane spring below). What it must not mean is that being
     * shoved along the ROAD axis is invisible. `Math.abs(b.vx)` read a car knocked 3 m/s backwards
     * as one doing 3 m/s forwards, and `Math.max(0, next)` then erased the shove outright — the
     * driver simply re-asserted their speed on the next step, so along x the car was a wall with a
     * number plate. MEASURED: a 6.8 t wrecker at full throttle, nose against a 1400 kg hatchback,
     * moved 0.24 m in two seconds and 0.70 m in four, then got free only when the car's own creep
     * logic took it round.
     *
     * Read signed, a driver can only claw a shove back at their own acceleration, so the truck
     * wins and then the car recovers — which is what the mass difference is for. */
    const speed = Math.abs(b.vx);
    const along = b.vx * car.dir;
    const accel = target > along ? T.accelMps2 : -T.brakeMps2;
    let next = along + accel * dtSec;
    if (accel > 0) next = Math.min(next, target); else next = Math.max(next, target);
    b.vx = car.dir * next;

    /* Round it, if there is room.
     *
     * A recovery truck parked in a lane is a permanent obstruction, and without this the road
     * simply silts up: MEASURED, three cars queued behind the Milestone 1 wrecker and after twenty
     * seconds not one had got past. Real drivers cross the centre line to go round a stopped
     * vehicle, and then come back. So: if the thing ahead is a VEHICLE (not a cone, which is a
     * request rather than a wall) and nothing is coming the other way, take the other lane. */
    const mine = laneY(st.terrain, car.dir);
    const other = laneY(st.terrain, -car.dir);
    /* ...and NOT for the car in front, which is the whole reason a tailback exists. A driver
     * crosses the centre line to get round a wrecker that is never going to move; a driver who
     * swings out to get past the car ahead of them is a driver in a different game. Let them, and
     * the queue behind an unclosed scene dissolves into an overtaking lane the instant it forms —
     * and the queue IS the hazard the closure protects you from. */
    const wantsRound = blocked && seen.kind && seen.kind !== 'cone' && seen.kind !== 'traffic'
      && seen.distM < T.overtakeM;
    if (wantsRound && oncomingClear(st, car)) car.onOtherSide = true;
    else if (!blocked && Math.abs(b.y - other) < 1.2) car.onOtherSide = false;
    /* Where to aim laterally. Creeping means squeezing past on whichever side of the obstruction
     * has more road, which is what edging round something actually looks like — and it keeps the
     * contact solver out of it, because a car that goes round does not need to be nudged through. */
    let targetY = car.onOtherSide ? other : mine;
    if (creeping) {
      const r = st.terrain.road;
      const north = car.creepAwayFromY - r.y0, south = r.y1 - car.creepAwayFromY;
      targetY = north > south ? r.y0 + 1.3 : r.y1 - 1.3;
    }

    /* Lane keeping, as a spring rather than as a hard reset.
     *
     * The lateral axis is left to the contact solver: a car that has just been shoved by a truck
     * SHOULD be off line for a moment. Zeroing vy every step made a hit look like a glitch — the
     * car snapped back into its lane on the next frame as if nothing had touched it. A spring back
     * to the lane centre with damping means it gets knocked about and recovers, which is what a
     * car does. */
    b.vy += (targetY - b.y) * T.laneSpring * dtSec;
    b.vy *= T.laneDamp;
    b.omega *= T.laneDamp;
    b.angle += b.omega * dtSec;
    car.braking = target < car.wantMps * zoneMul - 0.5;

    /* The horn means "somebody has seen you too late", so it stays about the scene. Following a car
     * at a steady 22 m/s satisfies "something ahead and not braking" every step of the way, and
     * left in, every driver on the road leant on the horn every three seconds at nothing. */
    if (blocked && seen.kind !== 'traffic' && !car.braking && simTimeMs - car.honkedAtMs > 3000) {
      car.honkedAtMs = simTimeMs;
      bus.emit(EVENTS.TRAFFIC_HORN, { car: car.id, what: seen.what, speed: Math.round(speed * 10) / 10 }, simTimeMs);
    }

    b.x += b.vx * dtSec;
    b.y += b.vy * dtSec;

    // Gone. Counted, because "how many went past while you had the road blocked" is a fact about
    // the job worth reporting.
    const out = car.dir === EAST ? b.x > st.terrain.world.widthM + 4 : b.x < -4;
    if (out) {
      tr.cars.splice(i, 1);
      tr.passed++;
      if (car.braking) tr.slowed++;
    }
  }
}

/** Traffic bodies, for the contact pass. They are as real as anything else in it. */
export const trafficBodies = (st) => (st.traffic ? st.traffic.cars : []);

export function describeTraffic(tr) {
  if (!tr) return null;
  return {
    onRoad: tr.cars.length,
    passed: tr.passed,
    slowed: tr.slowed,
    hits: tr.hits,
    braking: tr.cars.filter((c) => c.braking).length,
  };
}
