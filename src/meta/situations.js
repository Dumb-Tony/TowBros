/* Procedural situations. GDD §7 Milestone 6, the last clause:
 *
 *   "procedural situation generation from vehicle + incident + terrain + damage + conditions."
 *
 * Five axes, rolled independently from one seeded stream, and combined into a job. That is the
 * whole idea and it is worth being careful about, because the obvious version of it is bad.
 *
 * ── WHY THIS IS NOT A DIFFICULTY DIAL ────────────────────────────────────────────────
 * The tempting design is one number — "difficulty 0..1" — smeared across every axis, so a hard job
 * is a heavy vehicle, on the steepest site, in the dark, badly damaged, dug in. That produces a
 * ramp, and a ramp is not a set of situations: every job is the same job with the contrast turned
 * up, and the player never has to think about which axis is the problem.
 *
 * So the axes are INDEPENDENT. A box truck in the dry on the easiest site is a real job and so is
 * a hatchback at the quarry at night, and they need different answers. What the roll is bounded by
 * is not difficulty but PLAUSIBILITY (a box truck does not go off a bridge parapet) and REACH: an
 * outfit's reputation decides which vehicles get sent to it, because that is the one thing in this
 * game that a past job is allowed to change about a future one.
 *
 * ── AND WHY IT STILL CANNOT MAKE A JOB IMPOSSIBLE ────────────────────────────────────
 * GDD §4: "no scripted sequence and no mandatory tool". A generated situation may change what is
 * in the ditch, where it is, what state it arrived in and what the weather is doing. It may not
 * touch a force, a rating, or which approaches exist — `situationToOffer` below emits exactly the
 * same offer shape the authored board emits, and the scene reads the same six modifier keys it has
 * read since Milestone 4. A generator that could reach further would eventually generate a job
 * nobody can do, and the player would have no way to know which ones those were.
 */

import { CONFIG } from '../config.js';
import { mulberry32, hashStr } from '../core/rng.js';
import { SITES, siteById } from '../data/terrain.js';
import { casualtyDefById } from '../data/vehicles.js';
import { WEATHER, weatherById } from '../world/weather.js';

/* ── the five axes ─────────────────────────────────────────────────────────── */

/** VEHICLE. `minRep` is who gets sent this kind of work, not a difficulty tier. */
export const VEHICLES = Object.freeze([
  { id: 'sedan', weight: 5, minRep: 0, feeMul: 1.0 },
  /* Milestone 7's two. A motorcycle is a SMALL job that pays like one and is fiddly out of all
   * proportion to its weight; a car on its roof is the same shell in a worse state and pays for
   * the fact that the straight pull needs half again the tension. Neither is gated high, because
   * neither is "advanced content" — they are different problems, not harder ones. */
  { id: 'motorcycle', weight: 2, minRep: 0, feeMul: 0.7 },
  { id: 'sedanRoof', weight: 2, minRep: 15, feeMul: 1.5 },
  { id: 'van', weight: 3, minRep: 25, feeMul: 1.9 },
  { id: 'boxTruck', weight: 2, minRep: 50, feeMul: 3.2 },
]);

/**
 * INCIDENT — how it came to be off the road. This is the axis that carries the story, and each
 * one reaches the scene only through the modifier keys the scene has always read.
 */
export const INCIDENTS = Object.freeze([
  {
    id: 'slid', label: 'slid off', weight: 5, feeMul: 1.0,
    line: 'came off on the bend and slid down.',
    mods: { boggedMul: 1.0, seizedChance: 0.35, dentChance: 0.25, lieSpread: 1.0 },
  },
  {
    id: 'overnight', label: 'in overnight', weight: 4, feeMul: 1.3,
    line: 'been there since last night, and it has rained on it since.',
    mods: { boggedMul: 1.6, seizedChance: 0.55, dentChance: 0.3, lieSpread: 1.1 },
  },
  {
    id: 'through-rail', label: 'through the rail', weight: 3, feeMul: 1.55,
    line: 'went through the rail at speed. It is not in one piece.',
    mods: { boggedMul: 1.15, seizedChance: 0.75, dentChance: 1.0, dentsMax: 6, lieSpread: 1.5 },
  },
  {
    id: 'jack-knifed', label: 'across the bank', weight: 3, feeMul: 1.45,
    line: 'lying across the slope. The straight pull will not be the answer.',
    mods: { boggedMul: 1.05, seizedChance: 0.4, dentChance: 0.3, lieSpread: 1.9, lieBias: 0.35 },
  },
  {
    id: 'avoiding', label: 'swerved', weight: 3, feeMul: 1.15,
    line: 'swerved for something and put it off the edge. Barely a mark on it.',
    mods: { boggedMul: 0.8, seizedChance: 0.25, dentChance: 0.1, lieSpread: 1.2 },
  },
]);

/** DAMAGE — what the customer is going to be told, and what the payout is baselined against. */
export const CONDITIONS = Object.freeze([
  { id: 'clean', label: 'straight', weight: 5, feeMul: 1.0, mods: {} },
  { id: 'knocked', label: 'knocked about', weight: 3, feeMul: 1.12, mods: { dentChance: 1.0, dentsMax: 3 } },
  { id: 'bad', label: 'in a bad way', weight: 2, feeMul: 1.3, mods: { dentChance: 1.0, dentsMax: 6, seizedChance: 0.85 } },
]);

/* ── rolling one ───────────────────────────────────────────────────────────── */

function pickWeighted(list, rnd) {
  const total = list.reduce((a, x) => a + x.weight, 0);
  let r = rnd() * total;
  for (const x of list) { r -= x.weight; if (r <= 0) return x; }
  return list[list.length - 1];
}

/**
 * Roll one situation.
 *
 * @param {number} seed          the whole situation comes from this and nothing else
 * @param {number} reputation    decides which vehicles are in the pool. Nothing else is gated.
 * @returns {object} the five axes, plus the numbers a job is built from
 */
export function rollSituation(seed, reputation = 0) {
  const rnd = mulberry32((hashStr('situation') ^ (seed >>> 0)) >>> 0);

  const vehiclePool = VEHICLES.filter((v) => reputation >= v.minRep);
  const vehicle = pickWeighted(vehiclePool.length ? vehiclePool : [VEHICLES[0]], rnd);
  const incident = pickWeighted(INCIDENTS, rnd);
  const site = SITES[Math.floor(rnd() * SITES.length) % SITES.length];
  const condition = pickWeighted(CONDITIONS, rnd);
  // WEATHER is a table keyed by id, not a list. Dry is weighted heavily for the same reason
  // world/weather.js rolls it that way: bad weather is only interesting if it is not the default.
  const weather = pickWeighted(
    Object.values(WEATHER).map((w) => ({ ...w, weight: w.id === 'dry' ? 6 : 2 })), rnd);

  /* PLAUSIBILITY, and it is the only place one axis is allowed to look at another. A seven-tonne
   * box truck does not end up through the parapet of a narrow bridge, and a job that says it did
   * is a job the player will not believe. Re-rolled to the same site's easiest neighbour rather
   * than to "somewhere random", so the fix is legible in the offer. */
  let placed = site;
  if (vehicle.id === 'boxTruck' && site.id === 'bridge') placed = siteById('bend');

  const mods = { ...incident.mods };
  for (const [k, v] of Object.entries(condition.mods)) mods[k] = v;

  const feeMul = vehicle.feeMul * incident.feeMul * condition.feeMul * weather.feeMul;
  return {
    seed: seed >>> 0,
    vehicle, incident, condition, weather,
    site: placed,
    mods,
    feeMul,
    fee: Math.round(CONFIG.job.baseFee * feeMul),
    /* One sentence, assembled from the axes. It states what happened and never what to do about
     * it — GDD §5, and the same rule the inspect cards follow. */
    line: `${casualtyDefById(vehicle.id).label} at ${placed.name}: ${incident.line}`,
  };
}

/**
 * A situation as a dispatch offer — the same shape `offersFor` emits, so the board, the garage and
 * the scene cannot tell the difference between an authored job and a generated one.
 */
export function situationToOffer(situation, id) {
  const s = situation;
  return {
    id,
    type: `${s.vehicle.id}:${s.incident.id}`,
    title: `${casualtyDefById(s.vehicle.id).label}, ${s.incident.label}`,
    blurb: s.incident.line,
    seed: s.seed,
    siteId: s.site.id,
    siteName: s.site.name,
    siteBlurb: s.site.blurb,
    weatherId: s.weather.id,
    weatherLabel: s.weather.label,
    weatherBlurb: s.weather.blurb,
    casualtyId: s.vehicle.id,
    casualtyLabel: casualtyDefById(s.vehicle.id).label,
    conditionLabel: s.condition.label,
    feeMul: s.feeMul,
    distanceKm: Math.round((6 + ((s.seed % 220) / 10)) * 10) / 10,
    fee: s.fee,
    mods: { ...s.mods },
    locked: false,
    generated: true,
  };
}

/** For the tests and the debug overlay: the five axes as five words. */
export const describeSituation = (s) => ({
  vehicle: s.vehicle.id,
  incident: s.incident.id,
  site: s.site.id,
  condition: s.condition.id,
  weather: s.weather.id,
  fee: s.fee,
});
