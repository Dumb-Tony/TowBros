/* Procedural situations. GDD §7 Milestone 6, the last clause:
 *
 *   "procedural situation generation from vehicle + incident + terrain + damage + conditions."
 *
 * ...and GDD §7 Milestone 9, which adds a sixth: "a shunt: two casualties, one behind the other,
 * both to be got onto the road."
 *
 * Six axes, rolled independently from one seeded stream, and combined into a job. That is the
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
 * The sixth axis is the one most likely to be got wrong, because two vehicles obviously LOOKS like
 * the hard setting. It is not one. A shunt is rolled from the same stream as everything else and
 * looks at none of it, so it turns up in the dry on an easy lie, and one car on its own turns up in
 * fog at the quarry. The moment "two of them" implies "and everything else is bad as well", this
 * file is a difficulty dial with six positions instead of five.
 *
 * ── AND WHY IT STILL CANNOT MAKE A JOB IMPOSSIBLE ────────────────────────────────────
 * GDD §4: "no scripted sequence and no mandatory tool". A generated situation may change what is
 * in the ditch, how much of it there is, where it is, what state it arrived in and what the weather
 * is doing. It may not touch a force, a rating, or which approaches exist — `situationToOffer`
 * below emits exactly the same offer shape the authored board emits, on exactly the same key set,
 * and the scene reads the same six modifier keys it has read since Milestone 4. A generator that
 * could reach further would eventually generate a job nobody can do, and the player would have no
 * way to know which ones those were.
 */

import { CONFIG } from '../config.js';
import { mulberry32, hashStr } from '../core/rng.js';
import { SITES, siteById } from '../data/terrain.js';
import { casualtyDefById } from '../data/vehicles.js';
import { WEATHER, weatherById } from '../world/weather.js';

/* ── the six axes ──────────────────────────────────────────────────────────── */

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

/**
 * THE SECOND VEHICLE — the sixth axis (Milestone 9). Is there another one in this job, and how is
 * it lying against the first?
 *
 * `none` is an ENTRY in this table rather than a chance tested outside it. That costs the stream
 * exactly one draw either way, which is what keeps "is this a shunt" a weight in a table like
 * every other axis here instead of a special case wrapped round them.
 *
 * The other three are LIES, not difficulties. They say where the one behind finished up relative
 * to the one in front, and that is the whole of what the offer is allowed to say about it — the
 * order they come out in is a fact about the ground, which the player reads off the ground. None
 * of them carries a fee multiplier on purpose: what a shunt is worth is the second vehicle, not
 * the angle it stopped at, and an "awkward" arrangement priced higher than a square one would be
 * the difficulty dial coming in through the side door.
 *
 * `sepM` is bumper-to-bumper clearance at rest, `latM` is how far off the first one's centreline
 * it sits and `angRad` is its heading relative to the first one's. All three are MAGNITUDE ranges
 * and the side it ended up on comes out of the same number as the magnitude, so a lie costs three
 * draws whatever shape it is.
 */
export const SHUNTS = Object.freeze([
  { id: 'none', weight: 14, line: null },
  {
    id: 'nose-to-tail', weight: 3,
    line: 'is in the back of it, square on. Both of them are yours.',
    sepM: [0.25, 0.95], latM: [0.00, 0.35], angRad: [0.00, 0.14],
  },
  {
    id: 'slewed', weight: 2,
    line: 'came off behind it and finished up half across the slope. Both of them are yours.',
    sepM: [0.40, 1.40], latM: [0.70, 1.70], angRad: [0.30, 0.75],
  },
  {
    id: 'broadside', weight: 1,
    line: 'is lying broadside behind it, right across the way back up. Both of them are yours.',
    sepM: [0.50, 1.60], latM: [0.00, 0.80], angRad: [1.05, 1.50],
  },
]);

/** The county's gap in the rail — `RAIL.gapX0..gapX1` in data/terrain.js — before the site
 *  multiplier and before the ±1.4 m an attempt jitters it by. The NOMINAL number, because the
 *  generator cannot see the jitter: the offer is written before the terrain is built. */
const COUNTY_GAP_M = 15.0;

/** Bumper to bumper as the pair went through that gap. Not the resting clearance — that is drawn
 *  per job from the arrangement's `sepM`, and by then one of them may be sideways. */
const SHUNT_ARRIVAL_CLEAR_M = 0.6;

/**
 * WHAT THE SECOND VEHICLE IS WORTH, as a fraction of what it would have been worth on its own.
 *
 * A shunt has to pay more than one job and less than two, and that is not a matter of taste: you
 * took ONE slot for it, and a slot is a whole afternoon (meta/clock.js — the working day is
 * 600 minutes, which at 9 500 ms to the hour is 95 s of simulation, against 39 s for a clean
 * recovery). Two separate jobs cost two slots and two turnouts. A shunt costs one slot, one
 * turnout, one road closure and two recoveries.
 *
 * So the second vehicle is paid at 0.6 of its own rate and both bounds fall out of that rather
 * than needing to be checked pair by pair: 0 < 0.6 < 1 means every shunt pays strictly more than
 * the vehicle in front alone and strictly less than the two jobs done separately, for every
 * combination, with nothing to special-case.
 *
 * 0.6 and not 0.9 or 0.3 because of what a shunt costs the day rather than what it adds to the
 * scene. A job is a turnout and a recovery; the second casualty is a second recovery and no second
 * turnout. Paying 0.6 leaves the gain in the SLOT it did not spend — 1.6 jobs' money for one slot
 * against 2.0 for two — so a shunt is worth taking when the day is short of slots or light and is
 * not worth taking when it is not. Pay it 0.9 and it dominates every board; pay it 0.3 and it is a
 * trap. If the assembled scene turns out to cost closer to twice a single job's simulated time
 * than to 1.6x, this is the one number to move.
 */
export const SECOND_CASUALTY_SHARE = 0.6;

/* ── rolling one ───────────────────────────────────────────────────────────── */

function pickWeighted(list, rnd) {
  const total = list.reduce((a, x) => a + x.weight, 0);
  let r = rnd() * total;
  for (const x of list) { r -= x.weight; if (r <= 0) return x; }
  return list[list.length - 1];
}

/**
 * Who can plausibly be found behind whom, at this site, for this outfit.
 *
 * PLAUSIBILITY, in exactly the shape the single-vehicle roll already uses it: bound the draw, and
 * where the bound bites, repair it legibly rather than cancelling anything. Two rules, and both of
 * them are about how the pair ARRIVED rather than about how hard it is to get them back:
 *
 *   Nothing heavier ends up BEHIND something lighter. When a heavy vehicle runs into a light one
 *   the light one is what gets pushed on down the bank, so a shunt sorts itself by mass on the way
 *   in. A motorcycle behind a box truck is the ordinary case; a box truck behind a motorcycle is
 *   not a thing that happens, it is a motorcycle underneath a box truck.
 *
 *   Both of them came through the same gap in the rail. That is the bound the bridge already puts
 *   on a single seven-tonner, applied to a pair — 15.0 m of gap at the bend and 8.25 m at the
 *   bridge, against 15.4 m of two box trucks nose to tail. The county's own gap caps it as well as
 *   the site's, because the ford being a wide shallow crossing is not a licence for fourteen
 *   tonnes of lorry in a brook.
 *
 * The repair is the PARTNER and never the presence. Refusing the shunt when the drawn partner does
 * not fit would make "is there a second vehicle" a fact about the front one and the site, which is
 * the one thing the header says this axis must not be — and it would be invisible, because the
 * player never sees the roll that was thrown away. The pool cannot empty: the motorcycle is the
 * lightest and shortest thing in the county, needs no reputation, and 5.40 m of van plus 2.10 m of
 * bike still goes through the 8.25 m gap at the bridge with 0.75 m to spare.
 *
 * Reputation gates the partner for the same reason it gates the vehicle in front. Without it a
 * shunt would be a side door: an outfit nobody trusts would be sent a car on its roof as long as
 * there was a plain one parked in front of it.
 */
function shuntPartnersFor(frontDef, site, reputation) {
  const gapM = Math.min(COUNTY_GAP_M, COUNTY_GAP_M * (site.gapMul || 1));
  const pool = VEHICLES.filter((v) => {
    if (reputation < v.minRep) return false;
    const d = casualtyDefById(v.id);
    return d.massKg <= frontDef.massKg
        && frontDef.lengthM + SHUNT_ARRIVAL_CLEAR_M + d.lengthM <= gapM;
  });
  // Only reachable from a nonsensical reputation, and a job with nothing behind it would be worse
  // than a job with a bike behind it. Same shape as the vehicle pool's own fallback above.
  return pool.length ? pool : VEHICLES.filter((v) => v.id === 'motorcycle');
}

/**
 * Where the one behind is, IN THE ONE IN FRONT'S OWN FRAME — `+x` out of its nose, `+y` its right,
 * the body-local axes data/vehicles.js is written in. That is the whole reason this is a lie
 * rather than a position: "behind" has to mean behind the car, and the car is lying at whatever
 * angle the site and the incident left it at. Give the scene a world offset and a shunt on a lie
 * of 1.35 rad puts the second vehicle out in the middle of the carriageway.
 */
function shuntLie(shunt, frontDef, rearDef, rnd) {
  const span = (t, [lo, hi]) => lo + t * (hi - lo);
  const sep = span(rnd(), shunt.sepM);
  const ty = rnd() * 2 - 1;
  const ta = rnd() * 2 - 1;
  const y = ty < 0 ? -span(-ty, shunt.latM) : span(ty, shunt.latM);
  const angle = ta < 0 ? -span(-ta, shunt.angRad) : span(ta, shunt.angRad);
  /* How much of the one behind lies ALONG the first one's axis. Broadside it presents its width
   * rather than its length, and a centre-to-centre offset built from length alone would bury a
   * sideways car halfway into the boot of the one in front. */
  const along = Math.abs(Math.cos(angle)) * rearDef.lengthM
              + Math.abs(Math.sin(angle)) * rearDef.widthM;
  const r4 = (n) => Math.round(n * 10000) / 10000;
  return { x: r4(-(frontDef.lengthM / 2 + sep + along / 2)), y: r4(y), angle: r4(angle) };
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

  /* THE SIXTH AXIS (Milestone 9), drawn LAST and from the same stream. Last on purpose: every
   * draw above it is untouched, so a seed that produced a one-vehicle job before this existed
   * produces exactly the same vehicle, incident, site, damage and forecast now, and the only
   * thing a shunt costs the five older axes is nothing. */
  const shunt = pickWeighted(SHUNTS, rnd);
  const frontDef = casualtyDefById(vehicle.id);
  let second = null;
  let secondLie = null;
  if (shunt.id !== 'none') {
    second = pickWeighted(shuntPartnersFor(frontDef, placed, reputation), rnd);
    secondLie = shuntLie(shunt, frontDef, casualtyDefById(second.id), rnd);
  }

  const mods = { ...incident.mods };
  for (const [k, v] of Object.entries(condition.mods)) mods[k] = v;

  // See SECOND_CASUALTY_SHARE: two recoveries, one turnout, one slot.
  const vehicleMul = vehicle.feeMul + (second ? SECOND_CASUALTY_SHARE * second.feeMul : 0);
  const feeMul = vehicleMul * incident.feeMul * condition.feeMul * weather.feeMul;
  return {
    seed: seed >>> 0,
    vehicle, incident, condition, weather,
    /** The sixth axis: the arrangement, the vehicle behind, and where it is lying relative to the
     *  one in front. All three are null-shaped rather than absent on a one-vehicle job, because a
     *  job with one casualty and a job with two are the same kind of object. */
    shunt, second, secondLie,
    site: placed,
    mods,
    feeMul,
    fee: Math.round(CONFIG.job.baseFee * feeMul),
    /* One sentence, assembled from the axes. It states what happened and never what to do about
     * it — GDD §5, and the same rule the inspect cards follow. A shunt gets a second sentence in
     * the same voice: what is behind it, and that it is coming back too. Never "harder". */
    line: `${frontDef.label} at ${placed.name}: ${incident.line}`
        + (second ? ` A ${casualtyDefById(second.id).label} ${shunt.line}` : ''),
  };
}

/**
 * A situation as a dispatch offer — the same shape `offersFor` emits, so the board, the garage and
 * the scene cannot tell the difference between an authored job and a generated one.
 */
export function situationToOffer(situation, id) {
  const s = situation;
  const secondLabel = s.second ? casualtyDefById(s.second.id).label : null;
  return {
    id,
    type: `${s.vehicle.id}:${s.incident.id}`,
    /* WHAT IS OFF THE ROAD, and how many of it, on the card before the job is taken — the same
     * rule Milestone 6 put the casualty on the card for. A fee half again the usual one has to
     * have a reason printed beside it. */
    title: `${casualtyDefById(s.vehicle.id).label}${secondLabel ? ` and a ${secondLabel}` : ''}`
         + `, ${s.incident.label}`,
    blurb: s.incident.line + (secondLabel ? ` A ${secondLabel} ${s.shunt.line}` : ''),
    seed: s.seed,
    siteId: s.site.id,
    siteName: s.site.name,
    siteBlurb: s.site.blurb,
    weatherId: s.weather.id,
    weatherLabel: s.weather.label,
    weatherBlurb: s.weather.blurb,
    casualtyId: s.vehicle.id,
    casualtyLabel: casualtyDefById(s.vehicle.id).label,
    /* THE SECOND CASUALTY (Milestone 9). Two keys, always present and null on a one-vehicle job,
     * so the offer's key set is the same list whether or not there is a shunt in it — a board, a
     * save file and a scene that have to branch on which KEYS an offer has are three places a
     * two-vehicle job can be forgotten about. `secondLie` is in the first casualty's own body
     * frame (+x out of its nose, +y its right, radians relative to its heading), which is the only
     * frame in which "behind it" survives the vehicle being at 1.35 rad on a bank. */
    secondCasualtyId: s.second ? s.second.id : null,
    secondLie: s.secondLie,
    conditionLabel: s.condition.label,
    feeMul: s.feeMul,
    distanceKm: Math.round((6 + ((s.seed % 220) / 10)) * 10) / 10,
    fee: s.fee,
    mods: { ...s.mods },
    locked: false,
    generated: true,
  };
}

/** For the tests and the debug overlay: the six axes as six words. */
export const describeSituation = (s) => ({
  vehicle: s.vehicle.id,
  incident: s.incident.id,
  site: s.site.id,
  condition: s.condition.id,
  weather: s.weather.id,
  shunt: s.shunt ? s.shunt.id : 'none',
  second: s.second ? s.second.id : null,
  fee: s.fee,
});
