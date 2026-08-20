/* Pose the Milestone 4 garage screen for a documentation screenshot.
 *
 * An outfit a few jobs in: some money, a reputation that has opened up better work, a truck that
 * has been used, and a ledger with a bad day in it. All of it goes through the real company object
 * — nothing here is a mock-up of the screen, it is the screen looking at a company.
 */
import { CONFIG } from '../src/config.js';
import { settleJob, activeTruck } from '../src/meta/company.js';

const TB = window.__TB;
const c = TB.company;

// A short history, settled through the real function so the numbers are the numbers.
const recap = (o) => ({
  lines: [],
  summary: {
    delivered: o.delivered !== false,
    dents: o.dents || 0,
    partsLost: o.partsLost || 0,
    partsBent: 0,
    cableSnaps: o.snaps || 0,
    droppedInTransit: o.dropped || 0,
    strapsUsed: 2,
    payout: { baseFee: 1400, deductions: [], deducted: 1400 - o.paid, paid: o.paid, clean: !!o.clean, floored: false },
  },
});

c.money = CONFIG.company.startingMoney;
settleJob(c, recap({ paid: 1400, clean: true }), { impactsNs: 1200, peakTensionN: 12000, cableSnaps: 0 });
settleJob(c, recap({ paid: 1890, clean: true }), { impactsNs: 3000, peakTensionN: 18000, cableSnaps: 0 });
settleJob(c, recap({ paid: 980, dents: 3, partsLost: 1 }), { impactsNs: 42000, peakTensionN: 33000, cableSnaps: 0 });
settleJob(c, recap({ paid: 620, dropped: 1, snaps: 1, partsLost: 1 }), { impactsNs: 61000, peakTensionN: 41000, cableSnaps: 1 });
settleJob(c, recap({ paid: 2100, clean: true }), { impactsNs: 900, peakTensionN: 15000, cableSnaps: 0 });
c.reputation = 46;                 // far enough along to have unlocked the awkward work

TB.garage.refresh();
TB.toYard();
TB.hud.el.title.classList.remove('on');

window.__TB_POSED = {
  money: Math.round(c.money),
  reputation: Math.round(c.reputation),
  condition: activeTruck(c).condition,
  offers: TB.garage.offers.length,
};
