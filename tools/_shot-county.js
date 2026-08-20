/* Pose the Milestone 5 yard for a documentation screenshot: an outfit a few days in, looking at
 * the county and the board that goes with it.
 *
 * Same approach as tools/_shot-yard.js — everything goes through the real company object, so the
 * numbers on the screen are numbers the game produced.
 */
import { CONFIG } from '../src/config.js';
import { settleJob, activeTruck } from '../src/meta/company.js';

const TB = window.__TB;
const c = TB.company;

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
c.reputation = 46;

// A couple of days in, with yesterday's leftovers gone to the competition.
c.day = 3;
c.dispatchCursor = 2;
c.slotsLeft = 2;
c.takenToday = [];
c.rivalTook = [
  { title: 'Dug in overnight', site: 'the quarry approach', fee: 1890, by: 'Coastline Recovery' },
  { title: 'Routine recovery', site: 'the ford at Marle Brook', fee: 1400, by: 'A38 Rescue' },
];

TB.garage.refresh();
TB.toYard();
TB.hud.el.title.classList.remove('on');

// Scroll to the county, so the map and the board it belongs to are in the same frame.
requestAnimationFrame(() => {
  const county = TB.garage.el.querySelector('.gar-county');
  if (county) county.scrollIntoView({ block: 'start' });
});

window.__TB_POSED = {
  day: c.day,
  offers: TB.garage.offers.filter((o) => !o.locked).length,
  sitesOnMap: TB.garage.el.querySelectorAll('.county-site').length,
};
