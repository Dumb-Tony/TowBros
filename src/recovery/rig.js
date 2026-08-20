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
export function stepRig(veh, dtSec, input, bus, simTimeMs) {
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
    const slew = input ? (input.slewAxis ? input.slewAxis() : 0) : 0;
    if (slew !== 0) {
      veh.boomRad = clamp(veh.boomRad + slew * H.boomSlewRateRad * dtSec,
                          -H.boomSlewMaxRad, H.boomSlewMaxRad);
    }
  }
}

/** For the HUD and the inspect card. Facts, no advice. */
export function describeRig(veh) {
  if (!veh) return null;
  const o = veh.outriggers;
  return {
    outriggers: o ? (o.frac >= 1 ? 'down' : o.frac <= 0 ? 'up' : (o.down ? 'lowering' : 'raising')) : null,
    outriggerFrac: o ? Math.round(o.frac * 100) / 100 : 0,
    holdN: Math.round(veh.outriggerHoldN || 0),
    boomDeg: veh.def.boom ? Math.round((veh.boomRad || 0) * 180 / Math.PI) : null,
  };
}
