/* The winch line: one damped spring, two ends, and no opinion about who should move.
 *
 * GDD pillar 2, in full, because this file is the pillar:
 *   "The winch does not know who should win. Cable forces affect every connected body.
 *    Position, traction, slope, mass, and rigging decide the result."
 *
 * So there is exactly one tension number per step, and it is applied EQUAL AND OPPOSITE at
 * two physical offsets: the fairlead on the back of the truck, and the attachment point on
 * the vehicle. Both get torque. Nothing anywhere checks which body is the "load".
 *
 * ── WHY A SPRING AND NOT A ROPE ───────────────────────────────────────────────────────
 * GDD §4: "Cables use a stable spring constraint with capped forces and visual sag; they
 * are not a high-segment rope simulation." A segmented rope at 60 Hz with a 7-tonne truck
 * on one end needs either a solver or a much smaller step, and the player cannot tell the
 * difference. What the player CAN tell is whether tension builds smoothly, whether a chain
 * transmits a shock harder than a strap, and whether the line goes slack when the load
 * jumps toward the truck. All three of those are properties of a spring with the right
 * stiffness and damping, which is what CONFIG.rigging supplies per rigging type.
 *
 * ── PATH ──────────────────────────────────────────────────────────────────────────────
 *   direct:            fairlead --------------------- hook
 *   through a block:   fairlead ------ block -------- hook
 * Length is the sum of the legs, and each end is pulled toward the block rather than toward
 * the other end. That single change is what makes a tree-mounted snatch block able to turn
 * a hopeless up-slope pull into a sideways one.
 */

import { CONFIG } from '../config.js';
import { clamp, clamp01, unit, norm } from '../core/vec.js';
import { EVENTS } from '../core/eventBus.js';

export const WINCH = Object.freeze({
  STOWED:   'stowed',    // hook on the drum
  HELD:     'held',      // the player is walking it out
  LOOSE:    'loose',     // lying on the ground where it was dropped or torn free
  ATTACHED: 'attached',  // rigged to a zone on a vehicle
});

export function createWinch() {
  return {
    state: WINCH.STOWED,
    lineM: CONFIG.winch.minLineM,   // paid out; this is the spring's rest length
    motor: 0,                       // -1 paying out, 0 stopped, +1 reeling in
    stalled: false,
    targetId: null,                 // vehicle id the hook is rigged to
    zoneId: null,
    rig: 'bare',                    // 'bare' | 'strap' | 'chain'
    blockId: null,                  // gear id of a mounted snatch block, or null
    hook: { x: 0, y: 0 },           // world position of the hook when not attached
    tensionN: 0,
    tensionPrevN: 0,
    tensionFrac: 0,                 // of cableBreakN — the number the HUD and audio read
    shockFrac: 0,                   // how fast tension is rising, 0..1
    broken: false,
    spooledOut: false,              // hit the end of the drum
    lastEffectiveN: 0,              // tension as the ATTACHMENT feels it, after shock
    _stallSaidMs: -9999,
  };
}

/** Where the cable leaves the truck. */
export function fairleadPos(truck) {
  const l = truck.def.winchLocal;
  return truck.body.toWorld(l.x, l.y);
}

/** Where the far end of the cable is right now, whatever state it is in. */
export function hookPos(winch, vehiclesById) {
  if (winch.state === WINCH.ATTACHED) {
    const v = vehiclesById[winch.targetId];
    if (v) {
      const z = v.def.zones.find((q) => q.id === winch.zoneId);
      if (z) return v.body.toWorld(z.local.x, z.local.y);
    }
  }
  return { x: winch.hook.x, y: winch.hook.y };
}

/**
 * The cable's route as a list of world points, fairlead first. The renderer draws exactly
 * this, so a line the player sees bending round a block is a line that bends round a block
 * in the physics too.
 */
export function cablePath(winch, truck, vehiclesById, blocksById) {
  const a = fairleadPos(truck);
  const h = hookPos(winch, vehiclesById);
  const b = winch.blockId ? blocksById[winch.blockId] : null;
  return b ? [a, { x: b.x, y: b.y }, h] : [a, h];
}

/** Total length along the route. */
export function pathLength(path) {
  let d = 0;
  for (let i = 1; i < path.length; i++) d += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  return d;
}

/**
 * One step of winch behaviour: motor, then tension, then forces, then failure.
 *
 * @param {object} st        game state
 * @param {number} dtSec
 * @param {object} bus
 * @param {number} simTimeMs
 * @returns {number} tension in newtons
 */
export function stepCable(st, dtSec, bus, simTimeMs) {
  const w = st.winch;
  const truck = st.vehicles.truck;
  const W = CONFIG.winch;

  const block = w.blockId ? st.blocksById[w.blockId] : null;
  const rigNow = CONFIG.rigging[w.rig] || CONFIG.rigging.bare;
  const path = cablePath(w, truck, st.vehicles, st.blocksById);
  const dist = pathLength(path);

  /* ── overload relief ──────────────────────────────────────────────────────
   * A stalled drum stops pulling, but the geometry does not stop moving: the load settles, or
   * rotates, or grinds into something, and the stretch keeps growing. Without relief that walks
   * the tension straight past the 34 kN stall and into the 42 kN break, so ANY slow jam ends with
   * a parted cable — measured against the truck's own flank and against an unyielding guardrail,
   * both at 41.9 kN.
   *
   * So the drum gives line back: exactly enough stretch to hold at the motor's limit, capped at
   * reliefMps. A real winch does this — hydraulics bypass, brakes creep, and an operator eases
   * off. The important part is what it does NOT protect against: the cap means a genuine snatch
   * load still outruns the relief and still parts the line. Slow jams stall; shocks break. */
  if (w.state === WINCH.ATTACHED && w.tensionN > CONFIG.winch.motorMaxN) {
    const over = w.tensionN - CONFIG.winch.motorMaxN;
    // The slip rate RISES with the overload, because that is what a brake band does. A flat rate
    // was enough to stop a slow jam destroying the line but not enough to survive TOWING on it:
    // driving away with a load attached built tension faster than 0.55 m/s of payout could shed,
    // so any tow above a crawl parted the cable. Scaling with overload lets a steady tow work at
    // ~1.6 m/s of slip near the limit, while a genuine snatch — a step change in velocity — still
    // outruns it and still breaks the line, which is the failure worth keeping.
    const rate = CONFIG.winch.reliefMps * (1 + (over / CONFIG.winch.motorMaxN) * CONFIG.winch.reliefGain);
    const give = Math.min(rate * dtSec, over / rigNow.springK);
    w.lineM = Math.min(CONFIG.winch.spoolLengthM, w.lineM + give);
    w.relieving = true;
  } else {
    w.relieving = false;
  }

  /* ── the drum ─────────────────────────────────────────────────────────── */
  if (w.state === WINCH.HELD) {
    // Free spool: the drum pays out to whoever is walking the hook away, and refuses to
    // give more than it has. Running out of cable is a real constraint on where a pull can
    // be rigged from, so it is a real constraint here.
    const want = dist + 0.15;
    if (want > w.lineM) w.lineM = Math.min(W.spoolLengthM, Math.max(w.lineM, Math.min(want, w.lineM + W.freeSpoolMps * dtSec)));
    w.spooledOut = w.lineM >= W.spoolLengthM - 1e-3 && want > w.lineM;
    if (w.spooledOut) bus.emit(EVENTS.WINCH_SPOOL_END, { lineM: Math.round(w.lineM * 10) / 10 }, simTimeMs);
  } else if (w.motor !== 0) {
    const blockMul = block ? CONFIG.gear.snatchBlock.reelMul : 1;
    if (w.motor > 0) {
      // Reel in. The motor eases off as the load approaches its limit and stops dead at it,
      // which is a stall — GDD §4 wants the winch to be a machine with a capability, not an
      // infinite force. A stalled winch is a message: change something.
      const overFrac = norm(w.tensionN, W.motorMaxN - W.stallMarginN, W.motorMaxN);
      const ease = 1 - overFrac;
      w.stalled = w.tensionN >= W.motorMaxN;
      const speed = W.reelInMps * ease * blockMul;
      if (w.stalled) {
        if (simTimeMs - w._stallSaidMs > 2200) {
          w._stallSaidMs = simTimeMs;
          bus.emit(EVENTS.WINCH_STALLED, { tensionN: Math.round(w.tensionN) }, simTimeMs);
        }
      } else if (speed > 0) {
        w.lineM = Math.max(W.minLineM, w.lineM - speed * dtSec);
      }
    } else {
      w.stalled = false;
      w.lineM = Math.min(W.spoolLengthM, w.lineM + W.reelOutMps * blockMul * dtSec);
      w.spooledOut = w.lineM >= W.spoolLengthM - 1e-3;
    }
  } else {
    w.stalled = false;
  }

  /* ── tension ──────────────────────────────────────────────────────────── */
  w.tensionPrevN = w.tensionN;
  if (w.state !== WINCH.ATTACHED) { w.tensionN = 0; w.tensionFrac = 0; w.shockFrac = 0; return 0; }

  const target = st.vehicles[w.targetId];
  const zone = target && target.def.zones.find((z) => z.id === w.zoneId);
  if (!target || !zone) { w.tensionN = 0; w.tensionFrac = 0; return 0; }

  const rig = CONFIG.rigging[w.rig] || CONFIG.rigging.bare;
  const stretch = dist - w.lineM;
  if (stretch <= 0) {
    w.tensionN = 0; w.tensionFrac = 0; w.shockFrac = 0;
    return 0;
  }

  const fl = fairleadPos(truck);
  const hp = hookPos(w, st.vehicles);

  // Rate of change of the ROUTE length, which is what a spring along that route responds to.
  // With a block the two legs are independent, so each end contributes its own leg's rate.
  const vT = truck.body.velocityAt(fl.x, fl.y);
  const vH = target.body.velocityAt(hp.x, hp.y);
  let uT, uH, rate;
  if (block) {
    uT = unit(block.x - fl.x, block.y - fl.y);        // truck is pulled toward the block
    uH = unit(block.x - hp.x, block.y - hp.y);        // so is the load
    rate = -(vT.x * uT.x + vT.y * uT.y) - (vH.x * uH.x + vH.y * uH.y);
  } else {
    uT = unit(hp.x - fl.x, hp.y - fl.y);
    uH = { x: -uT.x, y: -uT.y };
    rate = (vH.x - vT.x) * uT.x + (vH.y - vT.y) * uT.y;
  }

  // Damped spring. `damp` is a fraction of the critical damping for the reduced mass, so a
  // strap and a chain of very different stiffness both behave, and neither rings.
  const mEff = (truck.body.massKg * target.body.massKg) / (truck.body.massKg + target.body.massKg);
  const c = rig.damp * 2 * Math.sqrt(rig.springK * mEff);
  // Damping is capped at a fraction of the spring term. It is a stabiliser, not a force the
  // player is meant to fight: unclamped it can exceed the spring entirely on a velocity spike and
  // part a line that is barely stretched, which reads as the cable breaking for no visible reason.
  // Clamped, the line breaks because it is stretched too far — which is both true and legible.
  const springT = rig.springK * stretch;
  const dampT = clamp(c * rate, -springT * 0.6, springT * 0.6);
  let T = springT + dampT;
  if (T < 0) T = 0;
  if (T > W.maxForceN) T = W.maxForceN;

  const advantage = block ? CONFIG.gear.snatchBlock.forceMul : 1;
  const applied = T * advantage;

  w.tensionN = T;
  w.tensionFrac = clamp01(T / W.cableBreakN);
  // How violently the load is arriving. A chain multiplies this through to the attachment;
  // a strap absorbs it. See CONFIG.rigging.shockMul.
  const dT = (T - w.tensionPrevN) / dtSec;
  w.shockFrac = clamp01(dT / 400000);

  /* ── forces ───────────────────────────────────────────────────────────── */
  truck.body.applyForceAt(uT.x * applied, uT.y * applied, fl.x, fl.y,
                          CONFIG.debug.showForces ? 'cableTruck' : '');
  target.body.applyForceAt(uH.x * applied, uH.y * applied, hp.x, hp.y,
                           CONFIG.debug.showForces ? 'cableLoad' : '');

  // What the ATTACHMENT feels, which is not the same as what the cable feels. Shock is the
  // difference between a strap and a chain, so it is applied here and only here.
  w.lastEffectiveN = T * (1 + (rig.shockMul - 1) * w.shockFrac);
  return T;
}

/**
 * The cable's own limit, checked AFTER the attachment's.
 *
 * The order is the point. THE WEAKEST LINK HAS TO GO FIRST, or the GDD's attachment table is a
 * lie: "tow hook — usually outlasts starter cable" only means something if a bumper rated at
 * 9 kN is judged before a cable rated at 42 kN. Checking the cable inside stepCable (as this
 * did originally) meant a single-step load spike parted the line while the bumper it was
 * hooked to survived — caught by m1 F10, where an overloaded bumper reported no failure at all.
 *
 * By the time this runs, stepAttachment may already have torn the attachment off and dropped
 * the hook, in which case there is no longer a loaded cable to part.
 */
export function stepCableBreak(st, bus, simTimeMs) {
  const w = st.winch;
  if (w.state !== WINCH.ATTACHED) return false;
  if (w.tensionN <= CONFIG.winch.cableBreakN) return false;
  snapCable(st, w.tensionN, bus, simTimeMs);
  return true;
}

/**
 * The line parts. Both ends recoil, the hook lands on the ground, and the job continues —
 * GDD §4: "no instant fail for damage or a worsening scene."
 */
export function snapCable(st, tensionN, bus, simTimeMs) {
  const w = st.winch;
  const truck = st.vehicles.truck;
  const fl = fairleadPos(truck);
  const hp = hookPos(w, st.vehicles);
  const target = st.vehicles[w.targetId];

  const u = unit(hp.x - fl.x, hp.y - fl.y);
  const recoil = CONFIG.winch.breakRecoilMps;

  // Stored energy leaves as a kick, scaled by how far past the limit it went. Equal and
  // opposite, like everything else the cable does.
  const over = clamp(tensionN / CONFIG.winch.cableBreakN, 1, 1.6);
  truck.body.applyImpulseAt(-u.x * recoil * truck.body.massKg * 0.055 * over,
                           -u.y * recoil * truck.body.massKg * 0.055 * over, fl.x, fl.y);
  if (target) {
    target.body.applyImpulseAt(u.x * recoil * target.body.massKg * 0.055 * over,
                               u.y * recoil * target.body.massKg * 0.055 * over, hp.x, hp.y);
  }

  w.state = WINCH.LOOSE;
  // The hook lands roughly a third of the way back along the line — a parted cable does not
  // fall neatly at either end.
  w.hook.x = hp.x - u.x * (CONFIG.winch.minLineM + 2.2);
  w.hook.y = hp.y - u.y * (CONFIG.winch.minLineM + 2.2);
  w.broken = true;
  w.targetId = null;
  w.zoneId = null;
  w.rig = 'bare';
  w.tensionN = 0;
  w.tensionFrac = 0;
  w.motor = 0;
  w.lineM = Math.max(CONFIG.winch.minLineM, w.lineM * 0.6);

  bus.emit(EVENTS.CABLE_SNAPPED, { tensionN: Math.round(tensionN) }, simTimeMs);
}

/** Slack in the line, metres. Negative means it is stretched. Used for the visual sag. */
export function slackM(winch, truck, vehiclesById, blocksById) {
  const d = pathLength(cablePath(winch, truck, vehiclesById, blocksById));
  return winch.lineM - d;
}

/** How the winch should read in the HUD, without the HUD knowing any physics. */
export function describeWinch(winch) {
  const W = CONFIG.winch;
  const frac = winch.tensionFrac;
  return {
    state: winch.state,
    lineM: Math.round(winch.lineM * 10) / 10,
    remainingM: Math.round((W.spoolLengthM - winch.lineM) * 10) / 10,
    tensionN: Math.round(winch.tensionN),
    tensionFrac: Math.round(frac * 100) / 100,
    level: frac >= W.tensionDangerFrac ? 'danger' : frac >= W.tensionWarnFrac ? 'warn' : 'ok',
    stalled: winch.stalled,
    rig: winch.rig,
    throughBlock: !!winch.blockId,
    zoneId: winch.zoneId,
  };
}
