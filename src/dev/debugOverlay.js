/* Developer overlay. F3. Never player-facing.
 *
 * Pattern from AirportBaggageCrew\src\dev\debugOverlay.js. What it shows is chosen to answer
 * the questions this particular game actually raises while it is being tuned:
 *
 *   "why did the truck slide?"          -> grip budget vs cable tension, per vehicle
 *   "why won't the car move?"           -> downslope + bogged + drag multipliers
 *   "is the slope what I authored?"     -> measured max gradient off the height field
 *   "did the gear do anything?"         -> the aid counts the tire model is actually reading
 *
 * Those four lines caught more bad numbers during Milestone 1 than the test suite did, because
 * they are visible while the mistake is happening.
 */

import { CONFIG } from '../config.js';
import { gripBudgetN, downslopeN } from '../sim/tires.js';

export class DebugOverlay {
  constructor(root, game, renderer) {
    this.game = game;
    this.renderer = renderer;
    this.on = CONFIG.debug.enabled;
    this.timeScaleIdx = CONFIG.debug.timeScales.indexOf(1);

    this.el = document.createElement('pre');
    this.el.className = 'debug';
    root.appendChild(this.el);

    this._fps = 60;
    this._acc = 0;
    this._frames = 0;

    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3') { e.preventDefault(); this.on = !this.on; this.el.classList.toggle('on', this.on); }
      if (!this.on) return;
      if (e.code === 'KeyG') { renderer.showGrid = !renderer.showGrid; }
      if (e.code === 'KeyH') { renderer.showForces = !renderer.showForces; }
      if (e.code === 'KeyT') {
        this.timeScaleIdx = (this.timeScaleIdx + 1) % CONFIG.debug.timeScales.length;
        game.clock.timeScale = CONFIG.debug.timeScales[this.timeScaleIdx];
      }
    });
    this.el.classList.toggle('on', this.on);
  }

  update(dtMs) {
    this._acc += dtMs; this._frames++;
    if (this._acc >= 320) { this._fps = Math.round((this._frames * 1000) / this._acc); this._acc = 0; this._frames = 0; }
    if (!this.on) return;

    const g = this.game;
    const st = g.state;
    const d = g.describe();
    const t = st.terrain;
    const truck = st.vehicles.truck, sedan = st.vehicles.sedan;
    const kN = (n) => (n / 1000).toFixed(1).padStart(6);

    const lines = [
      `TOW BROS  ${this._fps} fps   step ${d.stepCount}   x${g.clock.timeScale}${g.clock.paused ? '  PAUSED' : ''}`,
      `seed ${d.seed} attempt ${d.attempt}   draws w${d.draws.world}/a${d.draws.attempt}   events ${d.events}`,
      `terrain  max ${t.describe().maxAngleDeg}deg at y=${t.describe().atY}   drop ${t.describe().dropM} m   bake ${this.renderer.buildMs} ms`,
      '',
      `LINE  ${d.winch.state}${d.winch.throughBlock ? ' via block' : ''}  ${d.winch.rig}  zone ${d.winch.zoneId || '-'}`,
      `      tension ${kN(st.winch.tensionN)} kN  ${(d.winch.tensionFrac * 100).toFixed(0)}% of break   ${st.winch.stalled ? 'STALLED' : ''}`,
      `      line ${d.winch.lineM} m out, ${d.winch.remainingM} m on the drum   shock ${(st.winch.shockFrac * 100).toFixed(0)}%`,
      '',
      `SEDAN  ${d.sedan.surface}  v=${d.sedan.speed.toFixed(2)} m/s  w=${d.sedan.omega.toFixed(2)}`,
      `       grip ${kN(gripBudgetN(sedan, t))} kN   downslope ${kN(downslopeN(sedan.body, t))} kN`,
      `       bogged ${(sedan.boggedFactor * 100).toFixed(0)}% of ${kN(sedan.boggedN)} kN   moved ${d.sedan.travelledM} m`,
      `       drag x${sedan.dragMul.toFixed(2)}  bogMul x${sedan.boggedMul.toFixed(2)}  spin ${sedan.spinResistN.toFixed(0)}`,
      `       aids crib ${sedan.aids ? sedan.aids.cribbing : 0}  jack ${sedan.aids ? (sedan.aids.jackLift * 100).toFixed(0) : 0}%  chocks ${sedan.aids ? sedan.aids.chocks : 0}`,
      `       damage ${Object.keys(sedan.damage.parts).length ? JSON.stringify(sedan.damage.parts) : 'none'} dents ${sedan.damage.dents}`,
      '',
      `TRUCK  ${d.truck.surface}  v=${d.truck.speed.toFixed(2)} m/s  park ${truck.parkBrake ? 'ON' : 'off'}`,
      `       grip ${kN(gripBudgetN(truck, t))} kN   downslope ${kN(downslopeN(truck.body, t))} kN`,
      `       throttle ${d.truck.throttle}  steer ${d.truck.steerRad}  slip ${(truck.maxSlipMps || 0).toFixed(2)} m/s`,
      `       aids chocks ${truck.aids ? truck.aids.chocks : 0}   ${st.escalation.truckSlipping ? 'SLIPPING' : ''}${st.escalation.truckInDitch ? ' IN THE DITCH' : ''}`,
      '',
      ...d.crew.map((c) => `CREW${c.seat}  ${c.id}${c.id === st.player.id ? ' (me)' : '     '}  ` +
        `(${c.x.toFixed(1)}, ${c.y.toFixed(1)})  ` +
        `${c.driving ? 'in the ' + c.driving : c.holdingHook ? 'HAS THE HOOK' : c.carrying ? 'carrying ' + c.carrying : '-'}` +
        `${c.stumbleMs > 0 ? '   DOWN ' + c.stumbleMs + ' ms' : ''}`),
      // The authority audit. "ok" is the only acceptable answer: anything else means two people
      // believe they own the same object, which is a bug in a claim/release pair rather than a
      // situation to recover from at runtime. Printing it every frame is how it gets noticed.
      `AUTH   ${d.authority.ok ? 'ok' : 'BROKEN — ' + d.authority.problems.join('; ')}${st.winch.contested ? '   drum CONTESTED' : ''}`,
      // The command seam. `local` is which seats this machine supplies; `pending` is frames queued
      // but not yet delivered, which is latency made visible — the number a real transport would
      // make interesting.
      g.link
        ? `LINK   ${g.link.seats} seats, local [${g.link.localSeats.map((b) => b.seat).join(',')}]`
          + `  delay ${g.link.transport.delaySteps ?? 0} steps`
          + `  sent ${g.link.transport.sent} recv ${g.link.transport.received}`
          + `  pending [${(g.link.transport.pending || []).join(',')}]`
        : 'LINK   none — keyboard straight into the step',
      '',
      `GOAL   ${d.goal.cornersOnRoad}/4 corners  settled ${d.goal.settledMs} ms  ${d.goal.complete ? 'COMPLETE' : ''}`,
      `MISC   debris ${d.debris}  gear placed ${d.gear.placed}  blocks ${d.gear.blocks}  particles ${this.renderer.particles.length}`,
      '',
      'F3 overlay  G grid  H force arrows  T time scale',
      ...g.bus.recent(CONFIG.debug.recentEvents).map((e) => `  ${(e.simTimeMs / 1000).toFixed(1)}s ${e.type}`),
    ];
    this.el.textContent = lines.join('\n');
  }
}
