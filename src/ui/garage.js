/* The garage. GDD §7 Milestone 4: "persistent garage lobby ... and authored dispatch selection."
 *
 * A screen, not a room. The GDD says "lobby" and a lobby you can walk around in would be a second
 * game engine for no gain — what a player actually does between jobs is look at four numbers and
 * decide which one to fix, and that is a screen.
 *
 * ── WHAT IT IS ALLOWED TO SAY ────────────────────────────────────────────────────────
 * Facts and prices. Not advice. GDD §9's north star runs through here too: a garage that says
 * "you should repair the winch before taking this job" has answered the question for the player.
 * So it shows what the winch is at, what repairing it costs, what the job pays, and gets out of the
 * way. The one exception is a LOCKED offer, which says what reputation it needs — because that is
 * the only place in the game that explains what reputation is for.
 */

import { CONFIG } from '../config.js';
import {
  activeTruck, conditionEffects, repairQuote, repairTruck, buyGear, gearPrice, describeCompany,
} from '../meta/company.js';
import { offersFor, acceptOffer } from '../meta/dispatch.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const bar = (frac, warnAt = 0.72) => {
  const pct = Math.round(frac * 100);
  const cls = frac < 0.3 ? 'bad' : frac < warnAt ? 'warn' : 'ok';
  return `<span class="cond"><i class="${cls}" style="width:${pct}%"></i></span><b>${pct}%</b>`;
};

export class Garage {
  /**
   * @param {HTMLElement} root
   * @param {object} company
   * @param {(offer:object)=>void} onTakeJob
   */
  constructor(root, company, onTakeJob) {
    this.company = company;
    this.onTakeJob = onTakeJob;
    this.onChange = null;          // called whenever money/condition/stock moved, so main can save
    this.el = document.createElement('div');
    this.el.className = 'screen screen-garage';
    root.appendChild(this.el);
    this.offers = offersFor(company);
    this.note = '';

    /* One delegated click handler for the whole screen rather than a listener per button: the
     * panel is rebuilt from scratch on every change, and per-button listeners would either leak or
     * have to be torn down by hand every time. */
    this.el.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-act]');
      if (!b) return;
      this._act(b.dataset.act, b.dataset.arg);
    });
  }

  show() { this.el.classList.add('on'); this.render(); }
  hide() { this.el.classList.remove('on'); }
  get visible() { return this.el.classList.contains('on'); }

  /** Rebuild the offers — after a job, when the cursor has moved. */
  refresh() {
    this.offers = offersFor(this.company);
    if (this.visible) this.render();
  }

  _act(act, arg) {
    const c = this.company;
    const truck = activeTruck(c);
    if (act === 'repair') {
      const r = repairTruck(c, truck, arg);
      this.note = r.spent > 0
        ? `Spent £${r.spent}${r.done ? '' : ' — as much as you could afford'}.`
        : 'Nothing to fix there.';
    } else if (act === 'buy') {
      const r = buyGear(c, arg, 1);
      this.note = r.bought ? `Bought a ${arg} for £${r.spent}.` : `Cannot afford a ${arg}.`;
    } else if (act === 'take') {
      const offer = this.offers.find((o) => o.id === arg);
      if (!offer || offer.locked) return;
      this.onTakeJob(offer);
      return;                       // main.js hides the garage and starts the job
    }
    if (this.onChange) this.onChange(c);
    this.render();
  }

  render() {
    const c = this.company;
    const truck = activeTruck(c);
    const q = repairQuote(truck);
    const eff = conditionEffects(truck);
    const bits = [];

    bits.push('<div class="card garage-card">');
    bits.push('<h1>THE YARD</h1>');
    bits.push(`<div class="gar-top">
        <div class="gar-stat"><span>on the books</span><b>&pound;${Math.round(c.money)}</b></div>
        <div class="gar-stat"><span>reputation</span><b>${Math.round(c.reputation)}</b></div>
        <div class="gar-stat"><span>jobs</span><b>${c.jobsDelivered}/${c.jobsDone}</b></div>
      </div>`);

    /* The truck. Its condition is printed as what it DOES, not as a health bar with a number:
     * "drive 88%" is a fact about the machine the player is about to take out. */
    bits.push('<div class="gar-panel"><h2>' + esc(truck.name) + '</h2>');
    bits.push(`<div class="gar-row"><span>body</span>${bar(truck.condition.body)}
      <em>drive ${Math.round(eff.driveMul * 100)}% &middot; brakes ${Math.round(eff.brakeMul * 100)}%</em>
      <button data-act="repair" data-arg="body" ${q.body <= 0 || c.money <= 0 ? 'disabled' : ''}>
        ${q.body > 0 ? `fix &pound;${q.body}` : 'as new'}</button></div>`);
    bits.push(`<div class="gar-row"><span>winch</span>${bar(truck.condition.winch)}
      <em>cable holds ${Math.round(CONFIG.winch.cableBreakN * eff.cableMul / 1000)} kN</em>
      <button data-act="repair" data-arg="winch" ${q.winch <= 0 || c.money <= 0 ? 'disabled' : ''}>
        ${q.winch > 0 ? `fix &pound;${q.winch}` : 'as new'}</button></div>`);
    bits.push('</div>');

    // The cupboard. What you own is what goes on the truck.
    bits.push('<div class="gar-panel"><h2>equipment</h2><div class="gar-gear">');
    for (const kind of Object.keys(CONFIG.company.gearPrices)) {
      if (kind === 'default') continue;
      const n = c.stock[kind] || 0;
      bits.push(`<div class="gear-item ${n === 0 ? 'none' : ''}">
        <span>${esc(kind.replace(/([A-Z])/g, ' $1').toLowerCase())}</span>
        <b>${n}</b>
        <button data-act="buy" data-arg="${kind}" ${c.money < gearPrice(kind) ? 'disabled' : ''}
          >+ &pound;${gearPrice(kind)}</button></div>`);
    }
    bits.push('</div></div>');

    // The board.
    bits.push('<div class="gar-panel"><h2>on the board</h2>');
    for (const o of this.offers) {
      if (o.locked) {
        bits.push(`<div class="offer locked">
          <div class="offer-head"><b>${esc(o.title)}</b><span>&pound;${o.fee}</span></div>
          <p>${esc(o.blurb)}</p>
          <p class="offer-lock">needs a reputation of ${o.minRep} &middot; you have ${Math.round(c.reputation)}</p>
        </div>`);
        continue;
      }
      bits.push(`<div class="offer">
        <div class="offer-head"><b>${esc(o.title)}</b><span>&pound;${o.fee}</span></div>
        <p>${esc(o.blurb)}</p>
        <div class="offer-foot">
          <em>${o.distanceKm} km out</em>
          <button class="primary" data-act="take" data-arg="${o.id}">take it</button>
        </div>
      </div>`);
    }
    bits.push('</div>');

    // The ledger, most recent first. Short, and only what happened.
    if (c.ledger.length) {
      bits.push('<div class="gar-panel"><h2>last few</h2><div class="ledger">');
      for (const l of [...c.ledger].reverse().slice(0, 6)) {
        const what = !l.delivered ? 'left on the road'
          : l.clean ? 'delivered clean'
          : `delivered${l.dropped ? `, dropped it ${l.dropped}x` : ''}`
            + `${l.partsLost ? `, ${l.partsLost} part${l.partsLost === 1 ? '' : 's'} off` : ''}`;
        bits.push(`<div class="led-row"><span>#${l.n}</span><em>${esc(what)}</em><b>&pound;${l.paid}</b></div>`);
      }
      bits.push('</div></div>');
    }

    if (this.note) bits.push(`<p class="gar-note">${esc(this.note)}</p>`);
    bits.push('</div>');
    this.el.innerHTML = bits.join('');
  }
}
