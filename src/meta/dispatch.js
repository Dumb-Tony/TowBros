/* Dispatch. GDD §7 Milestone 4: "authored dispatch selection."
 *
 * Three jobs on the board; you take one. Authored in the sense that the SHAPE of each is chosen
 * rather than rolled — a rush job pays more and gives you a worse car, a routine one is money for
 * the morning — and seeded in the sense that which three you see is reproducible from the save.
 *
 * ── WHAT AN OFFER IS ALLOWED TO CHANGE ───────────────────────────────────────────────
 * A seed, a fee multiplier, and a small set of MODIFIERS the scene reads. That is all. It cannot
 * change how the winch works, what the ground does, or which approaches are viable — GDD §4's "no
 * scripted sequence and no mandatory tool" is a Milestone 1 promise and Milestone 4 does not get to
 * take it back. What varies is how far in the car is, how much of it is already broken, and what
 * the job is worth.
 *
 * ── AND WHY REPUTATION GATES THEM ────────────────────────────────────────────────────
 * Because otherwise reputation is a number on a screen. A company nobody trusts gets the routine
 * work; the jobs that pay get offered to the outfit that does not drop cars in the road. It is the
 * only place in the game where a past job changes what a future one can be.
 */

import { CONFIG } from '../config.js';
import { mulberry32, hashStr } from '../core/rng.js';

/**
 * The job templates. Each is a shape, not a scenario — the terrain is the same site every time,
 * and what changes is the state the car arrived in and what the customer is paying.
 *
 * `minRep` is the reputation an outfit needs before this kind of work comes their way.
 */
export const JOB_TYPES = Object.freeze([
  {
    id: 'routine',
    title: 'Routine recovery',
    blurb: 'Car off the road on the bend. Owner is waiting at the yard.',
    minRep: 0,
    feeMul: 1.0,
    mods: { boggedMul: 1.0, seizedChance: 0.35, dentChance: 0.25, lieSpread: 1.0 },
  },
  {
    id: 'dug-in',
    title: 'Dug in overnight',
    blurb: 'Been there since last night and it has rained on it. Nose is well in.',
    minRep: 0,
    feeMul: 1.35,
    mods: { boggedMul: 1.55, seizedChance: 0.55, dentChance: 0.3, lieSpread: 1.15 },
  },
  {
    id: 'rolled',
    title: 'Came off hard',
    blurb: 'Went through the rail at speed. It is not in one piece and the owner knows it.',
    minRep: 25,
    feeMul: 1.6,
    mods: { boggedMul: 1.2, seizedChance: 0.8, dentChance: 1.0, dentsMax: 6, lieSpread: 1.6 },
  },
  {
    id: 'awkward',
    title: 'Awkward lie',
    blurb: 'Sideways across the bank. The straight pull will not be the answer.',
    minRep: 40,
    feeMul: 1.5,
    mods: { boggedMul: 1.1, seizedChance: 0.45, dentChance: 0.3, lieSpread: 1.9, lieBias: 0.35 },
  },
  {
    id: 'contract',
    title: 'Fleet contract',
    blurb: 'Regular customer, and they will notice if it comes back marked.',
    minRep: 60,
    feeMul: 1.85,
    mods: { boggedMul: 1.0, seizedChance: 0.3, dentChance: 0.0, lieSpread: 0.9 },
  },
]);

/**
 * Build the board.
 *
 * Seeded from the company's dispatch cursor and nothing else — no clock, so the same save always
 * shows the same three jobs until one is taken, and reloading the page does not reroll the board.
 * That matters: a board that rerolls on refresh is a board you refresh until you like it.
 */
export function offersFor(company, count = CONFIG.company.offerCount) {
  const rnd = mulberry32((hashStr('dispatch') ^ (company.dispatchCursor * 0x9e3779b9)) >>> 0);
  const eligible = JOB_TYPES.filter((t) => company.reputation >= t.minRep);
  const pool = eligible.length ? eligible : [JOB_TYPES[0]];

  const out = [];
  const used = new Set();
  for (let i = 0; i < count; i++) {
    // Draw without replacement while there is anything left to draw, so a board of three is three
    // different jobs rather than the same one looked at from three angles.
    let pick = null;
    for (let tries = 0; tries < 12; tries++) {
      const c = pool[Math.floor(rnd() * pool.length) % pool.length];
      if (!used.has(c.id) || used.size >= pool.length) { pick = c; break; }
    }
    pick = pick || pool[i % pool.length];
    used.add(pick.id);

    const seed = (hashStr(`job:${company.dispatchCursor}:${i}`) ^ Math.floor(rnd() * 0xffffffff)) >>> 0;
    const distanceKm = Math.round((6 + rnd() * 22) * 10) / 10;
    out.push({
      id: `${company.dispatchCursor}-${i}`,
      type: pick.id,
      title: pick.title,
      blurb: pick.blurb,
      seed,
      feeMul: pick.feeMul,
      /** Presentation only — the drive to site is not simulated. It is why the fee differs. */
      distanceKm,
      fee: Math.round(CONFIG.job.baseFee * pick.feeMul),
      mods: { ...pick.mods },
      locked: false,
    });
  }

  /* The jobs the outfit is NOT good enough for, shown greyed out rather than hidden. A locked
   * offer with its reputation printed on it is the only thing in this game that tells the player
   * what reputation is for. */
  for (const t of JOB_TYPES) {
    if (company.reputation >= t.minRep) continue;
    out.push({
      id: `locked-${t.id}`, type: t.id, title: t.title, blurb: t.blurb,
      seed: 0, feeMul: t.feeMul, distanceKm: 0,
      fee: Math.round(CONFIG.job.baseFee * t.feeMul),
      mods: { ...t.mods }, locked: true, minRep: t.minRep,
    });
  }
  return out;
}

/** Take one. The cursor moves, so the board is different next time and cannot be rerolled. */
export function acceptOffer(company, offer) {
  if (offer.locked) return false;
  company.dispatchCursor += 1;
  return true;
}
