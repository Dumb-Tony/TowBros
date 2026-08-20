/* Who owns what. GDD §7 Milestone 2: "robust object authority."
 *
 * There is exactly one winch hook, one jack, one snatch block and two seats on this site, and
 * Milestone 2 puts two to four people on it. Every one of those objects can be wanted by more
 * than one person at the same moment, and the failure mode is not a crash — it is two crew each
 * believing they are carrying the hook while the cable draws a line to whichever of them the
 * renderer happened to ask second.
 *
 * ── THE RULE: OWNERSHIP LIVES ON THE OBJECT, NEVER IN A SIDE TABLE ────────────────────
 * A parallel `owners` map is the obvious design and it is the wrong one, for the same reason
 * src/recovery/gear.js recomputes its multipliers every step instead of caching them: two
 * records of one fact will eventually disagree, and the disagreement is invisible until
 * something reads the stale half. So:
 *
 *   the hook      st.winch.heldBy      crew id or null
 *   a gear item   item.carriedBy       crew id or null
 *   a seat        vehicle.occupiedBy   crew id or null
 *
 * There is nowhere else to look, so there is nothing to desync. Every function here is a
 * guarded transition on one of those three fields, and each one answers the same question
 * first: is it free, or is it already mine?
 *
 * ── WHY THIS IS THE FIRST THING BUILT ────────────────────────────────────────────────
 * GDD §6: "Future multiplayer authority should live above deterministic-ish simulation
 * commands: drive input, equipment pickup/place, attach/detach, and winch state." Those five
 * are exactly the things a claim protects. Get the claims right locally, with two people on one
 * keyboard fighting over one hook, and the network layer becomes a transport for commands
 * rather than a rewrite of the game.
 */

import { EVENTS } from '../core/eventBus.js';

/** Nothing is owned at the start of an attempt. Claims are recorded on the objects themselves,
 *  so this exists only to say so out loud — there is no table to initialise. */
export const UNOWNED = null;

/* ── the hook ──────────────────────────────────────────────────────────────── */

/** @returns {boolean} true if `crewId` may take the hook right now. */
export function hookFree(st, crewId) {
  return st.winch.heldBy === UNOWNED || st.winch.heldBy === crewId;
}

/** Take the hook. Fails (returns false) if somebody else has it. */
export function claimHook(st, crewId, bus, simTimeMs, from = 'drum') {
  if (!hookFree(st, crewId)) return false;
  st.winch.heldBy = crewId;
  bus.emit(EVENTS.HOOK_TAKEN, { crew: crewId, from }, simTimeMs);
  return true;
}

/** Put the hook down. Only the holder can, which is the whole point. */
export function releaseHook(st, crewId, bus, simTimeMs, where = 'ground') {
  if (st.winch.heldBy !== crewId) return false;
  st.winch.heldBy = UNOWNED;
  bus.emit(EVENTS.HOOK_STOWED, { crew: crewId, where }, simTimeMs);
  return true;
}

/* ── gear ──────────────────────────────────────────────────────────────────── */

export function gearFree(item, crewId) {
  return !item.carriedBy || item.carriedBy === crewId;
}

/** Pick an item up. One item per person is enforced by the caller (GDD §5: "the player carries
 *  one physical object"); one person per item is enforced here. */
export function claimGear(st, item, crewId, bus, simTimeMs) {
  if (!gearFree(item, crewId)) return false;
  item.carriedBy = crewId;
  item.placed = false;
  item.attachedTo = null;
  bus.emit(EVENTS.GEAR_PICKED_UP, { crew: crewId, gear: item.id, kind: item.kind }, simTimeMs);
  return true;
}

export function releaseGear(item, crewId) {
  if (item.carriedBy !== crewId) return false;
  item.carriedBy = UNOWNED;
  return true;
}

/* ── seats ─────────────────────────────────────────────────────────────────── */

export function seatFree(veh, crewId) {
  return !veh.occupiedBy || veh.occupiedBy === crewId;
}

/** Get in. A second person arriving at an occupied cab is refused — and the refusal has to be
 *  legible, so the caller turns this into a prompt rather than a silent no-op. */
export function claimSeat(st, veh, crewId, bus, simTimeMs) {
  if (!seatFree(veh, crewId)) return false;
  veh.occupiedBy = crewId;
  bus.emit(EVENTS.VEHICLE_ENTERED, { crew: crewId, vehicle: veh.id }, simTimeMs);
  return true;
}

export function releaseSeat(st, veh, crewId, bus, simTimeMs) {
  if (veh.occupiedBy !== crewId) return false;
  veh.occupiedBy = UNOWNED;
  bus.emit(EVENTS.VEHICLE_EXITED, { crew: crewId, vehicle: veh.id }, simTimeMs);
  return true;
}

/* ── housekeeping ──────────────────────────────────────────────────────────── */

/**
 * Drop everything a crew member owns. Called when they leave, or on a reset.
 *
 * Without this, a disconnect (or, locally, a crew member being removed) strands the hook and the
 * jack as owned-by-nobody-who-exists — unclaimable forever, because every claim checks "is it
 * free" and a dead owner's id is not free.
 */
export function releaseAll(st, crewId, bus, simTimeMs) {
  let released = 0;
  if (st.winch.heldBy === crewId) { releaseHook(st, crewId, bus, simTimeMs, 'abandoned'); released++; }
  for (const item of st.gear) {
    if (item.carriedBy === crewId) { item.carriedBy = UNOWNED; item.placed = true; released++; }
  }
  for (const id of Object.keys(st.vehicles)) {
    const v = st.vehicles[id];
    if (v.occupiedBy === crewId) { releaseSeat(st, v, crewId, bus, simTimeMs); released++; }
  }
  return released;
}

/**
 * Everything `crewId` currently owns, for the HUD and for the tests.
 * Derived, never stored — see the note at the top of this file.
 */
export function ownedBy(st, crewId) {
  return {
    hook: st.winch.heldBy === crewId,
    gear: st.gear.filter((g) => g.carriedBy === crewId).map((g) => g.id),
    seat: Object.keys(st.vehicles).find((id) => st.vehicles[id].occupiedBy === crewId) || null,
  };
}

/**
 * Assert the ownership graph is sane. Run it in the debug overlay, not only in tests — the
 * lesson from AirportBaggageCrew's `validateChain` (Dev\INDEX.md) is that an authority bug is
 * far easier to see live than to reconstruct from a trace afterwards.
 *
 * @returns {string[]} problems, empty when healthy
 */
export function validateAuthority(st) {
  const problems = [];
  const ids = new Set(st.crew.map((c) => c.id));

  if (st.winch.heldBy && !ids.has(st.winch.heldBy)) {
    problems.push(`hook held by unknown crew ${st.winch.heldBy}`);
  }
  const carrying = new Map();
  for (const item of st.gear) {
    if (!item.carriedBy) continue;
    if (!ids.has(item.carriedBy)) problems.push(`${item.id} carried by unknown crew ${item.carriedBy}`);
    // GDD §5: one physical object each. Two items on one person is a real bug, not a nicety.
    const n = (carrying.get(item.carriedBy) || 0) + 1;
    carrying.set(item.carriedBy, n);
    if (n > 1) problems.push(`crew ${item.carriedBy} is carrying ${n} objects`);
  }
  const seated = new Map();
  for (const id of Object.keys(st.vehicles)) {
    const who = st.vehicles[id].occupiedBy;
    if (!who) continue;
    if (!ids.has(who)) problems.push(`${id} occupied by unknown crew ${who}`);
    if (seated.has(who)) problems.push(`crew ${who} is in two vehicles`);
    seated.set(who, id);
  }
  // Holding the hook and sitting in the cab at the same time is physically impossible and would
  // put the cable's far end inside the truck that is pulling it.
  if (st.winch.heldBy && seated.has(st.winch.heldBy)) {
    problems.push(`crew ${st.winch.heldBy} holds the hook from inside a vehicle`);
  }
  return problems;
}
