/* The customer. GDD §7 Milestone 7: "the customer, at the scene."
 *
 * Somebody owns the car in the ditch, and until now nobody did. Six milestones of consequences have
 * all been mechanical — a torn bumper, a parted cable, a fee with deductions on it — and the one
 * thing a recovery operator actually deals with all day is a person standing on the verge watching
 * you decide what to do with the second most expensive thing they own.
 *
 * ── WHAT THEY ARE ALLOWED TO DO ──────────────────────────────────────────────────────
 * Nothing. They do not move, they do not help, they cannot be run over, and they never tell the
 * player what to do. GDD §9's north star is whether the player describes what THEY did, and a
 * character who says "try the snatch block" has answered the question for them.
 *
 * What they do instead is HAVE AN OPINION, formed from things that already happened, and take it
 * with them at the end:
 *
 *   what you did to the car    every dent and every part that came off, weighted much more heavily
 *                              than the payout weights them — the payout charges for the repair,
 *                              this is about watching it happen
 *   how long they stood there  the one cost the game has never charged for. See meta/clock.js.
 *   whether you dropped it     a load coming off the lift in front of its owner is its own event
 *
 * And the opinion reaches reputation DIRECTLY, in parallel with the damage table, because "the
 * customer was unhappy" and "the car has three dents" are two different facts about the same
 * afternoon and a company is judged on both.
 *
 * ── WHY THEY ARE NOT A CREW MEMBER ───────────────────────────────────────────────────
 * A crew member is an actor with claims on objects (src/crew/authority.js). The customer owns
 * nothing, claims nothing and is never addressed by a command frame, so putting them in `st.crew`
 * would mean every authority rule, every input seat and every network packet had to learn about a
 * person who does not act. They are scenery with a memory.
 */

import { CONFIG } from '../config.js';
import { EVENTS } from '../core/eventBus.js';

/** How they are feeling about it, worst to best. The label is what the HUD shows. */
export const MOOD = Object.freeze([
  { at: 0.00, id: 'furious', label: 'furious' },
  { at: 0.25, id: 'unhappy', label: 'not happy' },
  { at: 0.50, id: 'anxious', label: 'anxious' },
  { at: 0.75, id: 'patient', label: 'patient' },
  { at: 0.92, id: 'grateful', label: 'grateful' },
]);

export const moodOf = (frac) => {
  let best = MOOD[0];
  for (const m of MOOD) if (frac >= m.at) best = m;
  return best;
};

/**
 * Put somebody on the verge.
 *
 * @param {{x:number,y:number}} at   where they are standing
 * @param {object} [opts]
 * @param {boolean} [opts.present]   some jobs have nobody at the scene — a fleet contract's owner
 *   is a depot forty miles away. `present: false` is a customer who still forms an opinion from
 *   the state the car arrives in, and forms none at all from how long it took.
 */
export function createCustomer(at, { present = true, name = 'the owner' } = {}) {
  return {
    name,
    present,
    x: at.x, y: at.y,
    facing: -Math.PI / 2,
    /** 0..1. Starts high: they called you, so they are on your side until you give them a reason. */
    mood: CONFIG.customer.startMood,
    /** What they have actually seen happen, so the recap can say why rather than only how much. */
    saw: { dents: 0, partsLost: 0, drops: 0, snaps: 0 },
    /** Set once, when the job settles. */
    verdict: null,
    _watchedMs: 0,
  };
}

/**
 * One step of standing there.
 *
 * Reads the casualty's damage rather than listening for events, for the reason the rest of this
 * codebase recomputes gear effects every step: a tally kept by subscription drifts the first time
 * something reverts, and this one is read by the payout at the end of the job.
 */
export function stepCustomer(st, dtSec, bus, simTimeMs) {
  const c = st.customer;
  if (!c) return;
  const C = CONFIG.customer;
  const veh = st.vehicles.sedan;
  if (!veh) return;

  const arrived = veh.damage.arrived || { dents: 0, parts: {} };
  const dents = Math.max(0, (veh.damage.dents || 0) - (arrived.dents || 0));
  const partsLost = Object.keys(veh.damage.parts || {})
    .filter((k) => veh.damage.parts[k] === 'lost' && (arrived.parts || {})[k] !== 'lost').length;
  const drops = (st.job && st.job.droppedInTransit) || 0;
  const snaps = c.saw.snaps;

  /* WATCHING costs them patience, and only if they are actually here. It is a fixed drain per
   * second rather than a fraction of some budget, because the point is that a job which takes all
   * afternoon costs the same patience whoever's car it is. */
  if (c.present) c._watchedMs += dtSec * 1000;
  const waited = c.present ? (c._watchedMs / 1000) * C.perSecond : 0;

  const hurt = dents * C.perDent
    + partsLost * C.perPart
    + drops * C.perDrop
    + snaps * C.perSnap
    + waited;

  const was = moodOf(c.mood).id;
  c.mood = Math.max(0, Math.min(1, C.startMood - hurt));
  c.saw = { dents, partsLost, drops, snaps };

  const now = moodOf(c.mood).id;
  if (now !== was) {
    bus.emit(EVENTS.CUSTOMER_MOOD, { mood: now, from: was, moodFrac: Math.round(c.mood * 100) / 100 }, simTimeMs);
  }
}

/** A cable parting is loud and they will remember it. Called from the bus, once per snap. */
export function noteCableSnap(st) {
  if (st.customer) st.customer.saw.snaps += 1;
}

/**
 * What they thought of it, and what that is worth in reputation.
 *
 * Deliberately capable of being POSITIVE. A job done quickly and without a mark on the car should
 * be worth something on its own, or the customer is only ever a penalty and the player learns to
 * ignore them rather than to work around them.
 */
export function settleCustomer(customer) {
  if (!customer) return { rep: 0, mood: null, line: '' };
  const C = CONFIG.customer;
  const m = moodOf(customer.mood);
  const rep = Math.round((customer.mood - C.neutralMood) * C.repSwing * 10) / 10;
  const s = customer.saw;

  /* One sentence, from what they saw. A fact about their afternoon, not a grade — GDD §5. */
  let line;
  if (!customer.present) line = 'Nobody was there to watch.';
  else if (m.id === 'grateful') line = `${customer.name} watched the whole thing and shook your hand.`;
  else if (s.drops > 0) line = `${customer.name} watched you drop it in the road.`;
  else if (s.partsLost > 0) line = `${customer.name} picked a piece of their car up off the grass.`;
  else if (s.snaps > 0) line = `${customer.name} was standing there when the cable went.`;
  else if (s.dents > 2) line = `${customer.name} counted the dents.`;
  else if (m.id === 'furious' || m.id === 'unhappy') line = `${customer.name} stopped watching an hour ago.`;
  else line = `${customer.name} waited it out.`;

  customer.verdict = { mood: m.id, rep, line };
  return customer.verdict;
}

/** For the HUD, the recap and the tests. Facts only. */
export function describeCustomer(customer) {
  if (!customer) return null;
  const m = moodOf(customer.mood);
  return {
    name: customer.name,
    present: customer.present,
    mood: m.id,
    moodLabel: m.label,
    moodFrac: Math.round(customer.mood * 100) / 100,
    watchedMin: Math.round(customer._watchedMs / 60000 * 10) / 10,
    saw: { ...customer.saw },
  };
}
