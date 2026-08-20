/* The seam a network goes through. GDD §7 Milestone 2: "2-4 player networking."
 *
 * GDD §6 is specific about where multiplayer belongs:
 *
 *   "Future multiplayer authority should live above deterministic-ish simulation commands:
 *    drive input, equipment pickup/place, attach/detach, and winch state."
 *
 * ABOVE the simulation. So this module is not a network — it is the shape of what a network would
 * carry, and the adapter that lets the game be driven by it instead of by a keyboard.
 *
 * ── WHY THIS AND NOT A SOCKET ────────────────────────────────────────────────────────
 * The transport is the least interesting part of multiplayer and the only part that cannot be
 * playtested alone. The interesting part is whether the game survives being driven by something
 * other than the hands in front of it — one step late, out of order, or not at all. That is all
 * testable with no wire whatsoever, so it is done first and tested first (tools/m2-tests.js §Q).
 *
 * The project's rule is zero external requests: no CDN, no analytics, nothing fetched from
 * anywhere. WebRTC needs a signalling server to introduce two browsers, which is an external
 * request by any reading — so which transport gets bolted on here is a decision with a real
 * trade-off behind it, and not one to make silently in the middle of a refactor. Everything in
 * this file is transport-agnostic and stays correct whichever way that goes.
 *
 * ── THE COMMAND FRAME ────────────────────────────────────────────────────────────────
 * One frame per seat per simulation step. Two 16-bit masks:
 *
 *   held     the actions physically down this step   (walk, throttle, reel)
 *   pressed  the actions that went down THIS step    (attach, pick up, enter, brake)
 *
 * That is the whole protocol. It is exactly what Input already exposes — isDown/wasPressed — so
 * `stepCrew` cannot tell the difference between a keyboard and a packet, and there is no second
 * code path to keep in sync. Four bytes per seat per step: 60 steps/s x 4 seats x 4 bytes is
 * under a kilobyte a second before any delta coding, which is not a problem worth solving yet.
 *
 * Frames carry no positions and no forces. The simulation is fixed-step and seeded (Hg1 in the
 * M1 suite replays bit-for-bit), so the same commands from the same seed give the same world on
 * every machine. Sending state instead of intent would throw that away.
 */

/** The wire order. NEVER reorder or remove an entry — the index IS the bit. Append only. */
export const ACTIONS = Object.freeze([
  'moveUp', 'moveDown', 'moveLeft', 'moveRight',
  'context', 'inspect', 'detach', 'enterExit', 'brake',
  'winchIn', 'winchOut',
  /* Milestone 6, appended: the heavy wrecker's own machinery. Two slew keys and a leg toggle,
   * on the same tier as winchIn/winchOut — machine controls rather than the one contextual
   * verb, which is what those two have always been. Appended, never inserted: the index IS
   * the bit and a joining peer from an older build must not read a different action. */
  'slewLeft', 'slewRight', 'outriggers',
]);

const BIT = Object.freeze(ACTIONS.reduce((m, a, i) => (m[a] = 1 << i, m), {}));

/**
 * Read one seat's live Input into a frame.
 *
 * Called once per simulation step, inside the step, so the `pressed` mask lines up with the edges
 * `endStep` is about to clear. Reading it on the render frame instead would drop edges on any
 * frame that ran two steps, which is most of them.
 */
export function sampleFrame(input) {
  if (!input) return { held: 0, pressed: 0 };
  let held = 0, pressed = 0;
  for (const a of ACTIONS) {
    if (input.isDown(a)) held |= BIT[a];
    if (input.wasPressed(a)) pressed |= BIT[a];
  }
  return { held, pressed };
}

/** Sample every seat at once. Missing seats become empty frames, not holes. */
export function sampleFrames(inputs, seats) {
  const out = [];
  for (let i = 0; i < seats; i++) out.push(sampleFrame(inputs && inputs[i]));
  return out;
}

/** Pack a frame into one integer, for a transport that wants bytes rather than objects. */
export const packFrame = (f) => ((f.held & 0xffff) << 16) | (f.pressed & 0xffff);
export const unpackFrame = (n) => ({ held: (n >>> 16) & 0xffff, pressed: n & 0xffff });

export const EMPTY_FRAME = Object.freeze({ held: 0, pressed: 0 });

/**
 * An Input, driven by frames instead of by a keyboard.
 *
 * Deliberately duck-typed rather than subclassed: `stepCrew` asks for isDown / wasPressed /
 * driveAxis / moveAxis and nothing else, so matching that surface exactly is the whole contract.
 * If this class ever needs a method the real Input does not have, that is a sign a system reached
 * past the seam and should be fixed there instead.
 */
export class CommandInput {
  constructor(seat = 0) {
    this.seat = seat;
    this.frame = EMPTY_FRAME;
    /** Present so main.js's pointer handling and the HUD's virtual buttons do not special-case
     *  a remote seat. A remote player's mouse is their own business. */
    this.pointer = { x: 0, y: 0, down: false, seen: false };
    this.pointerWorld = null;
  }

  /** Hand it the frame for the step about to run. */
  setFrame(frame) { this.frame = frame || EMPTY_FRAME; return this; }

  isDown(action) { return (this.frame.held & (BIT[action] || 0)) !== 0; }
  wasPressed(action) { return (this.frame.pressed & (BIT[action] || 0)) !== 0; }
  wasReleased() { return false; }   // nothing in the sim reads releases; see Input.wasReleased

  /** Same normalisation as Input.moveAxis — diagonals are not faster. */
  moveAxis() {
    let x = (this.isDown('moveRight') ? 1 : 0) - (this.isDown('moveLeft') ? 1 : 0);
    let y = (this.isDown('moveDown') ? 1 : 0) - (this.isDown('moveUp') ? 1 : 0);
    if (x && y) { const inv = Math.SQRT1_2; x *= inv; y *= inv; }
    return { x, y };
  }

  /** The boom, over the wire like everything else. Milestone 6. */
  slewAxis() {
    return (this.isDown('slewRight') ? 1 : 0) - (this.isDown('slewLeft') ? 1 : 0);
  }

  /** And the same refusal to normalise driving: W+D is full throttle AND full lock. */
  driveAxis() {
    return {
      steer: (this.isDown('moveRight') ? 1 : 0) - (this.isDown('moveLeft') ? 1 : 0),
      throttle: (this.isDown('moveUp') ? 1 : 0) - (this.isDown('moveDown') ? 1 : 0),
    };
  }

  /* The frame is replaced every step, so there are no edges to clear and nothing to reset.
   * Present because the loop calls it on everything it is given. */
  endStep() {}
  clear() { this.frame = EMPTY_FRAME; }
  virtualDown() {} virtualUp() {} virtualTap() {}
}

/**
 * A transport that never leaves the machine, with a settable delay in simulation steps.
 *
 * This is the thing that makes the seam testable. A real wire adds latency and this reproduces
 * exactly that, deterministically, with no server: push a frame now, receive it `delaySteps`
 * steps later. Set the delay to 0 and it is local co-op; set it to 6 and it is 100 ms of ping.
 *
 * It is also the honest default for a single-player session. Seats 2 and 3 have no keyboard, so
 * without a transport they would be driven by `undefined` — and "the missing case is the same
 * code path as the working case" is worth more than the few bytes this costs.
 */
export class LoopbackTransport {
  constructor(seats = 4, delaySteps = 0) {
    this.seats = seats;
    this.delaySteps = delaySteps;
    this._queues = Array.from({ length: seats }, () => []);
    this._last = Array.from({ length: seats }, () => EMPTY_FRAME);
    /** Which step receive() is serving. Delay is measured in these, not in queue depth. */
    this._step = 0;
    this.sent = 0;
    this.received = 0;
  }

  /**
   * Queue one seat's frame, due `delaySteps` steps from now.
   *
   * Age, not queue depth. Holding a frame back "until more than N are waiting" reads the same at
   * first and is quietly wrong: the queue then keeps N frames forever and never drains, so the
   * last N commands of a session are never delivered at all. Stamping each frame with the step it
   * is due on drains correctly and makes the delay exact rather than approximate.
   */
  send(seat, frame) {
    if (seat < 0 || seat >= this.seats) return false;
    this._queues[seat].push({ dueAt: this._step + this.delaySteps, frame: frame || EMPTY_FRAME });
    this.sent++;
    return true;
  }

  /**
   * Take the frame each seat should be driven by this step, and advance the clock.
   *
   * A seat with nothing due REPEATS its last frame rather than going blank. That is not a shortcut
   * — it is what a held key means. Dropping to zero on a late packet would make a player let go of
   * the winch every time the network hiccupped, which is the most annoying possible failure and
   * the same reason `stepCrew` holds the last drive command when a seat has no input.
   */
  receive() {
    const out = [];
    for (let s = 0; s < this.seats; s++) {
      const q = this._queues[s];
      // Deliver at most one per step: frames are produced one per step, so delivering a backlog
      // all at once would compress several steps of intent into one and lose the rest.
      if (q.length && q[0].dueAt <= this._step) {
        this._last[s] = q.shift().frame;
        this.received++;
      }
      out.push(this._last[s]);
    }
    this._step++;
    return out;
  }

  /** Frames queued but not yet delivered, per seat. For the debug overlay. */
  get pending() { return this._queues.map((q) => q.length); }

  reset() {
    for (const q of this._queues) q.length = 0;
    this._last = this._last.map(() => EMPTY_FRAME);
    this._step = 0;
    this.sent = 0; this.received = 0;
  }
}

/**
 * The whole seam in one object: local keyboards in, one input per seat out.
 *
 * Every seat — local or remote — is driven by a CommandInput, including the one holding the
 * keyboard. That is the point. A local seat that bypassed the command path would be the one seat
 * whose bugs nobody found until the first real session.
 *
 * @param {number} seats     how many crew the session has
 * @param {object} transport anything with send(seat, frame) and receive() -> frame[]
 */
export class CommandLink {
  constructor(seats, transport = null) {
    this.seats = seats;
    this.transport = transport || new LoopbackTransport(seats, 0);
    this.inputs = Array.from({ length: seats }, (_, i) => new CommandInput(i));
    /** Which seats this machine supplies input for. Everything else arrives over the transport. */
    this.localSeats = [];
  }

  /** Declare a seat as locally driven by a real Input. */
  bindLocal(seat, input) {
    this.localSeats.push({ seat, input });
    return this;
  }

  /**
   * One step's worth of plumbing: sample the local keyboards, push them, take delivery, and
   * point every seat's CommandInput at the frame it should run.
   *
   * Call this INSIDE the fixed step, before stepCrew, and after nothing. The sampling has to see
   * the same edges stepCrew will.
   */
  pump() {
    for (const { seat, input } of this.localSeats) this.transport.send(seat, sampleFrame(input));
    const frames = this.transport.receive();
    for (let s = 0; s < this.seats; s++) this.inputs[s].setFrame(frames[s]);
    return this.inputs;
  }
}
