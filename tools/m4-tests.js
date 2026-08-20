/* TOW BROS — Milestone 4 suite: the company.
 *
 *   .\tools\smoketest.ps1 -Tests tools\m4-tests.js
 *
 * GDD §7 Milestone 4: "persistent garage lobby, a small fleet, equipment storage, repairs, money,
 * organization reputation, and authored dispatch selection."
 *
 * The question this suite asks is not "does the UI add up". It is whether the meta-layer is a
 * GAME LAYER or bookkeeping with a screen in front of it — so almost every section ends by
 * checking that a number in the save file has reached a force in the simulation.
 *
 *   Y  the save file: versioning, corruption, and never taking the game down
 *   Z  the company: money, wear, reputation, repairs, equipment
 *   AA the dispatch board: seeded, gated by reputation, and unable to change the rules
 *   AB the loop: does a job you did badly make the next one harder, and is it all still deterministic
 */

import { CONFIG } from '../src/config.js';
import { EVENTS } from '../src/core/eventBus.js';
import { Game } from '../src/game.js';
import { JOB, computePayout, cornersInBay } from '../src/world/scene.js';
import { STARTER_PILE } from '../src/data/equipment.js';
import {
  SAVE_KEY, SAVE_VERSION, LOAD, loadRaw, saveRaw, clearSave, storageAvailable, migrate,
} from '../src/meta/save.js';
import {
  newCompany, newTruck, loadCompany, saveCompany, resetCompany, activeTruck,
  conditionEffects, repairQuote, repairTruck, buyGear, gearPrice, loadOutFor, settleJob,
  describeCompany,
} from '../src/meta/company.js';
import { JOB_TYPES, offersFor, acceptOffer } from '../src/meta/dispatch.js';

/* ── reporting ───────────────────────────────────────────────────────────── */

const lines = [];
let passes = 0, fails = 0;
function ok(name, cond, detail = '') {
  if (cond) { passes++; lines.push(`PASS  ${name}`); }
  else { fails++; lines.push(`FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
}
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const gt = (n, a, b) => ok(n, a > b, `got ${a}, wanted > ${b}`);
const lt = (n, a, b) => ok(n, a < b, `got ${a}, wanted < ${b}`);
const near = (n, a, b, tol) => ok(n, Math.abs(a - b) <= tol, `got ${a}, want ${b} +/- ${tol}`);
const inRange = (n, a, lo, hi) => ok(n, a >= lo && a <= hi, `got ${a}, wanted ${lo}..${hi}`);
const note = (s) => lines.push(`      ${s}`);

let _pre = null;
function emit(status) {
  if (!_pre) {
    _pre = document.createElement('pre');
    _pre.id = 'test-out';
    _pre.style.cssText = 'position:fixed;inset:0;z-index:99999;overflow:auto;background:#06080c;'
      + 'color:#cfe;font:11px ui-monospace,Consolas,monospace;padding:12px;white-space:pre';
    document.body.appendChild(_pre);
  }
  const tail = status || (fails === 0
    ? `ALL-PASS  ${passes} assertions`
    : `FAILURES  ${fails} of ${passes + fails}`);
  _pre.textContent = '==TBTEST-BEGIN==\n' + lines.join('\n') + '\n\n' + tail + '\n==TBTEST-END==';
}

const STEP = CONFIG.sim.stepMs;

/* The suite writes to the real save key, so it takes a copy first and puts it back at the end.
 * A test suite that eats the player's company would be a poor trade for the assertions below. */
let _stash = null;
function borrowStorage() { try { _stash = localStorage.getItem(SAVE_KEY); } catch { _stash = null; } }
function returnStorage() {
  try {
    if (_stash === null) localStorage.removeItem(SAVE_KEY);
    else localStorage.setItem(SAVE_KEY, _stash);
  } catch { /* nothing to put back into */ }
}

/** A finished job, described the way recapFrom() describes one, without running a whole recovery. */
function fakeRecap({ delivered = true, paid = 1400, clean = true, dents = 0, partsLost = 0,
                     dropped = 0, snaps = 0 } = {}) {
  return {
    lines: [],
    summary: {
      delivered, dents, partsLost, partsBent: 0, cableSnaps: snaps,
      droppedInTransit: dropped, strapsUsed: 0,
      payout: { baseFee: 1400, deductions: [], deducted: 1400 - paid, paid, clean, floored: false },
    },
  };
}

/* ── Y. the save file ────────────────────────────────────────────────────── */

function sectionY() {
  lines.push('--- Y. the save file: versioned, and it never takes the game down ---');

  ok('Y1 this browser will let the page store something', storageAvailable());
  clearSave();
  const fresh = loadRaw();
  eq('Y2 nothing stored reads as fresh, not as broken', fresh.status, LOAD.FRESH);
  eq('Y3 with no data', fresh.data, null);

  ok('Y4 a company saves', saveRaw(newCompany()));
  const back = loadRaw();
  eq('Y5 and loads', back.status, LOAD.LOADED);
  eq('Y6 at the current version', back.data.version, SAVE_VERSION);
  ok('Y7 with a timestamp for the player, not for the simulation', typeof back.data.savedAt === 'string');

  /* THE RULE THAT MATTERS: a bad save can never take the game down. A game that will not start
   * because of its own save file is worse than a game with no save file. */
  localStorage.setItem(SAVE_KEY, 'not json at all {{{');
  const corrupt = loadRaw();
  eq('Y8 corrupt JSON is reported, not thrown', corrupt.status, LOAD.UNREADABLE);
  eq('Y9 and hands back nothing rather than half a company', corrupt.data, null);
  ok('Y10 with a sentence a player could read', /read/.test(corrupt.note), corrupt.note);

  localStorage.setItem(SAVE_KEY, '"a string"');
  eq('Y11 valid JSON that is not a save is caught too', loadRaw().status, LOAD.UNREADABLE);

  localStorage.setItem(SAVE_KEY, JSON.stringify({ version: SAVE_VERSION + 5, money: 9 }));
  const future = loadRaw();
  eq('Y12 a save from a later version is refused rather than guessed at', future.status, LOAD.TOO_NEW);
  eq('Y13 and does not leak its numbers in', future.data, null);

  localStorage.setItem(SAVE_KEY, JSON.stringify({ version: 0, money: 4321 }));
  const old = loadRaw();
  eq('Y14 an older save is migrated', old.status, LOAD.MIGRATED);
  eq('Y15 keeping what it had', old.data.money, 4321);
  eq('Y16 and arriving at the current version', old.data.version, SAVE_VERSION);
  eq('Y17 migrate() is a pure function of the object', migrate({ version: 0, money: 7 }, 0).money, 7);

  /* Every one of those has to produce a PLAYABLE company, not an exception. */
  for (const [what, text] of [
    ['corrupt', 'nonsense'],
    ['from the future', JSON.stringify({ version: 99 })],
    ['half-written', JSON.stringify({ version: SAVE_VERSION, money: null, fleet: 'yes' })],
    ['empty', '{}'],
  ]) {
    localStorage.setItem(SAVE_KEY, text);
    const { company } = loadCompany();
    ok(`Y18 a ${what} save still yields a company with money`, Number.isFinite(company.money));
    ok(`Y19 a ${what} save still yields a truck`, !!activeTruck(company));
  }

  // Missing fields fall back to a new company's values, not to undefined.
  localStorage.setItem(SAVE_KEY, JSON.stringify({ version: SAVE_VERSION, money: 250 }));
  const partial = loadCompany().company;
  eq('Y20 what the save DID say is kept', partial.money, 250);
  eq('Y21 and what it did not is defaulted, not undefined', partial.reputation, CONFIG.company.startingReputation);
  eq('Y22 including the fleet', partial.fleet.length, 1);
  ok('Y23 and the equipment cupboard', Object.keys(partial.stock).length > 0);

  clearSave();
  eq('Y24 clearing really clears', loadRaw().status, LOAD.FRESH);
}

/* ── Z. the company ──────────────────────────────────────────────────────── */

function sectionZ() {
  lines.push('--- Z. money, wear, reputation, repairs, equipment ---');

  const c = newCompany();
  eq('Z1 a new outfit has some money', c.money, CONFIG.company.startingMoney);
  eq('Z2 a reputation to build on', c.reputation, CONFIG.company.startingReputation);
  eq('Z3 one truck', c.fleet.length, 1);
  eq('Z4 in as-new condition', activeTruck(c).condition.body, 1);
  eq('Z5 and the starter pile in the cupboard', loadOutFor(c).length, STARTER_PILE.length);
  eq('Z6 with no jobs behind it', c.jobsDone, 0);

  /* CONDITION HAS TO REACH THE PHYSICS, or it is a progress bar. */
  const t = activeTruck(c);
  const newEff = conditionEffects(t);
  eq('Z7 a new truck is not penalised at all', newEff.driveMul, 1);
  eq('Z8 nor its brakes', newEff.brakeMul, 1);
  eq('Z9 nor its cable', newEff.cableMul, 1);
  t.condition.body = 0; t.condition.winch = 0;
  const wornEff = conditionEffects(t);
  lt('Z10 a worn-out truck drives worse', wornEff.driveMul, 1);
  lt('Z11 stops worse', wornEff.brakeMul, 1);
  lt('Z12 and its cable gives up sooner', wornEff.cableMul, 1);
  /* And NOT to zero. GDD §4 says no instant fail; neglect should make a job harder to do well,
   * never impossible to attempt. */
  gt('Z13 but it still drives', wornEff.driveMul, 0.5);
  gt('Z14 still stops', wornEff.brakeMul, 0.5);
  gt('Z15 and the cable still holds something worth having',
     CONFIG.winch.cableBreakN * wornEff.cableMul, 25000);
  note(`Z  worn out: drive ${Math.round(wornEff.driveMul * 100)}%, `
     + `brakes ${Math.round(wornEff.brakeMul * 100)}%, `
     + `cable ${Math.round(CONFIG.winch.cableBreakN * wornEff.cableMul / 1000)} kN`);

  // Repairs.
  const q = repairQuote(t);
  gt('Z16 a written-off truck costs real money to fix', q.total, 500);
  c.money = 10000;
  const r = repairTruck(c, t, 'all');
  eq('Z17 paying for it fixes it', Math.round(t.condition.body * 100), 100);
  eq('Z18 winch too', Math.round(t.condition.winch * 100), 100);
  eq('Z19 and the money is gone', c.money, 10000 - r.spent);
  eq('Z20 repairing an as-new truck costs nothing', repairTruck(c, t, 'all').spent, 0);

  // Partial repairs: you get what you paid for, which beats "you cannot afford this".
  t.condition.body = 0;
  c.money = repairQuote(t).body / 2;
  const partial = repairTruck(c, t, 'body');
  eq('Z21 half the money buys half the repair', Math.round(t.condition.body * 100), 50);
  eq('Z22 and spends all of it', Math.round(c.money), 0);
  ok('Z23 which it admits is not finished', !partial.done);

  // Equipment.
  const c2 = newCompany();
  const before = c2.stock.strap || 0;
  c2.money = 10000;
  const bought = buyGear(c2, 'strap', 2);
  eq('Z24 straps can be bought', c2.stock.strap, before + 2);
  eq('Z25 for money', bought.spent, gearPrice('strap') * 2);
  c2.money = 1;
  eq('Z26 and cannot be bought without it', buyGear(c2, 'jack', 1).bought, 0);
  eq('Z27 the loadout IS the cupboard, so running out means rigging bare',
     loadOutFor(c2).filter((k) => k === 'strap').length, before + 2);

  /* SETTLING UP. The loop the whole milestone exists for. */
  const c3 = newCompany();
  const startMoney = c3.money, startRep = c3.reputation;
  const good = settleJob(c3, fakeRecap({ paid: 1400, clean: true }), { impactsNs: 0, peakTensionN: 12000, cableSnaps: 0 });
  eq('Z28 a clean delivery pays', good.paid, 1400);
  eq('Z29 into the bank', c3.money, startMoney + 1400);
  gt('Z30 and moves the reputation up', c3.reputation, startRep);
  eq('Z31 the job is on the books', c3.jobsDone, 1);
  eq('Z32 and delivered', c3.jobsDelivered, 1);
  eq('Z33 with a line in the ledger', c3.ledger.length, 1);

  const c4 = newCompany();
  const bad = settleJob(c4, fakeRecap({ paid: 400, clean: false, partsLost: 2, dropped: 2, snaps: 1 }),
                        { impactsNs: 90000, peakTensionN: 41000, cableSnaps: 1 });
  lt('Z34 a bad day pays less', bad.paid, good.paid);
  lt('Z35 wears the truck', activeTruck(c4).condition.body, 1);
  lt('Z36 wears the winch harder still, because the cable parted', activeTruck(c4).condition.winch, 0.9);
  lt('Z37 and costs reputation', c4.reputation, CONFIG.company.startingReputation);
  gt('Z38 leaving a repair bill', bad.repairDue, 0);
  note(`Z  bad day: paid £${bad.paid}, body -${Math.round(bad.bodyWear * 100)}%, `
     + `winch -${Math.round(bad.winchWear * 100)}%, rep ${bad.reputation}, £${bad.repairDue} of repairs due`);

  // Abandoning a job is worse for reputation than delivering a damaged car.
  const c5 = newCompany();
  settleJob(c5, fakeRecap({ delivered: false, paid: 0, clean: false }), { impactsNs: 0, peakTensionN: 0, cableSnaps: 0 });
  lt('Z39 walking away from a job costs reputation', c5.reputation, CONFIG.company.startingReputation);
  eq('Z40 and pays nothing', c5.money, CONFIG.company.startingMoney);

  // Reputation is bounded, so a run of bad luck is a setback rather than a spiral.
  const c6 = newCompany();
  for (let i = 0; i < 40; i++) {
    settleJob(c6, fakeRecap({ delivered: false, paid: 0 }), { impactsNs: 0, peakTensionN: 0, cableSnaps: 0 });
  }
  ok('Z41 reputation cannot go below zero', c6.reputation >= 0, String(c6.reputation));
  const c7 = newCompany();
  for (let i = 0; i < 60; i++) {
    settleJob(c7, fakeRecap({ paid: 1400, clean: true }), { impactsNs: 0, peakTensionN: 0, cableSnaps: 0 });
  }
  ok('Z42 nor above a hundred', c7.reputation <= 100, String(c7.reputation));
  lt('Z43 and the ledger is bounded, because a save file is not a log',
     c7.ledger.length, CONFIG.company.ledgerSize + 1);

  // Condition is bounded too: a truck cannot wear past written-off.
  const c8 = newCompany();
  for (let i = 0; i < 30; i++) {
    settleJob(c8, fakeRecap({ paid: 100 }), { impactsNs: 400000, peakTensionN: 42000, cableSnaps: 2 });
  }
  ok('Z44 a truck cannot wear below zero', activeTruck(c8).condition.body >= 0);
  ok('Z45 nor its winch', activeTruck(c8).condition.winch >= 0);

  const d = describeCompany(newCompany());
  ok('Z46 describeCompany reports what the garage needs', d.money > 0 && d.truck && d.effects);
}

/* ── AA. the dispatch board ──────────────────────────────────────────────── */

function sectionAA() {
  lines.push('--- AA. the board: seeded, gated, and forbidden from changing the rules ---');

  const c = newCompany();
  const board = offersFor(c);
  const open = board.filter((o) => !o.locked);
  eq('AA1 the board offers as many jobs as it says it does', open.length, CONFIG.company.offerCount);
  ok('AA2 each with its own seed', open.every((o) => Number.isFinite(o.seed)));
  ok('AA3 a fee', open.every((o) => o.fee > 0));
  ok('AA4 and something to read', open.every((o) => o.blurb && o.title));

  /* SEEDED FROM THE SAVE, not from a clock. A board that rerolls on refresh is a board you
   * refresh until you like it. */
  const again = offersFor(newCompany());
  eq('AA5 the same company sees the same board twice',
     JSON.stringify(board.map((o) => o.seed)), JSON.stringify(again.map((o) => o.seed)));
  const c2 = newCompany();
  c2.dispatchCursor = 1;
  const moved = offersFor(c2);
  ok('AA6 and a different board once a job has been taken',
     JSON.stringify(moved.map((o) => o.seed)) !== JSON.stringify(board.map((o) => o.seed)));

  /* Accepting strikes a job off TODAY's board and spends a slot; the cursor — and therefore the
   * board — moves once, at the end of the day. It used to move per acceptance, and the consequence
   * was that the rivals at day end were awarded jobs the player had never been shown. */
  ok('AA7 accepting a job takes it', acceptOffer(c, open[0]));
  eq('AA7b and strikes it off the board for today', offersFor(c).some((o) => o.id === open[0].id), false);
  eq('AA8 while the rest of the day board stands', c.dispatchCursor, 0);
  eq('AA8b so the other jobs are still there for the second slot',
     offersFor(c).filter((o) => !o.locked).length, CONFIG.company.offerCount - 1);
  const locked = board.find((o) => o.locked);
  ok('AA9 a locked job cannot be accepted', locked ? !acceptOffer(c, locked) : true);

  /* REPUTATION GATES THE WORK, which is the only thing that makes reputation mean anything. */
  const rookie = newCompany();
  rookie.reputation = 0;
  const rookieBoard = offersFor(rookie);
  gt('AA10 a new outfit has jobs it cannot get yet', rookieBoard.filter((o) => o.locked).length, 0);
  ok('AA11 and every locked one says what it needs',
     rookieBoard.filter((o) => o.locked).every((o) => o.minRep > 0));
  /* Authored offers only. From Milestone 6 one slot on the board is a GENERATED situation
   * (src/meta/situations.js), whose `type` is a vehicle-and-incident pair rather than a JOB_TYPES
   * id — it gates its own vehicle pool on reputation and is asserted in the m6 suite. */
  ok('AA12 while the ones it CAN take are within its reputation',
     rookieBoard.filter((o) => !o.locked && !o.generated).every((o) => {
       const t = JOB_TYPES.find((jt) => jt.id === o.type);
       return t && rookie.reputation >= t.minRep;
     }));

  const veteran = newCompany();
  veteran.reputation = 100;
  const vetBoard = offersFor(veteran);
  eq('AA13 an outfit with a name gets everything', vetBoard.filter((o) => o.locked).length, 0);
  gt('AA14 including work that pays more',
     Math.max(...vetBoard.map((o) => o.fee)), Math.max(...rookieBoard.filter((o) => !o.locked).map((o) => o.fee)));

  /* WHAT AN OFFER MAY NOT DO. GDD §4: no scripted sequence, no mandatory tool. A dispatch board is
   * not allowed to take that back, so the modifier surface is deliberately tiny and this asserts
   * exactly which keys are in it. */
  const allowed = new Set(['boggedMul', 'seizedChance', 'dentChance', 'dentsMax', 'lieSpread', 'lieBias']);
  const stray = [];
  for (const t of JOB_TYPES) for (const k of Object.keys(t.mods)) if (!allowed.has(k)) stray.push(`${t.id}.${k}`);
  eq('AA15 offers may only change how the car arrived, nothing else', stray.length, 0, stray.join(', '));
  ok('AA16 none of them touches a force', JOB_TYPES.every((t) => !('springK' in t.mods) && !('motorMaxN' in t.mods)));
  ok('AA17 every template pays at least the standard fee', JOB_TYPES.every((t) => t.feeMul >= 1));
  ok('AA18 and the harder ones pay more',
     JOB_TYPES.find((t) => t.id === 'rolled').feeMul > JOB_TYPES.find((t) => t.id === 'routine').feeMul);
  note(`AA  ${JOB_TYPES.length} job types, fees ${JOB_TYPES.map((t) => t.feeMul).join('/')}x`);
}

/* ── AB. the loop ────────────────────────────────────────────────────────── */

async function sectionAB() {
  lines.push('--- AB. does the company reach the simulation, and is it all still deterministic ---');

  /* A job packet, the way main.js builds one: the offer's modifiers plus the outfit's own kit. */
  const company = newCompany();
  const offer = offersFor(company).find((o) => !o.locked);
  const packet = {
    ...offer,
    loadout: loadOutFor(company),
    effects: conditionEffects(activeTruck(company)),
  };

  const g = new Game({ seed: offer.seed, seedLabel: 'm4' });
  g.job = packet;
  g.startJob({ reroll: false, attempt: 1 });
  const st = g.state;

  eq('AB1 the scene lays out the outfit\'s own equipment', st.gear.length, packet.loadout.length);
  eq('AB2 the fee the board advertised is the fee the job carries', st.job.feeMul, offer.feeMul);
  eq('AB3 and it knows which offer it is', st.job.offerId, offer.id);

  /* THE PROMISE THE BOARD MAKES. It advertises a number; the payout has to be that number less
   * what the player broke. It was not: computePayout read the standard fee straight out of CONFIG
   * and quietly paid £1320 for a job the board had advertised at £1890. */
  const pay = computePayout(st, g.bus);
  eq('AB4 a clean job pays exactly what the board advertised', pay.paid, offer.fee);
  eq('AB5 and the fee it shows is that one, not the standard one', pay.baseFee, offer.fee);
  /* And only for what the RECOVERY did. A job that arrives with a dented car is a job with a
   * history (GDD §4); charging the operator for the crash they were called out to is not a
   * consequence of anything they decided, and it was — this offer advertised £1890 and paid
   * £1810 because the two dents it turned up with came off the fee. */
  const arrivedWith = st.vehicles.sedan.damage.arrived.dents;
  st.vehicles.sedan.damage.dents = arrivedWith + 2;
  const dented = computePayout(st, g.bus);
  eq('AB6 with damage coming off THAT fee', dented.paid, offer.fee - 2 * CONFIG.job.dentCost);
  ok('AB6b and the damage it arrived with costing nothing', arrivedWith >= 0);
  note(`AB  board said £${offer.fee}, job paid £${pay.paid} (arrived with ${arrivedWith} dents), `
     + `two more £${dented.paid}`);

  /* EQUIPMENT REACHES THE GROUND. Run out of straps and there are no straps at the site. */
  const poor = newCompany();
  poor.stock = { chock: 1 };
  const g2 = new Game({ seed: 555, seedLabel: 'poor' });
  g2.job = { loadout: loadOutFor(poor), effects: conditionEffects(activeTruck(poor)), mods: {} };
  g2.startJob({ reroll: false, attempt: 1 });
  eq('AB7 an outfit with one chock turns up with one chock', g2.state.gear.length, 1);
  eq('AB8 and it is a chock', g2.state.gear[0].kind, 'chock');
  eq('AB9 with no strap anywhere on site', g2.state.gear.filter((q) => q.kind === 'strap').length, 0);

  /* CONDITION REACHES THE FORCES. Same seed, same everything, one worn-out truck. */
  function driveTest(bodyCondition) {
    const co = newCompany();
    activeTruck(co).condition.body = bodyCondition;
    activeTruck(co).condition.winch = bodyCondition;
    const gg = new Game({ seed: 7777, seedLabel: 'cond' });
    gg.job = { loadout: null, effects: conditionEffects(activeTruck(co)), mods: {} };
    gg.startJob({ reroll: false, attempt: 1 });
    const tr = gg.state.vehicles.truck;
    tr.body.x = 60; tr.body.y = 10; tr.body.angle = 0;
    tr.body.vx = 0; tr.body.vy = 0; tr.body.omega = 0;
    tr.parkBrake = false; tr.occupiedBy = 'crew0';
    for (let i = 0; i < 180; i++) { tr.throttle = 1; gg.step(STEP, gg.state.simTimeMs + STEP, null); }
    return { speed: tr.body.speed, cableN: CONFIG.winch.cableBreakN * gg.state.winch.strengthMul };
  }
  const fresh = driveTest(1);
  const worn = driveTest(0);
  gt('AB10 a new truck accelerates', fresh.speed, 3);
  lt('AB11 a worn-out one accelerates less', worn.speed, fresh.speed - 0.3);
  gt('AB12 but it still moves — neglect is a cost, not a wall', worn.speed, 2);
  lt('AB13 and its cable gives up sooner', worn.cableN, fresh.cableN);
  note(`AB  after 3 s: new truck ${fresh.speed.toFixed(2)} m/s, worn ${worn.speed.toFixed(2)} m/s · `
     + `cable ${(fresh.cableN / 1000).toFixed(0)} -> ${(worn.cableN / 1000).toFixed(0)} kN`);

  /* THE MODIFIERS REACH THE SCENE — and only the parts they are allowed to reach. */
  function sceneFor(mods, seed = 909) {
    const gg = new Game({ seed, seedLabel: 'mods' });
    gg.job = { mods, loadout: null, effects: null };
    gg.startJob({ reroll: false, attempt: 1 });
    return gg.state;
  }
  const plain = sceneFor({ boggedMul: 1.0, seizedChance: 0, dentChance: 0 });
  const heavy = sceneFor({ boggedMul: 1.55, seizedChance: 0, dentChance: 0 });
  gt('AB14 a "dug in overnight" job really is dug in further',
     heavy.vehicles.sedan.boggedN, plain.vehicles.sedan.boggedN);
  eq('AB15 a job with no seized wheels has none', sceneFor({ seizedChance: 0, dentChance: 0 })
     .vehicles.sedan.wheelState.filter((w) => w.locked).length, 0);
  eq('AB16 and one that always seizes has one', sceneFor({ seizedChance: 1, dentChance: 0 })
     .vehicles.sedan.wheelState.filter((w) => w.locked).length, 1);
  eq('AB17 a contract job arrives without a scratch', sceneFor({ dentChance: 0 }).vehicles.sedan.damage.dents, 0);
  gt('AB18 and a wreck arrives with several',
     sceneFor({ dentChance: 1, dentsMax: 6 }).vehicles.sedan.damage.dents, 0);
  ok('AB19 the terrain is the same site whatever the job',
     Math.abs(plain.terrain.mud.x - heavy.terrain.mud.x) < 1e-9);
  ok('AB20 with the same guardrail', Math.abs(plain.terrain.rail.gapX0 - heavy.terrain.rail.gapX0) < 1e-9);

  /* AND IT IS ALL STILL DETERMINISTIC. Everything above adds state that a step could read, and
   * none of it may — the whole netcode rests on this. */
  /* The car has to actually MOVE for a bogged-in modifier to reach a signature. The first version
   * of this set winch.motor with nothing attached, so the sedan sat on the bank in both runs and
   * the two signatures were trivially equal — a test that proved nothing and reported that it had.
   * Releasing the handbrake lets the slope do the work, and bogged resistance is what it fights. */
  function sig(seed, mods) {
    const gg = new Game({ seed, seedLabel: 'det' });
    gg.job = { mods, loadout: null, effects: conditionEffects(newTruck('t', 't')) };
    gg.startJob({ reroll: false, attempt: 2 });
    gg.state.vehicles.sedan.parkBrake = false;
    gg.skipMs(6000);
    const b = gg.state.vehicles.sedan.body;
    return [b.x, b.y, b.angle, b.vx, b.vy, b.omega].map((n) => n.toFixed(9)).join(',');
  }
  eq('AB21 a job with modifiers replays bit-for-bit', sig(2468, { boggedMul: 1.3 }), sig(2468, { boggedMul: 1.3 }));
  ok('AB22 and a car dug in further really does behave differently',
     sig(2468, { boggedMul: 1.0 }) !== sig(2468, { boggedMul: 2.4 }),
     `${sig(2468, { boggedMul: 1.0 }).slice(0, 46)} vs ${sig(2468, { boggedMul: 2.4 }).slice(0, 46)}`);

  /* A JOB WITH NO COMPANY BEHIND IT IS THE MILESTONE 1-3 GAME, EXACTLY. That is the whole reason
   * the defaults are what they are, and it is what keeps three suites of prior assertions valid. */
  const plainGame = new Game({ seed: 4242, seedLabel: 'plain' });
  plainGame.startJob({ reroll: false, attempt: 1 });
  eq('AB23 no job means no fee multiplier', plainGame.state.job.feeMul, 1);
  eq('AB24 a full starter pile', plainGame.state.gear.length, STARTER_PILE.length);
  eq('AB25 a truck at full drive', plainGame.state.vehicles.truck.driveMul, 1);
  eq('AB26 full brakes', plainGame.state.vehicles.truck.brakeMul, 1);
  eq('AB27 and a new cable', plainGame.state.winch.strengthMul, 1);

  /* The live page, wired end to end. */
  const TB = window.__TB;
  ok('AB28 the live game has a company', !!TB.company);
  ok('AB29 and a yard to run it from', !!TB.garage);
  gt('AB30 with jobs on the board', TB.garage.offers.filter((o) => !o.locked).length, 0);
  eq('AB31 no errors on the crash banner', document.getElementById('err-banner'), null);
}

/* ── run ─────────────────────────────────────────────────────────────────── */

(async function run() {
  borrowStorage();
  const sections = [['Y', sectionY], ['Z', sectionZ], ['AA', sectionAA], ['AB', sectionAB]];
  for (const [name, fn] of sections) {
    try { await fn(); }
    catch (e) {
      fails++;
      lines.push(`FAIL  section ${name} threw: ${e && e.message}`);
      lines.push(`      ${(e && e.stack || '').split('\n').slice(1, 4).join('\n      ')}`);
    }
    emit(`... through section ${name}`);
  }
  returnStorage();
  emit();
})();
