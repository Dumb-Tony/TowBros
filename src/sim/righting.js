/* Rolling a vehicle over, and rolling it back.
 *
 * A rollover has been a one-way door since Milestone 1: stepVehicle set `rolled` and nothing
 * anywhere cleared it, so Milestone 7's casualty that ARRIVES on its roof was a grip multiplier
 * standing in for a whole recovery operation. GDD §7 Milestone 9 asks for the other direction —
 * "enough sideways impulse about its long axis and it comes over. Symmetrically, because that is
 * what rolling is — keep pulling and it goes straight over onto its roof again."
 *
 * This module owns the whole question. It is the ONLY writer of `veh.rolled` outside the two
 * places that author a vehicle already on its roof (world/scene.js `arrivesRolled`) or put a
 * machine on its side for a different reason entirely (recovery/rig.js, a boom past its chart) —
 * and both of those should call setRolled() rather than write the three fields themselves. Two
 * answers in the tree to "has this gone over" is how the drag penalty went missing for six
 * milestones; see resetAids in recovery/gear.js.
 *
 * ── WHY IT IS JUDGED IN NEWTON-SECONDS ────────────────────────────────────────────────
 * Because a force threshold flips a car on a one-step spike. That lesson has been paid for four
 * times in this project — the guardrail (sim/collision.js), the wheel lift's `dropNs`, the ground
 * anchors' `pullNs`, the boom's `tipNms` — and each one is commented where it was learned. A
 * winch pull is briefly worth several g at the tow eye and a snatch load is a spike by definition.
 * So: accumulate the side load as impulse, bleed it off when the pull stops, and crossing the
 * threshold is the event.
 *
 * ── AND WHY IT IS SIGNED ──────────────────────────────────────────────────────────────
 * Because rolling has a direction and a magnitude does not. Accumulating |lat| would mean a car
 * pulled hard left and then hard right had been "rolled twice as much" as one pulled left, when
 * in fact it has been rocked and is exactly where it started. This codebase has made the
 * forget-the-sign mistake twice and written down what each cost: `sepRate` in recovery/lift.js,
 * where a negated damping rate rang a rigid hinge between 0 and the 120 kN solver cap; and
 * `Math.abs(b.vx)` in world/traffic.js, where a car knocked backwards read as one driving
 * forwards and a 6.8 t wrecker could move it 0.24 m in two seconds. Signed, the same trace that
 * rotates a car cancels itself, and only a pull held in ONE direction adds up.
 *
 * ── WHERE IT READS THE LOAD, WHICH IS THE DESIGN DECISION ─────────────────────────────
 * stepRighting is called from game.js AFTER the contact pass and BEFORE stepVehicle, so the force
 * accumulator holds the external load — the line, the lift — and nothing from the ground yet.
 *
 * That is deliberate and it is not a detail. The net force AFTER the tire model is the wrong
 * number to roll a car with: a vehicle held perfectly by static friction reads a net side load of
 * zero, and being held is exactly the condition under which a side pull rolls it rather than
 * dragging it. MEASURED, at the old call site (net force, one line before b.integrate): a
 * deliberate broadside pull on a sedan accumulated 70 N·s of 9 000 over twenty seconds, because
 * the tyres ate it — the mechanic was unreachable. Read before the ground, the same pull is worth
 * what the line is actually putting across the car.
 *
 * Gravity is deliberately NOT in that reading either. A car parked across a slope has a lateral
 * component of its own weight, and it would accumulate for as long as it sat there. The threshold
 * this is judged against is a multiple of g in the first place; weight is what the restoring
 * moment is MADE of, not something trying to roll it.
 */

import { CONFIG } from '../config.js';
import { EVENTS } from '../core/eventBus.js';
import { SEDAN_DEF } from '../data/vehicles.js';

/* The two event names, read off `EVENTS` with a same-named string fallback — the seam
 * world/police.js uses, for the same reason. Every event in core/eventBus.js is named identically
 * to its own value, so `EVENTS.RIGHTED || 'RIGHTED'` is exactly `EVENTS.RIGHTED` once the bus
 * carries the key and a real string instead of `undefined` before it does. This module is built
 * and measured before RIGHTED exists anywhere but here. */
const ROLLED_OVER = EVENTS.ROLLED_OVER || 'ROLLED_OVER';
const RIGHTED = EVENTS.RIGHTED || 'RIGHTED';

/* ── BOTH NUMBERS SCALE WITH THE VEHICLE, AND THEY HAVE TO ────────────────────────────
 * `rightNs` is what it takes to roll A SEDAN — 1400 kg, which is the car every number in the
 * force budget at the top of config.js is quoted against. Rolling is lifting a centre of mass
 * over the outside wheels, so the impulse it takes scales with the mass doing the lifting; a flat
 * threshold would mean a 230 kg motorcycle and a 7.2 t box truck went over on the same pull.
 *
 * MEASURED, and this is why it is here rather than a note in the report: flat, the ordinary
 * Milestone 1 recovery ROLLED THE WRECKER. The cable leaves the drum 3.05 m behind the truck's
 * centre and pulls sideways on it for the whole 38 seconds, held by 63 kN of grip and a parking
 * brake — 8 996 N·s of side load against a 9 000 N·s threshold, so the truck went over on the
 * one manoeuvre this game has always supported. Scaled, a 6.8 t wrecker asks 43.7 kN·s and the
 * same recovery puts 9.0 into it.
 *
 * The reference is SEDAN_DEF's own mass rather than a literal 1400, so the two cannot drift.
 * A def may still override either number outright, the way `rollThresholdG` already may.
 */
const REFERENCE_KG = SEDAN_DEF.massKg;
const scaleOf = (veh) => veh.body.massKg / REFERENCE_KG;
const thresholdNsFor = (veh, V) => (veh.def.rightNs !== undefined
  ? veh.def.rightNs : V.rightNs * scaleOf(veh));
const decayNFor = (veh, V) => (veh.def.rightDecayNsPerSec !== undefined
  ? veh.def.rightDecayNsPerSec : V.rightDecayNsPerSec * scaleOf(veh));

/**
 * The one writer of the three fields that ARE a rollover.
 *
 * `dragMul` mirrors the rule resetAids() in recovery/gear.js applies every step — back to what the
 * OBJECT is worth, not to 1 — because gear.js is going to overwrite it next step anyway and the
 * two must agree within the step as well. `gripMul` has no reset anywhere, which is precisely why
 * it has to be written here: leave it and a righted car keeps 0.55x grip forever, having visibly
 * come back onto its wheels. (That asymmetry is not hypothetical — it is the reason `gripMul`
 * survived the resetAids bug that wiped `dragMul` for six milestones.)
 */
export function setRolled(veh, rolled, V = CONFIG.vehicle) {
  veh.rolled = !!rolled;
  veh.gripMul = veh.rolled ? V.rolledGripMul : 1;
  veh.dragMul = veh.rolled ? V.rolledDragMul : 1;
  return veh.rolled;
}

/** Side load about the vehicle's own long axis, in newtons. Positive is toward its right flank. */
export function sideLoadN(veh) {
  const b = veh.body;
  const r = b.right;
  return b.fx * r.x + b.fy * r.y;
}

/**
 * The accumulated sideways impulse about the long axis, and which way it is going over.
 *
 * @returns {{ns:number, sign:number, frac:number, thresholdNs:number}}
 *   `ns` is SIGNED — positive is over toward the vehicle's right flank — and `sign` is read off
 *   it in the same breath rather than stored beside it, because two records of one fact
 *   eventually disagree (crew/authority.js, and the note at the top of config.js).
 */
export function rollImpulseNs(veh, V = CONFIG.vehicle) {
  const ns = veh.rollNs || 0;
  const thresholdNs = thresholdNsFor(veh, V);
  return {
    ns,
    sign: ns > 0 ? 1 : (ns < 0 ? -1 : 0),
    frac: thresholdNs > 0 ? Math.min(1, Math.abs(ns) / thresholdNs) : 0,
    thresholdNs,
  };
}

/**
 * One vehicle, one step: accumulate, decay, and flip it if it has gone over.
 *
 * Call from game.js between the contact pass and stepVehicle — see the module note on why the
 * reading has to happen before the ground answers it.
 *
 * ── THE RULE, AND WHY THE DECAY RATE IS ALSO THE FLOOR ────────────────────────────────
 * The signed side load is added as impulse every step and the total is bled toward zero at
 * `rightDecayNsPerSec`. Those are not two rules: a load of L newtons held in one direction nets
 * (L - rightDecayNsPerSec) newton-seconds per second, so `rightDecayNsPerSec` newtons is exactly
 * the side load below which nothing ever adds up, and above it the time to go over is
 * rightNs / (L - rightDecayNsPerSec). One number, doing the job an accumulate-past-a-floor pair
 * would need two for, and it is the shape sim/collision.js already describes for the guardrail:
 * "a steady push of p N·s per step settles at p/(1-decay)".
 *
 * MEASURED, at 5 200 N·s/s against a 9 000 N·s threshold, on a 1400 kg sedan:
 *
 *   a held side load of  5.2 kN   never goes over, however long it is held
 *                        6.0 kN   over in 11.3 s
 *                        9.0 kN   over in  2.4 s
 *                       14.0 kN   over in  1.0 s
 *                       26.0 kN   over in  0.4 s
 *
 * ...and on the four pulls this game already had, none of which may roll anything:
 *
 *   m1 Hc snatch-block side pull, 5.1 kN peak        0 N·s   turns it 26 deg over 14 s
 *   the ordinary straight recovery, 8.5 kN peak  2 087 N·s   23% of the way, over 38 s
 *   the same recovery, the WRECKER, 12.4 kN peak     0 N·s   of a 43 714 N·s threshold
 *   m7 straight pull on a car on its roof          536 N·s   6%, and it stays on its roof
 *
 * The first line is the one the numbers were chosen against: Milestone 1 offers a side pull
 * through a snatch block as one of its supported approaches, and that pull must still turn a car
 * without putting it on its roof. The decay is what buys that margin, and it is the number with
 * no slack in it — at 3 900 N·s/s the ordinary recovery rolls the car it is recovering at 7.0 s
 * and the Milestone 7 pull rights a car on its roof by accident. `rightNs` has room either way:
 * 5 000, 7 000 and 9 000 all leave the ordinary recovery safe and all right a car on the same
 * pull within a third of a second of each other.
 */
export function stepRighting(veh, dtSec, bus = null, simTimeMs = 0, V = CONFIG.vehicle) {
  /* Lazily, rather than in createVehicle — the same seam the ground anchors use for `pullNs`, and
   * for the same reason: this module is measured before sim/vehicle.js knows it exists. */
  if (veh.rollNs === undefined) veh.rollNs = 0;
  if (veh.rollSettleMs === undefined) veh.rollSettleMs = 0;

  /* Off the ground on a boom (Milestone 8): nothing to roll about. stepVehicle takes the same
   * early exit for the same reason — everything below it is a conversation with the ground, and a
   * suspended load is not having one. The accumulator is left where it is rather than cleared, so
   * a pull that was half way there when the load came up is still half way there when it is set
   * down; that is what the player would predict, and it is what stepAirborne does with the bogged
   * counter for the same reason. */
  if (veh.suspended) return rollImpulseNs(veh, V);

  const thresholdNs = thresholdNsFor(veh, V);
  const bleed = decayNFor(veh, V) * dtSec;

  veh.rollNs += sideLoadN(veh) * dtSec;
  if (veh.rollNs > bleed) veh.rollNs -= bleed;
  else if (veh.rollNs < -bleed) veh.rollNs += bleed;
  else veh.rollNs = 0;

  /* IT HAS TO LAND BEFORE IT CAN GO OVER AGAIN. `rollSustainMs` is already this project's answer
   * to "a rollover is a rotation, not an instant" — it is why the trip below needs 220 ms of
   * lateral load rather than one step of it — so the same number bounds how fast one vehicle can
   * roll. MEASURED without it: two drums of a rotator across a sedan on tarmac, 45 kN of line
   * tension, flipped it 45 times in 20 seconds — every one of them a real event, a job-log line
   * and an audio cue. With it, 27, one every 0.8 s; and a deliberately absurd 200 kN cannot beat
   * 283 ms. The single flip that answers Milestone 9 is untouched, because nothing settles
   * between a first rollover and a second one that is 30 seconds away. */
  if (veh.rollSettleMs > 0) {
    veh.rollSettleMs = Math.max(0, veh.rollSettleMs - dtSec * 1000);
    veh.rollNs = 0;
    return rollImpulseNs(veh, V);
  }

  let went = false;
  if (thresholdNs > 0 && Math.abs(veh.rollNs) >= thresholdNs) {
    const impulseNs = Math.round(veh.rollNs);
    /* Reset, so going over again costs another whole threshold in the same direction. That is
     * what makes over-rolling a decision rather than an accident: a crew that keeps hauling after
     * the car has come onto its wheels has to put the same 9 000 N·s in a second time. Same
     * pattern as the anchors' `pullNs = 0` and the lift's `overNs = 0` on the step they fire. */
    veh.rollNs = 0;
    veh.rollLoadMs = 0;
    veh.rollSettleMs = veh.def.rollSustainMs || V.rollSustainMs;
    const cameOffItsRoof = veh.rolled;
    setRolled(veh, !cameOffItsRoof, V);
    went = true;
    if (bus) {
      bus.emit(cameOffItsRoof ? RIGHTED : ROLLED_OVER,
               { vehicle: veh.id, impulseNs }, simTimeMs);
    }
  }

  /* ── THE OTHER WAY OVER, MOVED HERE FROM stepVehicle ──────────────────────────────
   * A vehicle thrown sideways at speed trips over its outside wheels. This is that check, exactly
   * as sim/vehicle.js has carried it since Milestone 1 and with its threshold untouched — it is
   * here so that `veh.rolled` has one writer, not because it needed changing.
   *
   * It has to be SUSTAINED. Checking the instant value flipped cars on a single-step force spike:
   * a hard winch pull is briefly worth 3 g at the tow eye, and the sedan would arrive on the road
   * upside down for no reason a player could see. Caught in the m1 Ha trace, where ROLLED_OVER
   * fired during an ordinary recovery.
   *
   * The lateral g is read off `axPrev`/`ayPrev` — last step's net acceleration, which is the same
   * quantity the old call site computed as (net force / mass), one step later. It has to be,
   * because at THIS call site the ground has not been asked yet and a swerving vehicle's lateral
   * force is entirely its own tyres. 16.7 ms of lag against a 220 ms sustain.
   *
   * And it is deliberately ONE WAY. A trip is how a vehicle ends up on its roof, never how it
   * comes off one: a car being dragged on its roof at speed would otherwise right itself for free,
   * with nobody having decided anything. Coming back is the impulse path's job, above. */
  if (!veh.rolled && !went) {
    const b = veh.body;
    const r = b.right;
    const latG = Math.abs(b.axPrev * r.x + b.ayPrev * r.y) / CONFIG.sim.gravity;
    if (latG > (veh.def.rollThresholdG || V.rollThresholdG) && b.speed > 1.0) {
      veh.rollLoadMs = (veh.rollLoadMs || 0) + dtSec * 1000;
    } else {
      veh.rollLoadMs = 0;
    }
    if ((veh.rollLoadMs || 0) >= (veh.def.rollSustainMs || V.rollSustainMs)) {
      veh.rollLoadMs = 0;
      veh.rollNs = 0;
      setRolled(veh, true, V);
      if (bus) {
        bus.emit(ROLLED_OVER, { vehicle: veh.id, lateralG: Math.round(latG * 100) / 100 }, simTimeMs);
      }
    }
  }

  return rollImpulseNs(veh, V);
}

/** For the HUD, the inspect card and the tests. Facts, never advice — GDD §5. */
export function describeRighting(veh, V = CONFIG.vehicle) {
  const { ns, sign, frac, thresholdNs } = rollImpulseNs(veh, V);
  const kNs = (n) => (Math.abs(n) / 1000).toFixed(1);
  const lying = veh.rolled ? 'On its roof' : 'On its wheels';
  /* "Rated 22 kN, carrying 31" is the anchors' whole story and the player does the subtraction.
   * Same here: which way up it is, how much side load has built up, and which way it is going.
   * Never "keep pulling" and never "you are about to roll it". */
  const line = frac <= 0
    ? `${lying}. No side load on it.`
    : `${lying}. ${kNs(ns)} of ${kNs(thresholdNs)} kN·s across it, going over to its `
      + `${sign > 0 ? 'right' : 'left'}.`;
  return {
    rolled: veh.rolled,
    impulseNs: Math.round(ns),
    sign,
    frac: Math.round(frac * 100) / 100,
    thresholdNs,
    sideLoadN: Math.round(sideLoadN(veh)),
    line,
  };
}
