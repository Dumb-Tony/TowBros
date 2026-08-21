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
import { describeWinch, WINCH, drumsOf } from '../recovery/cable.js';
import { describeRig } from '../recovery/rig.js';
import { liftGearNoun, liftGearVerb } from '../recovery/lift.js';
import { loadedAnchor, describeAnchor } from '../recovery/anchors.js';
import { GameClock } from '../core/clock.js';
import { clamp01 } from '../core/vec.js';
import { seatOf, holdsHook, carriedItem } from '../player/player.js';
import { casualties, cornersOnRoad } from '../sim/vehicle.js';
import { JOB } from '../world/scene.js';
import { describePolice } from '../world/police.js';

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
    case EVENTS.RIGHTED:            return `rolled the ${e.vehicle} back onto its wheels`;
    case EVENTS.GEAR_SCATTERED:     return `the ${e.kind} was knocked out of place`;
    case EVENTS.GEAR_USED:          return e.kind === 'jack' ? `jack at ${e.liftStep} of ${e.of}` : null;
    case EVENTS.BRAKE_SET:          return e.on ? "set the sedan's parking brake" : "released the sedan's parking brake";
    case EVENTS.CREW_STUMBLED:      return `${who(e.crew)} was knocked off their feet`;
    case EVENTS.VEHICLE_ENTERED:    return `${who(e.crew)} got in the ${e.vehicle}`;
    case EVENTS.VEHICLE_EXITED:     return `${who(e.crew)} got out of the ${e.vehicle}`;
    case EVENTS.LOAD_HOISTED:       return `picked the ${e.label || e.vehicle} up — ${kN(e.weightN)} against ${kN(e.capacityN)}`;
    case EVENTS.LOAD_LOWERED:       return e.reason === 'lowered' ? `set the ${e.label || e.vehicle} down`
      : e.reason === 'tipped' ? `the ${e.label || e.vehicle} came down with the machine`
        : `LOST the ${e.label || e.vehicle} off the boom`;
    // Two different facts and the player needs both: the chart saying no BEFORE anything moves, and
    // the chart having gone against a load that is already in the air.
    case EVENTS.BOOM_OVERLOAD:      return e.refused
      ? `too much at ${e.reachM} m — ${kN(e.demandN)} against ${kN(e.capacityN)}`
      : `PAST THE CHART — ${kN(e.demandN)} at ${e.reachM} m, rated ${kN(e.capacityN)}`;
    case EVENTS.POLICE_DISPATCHED:  return 'a unit has been called to the open road';
    case EVENTS.POLICE_ON_SCENE:    return 'a unit is on scene';
    case EVENTS.POLICE_CITED:       return `cited for the carriageway — £${e.amountN}`;
    // The recap already says "both of them were on the road" and this said "the sedan" regardless.
    case EVENTS.RECOVERY_COMPLETE:  return e.vehicles > 1
      ? 'both of them are on the road' : 'the sedan is on the road';
    default: return null;
  }
}

/**
 * The one objective line, per job phase — a statement of fact in every case, never an instruction.
 */
function objectiveFor(st, cornersOn, lift) {
  const j = st.job;
  /* WHAT is in the ditch, by name. From Milestone 6 it is not always a sedan, and a line that
   * says "get the sedan onto the road" while a seven-tonne box truck is lying on the bank is the
   * interface disagreeing with the game. Still one line, still a statement of fact. */
  const what = st.vehicles.sedan ? st.vehicles.sedan.def.label : 'the sedan';
  /* TWO OF THEM (Milestone 9). One line still, and still a statement of fact — but it has to count
   * both, or a player who has one car up and one still in the ditch reads "2/4 corners up" and has
   * no idea which car that is about. Deliberately does NOT say which to do first: the one nearer
   * the road is in the other one's way, and reading that off the ground is the clause. */
  const all = casualties(st);

  /* OFF THE GROUND BEATS EVERY OTHER PHASE (Milestone 8), including the two-casualty line below —
   * which is why it now comes first. The job phases are about where a casualty has got to; one
   * hanging off a boom has not got anywhere yet, and a line reading "on the road, on its own
   * wheels" under a van in the air is the interface disagreeing with the game. It looked for
   * `st.vehicles.sedan` alone, so with two casualties the SECOND one being in the air was
   * invisible — and after Milestone 9 the second one is the one you are most likely to be
   * righting. Caught in the first screenshot of the clause, and again by an audit. */
  const airborne = all.find((v) => v.suspended);
  if (airborne) {
    const h = st.vehicles.truck.hoist;
    return `the ${airborne.def.label} is off the ground — ${(h.demandN / 1000).toFixed(1)} kN`
      + ` of ${(h.capacityN / 1000).toFixed(1)} at ${h.reachM.toFixed(1)} m`;
  }
  if (all.length > 1 && st.job.phase === JOB.RECOVER) {
    const upCount = all.filter((v) => cornersOnRoad(v, st.terrain).all).length;
    return `two of them in the ditch — ${upCount} of ${all.length} on the road`;
  }
  switch (j.phase) {
    case JOB.DELIVERED:
      return `delivered · £${j.payout ? j.payout.paid : 0}`;
    case JOB.TRANSPORT: {
      // Straps on a car yoke, chains on the heavy's underlift (Milestone 8). One place decides
      // the word — see recovery/lift.js liftGearNoun — because three files say it.
      const truck = st.vehicles.truck;
      const n = lift.straps.length;
      return `the ${what} is on the lift · ${n === 0
        ? `nothing ${liftGearVerb(truck)} it down`
        : `${n} ${liftGearNoun(truck, n)} on it`}`;
    }
    case JOB.LOAD:
      return j.bayCorners > 0
        ? `the ${what} is in the yard — ${j.bayCorners}/4 corners in the bay`
        : `the ${what} is on the road, on its own wheels`;
    default:
      return `get the ${what} onto the road — ${cornersOn}/4 corners up`;
  }
}

export class Hud {
  constructor(root, game, input) {
    this.root = root;
    this.game = game;
    this.input = input;
    this.onStart = null;
    this.onReset = null;
    this.onYard = null;
    /** What the company made of the job, set by main.js when it settles. Shown on the card. */
    this.settlement = null;
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
      rig: root.querySelector('.rig-line'),
      road: root.querySelector('.road-line'),
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
      netStall: root.querySelector('.netstall'),

      coop: root.querySelector('.coop'),
      coopPanel: root.querySelector('.coop-panel'),
      coopSay: root.querySelector('.coop-say'),
      coopOut: root.querySelector('.coop-out'),
      coopIn: root.querySelector('.coop-in'),
      coopGo: root.querySelector('.btn-coop-go'),
      coopCopy: root.querySelector('.btn-coop-copy'),
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
    root.querySelector('.btn-yard').addEventListener('click', () => {
      this._dismissedDone = true;
      if (this.onYard) this.onYard();
    });

    /* Co-op setup. The HUD does not know what a peer is — it collects the three intents
     * ("second tab", "host", "join") and the one blob of text, and hands them to main.js, which
     * owns the transports. Keeping the network out of the UI layer is the same instinct as
     * keeping ownership on the objects: one place that knows, and no second copy. */
    this.onCoop = null;                 // (kind, blob) => Promise<string|null>
    const coopBtn = (sel, kind) => root.querySelector(sel).addEventListener('click', () => {
      this._coopKind = kind;
      this._coopStart(kind);
    });
    coopBtn('.btn-coop-tab', 'tab');
    coopBtn('.btn-coop-host', 'host');
    coopBtn('.btn-coop-join', 'join');
    root.querySelector('.btn-coop-cancel').addEventListener('click', () => {
      this.el.coopPanel.classList.remove('on');
      this._coopKind = null;
    });
    this.el.coopCopy.addEventListener('click', () => {
      this.el.coopOut.select();
      // execCommand is deprecated and is also the only clipboard path that works without a
      // permission prompt on a page served from localhost over plain http. Both are tried.
      if (navigator.clipboard) navigator.clipboard.writeText(this.el.coopOut.value).catch(() => {});
      else document.execCommand('copy');
      this.el.coopCopy.textContent = 'copied';
      setTimeout(() => { this.el.coopCopy.textContent = 'copy'; }, 1200);
    });
    this.el.coopGo.addEventListener('click', async () => {
      const blob = this.el.coopIn.value.trim();
      if (!blob) { this._coopSay('Paste the text they sent you into the second box first.'); return; }
      this._coopSay('working…');
      const out = await this.onCoop(this._coopKind === 'host' ? 'host-answer' : 'join', blob);
      if (out === null) { this._coopSay('That did not look like a handshake. Ask them to send it again.'); return; }
      if (out) { this._coopShowOut(out, 'Send them this, and you are connected once they paste it.'); }
      else { this._coopSay('Connected. Starting the job…'); }
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

    /* The gauge shows the BUSIEST drum. On a light wrecker that is the only one; on the heavy it
     * is whichever line is closest to its limit, which is the one worth looking at. The second
     * drum gets a line of its own below rather than a second gauge — two gauges side by side is
     * twice the furniture for a number the player only needs when it matters. */
    const drums = drumsOf(st);
    const busiest = drums.reduce((a, b) => (b.tensionFrac > a.tensionFrac ? b : a), drums[0]);
    const w = describeWinch(busiest);
    const frac = busiest.tensionFrac;

    this._set(this.el.tension, `${(busiest.tensionN / 1000).toFixed(1)} kN`);
    this.el.gaugeFill.style.width = `${(clamp01(frac) * 100).toFixed(1)}%`;
    this.el.gauge.dataset.level = w.level;
    this._set(this.el.lineOut, `${w.lineM.toFixed(1)} m out`);

    let ws = 'hook stowed';
    if (busiest.state === WINCH.HELD) ws = 'carrying the hook';
    else if (busiest.state === WINCH.LOOSE) ws = 'hook on the ground';
    else if (busiest.state === WINCH.ATTACHED) {
      ws = `rigged: ${w.zoneId}${w.rig !== 'bare' ? ` / ${w.rig}` : ''}${w.throughBlock ? ' / through block' : ''}`;
    }
    if (drums.length > 1) ws = `${busiest.drumLabel}: ${ws}`;
    // "Blocked" and "stalled" are different facts and the player needs the difference: one means
    // the load has nowhere left to go, the other means the motor cannot beat it. Both stop the
    // drum, and only one of them is worth pulling harder at.
    if (busiest.contested) ws += " — TWO HANDS ON THE DRUM";
    else if (busiest.blocked) ws += " — AGAINST THE TRUCK";
    else if (busiest.stalled) ws += " — STALLED";
    this._set(this.el.winchState, ws);
    this.el.winchState.classList.toggle("stalled", busiest.stalled || busiest.blocked || busiest.contested);

    /* The other drum, and the legs, when there is a machine that has them (Milestone 6). Facts
     * only: what the second line is doing and whether the truck is standing on its outriggers. */
    if (this.el.rig) {
      const truck = st.vehicles.truck;
      const bits = [];
      for (const d of drums) {
        if (d === busiest) continue;
        bits.push(`${d.drumLabel}: ${d.state === WINCH.ATTACHED
          ? `${(d.tensionN / 1000).toFixed(1)} kN` : d.state}`);
      }
      const rig = describeRig(truck, st);
      if (rig && rig.outriggers) bits.push(`legs ${rig.outriggers}`);
      if (rig && rig.boomDeg !== null && rig.boomDeg !== 0) bits.push(`boom ${rig.boomDeg}°`);
      /* THE LOAD CHART, as two numbers and never as one (Milestone 8). A capacity on its own is a
       * rating; a capacity next to what is actually hanging there is a decision, and it is the
       * decision the whole clause exists for — reel in, slew back, or get the legs down. The
       * reach is shown with it because reach is the thing the player is changing. */
      if (rig && rig.chart) {
        if (rig.carrying) {
          bits.push(`boom load ${(rig.demandN / 1000).toFixed(1)}/${(rig.chart.capacityN / 1000).toFixed(1)} kN`
            + ` at ${rig.chart.reachM.toFixed(1)} m`
            + (rig.tipFrac > 0.2 ? ' — GOING OVER' : ''));
        } else if (rig.outriggerFrac > 0 || rig.boomDeg) {
          bits.push(`chart ${(rig.chart.capacityN / 1000).toFixed(0)} kN at the head`);
        }
      }
      /* And what the ANCHOR is carrying, when a line is routed through a block. Two numbers, and
       * the subtraction is the player's: a redirect puts up to twice the line tension on whatever
       * it is mounted to, and that is the fact worth having in front of you while you pull. */
      const anchor = loadedAnchor(st);
      if (anchor) {
        const d = describeAnchor(st, anchor);
        bits.push(`anchor ${(d.loadN / 1000).toFixed(1)}/${(d.ratedN / 1000).toFixed(0)} kN`
          + (d.strainFrac > 0.2 ? ' — GOING' : ''));
      }
      this._set(this.el.rig, bits.join('  ·  '));
      this.el.rig.classList.toggle('on', bits.length > 0);
    }


    this._set(this.el.clock, GameClock.formatMs(st.simTimeMs));
    /* One line of objective, and it says what is TRUE rather than what to do next.
     *
     * Milestone 3 made the job longer than the recovery, so the line follows the phase — but it is
     * still a statement of where the car is, not a step in a checklist. A player who winches the
     * car out and drives home without it has not failed a step; the car is on the road, and the
     * line says so. GDD §9 again: a UI that narrates the plan makes the north-star question
     * impossible to answer. */
    const on = st.goal.cornersOnRoad;
    const lift = st.vehicles.truck.lift;
    this._set(this.el.objective, objectiveFor(st, on, lift));

    /* THE STATE OF THE ROAD (Milestone 7), on its own line under the objective and only when
     * there is something true to say. It reports what the road IS — blocked, closed, how much
     * exposure has built up, who is here — and never that cones would be a good idea. The
     * distinction matters more here than anywhere else in the HUD: a line reading "put cones out"
     * turns a decision into an instruction, which is exactly what GDD §9's question cannot
     * survive. Hidden entirely on a scene that is not blocking anything, because a permanent
     * "Clear." is furniture. */
    if (this.el.road) {
      const pol = describePolice(st);
      const show = !!pol && pol.obstructed && (!pol.closed || pol.citations > 0);
      let line = '';
      if (show) {
        line = pol.line;
        if (pol.citations > 0 && pol.state !== 'onScene') {
          line += `  ·  ${pol.citations} citation${pol.citations === 1 ? '' : 's'}`;
        }
      }
      this._set(this.el.road, line);
      this.el.road.classList.toggle('on', show);
      this.el.road.classList.toggle('hot', show && (pol.state !== 'none' || pol.citations > 0));
    }

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
    /* The card comes up when the JOB is done, not when the recovery is. Milestone 1 showed it the
     * moment the car reached the road, which is now the middle of the job — and a results card at
     * the halfway point told the player they were finished when they were not. */
    if (st.job.phase === JOB.DELIVERED && !this._dismissedDone
        && !this.el.done.classList.contains('on')) {
      this.el.done.classList.add('on');
      this._renderRecap();
    }

    if (this._resetArmedMs > 0) {
      this._resetArmedMs -= 16;
      this.el.resetHint.classList.toggle('on', this._resetArmedMs > 0);
    } else {
      this.el.resetHint.classList.remove('on');
    }

    /* The only network UI during play, and it appears only when the connection is actually
     * holding the simulation up. A permanent "connected" badge is noise; a stall with no
     * explanation is a mystery, and a player would reasonably conclude the game had hung. */
    const net = this.game.net;
    const stalled = !!net && net.state === 'playing' && !net.transport.ready();
    this.el.netStall.classList.toggle('on', stalled);
    if (stalled) {
      const waiting = [...net.transport.claimedSeats]
        .filter((s) => !net.transport.localSeats.has(s))
        .map((s) => `crew ${s + 1}`);
      this._set(this.el.netStall, `waiting for ${waiting.join(' and ') || 'the other end'}…`);
    }
  }

  /** R once arms, R again resets. "Always available, never imposed" — and never by accident
   *  in the middle of a 30 kN pull. */
  armReset() {
    if (this._resetArmedMs > 0) { this._resetArmedMs = 0; return true; }
    this._resetArmedMs = 900;
    return false;
  }

  /* ── co-op panel ───────────────────────────────────────────────────────── */

  _coopSay(text) { this.el.coopSay.textContent = text; }

  _coopShowOut(text, say) {
    this.el.coopOut.classList.remove('hide');
    this.el.coopOut.value = text;
    this._coopSay(say);
  }

  async _coopStart(kind) {
    this.el.coopPanel.classList.add('on');
    this.el.coopOut.value = '';
    this.el.coopIn.value = '';
    this.el.coopOut.classList.add('hide');
    this.el.coopIn.classList.add('hide');
    this.el.coopGo.style.display = 'none';
    this.el.coopCopy.style.display = 'none';

    if (kind === 'tab') {
      this._coopSay('Open this same page in a second tab or window and press "open a second tab" '
        + 'there too. You will be crew 1 and crew 2 on one machine.');
      const out = await this.onCoop('tab', null);
      if (out === null) this._coopSay('This browser has no BroadcastChannel, so two tabs cannot talk.');
      return;
    }
    if (kind === 'host') {
      this._coopSay('Gathering…');
      const offer = await this.onCoop('host', null);
      if (offer === null) { this._coopSay('This browser cannot do WebRTC here.'); return; }
      this.el.coopCopy.style.display = '';
      this.el.coopIn.classList.remove('hide');
      this.el.coopGo.style.display = '';
      this._coopShowOut(offer, 'Send them this. When they send one back, paste it below and press '
        + '"use it".');
      return;
    }
    // join
    this.el.coopIn.classList.remove('hide');
    this.el.coopGo.style.display = '';
    this.el.coopCopy.style.display = '';
    this._coopSay('Paste what the host sent you, then press "use it".');
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
    // How many were in the ditch (Milestone 9). Only said when it is more than one, because a card
    // that announces "1 vehicle" on every ordinary job is furniture.
    const many = (s.casualties || 1) > 1;
    bits.push(`<p class="tag">${GameClock.formatMs(s.timeMs || 0)} on scene · `
      + `${s.attachments} attachment${s.attachments === 1 ? '' : 's'}`
      + `${many ? ` · ${s.casualties} vehicles` : ''}</p>`);
    bits.push('<ul class="recap">');
    for (const [t, text] of r.lines) bits.push(`<li><span>${t}s</span> ${escapeHtml(text)}</li>`);
    bits.push('</ul>');
    const cost = [];
    if (s.partsLost) cost.push(`${s.partsLost} part${s.partsLost === 1 ? '' : 's'} off ${many ? 'them' : 'the car'}`);
    if (s.partsBent) cost.push(`${s.partsBent} bent`);
    if (s.dents) cost.push(`${s.dents} dent${s.dents === 1 ? '' : 's'}`);
    if (s.cableSnaps) cost.push(`${s.cableSnaps} cable${s.cableSnaps === 1 ? '' : 's'} parted`);
    if (s.truckSlipped) cost.push('the truck went for a walk');
    if (s.guardrailHit) cost.push('the guardrail took some of it');
    bits.push(`<p class="hint">${cost.length ? escapeHtml(cost.join(' · ')) : 'Nothing broke. Suspiciously clean.'}</p>`);

    /* The payout, itemised. Every line names a decision the player made, which is the whole reason
     * it is itemised at all: a single number is a score, and a list of causes is a story. */
    const pay = s.payout;
    if (pay) {
      bits.push('<div class="payout">');
      bits.push(`<div class="pay-row"><span>recovery fee</span><b>&pound;${pay.baseFee}</b></div>`);
      for (const d of pay.deductions) {
        bits.push(`<div class="pay-row minus"><span>${escapeHtml(d.label)}</span><b>-&pound;${d.amount}</b></div>`);
      }
      bits.push(`<div class="pay-row total"><span>${pay.floored ? 'minimum callout' : 'paid'}</span>`
              + `<b>&pound;${pay.paid}</b></div>`);
      bits.push('</div>');
    }

    /* What the company made of it. Wear and reputation are consequences of the same decisions the
     * deductions above already named, so they go under the same rule: state them, do not advise. */
    const s2 = this.settlement;
    if (s2) {
      bits.push('<div class="payout settle">');
      if (s2.bodyWear > 0.005) bits.push(`<div class="pay-row minus"><span>wear on the truck</span><b>-${Math.round(s2.bodyWear * 100)}%</b></div>`);
      if (s2.winchWear > 0.005) bits.push(`<div class="pay-row minus"><span>wear on the winch</span><b>-${Math.round(s2.winchWear * 100)}%</b></div>`);
      if (s2.repairDue > 0) bits.push(`<div class="pay-row"><span>repairs waiting</span><b>&pound;${s2.repairDue}</b></div>`);
      bits.push(`<div class="pay-row"><span>reputation</span><b>${s2.reputation}</b></div>`);
      /* What it took out of the day (Milestone 7). A fact about the afternoon, stated the same way
       * the deductions are: this is what it cost, and the next job is in whatever light is left. */
      if (s2.minutesTaken > 0 && s2.clock) {
        const h = Math.floor(s2.minutesTaken / 60), m = Math.round(s2.minutesTaken % 60);
        bits.push(`<div class="pay-row"><span>on site</span><b>${h > 0 ? `${h}h ` : ''}${m}m</b></div>`);
        bits.push(`<div class="pay-row"><span>it is ${s2.clock.label}</span><b>${s2.clock.leftLabel}</b></div>`);
      }
      /* And the owner, in one sentence and one number. The sentence is what they saw; the number
       * is what it did to the outfit's name. Milestone 7 — see world/customer.js. */
      if (s2.customer) {
        bits.push(`<div class="pay-row ${s2.customerRep < 0 ? 'minus' : ''}"><span>${
          s2.customer.line}</span><b>${s2.customerRep >= 0 ? '+' : ''}${s2.customerRep}</b></div>`);
      }
      bits.push('</div>');
    }
    this.el.doneBody.innerHTML = bits.join('');
  }

  _set(el, text) { if (el && el._v !== text) { el._v = text; el.textContent = text; } }
}

const LOUD = new Set([
  EVENTS.CABLE_SNAPPED, EVENTS.ZONE_FAILED, EVENTS.COMPONENT_DETACHED,
  EVENTS.TRUCK_SLIPPING, EVENTS.ROLLED_OVER, EVENTS.RIGHTED, EVENTS.RECOVERY_COMPLETE,
]);

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const TEMPLATE = `
<div class="hud-top">
  <div class="hud-clock"><span class="hud-time">0:00</span></div>
  <div class="objective">get the sedan onto the road</div>
  <div class="road-line"></div>
  <div class="hud-slot">
    <div class="winch-panel">
      <div class="winch-state">hook stowed</div>
      <div class="gauge" data-level="ok">
        <div class="gauge-fill"></div>
        <div class="gauge-warn"></div>
      </div>
      <div class="rig-line"></div>
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

<div class="netstall">waiting for the other end&hellip;
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
    <button class="btn-start primary">to the yard</button>

    <div class="coop">
      <div class="coop-head">or bring somebody</div>
      <div class="coop-row">
        <button class="btn-coop-tab">open a second tab</button>
        <button class="btn-coop-host">host over the network</button>
        <button class="btn-coop-join">join somebody</button>
      </div>
      <div class="coop-panel">
        <p class="coop-say"></p>
        <textarea class="coop-out" readonly rows="3" spellcheck="false"></textarea>
        <textarea class="coop-in" rows="3" spellcheck="false" placeholder="paste what they send you"></textarea>
        <div class="coop-row">
          <button class="btn-coop-copy">copy</button>
          <button class="btn-coop-go primary">use it</button>
          <button class="btn-coop-cancel">cancel</button>
        </div>
        <p class="coop-note">
          No server is involved — you are passing the handshake yourselves, so send that blob
          however you already talk. Same network only unless you add a STUN server.
        </p>
      </div>
    </div>
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
    <h2>delivered</h2>
    <div class="done-body"></div>
    <button class="btn-yard primary">back to the yard</button>
    <button class="btn-keep">stay here</button>
    <button class="btn-reset">another go</button>
  </div>
</div>
`;
