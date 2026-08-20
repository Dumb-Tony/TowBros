/* Lockstep over the command seam. The other half of GDD §7 Milestone 2: "2-4 player networking."
 *
 * ── WHY LOCKSTEP, AND NOT A HOST WITH AUTHORITY ──────────────────────────────────────
 * This simulation is already fixed-step, seeded, and free of wall-clock time and Math.random —
 * m1-tests Hg1 replays a whole recovery bit-for-bit, and m2-tests P1 does it with a crew. When
 * that is true, the cheapest correct network is the one that sends nothing but intent: every peer
 * runs the same steps from the same seed with the same commands, and arrives at the same world.
 * No authority, no reconciliation, no interpolation, and no snapshots of a 6.8-tonne truck mid-slide
 * being smeared across three frames.
 *
 * The price is that nobody may step until EVERY seat's commands for that step have arrived. That is
 * the deal, and it is paid with input delay (below) rather than with prediction.
 *
 * ── INPUT DELAY ──────────────────────────────────────────────────────────────────────
 * A frame sampled while running step N is scheduled for step N + `stepDelay`. That gives the
 * network `stepDelay` steps — at 60 Hz, ~17 ms each — to deliver it before anybody needs it. Four
 * steps is 67 ms of headroom and about one frame of felt latency on the local player's own actions.
 *
 * `LoopbackTransport.delaySteps` in commands.js is the same idea with no wire attached, which is why
 * the delay path was already tested (m2-tests Q29) before this file existed.
 *
 * ── WHAT GOES ON THE WIRE ────────────────────────────────────────────────────────────
 * Frames, and a handshake. A frame is a seat, a step number and 32 bits of packed masks. Every
 * message also repeats the last few frames from that seat, so a dropped packet costs nothing as
 * long as the next one arrives inside the window — which means this works on an unreliable channel
 * as well as an ordered one.
 *
 * The handshake exists only to agree on the three things determinism needs: the seed, the attempt
 * number, and how many crew are on site. The host decides all three; a guest that disagrees would
 * diverge on the first step, so it does not get to have an opinion.
 */

import { sampleFrame, packFrame, unpackFrame, EMPTY_FRAME } from './commands.js';

/** Wire message types. Short because they are sent 60 times a second. */
export const MSG = Object.freeze({
  HELLO: 'h',      // guest -> host: I exist
  WELCOME: 'w',    // host -> guest: here is the world, and your seat
  INPUT: 'i',      // either way: frames
  BYE: 'b',        // either way: I am leaving
});

/*
 * How many past frames ride along with each message.
 *
 * This is the entire loss-recovery strategy: there is no ack, no retransmit request and no
 * resync, so a frame that falls outside this window when it is finally needed is gone, and a
 * lockstep peer missing a frame it needs waits forever. The window IS the maximum survivable
 * outage — 24 frames is 400 ms at 60 Hz.
 *
 * It costs almost nothing. A frame is a step number and 32 bits; 24 of them is a few hundred
 * bytes, sent once per local seat per step, so about 20 kB/s each way with one seat. That is
 * cheaper than the machinery an ack-based scheme would need, and it degrades honestly: a hiccup
 * inside the window is invisible, and one outside it stops the game rather than desyncing it.
 */
const REDUNDANCY = 24;

/**
 * The scheduler. Implements the same surface as LoopbackTransport — `send(seat, frame)`,
 * `receive()`, `pending`, `delaySteps` — so `CommandLink` cannot tell the difference, plus
 * `ready()`, which is the one thing a network adds: sometimes you may not step yet.
 */
export class LockstepTransport {
  /**
   * @param {number} seats      how many seats the session has
   * @param {number} stepDelay  steps of input delay
   * @param {function|null} transmit  called with each outgoing message. A bare function, not a
   *   peer object: NetSession owns the peer's single `onMessage` hook and routes to `_onMessage`
   *   here, and two objects both assigning that hook is a bug that silently eats half the
   *   protocol. Giving the scheduler a send-only capability makes the ownership unambiguous.
   *   (It was `null` for one round of tests, which is how the wire came to be write-only: both
   *   ends ran their four steps of input delay and then deadlocked forever.)
   */
  constructor(seats, stepDelay, transmit = null) {
    this.seats = seats;
    this.delaySteps = stepDelay;
    this.transmit = transmit;
    /** Seats this machine samples and transmits. Everything else must arrive. */
    this.localSeats = new Set();
    /** Seats a live peer has claimed. A seat nobody owns is driven by empty frames forever,
     *  which is correct: an absent player is a player doing nothing, not a stall. */
    this.claimedSeats = new Set();

    /** step -> seat -> packed frame. A Map of Maps, pruned behind the current step. */
    this._sched = new Map();
    this._step = 0;
    this._last = Array.from({ length: seats }, () => EMPTY_FRAME);
    this._history = Array.from({ length: seats }, () => []);   // [step, packed] pairs

    this.sent = 0;
    this.received = 0;
    /** Steps we wanted to run and could not, because somebody's commands had not arrived. The
     *  single most useful number in the whole system — it IS the connection quality. */
    this.stalls = 0;
    this.lastStallStep = -1;

  }

  /** The step the simulation is about to run. */
  get step() { return this._step; }

  /* ── outgoing ─────────────────────────────────────────────────────────── */

  /**
   * Schedule one local seat's frame for `step + delaySteps` and put it on the wire.
   *
   * Called by CommandLink.pump() once per local seat per step, which is the contract the whole
   * seam runs on: one send per seat per step. Two would interleave and halve the duty cycle.
   */
  send(seat, frame) {
    if (seat < 0 || seat >= this.seats) return false;
    const at = this._step + this.delaySteps;
    const packed = packFrame(frame || EMPTY_FRAME);
    this._put(at, seat, packed);

    const h = this._history[seat];
    h.push([at, packed]);
    if (h.length > REDUNDANCY) h.shift();

    if (this.transmit) this.transmit({ t: MSG.INPUT, s: seat, f: h.slice() });
    this.sent++;
    return true;
  }

  /* ── incoming ─────────────────────────────────────────────────────────── */

  _onMessage(m) {
    if (!m || m.t !== MSG.INPUT) return;          // handshake belongs to NetSession
    if (this.localSeats.has(m.s)) return;         // never let the wire overwrite our own hands
    this.claimedSeats.add(m.s);
    for (const [at, packed] of m.f) {
      if (at < this._step) continue;              // too late to matter; the step already ran
      if (this._put(at, m.s, packed)) this.received++;
    }
  }

  _put(step, seat, packed) {
    let row = this._sched.get(step);
    if (!row) { row = new Map(); this._sched.set(step, row); }
    if (row.has(seat)) return false;              // first delivery wins; resends are duplicates
    row.set(seat, packed);
    return true;
  }

  /* ── the gate ─────────────────────────────────────────────────────────── */

  /**
   * May the simulation run the next step?
   *
   * Only if every seat that a live peer has claimed has a frame scheduled for it. Local seats are
   * always satisfied, because `send` is called for them immediately before this. Unclaimed seats
   * are always satisfied, because nobody is driving them.
   *
   * The first `delaySteps` steps have no scheduled frames at all by construction — the delay is a
   * head start — so they run on empty frames. That is the standard warm-up and it is why the crew
   * spend the first ~67 ms standing still on both machines rather than one of them stalling.
   */
  ready() {
    const row = this._sched.get(this._step);
    for (const seat of this.claimedSeats) {
      if (this.localSeats.has(seat)) continue;
      if (this._step < this.delaySteps) continue;
      if (!row || !row.has(seat)) return false;
    }
    return true;
  }

  /** Take this step's frames and advance. Call only when ready(). */
  receive() {
    const row = this._sched.get(this._step);
    const out = [];
    for (let s = 0; s < this.seats; s++) {
      if (row && row.has(s)) {
        this._last[s] = unpackFrame(row.get(s));
      }
      // else: hold the last frame. A held key stays held through a gap; going blank would make
      // players let go of the winch every time a packet was late.
      out.push(this._last[s]);
    }
    this._sched.delete(this._step);
    this._step++;
    return out;
  }

  /**
   * Re-offer every frame this machine already holds for its own seats.
   *
   * ── THE DEADLOCK THIS EXISTS TO BREAK ────────────────────────────────────────────
   * Frames are produced by STEPPING: sampling happens inside the step. So a peer whose gate is
   * closed transmits nothing — and if both ends are closed at once, neither will ever send the
   * frame the other is waiting for. They wait for each other forever.
   *
   * That is not a hypothetical. MEASURED (m2-tests §R): a one-sided outage of eight steps left the
   * host needing the guest's frame for step N and the guest needing the host's for step N+4. Both
   * had already SAMPLED the frame the other needed. Neither could deliver it, because delivering
   * requires stepping and stepping requires delivery.
   *
   * The fix is not to produce new frames — a stalled peer has none — but to re-send the ones it
   * has. So the moment the gate closes, offer the whole redundancy window again. It costs nothing
   * in the normal case, because in the normal case the gate never closes.
   */
  flush() {
    if (!this.transmit) return 0;
    let n = 0;
    for (const seat of this.localSeats) {
      const h = this._history[seat];
      if (h.length) { this.transmit({ t: MSG.INPUT, s: seat, f: h.slice() }); n++; }
    }
    return n;
  }

  /** Record a step we wanted and could not have, and re-offer what we hold. */
  noteStall() {
    if (this.lastStallStep !== this._step) { this.stalls++; this.lastStallStep = this._step; }
    this.flush();
  }

  /** Frames scheduled ahead of the current step, per seat. The debug overlay's latency readout. */
  get pending() {
    const counts = new Array(this.seats).fill(0);
    for (const [at, row] of this._sched) {
      if (at < this._step) continue;
      for (const s of row.keys()) counts[s]++;
    }
    return counts;
  }

  reset() {
    this._sched.clear();
    this._step = 0;
    this._last = this._last.map(() => EMPTY_FRAME);
    this._history = this._history.map(() => []);
    this.sent = 0; this.received = 0; this.stalls = 0; this.lastStallStep = -1;
  }
}

/* ── the session ───────────────────────────────────────────────────────────── */

export const NET = Object.freeze({
  OFFLINE: 'offline',
  HOSTING: 'hosting',     // waiting for somebody
  JOINING: 'joining',     // sent hello, waiting for welcome
  PLAYING: 'playing',     // synced, stepping
  CLOSED: 'closed',
});

/**
 * Wires a transport to a Game and agrees on the world.
 *
 * Deliberately thin. The hard parts are elsewhere — determinism in the simulation, ownership in
 * `crew/authority.js`, scheduling in `LockstepTransport` — and this only has to make three numbers
 * match on both machines and then get out of the way.
 */
export class NetSession {
  /**
   * @param {object} game
   * @param {object} peer      transport with send(obj)/onMessage/close()
   * @param {object} opts      { host, seats, stepDelay, crewCount }
   */
  constructor(game, peer, { host = false, seats = 4, stepDelay = 4, crewCount = 2 } = {}) {
    this.game = game;
    this.peer = peer;
    this.isHost = !!host;
    this.seats = seats;
    this.stepDelay = stepDelay;
    this.crewCount = crewCount;
    this.state = NET.OFFLINE;
    /** Seat this machine's keyboard drives. Host is 0; each guest is assigned on welcome. */
    this.mySeat = host ? 0 : null;
    /** Seats other peers have claimed, host's view. */
    this.takenSeats = new Set(host ? [0] : []);
    this.error = null;
    /** Called when the state changes, so the UI can redraw without polling. */
    this.onChange = null;

    this.transport = new LockstepTransport(seats, stepDelay, (m) => this.peer && this.peer.send(m));
    if (host) this.transport.localSeats.add(0);
    if (host) this.transport.claimedSeats.add(0);

    // The session owns the peer's message hook and forwards what it does not handle. Two objects
    // both assigning `peer.onMessage` is a bug that silently drops half the protocol.
    if (peer) peer.onMessage = (m) => this._onMessage(m);
  }

  _set(state) {
    if (this.state === state) return;
    this.state = state;
    if (this.onChange) this.onChange(this);
  }

  /** Host: open and wait. Guest: announce ourselves. */
  start() {
    if (this.isHost) {
      this._set(NET.HOSTING);
    } else {
      this._set(NET.JOINING);
      this.peer.send({ t: MSG.HELLO });
    }
    return this;
  }

  _onMessage(m) {
    if (!m) return;
    switch (m.t) {
      case MSG.HELLO: {
        if (!this.isHost) return;               // guests do not hand out seats
        const seat = this._freeSeat();
        if (seat === null) { this.peer.send({ t: MSG.BYE, why: 'full' }); return; }
        this.takenSeats.add(seat);
        this.transport.claimedSeats.add(seat);
        /* The three numbers determinism needs, and nothing else. A guest that picked its own seed
         * would diverge on step one, so the host states all of it and the guest complies. */
        this.peer.send({
          t: MSG.WELCOME,
          seat,
          seed: this.game.seed,
          seedLabel: this.game.seedLabel,
          attempt: this.game.attempt,
          seats: this.seats,
          stepDelay: this.stepDelay,
          crewCount: this.crewCount,
        });
        this._set(NET.PLAYING);
        break;
      }
      case MSG.WELCOME: {
        if (this.isHost) return;
        this.mySeat = m.seat;
        this.seats = m.seats;
        this.stepDelay = m.stepDelay;
        this.crewCount = m.crewCount;

        // Rebuild the transport against the host's numbers, then rebuild the WORLD against its
        // seed and attempt. reroll:false is essential — reroll would advance the attempt counter
        // past the host's and lay out a different site.
        this.transport = new LockstepTransport(this.seats, this.stepDelay, (msg) => this.peer && this.peer.send(msg));
        this.transport.localSeats.add(m.seat);
        this.transport.claimedSeats.add(m.seat);
        this.transport.claimedSeats.add(0);          // the host is always seat 0 and always there
        this.game.crewCount = m.crewCount;
        this.game.startJob({ reroll: false, seed: m.seed, seedLabel: m.seedLabel, attempt: m.attempt });
        this._attachLink();
        this._set(NET.PLAYING);
        break;
      }
      case MSG.INPUT:
        this.transport._onMessage(m);
        break;
      case MSG.BYE:
        this.error = m.why || 'the other end left';
        this.close();
        break;
      default: break;
    }
  }

  _freeSeat() {
    for (let s = 0; s < this.seats; s++) if (!this.takenSeats.has(s)) return s;
    return null;
  }

  /** Point the game's CommandLink at this session's transport, keeping the local Input bound. */
  _attachLink() {
    const link = this.game.link;
    if (!link) return;
    link.seats = this.seats;
    link.transport = this.transport;
    // Exactly one local seat over a wire: the person at this keyboard. The others are elsewhere.
    link.localSeats = link.localSeats.slice(0, 1).map((b) => ({ seat: this.mySeat, input: b.input }));
    this.transport.localSeats.clear();
    this.transport.localSeats.add(this.mySeat);
    this.transport.claimedSeats.add(this.mySeat);
  }

  /** Host: called once the guest is in, to hand the link over. Safe to call repeatedly. */
  hostReady() {
    if (!this.isHost) return this;
    this._attachLink();
    return this;
  }

  /** True when the simulation may take another step. main.js gates game.frame on this. */
  canStep() {
    if (this.state !== NET.PLAYING) return this.state === NET.OFFLINE;
    const ok = this.transport.ready();
    if (!ok) this.transport.noteStall();
    return ok;
  }

  close() {
    if (this.peer) { try { this.peer.send({ t: MSG.BYE }); } catch { /* already gone */ } this.peer.close(); }
    this._set(NET.CLOSED);
  }

  describe() {
    return {
      state: this.state,
      host: this.isHost,
      seat: this.mySeat,
      seats: this.seats,
      claimed: [...this.transport.claimedSeats].sort(),
      stepDelay: this.stepDelay,
      step: this.transport.step,
      sent: this.transport.sent,
      received: this.transport.received,
      stalls: this.transport.stalls,
      pending: this.transport.pending,
      error: this.error,
    };
  }
}
