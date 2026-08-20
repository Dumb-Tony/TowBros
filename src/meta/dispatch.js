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
import { SITES } from '../data/terrain.js';
import { casualtyDefById } from '../data/vehicles.js';
import { rollWeather } from '../world/weather.js';
import { rollSituation, situationToOffer } from './situations.js';

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
  /* Milestone 6. A job is not only a car in a ditch any more, and the two below say so on the
   * board: WHAT is off the road is the first thing a dispatcher tells you, because it decides
   * which machine you take. Both need a reputation, not because reputation is a gate on content
   * but because nobody sends a seven-tonner to an outfit they have not used. */
  {
    id: 'van-down',
    title: 'Van off the bend',
    blurb: 'Panel van, nose in, and the owner has a delivery round to finish.',
    minRep: 30,
    feeMul: 2.1,
    casualtyId: 'van',
    mods: { boggedMul: 1.0, seizedChance: 0.4, dentChance: 0.3, lieSpread: 1.1 },
  },
  {
    id: 'heavy-down',
    title: 'Seven-tonner off the road',
    blurb: 'Box truck, loaded, and it is not coming out on a light-duty drum.',
    minRep: 55,
    feeMul: 3.4,
    casualtyId: 'boxTruck',
    mods: { boggedMul: 1.0, seizedChance: 0.5, dentChance: 0.25, lieSpread: 1.0 },
  },
]);

/**
 * Build the board.
 *
 * Seeded from the company's dispatch cursor and nothing else — no clock, so the same save always
 * shows the same board, and reloading the page does not reroll it. That matters: a board that
 * rerolls on refresh is a board you refresh until you like it.
 *
 * The board belongs to the DAY, not to each acceptance. Taking a job strikes it off today's board
 * and the rest are still there for the second slot; the cursor moves once, at the end of the day,
 * when whatever is left goes to somebody else. It was per-acceptance at first, and the consequence
 * was that the rivals were awarded jobs the player had never been shown — the board `endDay`
 * looked at was a different board from the one on screen.
 */
export function offersFor(company, count = CONFIG.company.offerCount) {
  const rnd = mulberry32((hashStr('dispatch') ^ (company.dispatchCursor * 0x9e3779b9)) >>> 0);
  const eligible = JOB_TYPES.filter((t) => company.reputation >= t.minRep);
  const pool = eligible.length ? eligible : [JOB_TYPES[0]];

  const out = [];
  const used = new Set();
  const taken = new Set(company.takenToday || []);
  /* One of the day's slots belongs to a GENERATED job (Milestone 6, below). A slot, not an extra
   * card: "three jobs, pick one" is the shape the whole day is built around, and a board that grew
   * to four would be a wider choice rather than a different kind of one. */
  const authored = Math.max(1, count - 1);
  for (let i = 0; i < authored; i++) {
    // Draw without replacement while there is anything left to draw, so a board of three is three
    // different jobs rather than the same one looked at from three angles.
    let pick = null;
    for (let tries = 0; tries < 12; tries++) {
      const c = pool[Math.floor(rnd() * pool.length) % pool.length];
      if (!used.has(c.id) || used.size >= pool.length) { pick = c; break; }
    }
    pick = pick || pool[i % pool.length];
    used.add(pick.id);

    const seed = (hashStr(`job:` + company.dispatchCursor + `:` + i) ^ Math.floor(rnd() * 0xffffffff)) >>> 0;
    const distanceKm = Math.round((6 + rnd() * 22) * 10) / 10;
    /* WHERE and IN WHAT (Milestone 5). Both drawn from the same seeded stream as everything else,
     * and both visible on the board before the job is taken — a wet night at the quarry pays more
     * for exactly the reason it is worth more, and the player gets to decide whether it is. */
    const site = SITES[Math.floor(rnd() * SITES.length) % SITES.length];
    const weather = rollWeather(rnd);
    out.push({
      id: company.dispatchCursor + `-` + i,
      type: pick.id,
      title: pick.title,
      blurb: pick.blurb,
      seed,
      siteId: site.id,
      siteName: site.name,
      siteBlurb: site.blurb,
      weatherId: weather.id,
      weatherLabel: weather.label,
      weatherBlurb: weather.blurb,
      /* WHAT is off the road (Milestone 6). On the card, before the job is taken, because it is
       * the fact that decides which machine you take out — and taking the wrong one is a decision
       * the player is allowed to make and then live with. */
      casualtyId: pick.casualtyId || 'sedan',
      casualtyLabel: casualtyDefById(pick.casualtyId).label,
      feeMul: pick.feeMul * weather.feeMul,
      /** Presentation only — the drive to site is not simulated. It is why the fee differs. */
      distanceKm,
      fee: Math.round(CONFIG.job.baseFee * pick.feeMul * weather.feeMul),
      mods: { ...pick.mods },
      locked: false,
    });
  }

  /* One GENERATED job on the board (Milestone 6), rolled from vehicle x incident x terrain x
   * damage x conditions — see meta/situations.js. One, not three: the authored shapes are the
   * spine of the board and a generator that replaced them would trade a set of jobs a designer
   * chose for a set nobody did. It emits the same offer shape, so nothing downstream can tell
   * which is which, and its seed comes from the same cursor, so it does not reroll on refresh. */
  const situation = rollSituation(
    (hashStr('gen:' + company.dispatchCursor) ^ Math.floor(rnd() * 0xffffffff)) >>> 0,
    company.reputation);
  out.push(situationToOffer(situation, company.dispatchCursor + '-g'));

  // Jobs already taken today are off the board. They are not offered twice and they are not
  // available to a rival at the end of the day either — you did them.
  const live = out.filter((o) => !taken.has(o.id));

  /* The jobs the outfit is NOT good enough for, shown greyed out rather than hidden. A locked
   * offer with its reputation printed on it is the only thing in this game that tells the player
   * what reputation is for. */
  for (const t of JOB_TYPES) {
    if (company.reputation >= t.minRep) continue;
    live.push({
      id: `locked-${t.id}`, type: t.id, title: t.title, blurb: t.blurb,
      seed: 0, feeMul: t.feeMul, distanceKm: 0,
      fee: Math.round(CONFIG.job.baseFee * t.feeMul),
      mods: { ...t.mods }, locked: true, minRep: t.minRep,
    });
  }
  return live;
}

/* ── the day, and the rivals (Milestone 5) ────────────────────────────────────
 *
 * GDD §7 Milestone 5: "dynamic dispatch ... and rival-job persistence."
 *
 * ── WHY A DAY AND NOT A CLOCK ────────────────────────────────────────────────────────
 * A wall clock in a meta-layer means a game that plays itself while you are not looking, and the
 * one thing this project has held to across five milestones is that nothing reads real time except
 * presentation. So the county's calendar advances when the player does something: taking a job
 * costs a slot, and running out of slots is the end of the day.
 *
 * ── WHY RIVALS ───────────────────────────────────────────────────────────────────────
 * Because otherwise a board is a menu that waits. The two jobs you did NOT take should not still be
 * sitting there tomorrow — somebody else in the county wanted the work, and the only thing that
 * makes choosing between three jobs a choice is that the other two go away.
 *
 * They are not a simulated competitor and they do not need to be. `rivalTook` is a name and a fee,
 * recorded when the day turns, and shown on the board the next morning. It costs nothing, it is
 * honest about what it is, and it does the whole job: you can see what you turned down.
 */

export const RIVALS = Object.freeze([
  'Coastline Recovery', 'Bett & Sons', 'Marle Valley Motors', 'A38 Rescue', 'Hadley Commercials',
]);

/** How many jobs an outfit can run before the day is done. */
export const SLOTS_PER_DAY = 2;

/**
 * End the day: whatever is still on the board goes to somebody else, and tomorrow's work appears.
 *
 * Called when the slots run out, and the record it leaves is the point — a player who spent the
 * day on two routine recoveries can see that the fleet contract went to Bett & Sons.
 */
export function endDay(company) {
  const rnd = mulberry32((hashStr('rivals') ^ (company.day * 0x85ebca6b)) >>> 0);
  // offersFor already strikes off what was taken today, so what is left IS what was declined.
  const left = offersFor(company).filter((o) => !o.locked);

  company.rivalTook = left.map((o) => ({
    title: o.title,
    site: o.siteName,
    fee: o.fee,
    by: RIVALS[Math.floor(rnd() * RIVALS.length) % RIVALS.length],
  }));

  company.day += 1;
  company.slotsLeft = SLOTS_PER_DAY;
  company.takenToday = [];
  // The board is keyed off the cursor, so moving it past the offers nobody took is what makes
  // tomorrow's work genuinely new rather than the same three jobs with one crossed out.
  company.dispatchCursor += 1;
  return company.rivalTook;
}

/** Take a job and spend a slot. Ends the day when the last one goes. */
export function useSlot(company, offer) {
  if (!company.takenToday.includes(offer.id)) company.takenToday.push(offer.id);
  company.slotsLeft = Math.max(0, company.slotsLeft - 1);
  if (company.slotsLeft === 0) return endDay(company);
  return null;
}

/** Take one. It comes off today's board; the cursor moves when the DAY does. */
export function acceptOffer(company, offer) {
  if (offer.locked) return false;
  if (!company.takenToday.includes(offer.id)) company.takenToday.push(offer.id);
  return true;
}
