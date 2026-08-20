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
import { SITES } from '../data/terrain.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const bar = (frac, warnAt = 0.72) => {
  const pct = Math.round(frac * 100);
  const cls = frac < 0.3 ? 'bad' : frac < warnAt ? 'warn' : 'ok';
  return `<span class="cond"><i class="${cls}" style="width:${pct}%"></i></span><b>${pct}%</b>`;
};

/**
 * The county, as a map. GDD §7 Milestone 5: "connect job scenes with a regional map or compact open
 * county."
 *
 * It is a MAP, not a level select and not a travel system. Every site is on it whether or not there
 * is work there today, because the point of a county is that it exists when you are not in it — the
 * quarry is up the far end of the valley on a morning when nobody has gone off the road there.
 *
 * Drawn as inline SVG for the same reason everything else here is hand-built: an external tile or
 * an image file would be the first outbound request this game has ever made.
 */
function countyMap(offers, focusId) {
  // A site can have more than one job on it — the map says the best one and how many there are,
  // rather than silently showing whichever happened to be last in the list.
  const live = new Map();
  for (const o of offers) {
    if (o.locked || !o.siteId) continue;
    const prev = live.get(o.siteId);
    live.set(o.siteId, { fee: Math.max(o.fee, prev ? prev.fee : 0), n: (prev ? prev.n : 0) + 1 });
  }

  const W = 300, H = 132;
  const px = (s) => (12 + s.map.x * (W - 24)).toFixed(1);
  const py = (s) => (14 + s.map.y * (H - 34)).toFixed(1);
  const bits = [`<svg class="county" viewBox="0 0 ${W} ${H}" role="img" aria-label="the county">`];

  /* The road network, authored rather than derived. Joining the sites in x order drew a lane that
   * doubled back on itself between the bridge and the quarry, which reads as a mistake rather than
   * as a county — so the valley road runs ford → bend → bridge → yard and the quarry hangs off it
   * on a spur, which is what a quarry approach is. */
  const at = (id) => SITES.find((s) => s.id === id);
  const leg = (ids) => ids.map((id, i) => (at(id) ? `${i ? 'L' : 'M'}${px(at(id))} ${py(at(id))}` : '')).join(' ');
  bits.push(`<path class="county-road" d="${leg(['ford', 'bend', 'bridge'])} L${W - 16} ${H - 22}"/>`);
  if (at('bend') && at('quarry')) bits.push(`<path class="county-road spur" d="${leg(['bend', 'quarry'])}"/>`);
  bits.push(`<circle class="county-yard" cx="${W - 16}" cy="${H - 22}" r="4"/>`);
  bits.push(`<text class="county-label" x="${W - 22}" y="${H - 8}" text-anchor="end">the yard</text>`);

  for (const s of SITES) {
    const o = live.get(s.id);
    const cls = ['county-site', o ? 'live' : 'quiet', focusId === s.id ? 'focus' : ''].join(' ');
    const x = px(s), y = py(s);
    bits.push(`<g class="${cls}" data-act="site" data-arg="${s.id}">`);
    if (o) bits.push(`<circle class="county-ring" cx="${x}" cy="${y}" r="9"/>`);
    bits.push(`<circle class="county-dot" cx="${x}" cy="${y}" r="4.5"/>`);
    bits.push(`<text class="county-label" x="${x}" y="${+y - 11}" text-anchor="middle">${esc(s.short)}</text>`);
    if (o) {
      bits.push(`<text class="county-fee" x="${x}" y="${+y + 17}" text-anchor="middle">&#163;${o.fee}`
        + `${o.n > 1 ? `<tspan class="county-n"> &#215;${o.n}</tspan>` : ''}</text>`);
    }
    bits.push('</g>');
  }
  bits.push('</svg>');
  return bits.join('');
}

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
    /** A site clicked on the map. Narrows the board to that place; it does not take the job. */
    this.focusSite = null;

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
    } else if (act === 'site') {
      /* Clicking a place on the map narrows the board to it, and clicking it again puts the rest
       * back. It deliberately does NOT take the job: a map is for looking at, and a mis-click that
       * launches you at a quarry in the dark would be a trap rather than a shortcut. */
      this.focusSite = this.focusSite === arg ? null : arg;
      this.note = '';
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
        <div class="gar-stat"><span>day ${c.day}</span><b>${c.slotsLeft} left</b></div>
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

    // The county, and the board that goes with it.
    const focus = this.focusSite;
    const focusSite = focus ? SITES.find((s) => s.id === focus) : null;
    bits.push('<div class="gar-panel gar-county"><h2>the county</h2>');
    bits.push(countyMap(this.offers, focus));
    bits.push(focusSite
      ? `<p class="county-note">${esc(focusSite.blurb)} <button class="linky" data-act="site"
           data-arg="${focus}">show the whole board</button></p>`
      : '<p class="county-note">Four places a car can end up. Pick one to see only its work.</p>');
    bits.push('</div>');

    bits.push('<div class="gar-panel"><h2>on the board</h2>');
    const shown = focus ? this.offers.filter((o) => o.locked || o.siteId === focus) : this.offers;
    if (focus && !shown.some((o) => !o.locked)) {
      bits.push(`<p class="gar-empty">Nothing at ${esc(focusSite ? focusSite.short : 'that site')}
        today.</p>`);
    }
    for (const o of shown) {
      if (o.locked) {
        bits.push(`<div class="offer locked">
          <div class="offer-head"><b>${esc(o.title)}</b><span>&pound;${o.fee}</span></div>
          <p>${esc(o.blurb)}</p>
          <p class="offer-lock">needs a reputation of ${o.minRep} &middot; you have ${Math.round(c.reputation)}</p>
        </div>`);
        continue;
      }
      /* Where and in what, on the card, BEFORE the job is taken. A wet night at the quarry pays
       * more for exactly the reason it is worth more, and the whole point is that the player gets
       * to decide whether it is worth it. */
      const wx = o.weatherId && o.weatherId !== 'dry' ? ` &middot; <b>${esc(o.weatherLabel)}</b>` : '';
      bits.push(`<div class="offer">
        <div class="offer-head"><b>${esc(o.title)}</b><span>&pound;${o.fee}</span></div>
        <p class="offer-where">${esc(o.siteName || '')}${wx}</p>
        <p>${esc(o.blurb)}</p>
        ${o.weatherBlurb ? `<p class="offer-weather">${esc(o.weatherBlurb)}</p>` : ''}
        <div class="offer-foot">
          <em>${o.distanceKm} km out</em>
          <button class="primary" data-act="take" data-arg="${o.id}">take it</button>
        </div>
      </div>`);
    }
    bits.push('</div>');

    /* What the outfits down the road picked up yesterday. The only reason choosing between three
     * jobs is a choice is that the other two go away — so the board says where they went. */
    if (c.rivalTook && c.rivalTook.length) {
      bits.push('<div class="gar-panel"><h2>went elsewhere</h2><div class="ledger">');
      for (const r of c.rivalTook.slice(0, 4)) {
        bits.push(`<div class="led-row"><em>${esc(r.title)} at ${esc(r.site || '')}</em>`
                + `<span class="rival">${esc(r.by)}</span><b>&pound;${r.fee}</b></div>`);
      }
      bits.push('</div></div>');
    }

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
