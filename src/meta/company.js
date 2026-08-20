/* The company. GDD §7 Milestone 4.
 *
 * Money, a small fleet, equipment stock, repairs and a reputation — the layer above the job that
 * makes one recovery matter to the next one.
 *
 * ── THE RULE THAT KEEPS THIS HONEST ──────────────────────────────────────────────────
 * Every number here has to REACH THE SIMULATION, or it is bookkeeping with a UI. So:
 *
 *   truck condition   scales drive force and brakes. A neglected wrecker is a worse wrecker.
 *   winch condition   scales what the cable can take before it parts.
 *   equipment stock   you take what you own to a job. Run out of straps and you tow it bare.
 *   reputation        decides which jobs get offered to you at all.
 *   money             pays for all of the above, and comes from the payout you earned.
 *
 * That last loop is the whole milestone: a job you did badly costs you money, which buys fewer
 * repairs and less gear, which makes the next job harder. Nothing punishes you; the consequences
 * are all the same kind of consequence the physics already produces.
 *
 * ── AND THE RULE THAT KEEPS IT DETERMINISTIC ─────────────────────────────────────────
 * The company is NOT part of the simulation. It picks a seed and hands it over; from that point the
 * fixed step is on its own and reproduces exactly as it always has. Nothing in here is read inside
 * a step, and nothing in here may be — the m1/m2/m3 determinism assertions all still hold with a
 * company attached because there is no path from one to the other.
 */

import { CONFIG } from '../config.js';
import { STARTER_PILE } from '../data/equipment.js';
import { loadRaw, saveRaw, clearSave, LOAD } from './save.js';

/** What a fleet vehicle looks like. Condition is 0..1 and 1 is "as new". */
export function newTruck(id, name) {
  return { id, name, condition: { body: 1, winch: 1 }, jobs: 0 };
}

/** A brand-new company, which is also the shape every save must have. */
export function newCompany() {
  const stock = {};
  for (const kind of STARTER_PILE) stock[kind] = (stock[kind] || 0) + 1;
  return {
    money: CONFIG.company.startingMoney,
    reputation: CONFIG.company.startingReputation,
    jobsDone: 0,
    jobsDelivered: 0,
    /** Monotonic, and the ONLY thing dispatch draws its seeds from. Never a clock. */
    dispatchCursor: 0,
    fleet: [newTruck('t1', 'the old Ford')],
    activeTruckId: 't1',
    stock,
    /** The last few jobs, for the garage's ledger. Bounded — this is a save file, not a log. */
    ledger: [],
  };
}

/** Load, or make a new one. Never throws; the status says what happened. */
export function loadCompany() {
  const res = loadRaw();
  if (!res.data) return { company: newCompany(), status: res.status, note: res.note };
  // A save is trusted only as far as its shape. Anything missing falls back to a new company's
  // value rather than to undefined, because `undefined` money is a very annoying bug to find.
  const base = newCompany();
  const d = res.data;
  const company = {
    ...base,
    money: num(d.money, base.money),
    reputation: clamp01to100(num(d.reputation, base.reputation)),
    jobsDone: num(d.jobsDone, 0) | 0,
    jobsDelivered: num(d.jobsDelivered, 0) | 0,
    dispatchCursor: num(d.dispatchCursor, 0) | 0,
    fleet: Array.isArray(d.fleet) && d.fleet.length ? d.fleet.map(fixTruck) : base.fleet,
    stock: (d.stock && typeof d.stock === 'object') ? { ...base.stock, ...d.stock } : base.stock,
    ledger: Array.isArray(d.ledger) ? d.ledger.slice(-CONFIG.company.ledgerSize) : [],
  };
  company.activeTruckId = company.fleet.some((t) => t.id === d.activeTruckId)
    ? d.activeTruckId : company.fleet[0].id;
  return { company, status: res.status, note: res.note };
}

export function saveCompany(company) { return saveRaw(company); }
export function resetCompany() { clearSave(); return newCompany(); }

const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clamp01to100 = (v) => Math.max(0, Math.min(100, v));
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function fixTruck(t) {
  const base = newTruck(String(t && t.id || 't1'), String(t && t.name || 'a truck'));
  if (!t || typeof t !== 'object') return base;
  return {
    ...base,
    condition: {
      body: clamp01(num(t.condition && t.condition.body, 1)),
      winch: clamp01(num(t.condition && t.condition.winch, 1)),
    },
    jobs: num(t.jobs, 0) | 0,
  };
}

export const activeTruck = (c) => c.fleet.find((t) => t.id === c.activeTruckId) || c.fleet[0];

/* ── what condition does to the machine ────────────────────────────────────── */

/**
 * The multipliers a truck's condition applies to the simulation.
 *
 * Deliberately mild and deliberately not zero: a wrecker at 40% is a worse wrecker, not a brick.
 * GDD §4's "no instant fail" reasoning extends here — neglect should make a job harder to do well,
 * never impossible to attempt.
 */
export function conditionEffects(truck) {
  const C = CONFIG.company;
  const body = truck ? truck.condition.body : 1;
  const winch = truck ? truck.condition.winch : 1;
  return {
    driveMul: 1 - (1 - body) * C.bodyDrivePenalty,
    brakeMul: 1 - (1 - body) * C.bodyBrakePenalty,
    cableMul: 1 - (1 - winch) * C.winchStrengthPenalty,
  };
}

/** What it costs to put a truck back to new. */
export function repairQuote(truck) {
  const C = CONFIG.company;
  const body = Math.round((1 - truck.condition.body) * C.bodyRepairFull);
  const winch = Math.round((1 - truck.condition.winch) * C.winchRepairFull);
  return { body, winch, total: body + winch };
}

/** Spend the money and fix it. Partial repairs are allowed: you pay for what you can afford. */
export function repairTruck(company, truck, part = 'all') {
  const q = repairQuote(truck);
  const want = part === 'body' ? q.body : part === 'winch' ? q.winch : q.total;
  if (want <= 0) return { spent: 0, done: true };
  const spend = Math.min(company.money, want);
  const frac = spend / want;
  if (part !== 'winch') truck.condition.body = clamp01(truck.condition.body + (1 - truck.condition.body) * frac);
  if (part !== 'body') truck.condition.winch = clamp01(truck.condition.winch + (1 - truck.condition.winch) * frac);
  company.money -= spend;
  return { spent: Math.round(spend), done: frac >= 1 - 1e-9 };
}

/* ── equipment ─────────────────────────────────────────────────────────────── */

export function gearPrice(kind) {
  return CONFIG.company.gearPrices[kind] ?? CONFIG.company.gearPrices.default;
}

export function buyGear(company, kind, n = 1) {
  const price = gearPrice(kind) * n;
  if (company.money < price) return { bought: 0, spent: 0 };
  company.money -= price;
  company.stock[kind] = (company.stock[kind] || 0) + n;
  return { bought: n, spent: price };
}

/** What goes in the truck for a job: the stock, as a list of kinds the scene can lay out. */
export function loadOutFor(company) {
  const out = [];
  for (const [kind, n] of Object.entries(company.stock)) {
    for (let i = 0; i < n; i++) out.push(kind);
  }
  return out;
}

/* ── settling up ───────────────────────────────────────────────────────────── */

/**
 * Close a job out: bank the money, wear the truck, move the reputation, and record it.
 *
 * Reads the finished simulation and writes the company. One direction only — nothing here reaches
 * back into the state it is reading, so a job can be settled twice without corrupting anything
 * (the caller guards that; this stays pure enough to test).
 *
 * @param {object} company
 * @param {object} recap    from world/scene.js recapFrom()
 * @param {object} wear     { impactsNs, peakTensionN, cableSnaps, gearLost }
 */
export function settleJob(company, recap, wear) {
  const C = CONFIG.company;
  const truck = activeTruck(company);
  const s = recap.summary;
  const paid = s.delivered && s.payout ? s.payout.paid : 0;

  company.money += paid;
  company.jobsDone += 1;
  if (s.delivered) company.jobsDelivered += 1;
  truck.jobs += 1;

  /* Wear. The body takes what it was hit with; the winch takes how hard it was worked, and a
   * parted cable is most of a winch service on its own. Both are fractions of a whole condition,
   * so the numbers below are "how many jobs like this before it needs attention". */
  const bodyWear = (wear.impactsNs || 0) / C.bodyWearRefNs;
  const winchWear = (wear.peakTensionN || 0) / C.winchWearRefN
    + (wear.cableSnaps || 0) * C.winchWearPerSnap;
  truck.condition.body = clamp01(truck.condition.body - bodyWear);
  truck.condition.winch = clamp01(truck.condition.winch - winchWear);

  /* Reputation. Delivering moves it up, damage moves it down, and dropping a customer's car in the
   * road moves it down a lot. It is bounded and it drifts back toward the middle, so one bad day is
   * a setback rather than a spiral. */
  let rep = company.reputation;
  if (s.delivered) rep += s.payout && s.payout.clean ? C.repClean : C.repDelivered;
  else rep += C.repAbandoned;
  rep -= (s.partsLost || 0) * C.repPerPartLost;
  rep -= (s.droppedInTransit || 0) * C.repPerDrop;
  rep -= (s.cableSnaps || 0) * C.repPerSnap;
  company.reputation = clamp01to100(rep);

  // Gear that was destroyed is gone and has to be bought again. Gear merely left lying at the site
  // comes home in the truck, because it is your gear and you are not going to leave it there.
  for (const kind of wear.gearLost || []) {
    if (company.stock[kind] > 0) company.stock[kind] -= 1;
  }

  company.ledger.push({
    n: company.jobsDone,
    paid,
    delivered: !!s.delivered,
    clean: !!(s.payout && s.payout.clean),
    dents: s.dents || 0,
    partsLost: s.partsLost || 0,
    dropped: s.droppedInTransit || 0,
    rep: Math.round(company.reputation),
  });
  if (company.ledger.length > C.ledgerSize) company.ledger.shift();

  return {
    paid,
    bodyWear: Math.round(bodyWear * 100) / 100,
    winchWear: Math.round(winchWear * 100) / 100,
    reputation: Math.round(company.reputation),
    repairDue: repairQuote(truck).total,
  };
}

/** For the garage, the debug overlay and the tests. */
export function describeCompany(c) {
  const t = activeTruck(c);
  return {
    money: Math.round(c.money),
    reputation: Math.round(c.reputation),
    jobsDone: c.jobsDone,
    jobsDelivered: c.jobsDelivered,
    truck: t.name,
    condition: { body: Math.round(t.condition.body * 100), winch: Math.round(t.condition.winch * 100) },
    repairDue: repairQuote(t).total,
    stock: { ...c.stock },
    effects: conditionEffects(t),
  };
}
