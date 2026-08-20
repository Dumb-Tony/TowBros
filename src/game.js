/* Game — owns the authoritative state and drives the fixed-step simulation.
 *
 * Structure from AirportBaggageCrew\src\game.js: one authoritative state object, an explicit
 * scene factory, a subscribe/notify boundary, and no clone-on-read (too slow at 60 Hz).
 *
 * THE PAUSE INVARIANT, inherited and still true: every simulation mutation happens inside
 * GameClock.advance()'s step callback. Nothing is driven by rAF directly and nothing uses a
 * browser timer, so pausing the clock pauses the entire scene by construction rather than by
 * every system remembering to check a flag.
 *
 * ── STEP ORDER IS THE MOST IMPORTANT THING IN THIS FILE ───────────────────────────────
 * The tire and bogged models size their static resistance against the external force ALREADY
 * IN THE ACCUMULATOR (src/sim/tires.js resistanceCap). That is what lets a vehicle hold
 * against a load instead of creeping under it — and it means the winch must have applied its
 * force before the tires are asked to resist it. Move stepCable below stepVehicle and the
 * sedan will crawl out of the ditch under 2 kN, which is both wrong and boring.
 */

import { CONFIG } from './config.js';
import { GameClock } from './core/clock.js';
import { EventBus, EVENTS } from './core/eventBus.js';
import { Rng, hashStr } from './core/rng.js';
import { buildScene, stepGoal, stepEscalation, stepJob, recapFrom, JOB } from './world/scene.js';
import { stepCrew, describeVehicle, seatOf, holdsHook, carriedItem } from './player/player.js';
import { validateAuthority } from './crew/authority.js';
import { stepVehicle } from './sim/vehicle.js';
import { stepCollisions } from './sim/collision.js';
import { stepCable, stepCableBreak, describeWinch } from './recovery/cable.js';
import { stepLift, describeLift } from './recovery/lift.js';
import { stepAttachment, applyImpactDamage, stepDebris } from './recovery/attach.js';
import { stepGearEffects } from './recovery/gear.js';
import { gripBudgetN, downslopeN } from './sim/tires.js';

export const MODES = Object.freeze({
  TITLE: 'title',
  PLAYING: 'playing',
  PAUSED: 'paused',
});

/* One named RNG stream per concern, each seeded from the attempt seed with a fixed offset.
 * Separate streams mean adding a draw to one system cannot shift the sequence another system
 * sees — the bug that silently rearranges a balanced scenario. */
const STREAMS = Object.freeze({
  world:   0x00000000,   // scene layout: mud, trees, rail gap, where the sedan came to rest
  attempt: 0x9e3779b9,   // per-attempt variation: which wheels seized, how dug in it is
  fx:      0x85ebca6b,   // presentation jitter. Never touched by a rule.
});

export class Game {
  constructor({ seed = CONFIG.sim.defaultSeed, seedLabel = CONFIG.sim.seedLabel } = {}) {
    this.bus = new EventBus({ logSize: CONFIG.debug.eventLogSize });
    this.clock = new GameClock({ stepMs: CONFIG.sim.stepMs, maxFrameMs: CONFIG.sim.maxFrameMs });

    this.seed = seed >>> 0;
    this.seedLabel = seedLabel;
    this.attempt = 0;
    this.rng = {};
    for (const name of Object.keys(STREAMS)) {
      this.rng[name] = new Rng((this.seed ^ STREAMS[name]) >>> 0, name);
    }

    this._listeners = new Set();
    this.frames = 0;

    /* A load coming off the lift in transit is a fact about the JOB, and the payout reads it. It is
     * counted from the event rather than from inside stepLift so the number survives a reset that
     * clears the log, and so the lift does not need to know a payout exists. */
    this.bus.on(EVENTS.LIFT_RELEASED, (e) => {
      if (e.dropped && this.state && this.state.job) this.state.job.droppedInTransit++;
    });
    /** Optional CommandLink (src/net/commands.js). When set, it supplies one input per seat every
     *  step and whatever the caller passed to frame()/step() is ignored. Null means "the keyboard
     *  is the input", which is what the M1 suite drives. */
    this.link = null;
    /** Lockstep gate (src/net/session.js). When set, `frame()` will not run a step unless
     *  `net.canStep()` says every seat's commands for it have arrived. */
    this.net = null;
    /** How many crew the scene builds. Settable because a networked session's HOST decides it and
     *  both peers must agree — a different crew size is a different world on step one. */
    this.crewCount = CONFIG.crew.count;
    /** The dispatch offer this attempt is running, with the company's loadout and truck condition
     *  folded in. Null for a plain job — see world/scene.js buildScene. */
    this.job = null;
    this.state = this._newState();
    this._syncClockToMode();
  }

  static seedFromLabel(label) { return hashStr(label); }

  _newState() {
    const st = buildScene(this.rng.world, this.crewCount, this.job);
    st.version = 1;
    st.seed = this.seed;
    st.seedLabel = this.seedLabel;
    st.attempt = this.attempt;
    st.mode = MODES.TITLE;
    st.simTimeMs = 0;
    st.settings = { audio: CONFIG.audio.enabled };
    return st;
  }

  /** clock.paused is a FUNCTION of mode and must never be set independently. */
  _syncClockToMode() { this.clock.setPaused(this.state.mode !== MODES.PLAYING); }

  /* ── lifecycle ────────────────────────────────────────────────────────── */

  /**
   * Full reset. GDD §4: "Reset is always available, never imposed."
   *
   * `reroll` advances the attempt counter and reseeds the world stream, which is how the
   * completion criterion "repeating the scenario does not feel exactly identical" is met:
   * the same site, laid out slightly differently, with the same approaches still viable.
   * Pass reroll:false to replay the identical attempt — which is what the tests do.
   */
  reset({ reroll = true, seed = this.seed, seedLabel = this.seedLabel, attempt = null } = {}) {
    this.seed = seed >>> 0;
    this.seedLabel = seedLabel;
    // An explicit attempt is how a joining peer adopts the host's world exactly. It beats reroll.
    if (attempt !== null) this.attempt = attempt;
    else if (reroll) this.attempt++;
    this.clock.reset();
    for (const name of Object.keys(STREAMS)) {
      // Mixing the attempt number in is what re-rolls the layout without losing
      // reproducibility: attempt 3 of seed X is always the same attempt 3 of seed X.
      this.rng[name].reset((this.seed ^ STREAMS[name] ^ (this.attempt * 0x2545f491)) >>> 0);
    }
    this.bus.clearLog();
    this.state = this._newState();
    this.frames = 0;
    this._syncClockToMode();
    this.bus.emit(EVENTS.SIM_RESET, { seed: this.seed, attempt: this.attempt }, 0);
    this._notify();
    return this;
  }

  /** Reset straight into play, skipping the title card. */
  startJob(opts = {}) {
    this.reset(opts);
    this.setMode(MODES.PLAYING);
    return this;
  }

  /* ── mode ─────────────────────────────────────────────────────────────── */

  /** The ONLY writer of state.mode and clock.paused. */
  setMode(mode) {
    if (this.state.mode === mode) return mode;
    const prev = this.state.mode;
    this.state.mode = mode;
    this.clock.setPaused(mode !== MODES.PLAYING);
    this.bus.emit(EVENTS.MODE_CHANGED, { prev, mode }, this.clock.simTimeMs);
    if (mode === MODES.PAUSED) this.bus.emit(EVENTS.SIM_PAUSED, { prev }, this.clock.simTimeMs);
    if (prev === MODES.PAUSED && mode === MODES.PLAYING) {
      this.bus.emit(EVENTS.SIM_RESUMED, {}, this.clock.simTimeMs);
    }
    this._notify();
    return mode;
  }

  togglePause() {
    if (this.state.mode === MODES.PLAYING) return this.setMode(MODES.PAUSED);
    if (this.state.mode === MODES.PAUSED) return this.setMode(MODES.PLAYING);
    return this.state.mode;
  }

  /** Focus loss auto-pauses. Never auto-resumes: coming back to a cable under 30 kN that you
   *  did not choose to load is a bug report, not a challenge. */
  pauseForBlur() {
    if (this.state.mode === MODES.PLAYING) this.setMode(MODES.PAUSED);
  }

  get isRunning() { return this.state.mode === MODES.PLAYING; }

  /* ── simulation ───────────────────────────────────────────────────────── */

  /**
   * Normalise whatever the caller passed into an array indexed by crew SEAT.
   *
   * Milestone 2 needs one input source per crew member, but every existing caller — main.js, and
   * the whole m1 suite — hands over a single Input. Accepting both keeps those working and means
   * a one-player game is honestly just a crew of one.
   */
  _asInputs(input) {
    /* A CommandLink, if one is attached, OVERRIDES whatever was passed in.
     *
     * Every seat then runs off a command frame — the local keyboard included, sampled and pushed
     * through the transport like everybody else. One code path, so a local seat cannot quietly
     * work while a remote one is broken. See src/net/commands.js.
     *
     * pump() runs from here, INSIDE the step, because sampling has to see the same input edges
     * stepCrew is about to read. A step later and every tap is gone. */
    if (this.link) return this.link.pump();
    if (!input) return null;
    return Array.isArray(input) ? input : [input];
  }

  /** One real render frame. Called from requestAnimationFrame ONLY. */
  frame(realDeltaMs, input = null) {
    this.frames++;
    // Deliberately NOT hoisted when a link is attached: each step needs its own freshly pumped
    // frames, and _asInputs (called inside step) is what pumps them.
    const inputs = this.link ? null : this._asInputs(input);
    return this.clock.advance(realDeltaMs, (stepMs, simTimeMs) => {
      this.step(stepMs, simTimeMs, inputs);
      // Input edges are consumed per SIM step, not per frame — and per SEAT, or crew 1's tap
      // would survive into a step where crew 0 had already consumed theirs.
      if (inputs) for (const i of inputs) if (i) i.endStep();
      // With a link attached the real keyboards sit behind it, so they need clearing from here.
      if (this.link) for (const b of this.link.localSeats) b.input.endStep();
    }, this.net ? () => this.net.canStep() : null);
  }

  /**
   * One fixed simulation step. Read the note at the top of this file before reordering.
   */
  step(stepMs, simTimeMs, input) {
    const st = this.state;
    st.simTimeMs = simTimeMs;
    const dt = stepMs / 1000;
    const inputs = this._asInputs(input);

    // 1. Intent, for every crew member. Moves them, sets driver inputs, resolves the one drum
    //    between several pairs of hands, carries the hook.
    stepCrew(st, st.terrain, dt, inputs, this.bus, simTimeMs);

    // 2. Equipment. Rebuilds every multiplier and the block routing table from what is
    //    lying where, so the cable and the tires below read a current world.
    stepGearEffects(st, st.terrain, dt, this.bus, simTimeMs);

    // 3. The line. Applies equal-and-opposite force at two offsets. FIRST force of the step.
    stepCable(st, dt, this.bus, simTimeMs);

    /* 3b. The wheel lift, if it is carrying anything. Beside the cable and for the same reason:
     *     it is a force at an offset on two bodies, and the tires below size their static
     *     resistance against what is already in the accumulator. A loaded truck that is asked to
     *     hold against its own load has to be asked in that order. */
    stepLift(st, dt, this.bus, simTimeMs);

    // 4. Did the attachment survive what the line just did to it? WEAKEST LINK FIRST — the
    //    attachment is judged before the cable, or a 9 kN bumper would outlive a 42 kN cable.
    stepAttachment(st, this.bus, simTimeMs);
    stepCableBreak(st, this.bus, simTimeMs);

    // 5. Contacts, as impulses. Before integration so the tires react to the new velocities.
    const dynamics = [st.vehicles.truck, st.vehicles.sedan, ...st.debris];
    st.fx.peakImpulse = stepCollisions(
      dynamics, st.scenery, this.bus, simTimeMs,
      (A, B, jn, hit) => applyImpactDamage(st, A, B, jn, hit, this.bus, simTimeMs),
    );

    // 6. Ground. Slope, bogged, chocks, tires, then integrate. The tires size their grip
    //    against everything accumulated above.
    stepVehicle(st.vehicles.truck, st.terrain, dt, this.bus, simTimeMs);
    stepVehicle(st.vehicles.sedan, st.terrain, dt, this.bus, simTimeMs);
    stepDebris(st, st.terrain, dt);

    // 7. Outcome. Reports; never intervenes.
    stepGoal(st, this.bus, simTimeMs);
    stepJob(st, this.bus, simTimeMs);
    stepEscalation(st, this.bus, simTimeMs);
  }

  /** Fast-forward without real frames. Also how the test suite runs a whole recovery. */
  skipMs(ms, input = null) {
    const inputs = this._asInputs(input);
    return this.clock.skipMs(ms, (stepMs, t) => {
      this.step(stepMs, t, inputs);
      if (inputs) for (const i of inputs) if (i) i.endStep();
    });
  }

  /** The job, read back off the event log. GDD §9. */
  recap() { return recapFrom(this.bus, this.state); }

  /* ── observation boundary ─────────────────────────────────────────────── */

  subscribe(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _notify() { for (const fn of Array.from(this._listeners)) fn(this.state); }

  /**
   * Compact snapshot for the debug overlay and the tests. Everything here is part of the
   * determinism contract: two runs of one seed and attempt must produce identical output.
   */
  describe() {
    const st = this.state;
    const t = st.terrain;
    const truck = st.vehicles.truck, sedan = st.vehicles.sedan;
    const r2 = (v) => Math.round(v * 100) / 100;
    return {
      mode: st.mode,
      seed: this.seed,
      attempt: this.attempt,
      simTimeMs: Math.round(st.simTimeMs),
      stepCount: this.clock.stepCount,
      frames: this.frames,
      paused: this.clock.paused,
      draws: { world: this.rng.world.draws, attempt: this.rng.attempt.draws },
      events: this.bus.emitted,

      winch: describeWinch(st.winch),
      lift: describeLift(st.vehicles.truck.lift),
      job: {
        phase: st.job.phase,
        bayCorners: st.job.bayCorners,
        inBayMs: Math.round(st.job.inBayMs),
        dropped: st.job.droppedInTransit,
        paid: st.job.payout ? st.job.payout.paid : null,
      },
      crew: st.crew.map((p) => ({
        id: p.id, seat: p.seat,
        x: r2(p.x), y: r2(p.y),
        driving: seatOf(st, p)?.id ?? null,
        holdingHook: holdsHook(st, p),
        carrying: carriedItem(st, p)?.id ?? null,
        stumbleMs: Math.round(p.stumbleMs),
      })),
      authority: (() => { const problems = validateAuthority(st); return { ok: problems.length === 0, problems }; })(),
      sedan: {
        ...sedan.body.describe(),
        surface: t.surfaceAt(sedan.body.x, sedan.body.y).id,
        boggedFrac: r2(sedan.boggedFactor),
        travelledM: r2(sedan.travelledM),
        gripN: Math.round(gripBudgetN(sedan, t)),
        downslopeN: Math.round(downslopeN(sedan.body, t)),
        dragMul: r2(sedan.dragMul),
        parts: { ...sedan.damage.parts },
        dents: sedan.damage.dents,
      },
      truck: {
        ...truck.body.describe(),
        surface: t.surfaceAt(truck.body.x, truck.body.y).id,
        gripN: Math.round(gripBudgetN(truck, t)),
        parkBrake: truck.parkBrake,
        throttle: r2(truck.throttle),
        steerRad: r2(truck.steerRad),
      },
      goal: { ...st.goal },
      escalation: { ...st.escalation },
      gear: {
        carried: st.gear.filter((g) => g.carriedBy).length,
        placed: st.gear.filter((g) => g.placed).length,
        blocks: Object.keys(st.blocksById).length,
      },
      debris: st.debris.length,
      terrain: t.describe(),
    };
  }

  /** Inspect-style summary of both vehicles, for the debug overlay. */
  describeVehicles() {
    return {
      sedan: describeVehicle(this.state.vehicles.sedan, this.state.terrain),
      truck: describeVehicle(this.state.vehicles.truck, this.state.terrain),
    };
  }
}
