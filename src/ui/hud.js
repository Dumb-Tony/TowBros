/* The interface. DOM over the canvas, and it decides nothing.
 *
 * GDD §5: controls "small enough to remember after one glance", winch operation available
 * "through both keys and large on-screen controls", and inspection that gives facts. So the
 * HUD is four things and no more:
 *
 *   the tension gauge      the only number that has to be visible continuously
 *   the context prompt     what E means where you are standing, in words
 *   the job log            what has happened, in the order it happened
 *   the inspect card       what you just looked at
 *
 * There is NO objective tracker beyond one line, no step list, no tutorial arrow and no hint
 * system. GDD §9's north-star question is whether players describe what they did rather than
 * what the mission told them to do, and a UI that narrates the plan makes that impossible to
 * answer. If it feels like something is missing here, that is the design.
 *
 * Style tokens are the shared studio set from Dev\INDEX.md ("UI / shell" -> style tokens), so
 * this looks like the same house as Chameleon, Something's Different and Airport Baggage Crew.
 */

import { CONFIG } from '../config.js';
import { EVENTS } from '../core/eventBus.js';
import { describeWinch, WINCH } from '../recovery/cable.js';
import { GameClock } from '../core/clock.js';
import { clamp01 } from '../core/vec.js';
import { seatOf, holdsHook, carriedItem } from '../player/player.js';

/** One readable sentence per event. The job log is the GDD's north star made literal, so the
 *  wording matters: it says what happened, never what to do about it. */
function phrase(e) {
  const kN = (n) => `${(n / 1000).toFixed(1)} kN`;
  // 'crew0' -> 'crew 1', matching createCrewMember's default name. With more than one person on
  // site the log has to say WHO, or half of it becomes unattributable.
  const who = (id) => {
    const m = /^crew(\d+)$/.exec(String(id || ''));
    return m ? `crew ${+m[1] + 1}` : 'somebody';
  };
  switch (e.type) {
    case EVENTS.HOOK_TAKEN:        return `${who(e.crew)} took the hook off the drum`;
    // 'dropped' means they were knocked over. CREW_STUMBLED already says that, so saying it twice
    // would read as two events.
    case EVENTS.HOOK_STOWED:       return e.where === 'dropped' ? null : `${who(e.crew)} set the hook down`;
    case EVENTS.HOOK_ATTACHED:     return `hooked the ${e.zoneLabel}${e.rig !== 'bare' ? ` through the ${e.rig}` : ''}`;
    case EVENTS.HOOK_DETACHED:     return e.reason === 'player' ? 'unhooked' : null;
    case EVENTS.RIG_APPLIED:       return `wrapped the ${e.rig} round the ${e.zone}`;
    case EVENTS.BLOCK_MOUNTED:     return 'secured the snatch block to a tree';
    case EVENTS.CABLE_ROUTED:      return e.removed ? 'took the line out of the block' : 'ran the line through the block';
    case EVENTS.WINCH_STALLED:     return `winch stalled — ${kN(e.tensionN)}`;
    case EVENTS.WINCH_SPOOL_END:   return 'out of cable';
    case EVENTS.CABLE_SNAPPED:     return `THE CABLE PARTED at ${kN(e.tensionN)}`;
    case EVENTS.ZONE_FAILED:       return e.mode === 'bent'
      ? `bent the ${e.zoneLabel} — ${kN(e.loadN)} against ${kN(e.capacityN)}`
      : `tore the ${e.zoneLabel} off — ${kN(e.loadN)} against ${kN(e.capacityN)}`;
    case EVENTS.COMPONENT_DETACHED: return e.label ? `the ${e.label} came off` : null;
    case EVENTS.COMPONENT_DAMAGED:  return e.state === 'bent' ? `${e.part} is bent` : null;
    case EVENTS.IMPACT:             return e.impulseNs > CONFIG.damage.impactDentNs ? `hit something hard — ${e.impulseNs} N·s` : null;
    case EVENTS.GUARDRAIL_BENT:     return e.broken ? 'took out a section of guardrail' : 'bent the guardrail';
    case EVENTS.TRUCK_SLIPPING:     return `the truck is sliding on ${e.surface.replace('wetGrass', 'wet grass')}`;
    case EVENTS.ROLLED_OVER:        return `rolled the ${e.vehicle}`;
    case EVENTS.GEAR_SCATTERED:     return `the ${e.kind} was knocked out of place`;
    case EVENTS.GEAR_USED:          return e.kind === 'jack' ? `jack at ${e.liftStep} of ${e.of}` : null;
    case EVENTS.BRAKE_SET:          return e.on ? "set the sedan's parking brake" : "released the sedan's parking brake";
    case EVENTS.CREW_STUMBLED:      return `${who(e.crew)} was knocked off their feet`;
    case EVENTS.VEHICLE_ENTERED:    return `${who(e.crew)} got in the ${e.vehicle}`;
    case EVENTS.VEHICLE_EXITED:     return `${who(e.crew)} got out of the ${e.vehicle}`;
    case EVENTS.RECOVERY_COMPLETE:  return 'the sedan is on the road';
    default: return null;
  }
}

export class Hud {
  constructor(root, game, input) {
    this.root = root;
    this.game = game;
    this.input = input;
    this.onStart = null;
    this.onReset = null;
    this.onToggleAudio = null;
    this.logLines = [];
    this._resetArmedMs = 0;

    root.innerHTML = TEMPLATE;
    this.el = {
      top: root.querySelector('.hud-top'),
      objective: root.querySelector('.objective'),
      gauge: root.querySelector('.gauge'),
      gaugeFill: root.querySelector('.gauge-fill'),
      gaugeWarn: root.querySelector('.gauge-warn'),
      tension: root.querySelector('.tension-val'),
      lineOut: root.querySelector('.line-val'),
      winchState: root.querySelector('.winch-state'),
      clock: root.querySelector('.hud-time'),

      bottom: root.querySelector('.hud-bottom'),
      crewStrip: root.querySelector('.crew-strip'),
      prompt: root.querySelector('.prompt'),
      held: root.querySelector('.held'),
      winchBtns: root.querySelector('.winch-controls'),

      log: root.querySelector('.joblog'),
      card: root.querySelector('.inspect-card'),
      cardTitle: root.querySelector('.inspect-card h3'),
      cardBody: root.querySelector('.inspect-card .lines'),

      title: root.querySelector('.screen-title'),
      pause: root.querySelector('.screen-pause'),
      done: root.querySelector('.screen-done'),
      doneBody: root.querySelector('.done-body'),
      resetHint: root.querySelector('.reset-hint'),
    };

    // The stall marker on the gauge is where the motor gives up, so it has to be COMPUTED from
    // the force budget rather than written into the stylesheet. It sat at a hardcoded 81% (the old
    // 34/42 kN ratio) and would have silently lied the moment either number was retuned.
    this.el.gaugeWarn.style.left =
      `${(CONFIG.winch.motorMaxN / CONFIG.winch.cableBreakN * 100).toFixed(1)}%`;

    root.querySelector('.btn-start').addEventListener('click', () => this.onStart && this.onStart());
    root.querySelector('.btn-resume').addEventListener('click', () => this.game.togglePause());
    for (const b of root.querySelectorAll('.btn-reset')) {
      b.addEventListener('click', () => this.onReset && this.onReset());
    }
    root.querySelector('.btn-keep').addEventListener('click', () => {
      this.el.done.classList.remove('on');
      this._dismissedDone = true;
    });

    // Large on-screen winch controls — GDD §5 requires these, not just keys. They latch the
    // same actions the keyboard does, through Input, so no system downstream can tell which
    // one the player used.
    for (const b of root.querySelectorAll('[data-hold]')) {
      const action = b.dataset.hold;
      const down = (ev) => { ev.preventDefault(); this.input.virtualDown(action); b.classList.add('pressed'); };
      const up = (ev) => { ev.preventDefault(); this.input.virtualUp(action); b.classList.remove('pressed'); };
      b.addEventListener('pointerdown', down);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointerleave', up);
      b.addEventListener('pointercancel', up);
    }

    game.bus.onAny((e) => {
      const text = phrase(e);
      if (!text) return;
      this.logLines.push({ t: e.simTimeMs, text, loud: LOUD.has(e.type) });
      if (this.logLines.length > 7) this.logLines.shift();
      this._logDirty = true;
    });
    game.bus.on(EVENTS.SIM_RESET, () => {
      this.logLines.length = 0;
      this._logDirty = true;
      this._dismissedDone = false;
      this.el.done.classList.remove('on');
    });
  }

  /** Called every render frame. Cheap: string writes only when the value changed. */
  update() {
    const st = this.game.state;
    const mode = st.mode;

    this.el.title.classList.toggle('on', mode === 'title');
    this.el.pause.classList.toggle('on', mode === 'paused');
    const playing = mode === 'playing';
    this.el.top.classList.toggle('on', playing);
    this.el.bottom.classList.toggle('on', playing);
    this.el.log.classList.toggle('on', playing);

    if (!playing) return;

    const w = describeWinch(st.winch);
    const frac = st.winch.tensionFrac;

    this._set(this.el.tension, `${(st.winch.tensionN / 1000).toFixed(1)} kN`);
    this.el.gaugeFill.style.width = `${(clamp01(frac) * 100).toFixed(1)}%`;
    this.el.gauge.dataset.level = w.level;
    this._set(this.el.lineOut, `${w.lineM.toFixed(1)} m out`);

    let ws = 'hook stowed';
    if (st.winch.state === WINCH.HELD) ws = 'carrying the hook';
    else if (st.winch.state === WINCH.LOOSE) ws = 'hook on the ground';
    else if (st.winch.state === WINCH.ATTACHED) {
      ws = `rigged: ${w.zoneId}${w.rig !== 'bare' ? ` / ${w.rig}` : ''}${w.throughBlock ? ' / through block' : ''}`;
    }
    // "Blocked" and "stalled" are different facts and the player needs the difference: one means
    // the load has nowhere left to go, the other means the motor cannot beat it. Both stop the
    // drum, and only one of them is worth pulling harder at.
    if (st.winch.contested) ws += " — TWO HANDS ON THE DRUM";
    else if (st.winch.blocked) ws += " — AGAINST THE TRUCK";
    else if (st.winch.stalled) ws += " — STALLED";
    this._set(this.el.winchState, ws);
    this.el.winchState.classList.toggle("stalled", st.winch.stalled || st.winch.blocked || st.winch.contested);

    this._set(this.el.clock, GameClock.formatMs(st.simTimeMs));

    // One line of objective, and a corner count so "all four wheels on the road" is legible
    // without being a checklist.
    const on = st.goal.cornersOnRoad;
    this._set(this.el.objective, st.goal.complete
      ? 'the sedan is on the road'
      : `get the sedan onto the road — ${on}/4 corners up`);

    /* The prompt line belongs to the LOCAL player — crew[0]. Everything about their state is
     * read back off the world objects rather than out of a field on the person: whether they are
     * in a seat, holding the hook, or carrying gear are all answered by asking the object who owns
     * it. That is the M2 authority rule, and the HUD obeys it like everything else does. */
    const me = st.player;
    const seat = seatOf(st, me);
    const hint = me.contextHint;
    if (me.stumbleMs > 0) {
      this._set(this.el.prompt, 'down — getting up');
    } else if (seat) {
      this._set(this.el.prompt, seat.id === 'truck'
        ? 'W/S drive · A/D steer · Space parking brake · V get out · I/O winch'
        : "W/S roll · A/D steer · Space this car's brake · V get out");
    } else if (hint) {
      // A hint can name two keys at once: standing at the casualty's door, E reaches in for the
      // handbrake and V gets you into the seat. Showing only the first would hide a mechanic.
      this._set(this.el.prompt, `[${hint.key}] ${hint.label}`
        + (hint.alt ? ` · [${hint.alt.key}] ${hint.alt.label}` : ''));
    } else {
      this._set(this.el.prompt, 'WASD walk · Q look · E use · F let go · V get in · I/O winch');
    }

    const carried = carriedItem(st, me);
    const heldText = holdsHook(st, me) ? 'winch hook'
      : carried ? carried.kind.replace(/([A-Z])/g, ' $1').toLowerCase() : '';
    this.el.held.classList.toggle('on', !!heldText);
    if (heldText) this._set(this.el.held, `carrying: ${heldText}`);

    // The crew strip. One chip per person, saying what they have hold of — because with two to
    // four people on site the question "who has the hook" is asked constantly, and walking over
    // to look is a poor way to answer it.
    if (st.crew.length > 1) this._updateCrewStrip(st);

    if (this._logDirty) {
      this._logDirty = false;
      this.el.log.innerHTML = this.logLines.map((l) =>
        `<div class="logline${l.loud ? ' loud' : ''}"><span class="t">${(l.t / 1000).toFixed(1)}s</span>${escapeHtml(l.text)}</div>`
      ).join('');
    }

    const ins = st.player.inspect;
    this.el.card.classList.toggle('on', !!ins);
    if (ins && this._insTitle !== ins.title + ins.ttlMs) {
      this._insTitle = ins.title + ins.ttlMs;
      this.el.cardTitle.textContent = ins.title;
      this.el.cardBody.innerHTML = ins.lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('');
    }

    // The completion card. It reports and then gets out of the way: the sim keeps running and
    // the player can carry on driving around, because GDD §4 says reset is never imposed.
    if (st.goal.complete && !this._dismissedDone && !this.el.done.classList.contains('on')) {
      this.el.done.classList.add('on');
      this._renderRecap();
    }

    if (this._resetArmedMs > 0) {
      this._resetArmedMs -= 16;
      this.el.resetHint.classList.toggle('on', this._resetArmedMs > 0);
    } else {
      this.el.resetHint.classList.remove('on');
    }
  }

  /** R once arms, R again resets. "Always available, never imposed" — and never by accident
   *  in the middle of a 30 kN pull. */
  armReset() {
    if (this._resetArmedMs > 0) { this._resetArmedMs = 0; return true; }
    this._resetArmedMs = 900;
    return false;
  }

  /* One chip per crew member: their tint, their name, and what they are holding.
   *
   * Written from the objects, never from a table. `st.winch.heldBy`, `item.carriedBy` and
   * `vehicle.occupiedBy` ARE the truth about who has what — if this display and the simulation
   * ever disagreed it would mean the authority layer had a second copy of the answer somewhere,
   * which is the bug the whole design is arranged to make impossible.
   */
  _updateCrewStrip(st) {
    const parts = [];
    for (const p of st.crew) {
      const seat = seatOf(st, p);
      const item = carriedItem(st, p);
      const what = p.stumbleMs > 0 ? 'down'
        : seat ? `in the ${seat.id}`
        : holdsHook(st, p) ? 'the hook'
        : item ? item.kind.replace(/([A-Z])/g, ' $1').toLowerCase()
        : 'empty-handed';
      const cls = `crew-chip${p === st.player ? ' me' : ''}${p.stumbleMs > 0 ? ' down' : ''}`;
      parts.push(`<div class="${cls}"><i style="background:${p.tint}"></i>` +
                 `<b>${escapeHtml(p.name)}</b><span>${escapeHtml(what)}</span></div>`);
    }
    const html = parts.join('');
    if (this._crewHtml !== html) { this._crewHtml = html; this.el.crewStrip.innerHTML = html; }
  }

  _renderRecap() {
    const r = this.game.recap();
    const s = r.summary;
    const bits = [];
    bits.push(`<p class="tag">${GameClock.formatMs(s.timeMs || 0)} on scene · ${s.attachments} attachment${s.attachments === 1 ? '' : 's'}</p>`);
    bits.push('<ul class="recap">');
    for (const [t, text] of r.lines) bits.push(`<li><span>${t}s</span> ${escapeHtml(text)}</li>`);
    bits.push('</ul>');
    const cost = [];
    if (s.partsLost) cost.push(`${s.partsLost} part${s.partsLost === 1 ? '' : 's'} off the car`);
    if (s.partsBent) cost.push(`${s.partsBent} bent`);
    if (s.dents) cost.push(`${s.dents} dent${s.dents === 1 ? '' : 's'}`);
    if (s.cableSnaps) cost.push(`${s.cableSnaps} cable${s.cableSnaps === 1 ? '' : 's'} parted`);
    if (s.truckSlipped) cost.push('the truck went for a walk');
    if (s.guardrailHit) cost.push('the guardrail took some of it');
    bits.push(`<p class="hint">${cost.length ? escapeHtml(cost.join(' · ')) : 'Nothing broke. Suspiciously clean.'}</p>`);
    this.el.doneBody.innerHTML = bits.join('');
  }

  _set(el, text) { if (el && el._v !== text) { el._v = text; el.textContent = text; } }
}

const LOUD = new Set([
  EVENTS.CABLE_SNAPPED, EVENTS.ZONE_FAILED, EVENTS.COMPONENT_DETACHED,
  EVENTS.TRUCK_SLIPPING, EVENTS.ROLLED_OVER, EVENTS.RECOVERY_COMPLETE,
]);

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const TEMPLATE = `
<div class="hud-top">
  <div class="hud-clock"><span class="hud-time">0:00</span></div>
  <div class="objective">get the sedan onto the road</div>
  <div class="hud-slot">
    <div class="winch-panel">
      <div class="winch-state">hook stowed</div>
      <div class="gauge" data-level="ok">
        <div class="gauge-fill"></div>
        <div class="gauge-warn"></div>
      </div>
      <div class="winch-nums"><span class="tension-val">0.0 kN</span><span class="line-val">0.5 m out</span></div>
    </div>
  </div>
</div>

<div class="joblog"></div>

<div class="inspect-card"><h3></h3><div class="lines"></div></div>

<div class="hud-bottom">
  <div class="crew-strip"></div>
  <div class="held"></div>
  <div class="prompt"></div>
  <div class="winch-controls">
    <button data-hold="winchOut" class="winch-btn">▼ pay out <kbd>O</kbd></button>
    <button data-hold="winchIn" class="winch-btn primary">▲ reel in <kbd>I</kbd></button>
  </div>
  <div class="reset-hint">press <kbd>R</kbd> again to reset the scene</div>
</div>

<div class="screen screen-title on">
  <div class="card">
    <h1>TOW BROS</h1>
    <p class="tag">Two of you. One ditch. One winch.</p>
    <p class="milestone">Milestone 2 — a crew, not a player</p>
    <p class="hint">
      A sedan is nose-down on a wet grassy embankment. A tow truck is on the road.<br>
      Nothing here tells you how to do this, because there is no correct way to do it.
    </p>
    <p class="scope">
      <b>crew 1</b> &nbsp;<kbd>WASD</kbd> walk / drive · <kbd>Q</kbd> look · <kbd>E</kbd> use ·
      <kbd>F</kbd> let go · <kbd>V</kbd> get in · <kbd>Space</kbd> brake · <kbd>I</kbd>/<kbd>O</kbd> winch<br>
      <b>crew 2</b> &nbsp;<kbd>↑←↓→</kbd> walk / drive · <kbd>.</kbd> look · <kbd>/</kbd> use ·
      <kbd>,</kbd> let go · <kbd>⇧</kbd> get in · <kbd>\</kbd> brake · <kbd>]</kbd>/<kbd>[</kbd> winch<br>
      <kbd>-</kbd>/<kbd>=</kbd> zoom · <kbd>R</kbd> <kbd>R</kbd> reset · <kbd>Esc</kbd> pause · <kbd>F3</kbd> the numbers<br>
      One hook, one jack, one snatch block, two seats. Whoever gets there first gets it.
    </p>
    <button class="btn-start primary">start the job</button>
  </div>
</div>

<div class="screen screen-pause">
  <div class="card">
    <h2>paused</h2>
    <p class="hint">Nothing is moving. The cable is exactly as tight as you left it.</p>
    <button class="btn-resume primary">back to it</button>
    <button class="btn-reset">reset the scene</button>
  </div>
</div>

<div class="screen screen-done">
  <div class="card wide">
    <h2>on the road</h2>
    <div class="done-body"></div>
    <button class="btn-keep primary">carry on</button>
    <button class="btn-reset">another go</button>
  </div>
</div>
`;
