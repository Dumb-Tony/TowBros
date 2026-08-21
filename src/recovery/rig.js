/* The heavy wrecker's own machinery: outriggers and a slewing boom. GDD §7 Milestone 6,
 * "heavy wreckers/rotators, multiple winches and outriggers".
 *
 * ── OUTRIGGERS ARE ONE DECISION, NOT AN UPGRADE ──────────────────────────────────────
 * Legs down and the truck stands on four pads instead of four tyres: it stops sliding, it stops
 * being swung round by an off-centre pull, and the grip budget that has decided every argument
 * since Milestone 1 stops applying to it. Legs down and it cannot move a centimetre.
 *
 * That is the whole feature. It is not "more force" — the drums are what they are — it is the
 * ability to USE the force you already had, bought by giving up the ability to reposition. A light
 * wrecker that is losing an argument can back up and try a better angle; a heavy one on its legs
 * has committed.
 *
 * ── AND THE BOOM IS THE OTHER HALF OF IT ─────────────────────────────────────────────
 * Committing is only interesting if you can still change something, and on a rotator what you can
 * change is where the line leaves the machine. Slewing the boom moves both fairleads through an
 * arc, so the pull direction — and the torque it puts on the truck — stops being a fact about
 * where you parked and becomes something you steer.
 *
 * Nothing here is a mode. `fairleadPos` reads `truck.boomRad` and the tire model reads the
 * outriggers' resistance; both are just numbers on the truck.
 */

import { CONFIG } from '../config.js';
import { EVENTS } from '../core/eventBus.js';
import { clamp } from '../core/vec.js';
import { WINCH, drumsOf, fairleadPos, hookPos } from './cable.js';
import { setRolled } from '../sim/righting.js';

export const hasOutriggers = (veh) => !!(veh && veh.outriggers);
export const hasBoom = (veh) => !!(veh && veh.def.boom);

/** Legs on the ground, 0..1. Anything less than fully down carries a fraction of the hold. */
export const outriggerFrac = (veh) => (veh && veh.outriggers ? veh.outriggers.frac : 0);

/** Where each pad is, in the world. The renderer draws these and nothing else needs them. */
export function outriggerPads(veh) {
  if (!veh || !veh.def.outriggers) return [];
  return veh.def.outriggers.map((o) => ({
    id: o.id,
    ...veh.body.toWorld(o.local.x, o.local.y),
    /* Extended, the pad sits further out than the mount — which is the point of an outrigger and
     * also why a heavy wrecker needs a lane and a half to set up in. */
    outY: o.local.y * (1 + 0.55 * outriggerFrac(veh)),
  }));
}

/** Ask for the legs to come down, or to come up. Returns what it is now doing. */
export function toggleOutriggers(veh, bus, simTimeMs) {
  if (!hasOutriggers(veh)) return null;
  const o = veh.outriggers;
  o.down = !o.down;
  bus.emit(EVENTS.OUTRIGGERS, { vehicle: veh.id, down: o.down }, simTimeMs);
  return o.down;
}

/**
 * Run the legs and the boom for one step.
 *
 * Called before the tire model, because what the tires are asked to hold against depends on
 * whether the truck is standing on its legs.
 */
export function stepRig(veh, dtSec, bus, simTimeMs) {
  if (!veh) return;
  const H = CONFIG.heavy;

  if (veh.outriggers) {
    const o = veh.outriggers;
    const rate = 1000 / H.outriggerDeployMs;
    o.frac = clamp(o.frac + (o.down ? 1 : -1) * rate * dtSec, 0, 1);
    /* Legs down means legs down: no drive at all, not "less drive". A truck that could creep on
     * its outriggers would tear them off, and more to the point it would let the player have the
     * whole decision for free. */
    if (o.frac > 0.02) {
      veh.throttle = 0;
      veh.brakeInput = 0;
      veh.parkBrake = true;
    }
    /* What the legs are worth, handed to the tire model as static resistance the same way a chock
     * is. It is a resistance and not an immovable flag, so a big enough load still wins — the
     * machine is anchored, not welded to the county. */
    veh.outriggerHoldN = H.outriggerHoldN * o.frac;
    veh.outriggerSpinN = H.outriggerSpinResistN * o.frac;
  }

  if (veh.def.boom) {
    /* The slew comes off the TRUCK, written there by stepCrew from every seat that is asking for
     * it. It used to be read here from one input object — `inputs.find(Boolean)`, which is
     * deterministically seat 0 — so on the one machine whose whole point is that two people work
     * it, only one of them could ever move the fairleads. Every other machine control in this game
     * is collected per seat and resolved once; this is now too. */
    const slew = veh.slewInput || 0;
    if (slew !== 0) {
      veh.boomRad = clamp(veh.boomRad + slew * H.boomSlewRateRad * dtSec,
                          -H.boomSlewMaxRad, H.boomSlewMaxRad);
    }
  }
}

/* ── THE LOAD CHART ────────────────────────────────────────────────────────────────────
 * GDD §7 Milestone 8: "the boom gets reach as well as slew, and a capacity that falls away with
 * both".
 *
 * A crane's capacity is not a number, it is a surface, and the surface is not a table of authored
 * values either — it falls out of one piece of school mechanics. A machine tips about the edge of
 * whatever it is standing on. The machine's own weight acting through the distance from its centre
 * to that edge is the righting moment; the load acting through the distance from the edge OUT to
 * where it hangs is the overturning moment. Equal them and rearrange:
 *
 *     capacity = machineWeight x lever / (distance - lever)
 *
 * `lever` is the whole design. On its outriggers a 15 t wrecker stands on a rectangle roughly
 * 5.2 m long and 3.8 m wide; on its tyres it stands on its own wheelbase and track, which is far
 * less in both directions and dramatically less across. So the lever depends on WHICH WAY THE LOAD
 * IS, and the classic approximation for the boundary of that rectangle is the ellipse through its
 * four half-extents. That is `tipLeverM` below.
 *
 * Everything here is measured off the bodies every step. There is no "lift mode", no authored
 * chart, and no flag: the load's distance from the machine IS the reach, so reeling it in gains
 * capacity and paying it out spends it. The player operates the chart with the controls the machine
 * already had, and never learns a new key.
 *
 * ── TWO THINGS THE MEASUREMENT CHANGED, WHICH ARE WORTH KNOWING BEFORE YOU EDIT THIS ──
 * First: slew barely matters here, and it was expected to matter most. `boomPivotX` puts the slew
 * centre 2.3 m behind the machine's own centre, so swinging the head to full lock brings it from
 * 4.60 m out to 3.98 — the lever shrinks and the radius shrinks with it, almost exactly in step.
 * Measured at the head with the legs UP: 46.2 kN straight back against 47.3 kN at full lock. What decides a pick
 * here is the legs and how far out the load is hanging. See CONFIG.heavy for the whole table.
 *
 * Second: you cannot lift something too heavy. The chart REFUSES the pick and the line just goes
 * tight, which is what the machine does and is also the difference between a mechanic and a
 * trapdoor. The first draft lifted anything reeled to the head and tipped the machine for it,
 * which turned "winch a box truck in on your outriggers" — a thing two milestones of tests do on
 * purpose — into an instant rollover. So a tip is never "you picked up too much". It is the chart
 * CHANGING under a load already in the air, and the fastest way to do that is to raise the legs.
 */

const G = () => CONFIG.sim.gravity;

/** Where the boom head is. The same point the line leaves the machine from — see cable.js. */
export function boomHeadPos(truck, winch = null) {
  return fairleadPos(truck, winch);
}

/**
 * The lever to the tipping edge, for a load lying at `angleFromRear` off straight-back.
 *
 * The ellipse through the footprint's four half-extents: at 0 it is the rear half-length, at a
 * right angle it is the half-track, and in between it is neither the larger of the two (which
 * would let a machine pick up sideways what it can only pick up over the tail) nor their average.
 */
export function tipLeverM(truck, angleFromRear) {
  const H = CONFIG.heavy;
  const legs = outriggerFrac(truck);
  // Part way down is part way to the wider footprint. The legs take 2.6 s to deploy and a player
  // who starts lifting at 1.3 s should get half the benefit rather than all or none of it.
  const rear = H.tipLeverTyresRearM + (H.tipLeverLegsRearM - H.tipLeverTyresRearM) * legs;
  const side = H.tipLeverTyresSideM + (H.tipLeverLegsSideM - H.tipLeverTyresSideM) * legs;
  const c = Math.cos(angleFromRear) / rear;
  const s = Math.sin(angleFromRear) / side;
  return 1 / Math.sqrt(c * c + s * s);
}

/**
 * Where a point is relative to the machine, in the terms the chart is written in: how far out it
 * is, and how far round from straight-back it lies.
 *
 * Straight back is the truck's own −x. The angle is folded to 0..π/2 because a machine is
 * symmetrical about its spine and tips the same way to either side.
 */
export function loadGeometry(truck, x, y) {
  const l = truck.body.toLocal(x, y);
  const distM = Math.hypot(l.x, l.y);
  const angle = distM < 1e-6 ? 0 : Math.abs(Math.atan2(Math.abs(l.y), -l.x));
  return { distM, angle: Math.min(angle, Math.PI / 2), local: l };
}

/**
 * What the machine can hold at that point, and what it is being asked for.
 *
 * `reachM` is the distance PAST the tipping edge; a load inside the footprint has no overturning
 * moment at all and the answer is the structural ceiling. Both numbers are returned because the
 * HUD shows the pair — a capacity on its own is a rating, and a rating next to a demand is a
 * decision.
 */
export function boomChart(truck, x, y) {
  const H = CONFIG.heavy;
  const g = loadGeometry(truck, x, y);
  const leverM = tipLeverM(truck, g.angle);
  const reachM = Math.max(0, g.distM - leverM);
  const momentNm = truck.body.massKg * G() * leverM;
  const capacityN = reachM <= 0.01 ? H.boomMaxLoadN
    : Math.min(H.boomMaxLoadN, momentNm / reachM);
  return { capacityN, reachM, leverM, momentNm, distM: g.distM, slewFromRear: g.angle };
}

/** What is hanging on the boom, or null. Ownership on the object, never in a side table. */
export function suspendedLoad(st) {
  const id = st.vehicles.truck.hoist ? st.vehicles.truck.hoist.carryingId : null;
  return id ? st.vehicles[id] || null : null;
}

export function createHoist() {
  return {
    /** Vehicle id off the ground, or null. THE record of what is up. */
    carryingId: null,
    /** Which drum is holding it — a rotator has two and they are not interchangeable. */
    drumId: null,
    /** Accumulated overturning excess, in NEWTON-METRE-SECONDS. See CONFIG.heavy.tipNms. */
    overNms: 0,
    /** Live readouts, recomputed every step. */
    capacityN: 0, demandN: 0, reachM: 0, loadFrac: 0,
  };
}

/**
 * Pick things up, put them down, and decide whether the machine can stand it.
 *
 * Runs after the cable and before the ground, because whether a vehicle's tyres are on the ground
 * this step is exactly what it decides.
 *
 * ── WHY THERE IS NO HOIST BUTTON ──────────────────────────────────────────────────────
 * A load comes off the ground when it has been reeled in to within `hoistM` of the boom head, and
 * goes back down when it is paid out past it. That is what the machine actually does, it needs no
 * key that did not already exist, and it is discoverable by doing the obvious thing: keep winching
 * and the car comes up. It also makes the chart operable — line out IS reach — so the two controls
 * the rotator already had turn out to be the crane controls.
 */
export function stepHoist(st, dtSec, bus, simTimeMs) {
  const truck = st.vehicles.truck;
  if (!truck || !truck.def.boom) return;
  if (!truck.hoist) truck.hoist = createHoist();
  const H = CONFIG.heavy;
  const hoist = truck.hoist;

  let held = hoist.carryingId ? st.vehicles[hoist.carryingId] : null;
  if (held && !held.suspended) held = null;      // something else put it down

  /* A MACHINE THAT HAS GONE OVER DOES NOT PICK ANYTHING UP. Without this the tip is a loop rather
   * than an event: the load is set down, the very next step finds a short line and a casualty on
   * the ground and hoists it straight back, and the wrecker lies on its side flinging a box truck
   * into the air sixty times a second. Caught by the probe as `tipped=true stillUp=true` — the two
   * facts that cannot both be true. */
  if (truck.rolled) {
    if (held) lowerLoad(st, held, bus, simTimeMs, 'tipped');
    /* EVERY live readout, not three of them. `overNms` and `reachM` were left where the tip found
     * them, so `describeRig().tipFrac` read 1.00 and the reach read stale for the rest of the
     * attempt — a HUD line describing a load that is lying on the grass beside a machine on its
     * side. `warned` too, or the 35% warning is suppressed for the next pick. */
    hoist.capacityN = 0; hoist.demandN = 0; hoist.loadFrac = 0; hoist.reachM = 0;
    hoist.overNms = 0; hoist.warned = false;
    return;
  }

  /* Can anything come up? Only a line that is ATTACHED, on a boom drum, reeled to the head. The
   * casualty is checked against the head rather than against the truck: the whole point of a
   * slewing boom is that the pick-up point is not where the machine is. */
  if (!held) {
    for (const w of drumsOf(st)) {
      if (w.state !== WINCH.ATTACHED) continue;
      if (w.lineM > H.hoistM) continue;
      const veh = st.vehicles[w.targetId];
      if (!veh || veh === truck || veh.suspended) continue;
      const head = boomHeadPos(truck, w);
      const p = hookPos(w, st.vehicles);
      if (Math.hypot(p.x - head.x, p.y - head.y) > H.hoistM) continue;
      /* YOU CANNOT PICK UP WHAT THE CHART WILL NOT TAKE. The line goes tight, the machine sits
       * there, and nothing leaves the ground — which is what actually happens, and it is also the
       * difference between a mechanic and a trapdoor. The draft lifted anything reeled to the head
       * and then tipped the machine for it, which turned "winch a box truck in on your outriggers"
       * — a thing two milestones of tests do on purpose — into an instant rollover. Caught by the
       * m6 suite's AJ30, which asserts a machine on its legs stays where it was put and found it
       * 21.4 m away.
       *
       * So the tip is not "you lifted something too heavy". It is "the chart changed while you had
       * it up", and the fastest way to do that is to raise the legs with a load in the air. */
      /* Judged where the WEIGHT is, not where the hook is. The hook is on a bumper and the mass is
       * three metres behind it, so charting the hook flattered every long casualty: a box truck
       * hooked by its nose read 32 kN of reach and lifted, then the moment it was in the air the
       * chart was recomputed at its centre and it was 15 kN past the limit. A load's radius is to
       * its centre of mass — measure it in the same place both times or the gate is a lie. */
      const pick = boomChart(truck, veh.body.x, veh.body.y);
      const weightN = veh.body.massKg * G();
      if (weightN > pick.capacityN) {
        if (hoist.refusedId !== veh.id) {
          hoist.refusedId = veh.id;
          bus.emit(EVENTS.BOOM_OVERLOAD, {
            vehicle: truck.id, refused: veh.id, demandN: Math.round(weightN),
            capacityN: Math.round(pick.capacityN), reachM: Math.round(pick.reachM * 100) / 100,
          }, simTimeMs);
        }
        continue;
      }
      hoist.refusedId = null;
      veh.suspended = true;
      veh.parkBrake = false;
      hoist.carryingId = veh.id;
      hoist.drumId = w.drumId;
      hoist.overNms = 0;
      held = veh;
      bus.emit(EVENTS.LOAD_HOISTED, {
        vehicle: veh.id, label: veh.def.label, drum: w.drumId, weightN: Math.round(weightN),
        capacityN: Math.round(pick.capacityN), reachM: Math.round(pick.reachM * 100) / 100,
      }, simTimeMs);
      break;
    }
  }

  if (!held) {
    hoist.carryingId = null;
    hoist.capacityN = 0; hoist.demandN = 0; hoist.reachM = 0; hoist.loadFrac = 0;
    hoist.overNms = Math.max(0, hoist.overNms - H.tipDecayNmsPerSec * dtSec);
    // And the warning is armed again once the accumulator is back to nothing. It was only cleared
    // inside the load-held-and-under-the-chart branch, so setting a warned load down left the next
    // pick's 35% warning suppressed until a step happened to satisfy that branch.
    if (hoist.overNms <= 0) hoist.warned = false;
    return;
  }

  const w = drumsOf(st).find((d) => d.drumId === hoist.drumId);
  const stillRigged = w && w.state === WINCH.ATTACHED && w.targetId === held.id;
  const p = { x: held.body.x, y: held.body.y };
  const ch = boomChart(truck, p.x, p.y);
  const demandN = held.body.massKg * G();

  hoist.capacityN = ch.capacityN;
  hoist.demandN = demandN;
  hoist.reachM = ch.reachM;
  hoist.loadFrac = ch.capacityN > 0 ? demandN / ch.capacityN : 0;

  /* Down again: paid out past the hoist distance, or the line is no longer holding it at all —
   * a parted cable or a torn attachment drops what it was carrying, and that is the same fact
   * the wheel lift reports when a load comes off the yoke. */
  if (!stillRigged || w.lineM > H.hoistM * 1.35) {
    lowerLoad(st, held, bus, simTimeMs, stillRigged ? 'lowered' : 'lost');
    return;
  }

  /* WHAT IT COSTS TO ASK FOR MORE THAN THE CHART. Accumulated in newton-metre-seconds and decayed,
   * the same judgment every other threshold in this game makes: one step at 105% is a gust, and
   * several seconds of it is a machine going over. A force threshold here would put a 15 t wrecker
   * on its roof the first time a hanging load swung. */
  const excessNm = Math.max(0, (demandN - ch.capacityN)) * Math.max(ch.reachM, 0.1);
  if (excessNm > 0) {
    hoist.overNms += excessNm * dtSec;
    if (!hoist.warned && hoist.overNms > H.tipNms * 0.35) {
      hoist.warned = true;
      bus.emit(EVENTS.BOOM_OVERLOAD, {
        vehicle: truck.id, demandN: Math.round(demandN),
        capacityN: Math.round(ch.capacityN), reachM: Math.round(ch.reachM * 100) / 100,
      }, simTimeMs);
    }
  } else {
    hoist.overNms = Math.max(0, hoist.overNms - H.tipDecayNmsPerSec * dtSec);
    if (hoist.overNms <= 0) hoist.warned = false;
  }

  if (hoist.overNms >= H.tipNms) {
    /* Over it goes. The machine ends up in the state a rolled vehicle is already in — this is not
     * a new failure, it is the one sim/vehicle.js has had since Milestone 1, reached a second way.
     * The load comes down with it, because a machine on its side is not holding anything. */
    setRolled(truck, true);
    if (truck.outriggers) { truck.outriggers.down = false; }
    bus.emit(EVENTS.ROLLED_OVER, { vehicle: truck.id, cause: 'boom' }, simTimeMs);
    lowerLoad(st, held, bus, simTimeMs, 'tipped');
    return;
  }

  /* A hanging load swings, and a pendulum with nothing damping it swings for the rest of the job.
   * Applied as a force rather than by writing the velocity, so it goes through the accumulator
   * like everything else and the contact pass can still argue with it. */
  const b = held.body;
  const k = H.hangDamp * b.massKg;
  b.applyForce(-b.vx * k, -b.vy * k);
  b.applyTorque(-b.omega * k * 0.6);
}

/** Set a suspended load back on the ground. The one writer of `veh.suspended = false`. */
export function lowerLoad(st, veh, bus, simTimeMs, reason = 'lowered') {
  const truck = st.vehicles.truck;
  if (!veh || !veh.suspended) return false;
  veh.suspended = false;
  if (truck.hoist) {
    truck.hoist.carryingId = null;
    truck.hoist.drumId = null;
    truck.hoist.loadFrac = 0;
  }

  /* A CAR SET DOWN DELIBERATELY IS SET DOWN THE RIGHT WAY UP (Milestone 9).
   *
   * This is what the whole load chart was for. A rollover has been a one-way door since Milestone 1
   * — `rolled` was set and nothing anywhere cleared it — so a casualty on its roof was a grip
   * multiplier standing in for an operation. Picking it up and putting it back down IS that
   * operation, and it needs no new key, no new state and no animation: the chart already decides
   * whether this machine can lift this vehicle at this reach, so "can I right it with the boom"
   * is answered by a number that was already being computed every step.
   *
   * Which is also why the seven-tonner cannot be righted this way and a car can. The other answer
   * — rolling it with a side pull — is sim/righting.js, and it is the one that works when there is
   * no rotator on the job.
   *
   * Only on a DELIBERATE set-down. A load lost off the boom, or one that came down with a machine
   * that went over, lands however it lands: `reason` is the whole distinction, and a car that is
   * dropped must not quietly do the player a favour. */
  let righted = false;
  if (reason === 'lowered' && veh.rolled) {
    // ONE writer for the three fields that go together. They were set by hand in three places, and
    // that split is exactly how the drag penalty went missing for six milestones — see the note on
    // `resetAids` at the top of recovery/gear.js.
    setRolled(veh, false, CONFIG.vehicle, { settle: true });
    righted = true;
    bus.emit(EVENTS.RIGHTED, {
      vehicle: veh.id, label: veh.def.label, how: 'boom',
    }, simTimeMs);
  }

  bus.emit(EVENTS.LOAD_LOWERED, {
    vehicle: veh.id, label: veh.def.label, reason, righted,
    x: Math.round(veh.body.x * 10) / 10, y: Math.round(veh.body.y * 10) / 10,
  }, simTimeMs);
  return true;
}

/** For the HUD and the inspect card. Facts, no advice. */
export function describeRig(veh, st = null) {
  if (!veh) return null;
  const o = veh.outriggers;
  const h = veh.hoist;
  /* The chart, for wherever the load is or would be. With something up it is the live pair; with
   * nothing up it is what the machine could take at the head right now, which is the number worth
   * knowing BEFORE you pick anything up. */
  let chart = null;
  if (veh.def.boom && st) {
    const head = boomHeadPos(veh);
    const at = h && h.carryingId && st.vehicles[h.carryingId]
      ? st.vehicles[h.carryingId].body : head;
    const c = boomChart(veh, at.x, at.y);
    chart = {
      capacityN: Math.round(c.capacityN),
      reachM: Math.round(c.reachM * 100) / 100,
      leverM: Math.round(c.leverM * 100) / 100,
    };
  }
  return {
    outriggers: o ? (o.frac >= 1 ? 'down' : o.frac <= 0 ? 'up' : (o.down ? 'lowering' : 'raising')) : null,
    outriggerFrac: o ? Math.round(o.frac * 100) / 100 : 0,
    holdN: Math.round(veh.outriggerHoldN || 0),
    boomDeg: veh.def.boom ? Math.round((veh.boomRad || 0) * 180 / Math.PI) : null,
    chart,
    carrying: h ? h.carryingId : null,
    demandN: h ? Math.round(h.demandN) : 0,
    loadFrac: h ? Math.round(h.loadFrac * 100) / 100 : 0,
    tipFrac: h ? Math.round((h.overNms / CONFIG.heavy.tipNms) * 100) / 100 : 0,
  };
}
