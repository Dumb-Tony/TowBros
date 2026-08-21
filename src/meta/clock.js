/* The county's afternoon. GDD §7 Milestone 7: "a job clock".
 *
 * Six milestones and nothing in this game has ever been in a hurry. Every decision so far has cost
 * something — line, grip, gear, a bumper, a reputation — except the one every recovery operator
 * actually spends most of: TIME. So a job that takes all afternoon should cost the afternoon.
 *
 * ── WHY THIS IS NOT A TIMER ──────────────────────────────────────────────────────────
 * A countdown with a fail state would break GDD §4 ("no instant fail") and, worse, would answer the
 * north-star question for the player: a game that says "hurry up" has told them what to do. So
 * nothing here ever stops a job or takes one away mid-recovery. What it does is spend the day:
 *
 *   the clock runs while you work    a recovery that takes 90 s of simulation is four hours
 *   the light goes with it           and the light level is already wired to traffic's sight
 *                                    distance and to the renderer, so dusk is a real consequence
 *                                    of a slow morning rather than a filter over the screen
 *   the day ends when it ends        two slots OR the light, whichever runs out first
 *
 * That puts "do it properly" and "do it now" in tension for the first time, and leaves the choice
 * entirely with the player. Take the long careful route on the first job and the second one is in
 * the dark; rush the first and you are working on a car you have damaged.
 *
 * ── AND WHY IT IS NOT A WALL CLOCK ───────────────────────────────────────────────────
 * For the same reason nothing else in this project reads real time: a meta-layer that advances
 * while nobody is looking is a game that plays itself. The clock advances when a JOB does, by the
 * simulated time that job took, and by nothing else.
 */

import { CONFIG } from '../config.js';

const pad = (n) => String(n).padStart(2, '0');

/** Minutes of the working day that have been spent. */
export const minutesUsed = (company) => Math.max(0, (company.clockMin || 0));

/** The hour of the day, as a number. 8.5 is half past eight. */
export function hourOf(company) {
  const C = CONFIG.company;
  return C.dayStartHour + minutesUsed(company) / 60;
}

/** "14:20". For the garage and the HUD. */
export function clockLabel(company) {
  const h = hourOf(company);
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${pad(hh % 24)}:${pad(mm % 60)}`;
}

/** Minutes of working day left before the light goes. Negative means you are past it. */
export function minutesLeft(company) {
  const C = CONFIG.company;
  return (C.dayEndHour - C.dayStartHour) * 60 - minutesUsed(company);
}

/**
 * How much daylight there is at this point in the day, 0..1.
 *
 * Flat through the middle of the day and falling away at the ends, because the interesting part is
 * the last two hours and a linear ramp from dawn would spend most of its range on nothing. The
 * floor is not zero: a recovery crew arrives with lights on the truck, and a scene lit only by
 * those is dark, not invisible.
 */
export function daylightAt(company) {
  const C = CONFIG.company;
  const h = hourOf(company);
  const duskStart = C.dayEndHour - C.duskHours;
  if (h <= duskStart) return 1;
  const t = Math.min(1, (h - duskStart) / Math.max(0.001, C.duskHours + C.afterDarkHours));
  return Math.max(C.nightLightFloor, 1 - t * (1 - C.nightLightFloor));
}

/**
 * What a job takes out of the day.
 *
 * `simMsPerHour` is the exchange rate, and it is the one number here worth arguing about. Measured
 * against the suites: a clean far-lane recovery is 39 s of simulation, a mid-road one 35 s, a box
 * truck in two parks 67 s, and the delivery leg adds 20-30 s on top.
 *
 * At **9 500 ms to the hour** a straightforward job is 4.1 hours and a bad 90-second one is 9.5 —
 * so two ordinary recoveries fill the day and the second one finishes at 16:13, in falling light.
 *
 * It was first written at 12 000, which made the same job 3.3 hours: two of them finished at 14:40,
 * the light never went, and the clock cost nothing at all. **If a clock never changes an outcome,
 * the exchange rate is wrong, not the idea.** This paragraph went on quoting the 12 000 numbers
 * after the retune and an audit caught it — the module that owns the clock was documenting the
 * number it does not use.
 */
export function jobMinutes(simTimeMs) {
  return (simTimeMs / CONFIG.company.simMsPerHour) * 60;
}

/**
 * Spend a job's time. Called once, when a job settles.
 * @returns {{minutes:number, clockMin:number, ranOut:boolean}}
 */
export function spendTime(company, simTimeMs) {
  const minutes = jobMinutes(simTimeMs);
  company.clockMin = minutesUsed(company) + minutes;
  return {
    minutes: Math.round(minutes),
    clockMin: company.clockMin,
    ranOut: minutesLeft(company) <= 0,
  };
}

/** Start of a new working day. */
export function resetClock(company) {
  company.clockMin = 0;
  return company;
}

/** For the garage, the HUD and the tests. Facts only — GDD §5. */
export function describeClock(company) {
  const left = minutesLeft(company);
  const hrs = Math.floor(Math.abs(left) / 60);
  const mins = Math.round(Math.abs(left) % 60);
  return {
    label: clockLabel(company),
    hour: Math.round(hourOf(company) * 100) / 100,
    minutesLeft: Math.round(left),
    daylight: Math.round(daylightAt(company) * 100) / 100,
    /* A statement about the sky, not an instruction about what to do with it. */
    light: left <= 0 ? 'dark'
      : daylightAt(company) >= 0.999 ? 'daylight'
      : 'getting dark',
    leftLabel: left <= 0
      ? 'the light has gone'
      : `${hrs > 0 ? `${hrs}h ` : ''}${mins}m of light left`,
  };
}
