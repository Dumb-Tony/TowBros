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

/** One readable sentence per event. The job log is the GDD's north star made literal, so the
 *  wording matters: it says what happened, never what to do about it. */
function phrase(e) {
  const kN = (n) => `${(n / 1000).toFixed(1)} kN`;
  switch (e.type) {
    case EVENTS.HOOK_TAKEN:        return 'took the hook off the drum';
    case EVENTS.HOOK_STOWED:       return 'set the hook down';
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
    case EVENTS.VEHICLE_ENTERED:    return 'got in the truck';
    case EVENTS.VEHICLE_EXITED:     return 'got out';
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
    if (st.winch.stalled) ws += ' — STALLED';
    this._set(this.el.winchState, ws);
    this.el.winchState.classList.toggle('stalled', st.winch.stalled);

    this._set(this.el.clock, GameClock.formatMs(st.simTimeMs));

    // One line of objective, and a corner count so "all four wheels on the road" is legible
    // without being a checklist.
    const on = st.goal.cornersOnRoad;
    this._set(this.el.objective, st.goal.complete
      ? 'the sedan is on the road'
      : `get the sedan onto the road — ${on}/4 corners up`);

    const hint = st.player.contextHint;
    const driving = !!st.player.inVehicleId;
    if (driving) {
      this._set(this.el.prompt, 'W/S drive · A/D steer · Space parking brake · Enter get out · I/O winch');
    } else if (hint) {
      this._set(this.el.prompt, `[${hint.key}] ${hint.label}`);
    } else {
      this._set(this.el.prompt, 'WASD walk · Q look · E use · F let go · Enter get in · I/O winch');
    }

    const carried = st.player.carryingGearId
      ? st.gear.find((g) => g.id === st.player.carryingGearId) : null;
    const heldText = st.player.holdingHook ? 'winch hook'
      : carried ? carried.kind.replace(/([A-Z])/g, ' $1').toLowerCase() : '';
    this.el.held.classList.toggle('on', !!heldText);
    if (heldText) this._set(this.el.held, `carrying: ${heldText}`);

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
    <p class="tag">One vehicle. One ditch. One recovery.</p>
    <p class="milestone">Milestone 1 — recovery sandbox</p>
    <p class="hint">
      A sedan is nose-down on a wet grassy embankment. A tow truck is on the road.<br>
      Nothing here tells you how to do this, because there is no correct way to do it.
    </p>
    <p class="scope">
      <kbd>WASD</kbd> walk / drive · <kbd>Q</kbd> look at something · <kbd>E</kbd> use what is in front of you<br>
      <kbd>F</kbd> let go · <kbd>Enter</kbd> get in and out · <kbd>I</kbd>/<kbd>O</kbd> winch in and out<br>
      <kbd>Space</kbd> parking brake · <kbd>-</kbd>/<kbd>=</kbd> zoom · <kbd>R</kbd> <kbd>R</kbd> reset · <kbd>Esc</kbd> pause
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
