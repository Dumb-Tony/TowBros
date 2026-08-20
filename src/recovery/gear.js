/* What the boring equipment actually does.
 *
 * GDD pillar 7: "Boring equipment becomes exciting. Chocks, wood blocks, jacks, straps,
 * chains, and pulleys should unlock surprising strategies." The way that is earned is by
 * every item having a small, honest, mechanical effect — and by NONE of them having a
 * scripted one. There is no "correct" placement check anywhere in this file. There is a
 * geometry test, and clever placements pass it.
 *
 * The effects are recomputed from scratch every step rather than applied once when an item
 * is placed. That costs a few dozen distance tests and buys something worth far more: gear
 * that stops working when it is knocked out of position, and a vehicle whose multipliers can
 * never drift out of sync with the objects lying around it.
 */

import { CONFIG } from '../config.js';
import { EVENTS } from '../core/eventBus.js';
import { GEAR, USE, gearDef } from '../data/equipment.js';
import { clamp, clamp01, lerp, unit } from '../core/vec.js';

/** Reset every gear-derived multiplier. Called first each step so nothing accumulates. */
function resetAids(st) {
  for (const id of Object.keys(st.vehicles)) {
    const v = st.vehicles[id];
    v.dragMul = 1;
    v.boggedMul = 1;
    v.spinResistN = 0;
    v.chockAids = [];
    for (const ws of v.wheelState) ws.lifted = false;
    v.aids = { cribbing: 0, jackLift: 0, chocks: 0 };
  }
  st.blocksById = {};
}

/** Nearest vehicle whose footprint (plus a margin) contains or is near a point. */
function vehicleNear(st, x, y, maxDist) {
  let best = null, bestD = Infinity;
  for (const id of Object.keys(st.vehicles)) {
    const v = st.vehicles[id];
    const b = v.body;
    // Distance to the box, not to the centre: cribbing tucked under a long truck should
    // count, and a block by the middle of a sedan is right against it.
    const l = b.toLocal(x, y);
    const dx = Math.max(0, Math.abs(l.x) - b.halfL);
    const dy = Math.max(0, Math.abs(l.y) - b.halfW);
    const d = Math.hypot(dx, dy);
    if (d < bestD && d <= maxDist) { bestD = d; best = v; }
  }
  return best ? { veh: best, dist: bestD } : null;
}

/** Nearest wheel of any vehicle to a point. Chocks care about wheels, not vehicles. */
function wheelNear(st, x, y, maxDist) {
  let best = null, bestD = Infinity;
  for (const id of Object.keys(st.vehicles)) {
    const v = st.vehicles[id];
    for (let i = 0; i < v.def.wheels.length; i++) {
      const w = v.def.wheels[i];
      const p = v.body.toWorld(w.local.x, w.local.y);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD && d <= maxDist) { bestD = d; best = { veh: v, index: i, x: p.x, y: p.y }; }
    }
  }
  return best ? { ...best, dist: bestD } : null;
}

/**
 * Recompute every equipment effect. Mutates vehicle multipliers and st.blocksById.
 */
export function stepGearEffects(st, terrain, dtSec, bus, simTimeMs) {
  resetAids(st);

  const cribCount = new Map();     // vehicle id -> blocks in position

  for (const item of st.gear) {
    if (item.carriedBy) continue;
    const def = gearDef(item.kind);
    if (!def) continue;

    switch (item.kind) {
      case 'cribbing': {
        const near = vehicleNear(st, item.x, item.y, CONFIG.gear.cribbing.reachM);
        if (!near) break;
        item.attachedTo = near.veh.id;
        cribCount.set(near.veh.id, (cribCount.get(near.veh.id) || 0) + 1);
        break;
      }

      case 'jack': {
        if (item.liftStep <= 0) break;
        const near = vehicleNear(st, item.x, item.y, CONFIG.gear.jack.reachM);
        if (!near) { item.liftStep = 0; break; }
        item.attachedTo = near.veh.id;
        const frac = clamp01(item.liftStep / CONFIG.gear.jack.liftSteps);
        const v = near.veh;
        v.dragMul *= lerp(1, CONFIG.gear.jack.liftDragMul, frac);
        v.boggedMul *= lerp(1, CONFIG.gear.jack.liftBoggedMul, frac);
        v.aids.jackLift = Math.max(v.aids.jackLift, frac);

        // Once it is more than half up, the nearest corner is genuinely off the ground.
        if (frac > 0.5) {
          const w = wheelNear(st, item.x, item.y, 2.0);
          if (w && w.veh === v) v.wheelState[w.index].lifted = true;
        }

        // A jack is a column. Sideways load knocks it out — GDD §4: "unstable under large
        // sideways loads". The consequence is the lesson; there is no warning label.
        const r = v.body.right;
        const lateralN = Math.abs(v.body.fx * r.x + v.body.fy * r.y);
        if (lateralN > CONFIG.gear.jack.slipLateralN) {
          item.liftStep = 0;
          item.x += r.x * 0.5; item.y += r.y * 0.5;
          item.angle += 1.1;
          bus.emit(EVENTS.GEAR_SCATTERED, {
            gear: item.id, kind: 'jack', reason: 'sideways-load',
            lateralN: Math.round(lateralN),
          }, simTimeMs);
        }
        break;
      }

      case 'chock': {
        const w = wheelNear(st, item.x, item.y, CONFIG.gear.chock.reachM);
        if (!w) break;
        const v = w.veh;
        // A wedge resists the wheel rolling INTO it, so its direction is wheel -> chock.
        const dir = unit(item.x - w.x, item.y - w.y);
        if (dir.x === 0 && dir.y === 0) break;
        // And a chock only stops ROLLING. Alongside a tire it does nothing, which is the
        // whole of "poor placement has little effect".
        const wf = v.body.dirToWorld(1, 0);
        const align = Math.abs(dir.x * wf.x + dir.y * wf.y);
        if (align < CONFIG.gear.chock.alignDot) break;

        v.chockAids.push({
          wheelIndex: w.index, dirX: dir.x, dirY: dir.y,
          resistN: CONFIG.gear.chock.resistN * align,
        });
        v.aids.chocks++;
        item.attachedTo = v.id;
        break;
      }

      case 'snatchBlock': {
        if (!item.attachedTo) break;      // only a MOUNTED block redirects anything
        st.blocksById[item.id] = { id: item.id, x: item.x, y: item.y, anchorId: item.attachedTo };
        break;
      }

      default: break;                     // strap and chain do their work in attach.js
    }
  }

  // Cribbing: two blocks give the full effect, four give more yaw resistance. Diminishing,
  // because "bring all four" should be a real choice and not an obvious one.
  for (const [vid, n] of cribCount) {
    const v = st.vehicles[vid];
    if (!v) continue;
    const t = clamp01(n / 2);
    v.dragMul *= lerp(1, CONFIG.gear.cribbing.dragMul, t);
    v.boggedMul *= lerp(1, CONFIG.gear.cribbing.boggedMul, t);
    v.spinResistN += CONFIG.gear.cribbing.spinResist * clamp01(n / 4);
    v.aids.cribbing = n;
  }

  // An impact scatters blocks that were tucked under a vehicle. GDD §4: "can be scattered
  // by impacts".
  for (const id of Object.keys(st.vehicles)) {
    const v = st.vehicles[id];
    const last = v._scatterMark || 0;
    if (v.damage.worstImpactNs > CONFIG.gear.cribbing.scatterNs && v.damage.worstImpactNs > last) {
      v._scatterMark = v.damage.worstImpactNs;
      for (const item of st.gear) {
        if (item.kind !== 'cribbing' || item.attachedTo !== id || item.carriedBy) continue;
        const away = unit(item.x - v.body.x, item.y - v.body.y);
        item.x += away.x * 1.1; item.y += away.y * 1.1;
        item.angle += 0.8;
        item.attachedTo = null;
        bus.emit(EVENTS.GEAR_SCATTERED, { gear: item.id, kind: 'cribbing', reason: 'impact' }, simTimeMs);
      }
    }
  }
}

/* ── player actions ─────────────────────────────────────────────────────────── */

/** The nearest gear item a player at (x,y) could pick up. */
export function nearestGear(st, x, y, maxDist = CONFIG.gear.pickupReachM) {
  let best = null, bestD = Infinity;
  for (const item of st.gear) {
    if (item.carriedBy) continue;
    const d = Math.hypot(item.x - x, item.y - y);
    if (d < bestD && d <= maxDist) { bestD = d; best = item; }
  }
  return best ? { item: best, dist: bestD } : null;
}

export function pickUpGear(st, item, bus, simTimeMs) {
  item.carriedBy = 'player';
  item.placed = false;
  item.attachedTo = null;
  bus.emit(EVENTS.GEAR_PICKED_UP, { gear: item.id, kind: item.kind }, simTimeMs);
  return item;
}

/** Put the carried item down at a world point. Where it lands is where it works. */
export function placeGear(st, item, x, y, angle, bus, simTimeMs) {
  item.carriedBy = null;
  item.placed = true;
  item.x = x; item.y = y; item.angle = angle;
  bus.emit(EVENTS.GEAR_PLACED, {
    gear: item.id, kind: item.kind,
    x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10,
  }, simTimeMs);
  return item;
}

/** Secure a snatch block to a tree. Needs a tree; there is nothing else strong enough here. */
export function mountBlock(st, item, terrain, bus, simTimeMs) {
  let best = null, bestD = Infinity;
  for (const t of terrain.trees) {
    const d = Math.hypot(t.x - item.x, t.y - item.y) - t.r;
    if (d < bestD) { bestD = d; best = t; }
  }
  if (!best || bestD > CONFIG.gear.snatchBlock.anchorReachM) return null;

  // Sit it against the trunk on the side it was carried from, so the line clears the tree.
  const dir = unit(item.x - best.x, item.y - best.y);
  item.x = best.x + dir.x * (best.r + 0.28);
  item.y = best.y + dir.y * (best.r + 0.28);
  item.attachedTo = best.id;
  item.carriedBy = null;
  item.placed = true;
  bus.emit(EVENTS.BLOCK_MOUNTED, { gear: item.id, anchor: best.id }, simTimeMs);
  return best;
}

export function unmountBlock(st, item, bus, simTimeMs) {
  item.attachedTo = null;
  if (st.winch.blockId === item.id) st.winch.blockId = null;
  bus.emit(EVENTS.BLOCK_REMOVED, { gear: item.id }, simTimeMs);
}

/** Route the line through a mounted block, or take it back out. The routing is a decision,
 *  not an automatic consequence of the block existing. */
export function routeThroughBlock(st, item, bus, simTimeMs) {
  if (!item || !item.attachedTo) return false;
  st.winch.blockId = item.id;
  bus.emit(EVENTS.CABLE_ROUTED, { gear: item.id, anchor: item.attachedTo }, simTimeMs);
  return true;
}

export function unrouteBlock(st, bus, simTimeMs) {
  if (!st.winch.blockId) return false;
  const was = st.winch.blockId;
  st.winch.blockId = null;
  bus.emit(EVENTS.CABLE_ROUTED, { gear: was, anchor: null, removed: true }, simTimeMs);
  return true;
}

/** One pump of the jack. Held, so it takes a few seconds of standing there. */
export function pumpJack(st, item, dtSec, bus, simTimeMs) {
  if (item.kind !== 'jack') return false;
  item.pumpMs += dtSec * 1000;
  if (item.pumpMs < CONFIG.gear.jack.pumpMs) return false;
  item.pumpMs = 0;
  if (item.liftStep >= CONFIG.gear.jack.liftSteps) return false;
  item.liftStep++;
  bus.emit(EVENTS.GEAR_USED, {
    gear: item.id, kind: 'jack', liftStep: item.liftStep, of: CONFIG.gear.jack.liftSteps,
  }, simTimeMs);
  return true;
}

/** What the context key would do if pressed right now, as a label and a verb. The HUD shows
 *  the label; src/player/player.js performs the verb. One source of truth for both. */
export function contextFor(st, terrain, px, py, carried) {
  if (carried) {
    const def = gearDef(carried.kind);
    if (def.use === USE.MOUNT) {
      for (const t of terrain.trees) {
        if (Math.hypot(t.x - px, t.y - py) - t.r <= CONFIG.gear.snatchBlock.anchorReachM) {
          return { verb: USE.MOUNT, label: `secure the ${def.label} to the tree`, target: t };
        }
      }
    }
    if (def.use === USE.RIG) {
      return { verb: USE.RIG, label: `wrap the ${def.label} round a strong point`, target: null };
    }
    return { verb: USE.PLACE, label: `set down the ${def.label}`, target: null };
  }

  const g = nearestGear(st, px, py);
  if (g) {
    const def = gearDef(g.item.kind);
    if (g.item.kind === 'jack' && g.item.liftStep < CONFIG.gear.jack.liftSteps) {
      const near = vehicleNear(st, g.item.x, g.item.y, CONFIG.gear.jack.reachM);
      if (near) return { verb: USE.OPERATE, label: `pump the jack (${g.item.liftStep}/${CONFIG.gear.jack.liftSteps})`, target: g.item };
    }
    if (g.item.kind === 'snatchBlock' && g.item.attachedTo && st.winch.blockId !== g.item.id) {
      return { verb: 'route', label: 'run the line through the block', target: g.item };
    }
    return { verb: 'pickup', label: `pick up the ${def.label}`, target: g.item };
  }
  return null;
}

export { GEAR, USE };
