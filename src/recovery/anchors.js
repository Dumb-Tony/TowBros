/* Anchors, and the ways they let go. GDD §7 Milestone 6: "richer anchors".
 *
 * GDD §4 listed "small/weak anchors can fail" among the failure modes, and Milestone 1 deferred it
 * — `anchorStrengthN` has been authored on every tree since the first commit and read by nothing.
 * This is where it starts being read.
 *
 * ── WHY AN ANCHOR IS INTERESTING AT ALL ──────────────────────────────────────────────
 * Because a snatch block doubles the load. The two legs of a redirected line each pull the block
 * toward themselves, so what the anchor holds is `2·T·cos(θ/2)` — up to twice the line tension when
 * the line is folded right back on itself, which is exactly the geometry a side pull wants. The
 * moment the redirect becomes worth doing is the moment the anchor becomes the thing that might go.
 *
 * That means the player's decision is not "is there a tree" but "is that tree enough", and the
 * answer depends on how sharply they turned the line — which is a fact about where they parked.
 *
 * ── AND WHY IT IS JUDGED IN NEWTON-SECONDS ───────────────────────────────────────────
 * Same reason as the guardrail (src/sim/collision.js) and the wheel lift (recovery/lift.js), and
 * this codebase has now learned it three times: a threshold on force fails on the first spike, and
 * a spike is what a snatch load is. Accumulate the overload instead and a tree leans, holds, and
 * then goes over — three distinguishable things, only one of which is a failure.
 */

import { CONFIG } from '../config.js';
import { EVENTS } from '../core/eventBus.js';
import { drumsOf } from './cable.js';

/**
 * Everything a snatch block can be mounted to, with what it is worth.
 *
 * Trees and driven ground anchors, in one list, because the block does not care which it is on.
 * Boulders are deliberately NOT in here: the quarry's five of them are loose rock, and "nothing to
 * hang a block on" is that site's whole identity (src/data/terrain.js SITES).
 *
 * @returns {Array<{id:string, x:number, y:number, r:number, strengthN:number, kind:string}>}
 */
export function anchorPoints(st) {
  const out = [];
  for (const t of st.terrain.trees) {
    if (t.fallen) continue;                 // a tree on its side anchors nothing
    out.push({ id: t.id, x: t.x, y: t.y, r: t.r, kind: 'tree', strengthN: t.anchorStrengthN, ref: t });
  }
  for (const it of st.gear) {
    if (it.kind !== 'groundAnchor' || !it.placed || it.carriedBy) continue;
    out.push({
      id: it.id, x: it.x, y: it.y, r: 0.18, kind: 'groundAnchor',
      strengthN: groundAnchorHoldN(st, it), ref: it,
    });
  }
  return out;
}

/**
 * What a driven anchor is worth where it is standing.
 *
 * Recomputed from the ground under it every time it is asked, which is the same rule the rest of
 * the equipment follows (see the note at the top of recovery/gear.js): an anchor knocked into the
 * mud is worth what mud is worth, and nothing is cached that could drift out of step with it.
 */
export function groundAnchorHoldN(st, item) {
  const surf = st.terrain.surfaceAt(item.x, item.y);
  return CONFIG.gear.groundAnchor.holdN * (surf.anchorHoldMul ?? 0);
}

/** The anchor a mounted block is on, or null. Read by the HUD when a line is routed. */
export function anchorOf(st, blockId) {
  const block = st.blocksById[blockId];
  if (!block || !block.anchorId) return null;
  return anchorPoints(st).find((a) => a.id === block.anchorId) || null;
}

/** The anchor carrying the most right now, across every drum, or null. For the HUD. */
export function loadedAnchor(st) {
  let best = null, bestLoad = 0;
  for (const w of drumsOf(st)) {
    if (!w.blockId || !(w.anchorLoadN > bestLoad)) continue;
    const a = anchorOf(st, w.blockId);
    if (a) { best = a; bestLoad = w.anchorLoadN; }
  }
  return best;
}

/**
 * What the anchor is carrying, in newtons.
 *
 * `2·T·cos(θ/2)`, computed as the magnitude of the two leg tensions summed as vectors, which is
 * the same thing and does not need the half-angle. A block routed in a straight line puts 2·T on
 * its anchor; one folded back to 90° puts 1.41·T; one that barely turns the line puts almost none.
 *
 * @param {{x:number,y:number}} block
 * @param {{x:number,y:number}} fromA  one end of the line (the fairlead)
 * @param {{x:number,y:number}} fromB  the other (the hook)
 * @param {number} tensionN
 */
export function anchorLoadN(block, fromA, fromB, tensionN) {
  if (tensionN <= 0) return 0;
  const ax = block.x - fromA.x, ay = block.y - fromA.y;
  const bx = block.x - fromB.x, by = block.y - fromB.y;
  const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1;
  // Each leg pulls the block toward the end it comes from, i.e. back down its own leg.
  const sx = -ax / la - bx / lb, sy = -ay / la - by / lb;
  return tensionN * Math.hypot(sx, sy);
}

/**
 * Judge every anchor against what it is holding.
 *
 * Runs after the cable has set `winch.anchorLoadN`, in the same weakest-link-first chain as the
 * attachment and the cable itself. An anchor that goes takes the redirect with it: the block comes
 * off, the routing is dropped, and the line snaps back to a straight pull — which is a large,
 * sudden change in the geometry and is meant to be.
 */
export function stepAnchors(st, dtSec, bus, simTimeMs) {
  const A = CONFIG.anchors;
  /* Summed across every drum, because two lines can be redirected through blocks on the SAME tree
   * — which is a perfectly reasonable thing for a two-winch machine to do, and a good way to pull
   * a tree over. The anchor holds what is on it, not what one drum put there. */
  const loads = new Map();
  for (const w of drumsOf(st)) {
    if (!w.anchorId || w.anchorLoadN <= 0) continue;
    loads.set(w.anchorId, (loads.get(w.anchorId) || 0) + w.anchorLoadN);
  }

  for (const a of anchorPoints(st)) {
    const ref = a.ref;
    if (ref.pullNs === undefined) ref.pullNs = 0;
    const load = loads.get(a.id) || 0;
    const over = load - a.strengthN * A.creepFrac;

    if (over > 0) {
      ref.pullNs += over * dtSec;
    } else {
      ref.pullNs = Math.max(0, ref.pullNs - A.recoverPerSec * dtSec);
      continue;
    }
    if (ref.pullNs < A.failNs) continue;

    /* It has gone. A tree uproots and stops being solid; a driven anchor pulls out and is
     * lying on the ground again, ready to be driven in somewhere that will hold it. */
    ref.pullNs = 0;
    if (a.kind === 'tree') ref.fallen = true;
    else ref.placed = false;

    // The block was on it. Take the block off and drop the routing on every drum that was using
    // it, or a cable would be redirecting through a point that is no longer attached to anything.
    for (const it of st.gear) {
      if (it.kind !== 'snatchBlock' || it.attachedTo !== a.id) continue;
      it.attachedTo = null;
      delete st.blocksById[it.id];
      for (const w of drumsOf(st)) {
        if (w.blockId === it.id) w.blockId = null;
        if (w.anchorId === a.id) { w.anchorId = null; w.anchorLoadN = 0; }
      }
    }
    bus.emit(EVENTS.ANCHOR_FAILED, {
      anchor: a.id, kind: a.kind,
      ratedN: Math.round(a.strengthN),
      loadN: Math.round(load),
    }, simTimeMs);
  }
}

/** For the inspect card and the HUD: what this anchor is and how it is doing. */
export function describeAnchor(st, a) {
  const frac = a.ref && a.ref.pullNs ? a.ref.pullNs / CONFIG.anchors.failNs : 0;
  let held = 0;
  for (const w of drumsOf(st)) if (w.anchorId === a.id) held += w.anchorLoadN;
  return {
    id: a.id,
    kind: a.kind,
    ratedN: Math.round(a.strengthN),
    loadN: Math.round(held),
    strainFrac: Math.min(1, frac),
    /* A fact, never a recommendation — GDD §5. "Rated 22 kN, carrying 31" is the whole story and
     * the player can do the subtraction. */
    line: a.strengthN <= 0
      ? 'It will not go into this ground at all.'
      : `Rated ${Math.round(a.strengthN / 1000)} kN. Carrying ${Math.round(held / 1000)} kN.`,
  };
}
