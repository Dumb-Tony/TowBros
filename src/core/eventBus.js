/* Domain event bus.
 *
 * COPIED from AirportBaggageCrew\src\core\eventBus.js (Dev\INDEX.md "Simulation loop,
 * time & state"). Subscribe/emit plus a BOUNDED recent-event log.
 *
 * In Tow Bros the log is not a debug luxury, it is the answer to GDD §9's north-star
 * question. A player should be able to say "I hooked the bumper, it tore off, so I
 * chained the axle" — and the event log is the machine-readable version of exactly that
 * sentence. The HUD renders the tail of it as the job log.
 *
 * Rendering and UI listen. They never emit gameplay events and never decide rules.
 */

export const EVENTS = Object.freeze({
  SIM_RESET:          'SIM_RESET',
  SIM_PAUSED:         'SIM_PAUSED',
  SIM_RESUMED:        'SIM_RESUMED',
  MODE_CHANGED:       'MODE_CHANGED',

  // player / possession
  VEHICLE_ENTERED:    'VEHICLE_ENTERED',
  VEHICLE_EXITED:     'VEHICLE_EXITED',
  INSPECTED:          'INSPECTED',
  BRAKE_SET:          'BRAKE_SET',      // { crew, vehicle, on } — reached in through the window
  CREW_STUMBLED:      'CREW_STUMBLED',  // { crew, speed } knocked down by something moving

  // rigging
  HOOK_TAKEN:         'HOOK_TAKEN',      // carried off the drum on foot
  HOOK_STOWED:        'HOOK_STOWED',
  HOOK_ATTACHED:      'HOOK_ATTACHED',   // { zone, rig }
  HOOK_DETACHED:      'HOOK_DETACHED',
  RIG_APPLIED:        'RIG_APPLIED',     // strap or chain wrapped round a zone
  BLOCK_MOUNTED:      'BLOCK_MOUNTED',   // snatch block secured to an anchor
  BLOCK_REMOVED:      'BLOCK_REMOVED',
  CABLE_ROUTED:       'CABLE_ROUTED',    // line now runs through the block

  // winch
  WINCH_IN:           'WINCH_IN',
  WINCH_OUT:          'WINCH_OUT',
  WINCH_STALLED:      'WINCH_STALLED',   // motor cannot beat the load
  WINCH_SPOOL_END:    'WINCH_SPOOL_END',
  CABLE_SNAPPED:      'CABLE_SNAPPED',   // { tensionN }

  // consequences
  ZONE_FAILED:        'ZONE_FAILED',     // { zone, tensionN } attachment tore out
  COMPONENT_DETACHED: 'COMPONENT_DETACHED',
  COMPONENT_DAMAGED:  'COMPONENT_DAMAGED',
  IMPACT:             'IMPACT',          // { impulseN, a, b }
  GUARDRAIL_BENT:     'GUARDRAIL_BENT',
  TRUCK_SLIPPING:     'TRUCK_SLIPPING',  // the recovery vehicle is losing the argument
  ROLLED_OVER:        'ROLLED_OVER',

  // equipment
  GEAR_PICKED_UP:     'GEAR_PICKED_UP',

  /* The wheel lift and the delivery. GDD §7 Milestone 3. */
  LIFT_EXTENDED:      'LIFT_EXTENDED',
  LIFT_STOWED:        'LIFT_STOWED',
  LIFT_ENGAGED:       'LIFT_ENGAGED',    // { vehicle, end, misalignDeg } an axle is up
  LIFT_RELEASED:      'LIFT_RELEASED',   // { vehicle, reason, dropped } set down, or lost
  LOAD_SECURED:       'LOAD_SECURED',    // { gear, kind, straps, capacityN }
  JOB_PHASE:          'JOB_PHASE',       // { from, to }
  JOB_DELIVERED:      'JOB_DELIVERED',   // { payout, deductions, atMs }

  /* Traffic and the county. GDD §7 Milestone 5. */
  TRAFFIC_HORN:       'TRAFFIC_HORN',    // { car, what, speed } somebody has seen you too late
  TRAFFIC_HIT:        'TRAFFIC_HIT',     // { car, what, impulseNs } and did not stop in time
  GEAR_PLACED:        'GEAR_PLACED',
  GEAR_USED:          'GEAR_USED',       // jack pumped
  GEAR_SCATTERED:     'GEAR_SCATTERED',  // cribbing kicked out by an impact

  // outcome
  RECOVERY_COMPLETE:  'RECOVERY_COMPLETE',
});

/* Types the recap is built from. The `log` is a RING and evicts its oldest entries, which is
 * correct for a debug overlay and useless for a story: a two-minute recovery would lose the
 * moment the player chose the bumper. So story-worthy events go to a second, append-only list
 * that keeps the BEGINNING and drops anything past its cap.
 *
 * Caught by the m1 suite: with only the ring, recapFrom() returned an empty job on any
 * recovery long enough to be interesting. */
const STORY = new Set([
  'HOOK_ATTACHED', 'HOOK_DETACHED', 'RIG_APPLIED', 'BLOCK_MOUNTED', 'CABLE_ROUTED', 'BRAKE_SET',
  'WINCH_STALLED', 'CABLE_SNAPPED', 'ZONE_FAILED', 'COMPONENT_DETACHED', 'COMPONENT_DAMAGED',
  'IMPACT', 'GUARDRAIL_BENT', 'TRUCK_SLIPPING', 'ROLLED_OVER', 'GEAR_SCATTERED', 'CREW_STUMBLED',
  'RECOVERY_COMPLETE', 'LIFT_ENGAGED', 'LIFT_RELEASED', 'LOAD_SECURED', 'JOB_DELIVERED',
  'TRAFFIC_HIT',
]);

export class EventBus {
  constructor({ logSize = 256, storySize = 220 } = {}) {
    this._handlers = new Map();   // type -> Set<fn>
    this._any = new Set();
    this.logSize = logSize;
    this.log = [];                // ring, newest last
    this.storySize = storySize;
    this.story = [];              // append-only, oldest kept
    this.counts = new Map();      // type -> total ever emitted, independent of eviction
    this.emitted = 0;
  }

  /** @returns {() => void} unsubscribe */
  on(type, fn) {
    let set = this._handlers.get(type);
    if (!set) { set = new Set(); this._handlers.set(type, set); }
    set.add(fn);
    return () => set.delete(fn);
  }

  /** @returns {() => void} unsubscribe */
  onAny(fn) { this._any.add(fn); return () => this._any.delete(fn); }

  off(type, fn) {
    const set = this._handlers.get(type);
    if (set) set.delete(fn);
  }

  emit(type, payload = {}, simTimeMs = 0) {
    const evt = { type, simTimeMs, ...payload };
    this.emitted++;
    this.counts.set(type, (this.counts.get(type) || 0) + 1);

    this.log.push(evt);
    if (this.log.length > this.logSize) this.log.shift();
    if (STORY.has(type) && this.story.length < this.storySize) this.story.push(evt);

    const set = this._handlers.get(type);
    // iterate a copy: a handler may unsubscribe itself mid-dispatch
    if (set) for (const fn of Array.from(set)) fn(evt);
    for (const fn of Array.from(this._any)) fn(evt);
    return evt;
  }

  /** Most recent events, newest first. */
  recent(n = 8) { return this.log.slice(-n).reverse(); }

  /** How many of a type have EVER been emitted this attempt. Read from the counter, not the
   *  ring — a count that silently falls back to zero once the log rolls over is worse than no
   *  count at all. */
  count(type) { return this.counts.get(type) || 0; }

  clearLog() {
    this.log.length = 0;
    this.story.length = 0;
    this.counts.clear();
    this.emitted = 0;
  }

  /** Drop every subscriber. Restart rebuilds systems, so stale closures must not survive. */
  clearHandlers() { this._handlers.clear(); this._any.clear(); }
}
