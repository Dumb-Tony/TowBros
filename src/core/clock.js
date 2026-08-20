/* GameClock — the single owner of simulation time.
 *
 * COPIED from AirportBaggageCrew\src\core\clock.js (Dev\INDEX.md "Simulation loop, time
 * & state"). No system may read Date.now(), performance.now(), setTimeout or setInterval
 * to decide when something happens.
 *
 * A FIXED STEP IS NOT A STYLE CHOICE HERE. Tow Bros resolves a stiff cable spring
 * between two rigid bodies (src/recovery/cable.js) and a per-wheel friction impulse that
 * divides by dt (src/sim/tires.js). Both have a stability limit that is a function of
 * step size. On a variable step a 144 Hz monitor and a 30 fps laptop would not merely
 * feel different — one of them would blow the constraint up. Every force number in
 * src/config.js is tuned against CONFIG.sim.stepMs.
 *
 * Fixed step with an accumulator: real frame time is clamped, scaled, banked, and spent
 * in whole 1/60 s steps. The clock advances simTimeMs ITSELF, inside advance(), as it
 * calls the step callback — so simulation time and steps executed cannot drift apart no
 * matter what the caller does.
 */

export class GameClock {
  /**
   * @param {number} stepMs      fixed simulation step
   * @param {number} maxFrameMs  frame gaps longer than this are discarded, not banked.
   *   Backgrounded tabs hand back multi-second deltas; without this the sim would try to
   *   catch up over hundreds of steps, and a rigged cable would resolve hundreds of
   *   steps of tension inside one frame. Alt-tabbing would snap the line.
   */
  constructor({ stepMs = 1000 / 60, maxFrameMs = 250 } = {}) {
    this.stepMs = stepMs;
    this.maxFrameMs = maxFrameMs;
    this.reset();
  }

  reset() {
    this.simTimeMs = 0;
    this.stepCount = 0;
    this.accumulatorMs = 0;
    this.paused = false;
    this.timeScale = 1;      // debug only; never shipped off 1
    this.clampedFrames = 0;  // diagnostic: how often we threw time away
  }

  /**
   * Spend one real frame of elapsed time.
   * @param {number} realDeltaMs  wall-clock ms since the previous frame
   * @param {(stepMs:number, simTimeMs:number)=>void} onStep  run once per fixed step
   * @returns {number} steps executed
   *
   * Paused returns 0 without touching the accumulator, so unpausing resumes mid-step
   * rather than dumping a burst of banked time into the world.
   */
  advance(realDeltaMs, onStep) {
    if (this.paused) return 0;

    let dt = realDeltaMs;
    if (dt > this.maxFrameMs) { dt = this.maxFrameMs; this.clampedFrames++; }
    if (dt < 0) dt = 0;

    this.accumulatorMs += dt * this.timeScale;

    let steps = 0;
    while (this.accumulatorMs >= this.stepMs) {
      this.accumulatorMs -= this.stepMs;
      this.simTimeMs += this.stepMs;
      this.stepCount++;
      steps++;
      if (onStep) onStep(this.stepMs, this.simTimeMs);
    }
    return steps;
  }

  /** Fraction of the way into the next step, for render interpolation. 0..1 */
  get alpha() { return this.accumulatorMs / this.stepMs; }

  setPaused(p) { this.paused = !!p; }
  togglePause() { this.paused = !this.paused; return this.paused; }

  /** Run the simulation forward without waiting for real frames.
   *
   *  This is also how the test suite runs an entire recovery: MEASURED and recorded in
   *  Dev\INDEX.md, headless Chrome in --dump-dom mode delivers only 1-3 rAF callbacks
   *  ever, so a suite that waits for frames waits forever. Drive the step directly. */
  skipMs(ms, onStep) {
    const wasPaused = this.paused;
    this.paused = false;
    // fed in maxFrameMs-sized slices so the clamp never discards the skip itself
    let left = ms, steps = 0;
    while (left > 0) {
      const chunk = Math.min(left, this.maxFrameMs);
      steps += this.advance(chunk, onStep);
      left -= chunk;
    }
    this.paused = wasPaused;
    return steps;
  }

  /** m:ss for the HUD. Formatting lives here so no two panels disagree. */
  static formatMs(ms) {
    if (ms < 0) ms = 0;
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
}
