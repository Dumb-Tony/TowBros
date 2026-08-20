/* Input abstraction.
 *
 * COPIED from AirportBaggageCrew\src\core\input.js (Dev\INDEX.md "Simulation loop, time
 * & state"). Systems ask for ACTIONS, never for KeyW; the binding table is data.
 *
 * GDD §5: "Walking and driving share directional input." That is why there is no
 * separate throttle/steer action — moveUp/moveDown/moveLeft/moveRight mean walk when you
 * are on foot and mean throttle/brake/steer when you are in the seat. One set of keys,
 * two readings, decided by src/player/player.js and nothing else.
 *
 * GDD §5 also requires the winch to be reachable at all times, so winchIn/winchOut are
 * their own actions rather than a mode: you can reel while walking, while driving, and
 * while watching the truck slide toward the ditch.
 *
 * Two query shapes:
 *   isDown(action)     held this frame  — walking, throttle, reeling
 *   wasPressed(action) edge this step   — attach, pick up, enter, pause
 * wasPressed is cleared by endStep(), which the fixed-step loop calls, so input edges
 * align to simulation steps rather than to render frames.
 */

export const DEFAULT_BINDINGS = Object.freeze({
  moveUp:    ['KeyW', 'ArrowUp'],
  moveDown:  ['KeyS', 'ArrowDown'],
  moveLeft:  ['KeyA', 'ArrowLeft'],
  moveRight: ['KeyD', 'ArrowRight'],

  // one contextual action, because GDD §5 wants controls "small enough to remember
  // after one glance": pick up gear / place gear / take the hook / attach it / mount the
  // snatch block / pump the jack are all this key, chosen by what you are standing next to.
  context:   ['KeyE'],
  inspect:   ['KeyQ'],
  detach:    ['KeyF'],       // unhook the line, or drop what you are carrying
  enterExit: ['Enter', 'KeyV'],
  brake:     ['Space'],      // in the seat: parking brake. on foot: nothing.

  winchIn:   ['KeyI', 'BracketRight'],
  winchOut:  ['KeyO', 'BracketLeft'],

  restart:   ['KeyR'],
  pause:     ['Escape'],
  debug:     ['F3'],
  zoomIn:    ['Equal'],
  zoomOut:   ['Minus'],
});

/**
 * One binding map per crew seat, for people sharing a keyboard.
 *
 * GDD §7 Milestone 2 wants 2-4 players. The network transport is not the interesting part of that
 * and it is the part that cannot be playtested alone, so local co-op comes first: seat 0 lives on
 * the WASD cluster, seat 1 on the arrows and the punctuation keys to their left. Two hand
 * positions, mirrored, which is how couch co-op has always worked.
 *
 * Seat 0 loses the arrow keys and the bracket keys it used to share — one seat cannot own both
 * halves of the keyboard, and seat 1 needs somewhere to live. Seats 2 and 3 have no keyboard map
 * at all: they exist for the network layer to drive, and a member with no input source simply
 * takes no action, which is exactly what a client looks like between packets.
 */
export const CREW_BINDINGS = Object.freeze([
  Object.freeze({
    moveUp: ['KeyW'], moveDown: ['KeyS'], moveLeft: ['KeyA'], moveRight: ['KeyD'],
    context: ['KeyE'], inspect: ['KeyQ'], detach: ['KeyF'],
    enterExit: ['KeyV', 'Enter'], brake: ['Space'],
    winchIn: ['KeyI'], winchOut: ['KeyO'],
  }),
  Object.freeze({
    moveUp: ['ArrowUp'], moveDown: ['ArrowDown'], moveLeft: ['ArrowLeft'], moveRight: ['ArrowRight'],
    context: ['Slash'], inspect: ['Period'], detach: ['Comma'],
    enterExit: ['ShiftRight'], brake: ['Backslash'],
    winchIn: ['BracketRight'], winchOut: ['BracketLeft'],
  }),
]);

export class Input {
  constructor(target = window, bindings = DEFAULT_BINDINGS) {
    this.target = target;
    this.setBindings(bindings);

    this._down = new Set();      // codes physically held
    this._pressed = new Set();   // codes that went down since the last endStep()
    this._released = new Set();
    this.pointer = { x: 0, y: 0, down: false, seen: false };
    this.pointerWorld = null;      // world-space aim, recomputed each frame by main.js
    this._bound = [];
    /** Fired when the window loses focus. main.js pauses on it. */
    this.onBlur = null;
    /** Actions latched by on-screen buttons — GDD §5 requires "large on-screen
     *  controls" for the winch, and a touch button has to look exactly like a key to
     *  every system downstream or the two paths will drift. */
    this._virtual = new Set();
    this._virtualPressed = new Set();
  }

  setBindings(bindings) {
    this.bindings = bindings;
    this._codeToActions = new Map();
    for (const [action, codes] of Object.entries(bindings)) {
      for (const code of codes) {
        if (!this._codeToActions.has(code)) this._codeToActions.set(code, []);
        this._codeToActions.get(code).push(action);
      }
    }
  }

  attach() {
    const add = (t, type, fn) => { t.addEventListener(type, fn); this._bound.push([t, type, fn]); };
    add(this.target, 'keydown', (e) => {
      // Never swallow browser reload/devtools; do swallow the keys we bind, so Space
      // does not scroll the page and F3 does not open Find.
      if (this._codeToActions.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this._down.add(e.code);
      this._pressed.add(e.code);
    });
    add(this.target, 'keyup', (e) => {
      this._down.delete(e.code);
      this._released.add(e.code);
    });
    // A held key whose keyup lands outside the window would stick forever.
    add(this.target, 'blur', () => { this.clear(); if (this.onBlur) this.onBlur(); });
    return this;
  }

  detach() {
    for (const [t, type, fn] of this._bound) t.removeEventListener(type, fn);
    this._bound.length = 0;
  }

  isDown(action) {
    if (this._virtual.has(action)) return true;
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const c of codes) if (this._down.has(c)) return true;
    return false;
  }

  wasPressed(action) {
    if (this._virtualPressed.has(action)) return true;
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const c of codes) if (this._pressed.has(c)) return true;
    return false;
  }

  wasReleased(action) {
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const c of codes) if (this._released.has(c)) return true;
    return false;
  }

  /** -1..1 on each axis from the four movement actions. Diagonals normalised.
   *  Read as a walk vector on foot and as throttle/steer in the seat. */
  moveAxis() {
    let x = (this.isDown('moveRight') ? 1 : 0) - (this.isDown('moveLeft') ? 1 : 0);
    let y = (this.isDown('moveDown') ? 1 : 0) - (this.isDown('moveUp') ? 1 : 0);
    if (x && y) { const inv = Math.SQRT1_2; x *= inv; y *= inv; }
    return { x, y };
  }

  /** Raw, un-normalised axes. Driving must NOT normalise: holding W+D is full throttle
   *  and full lock, not 0.707 of each. */
  driveAxis() {
    return {
      steer:    (this.isDown('moveRight') ? 1 : 0) - (this.isDown('moveLeft') ? 1 : 0),
      throttle: (this.isDown('moveUp') ? 1 : 0) - (this.isDown('moveDown') ? 1 : 0),
    };
  }

  /* ── on-screen controls ───────────────────────────────────────────────── */
  /** Hold a virtual button down (pointerdown on an HUD control). */
  virtualDown(action) { this._virtual.add(action); this._virtualPressed.add(action); }
  virtualUp(action)   { this._virtual.delete(action); }
  /** A virtual tap: down and up inside one step, for edge-triggered actions. */
  virtualTap(action)  { this._virtualPressed.add(action); }

  /** Clear the per-step edge sets. Called once per fixed simulation step. */
  endStep() { this._pressed.clear(); this._released.clear(); this._virtualPressed.clear(); }

  /** Drop all held state (focus loss, restart). */
  clear() {
    this._down.clear(); this._pressed.clear(); this._released.clear();
    this._virtual.clear(); this._virtualPressed.clear();
  }

  /** Test hook: synthesise input without a real keyboard. */
  _debugPress(code)   { this._down.add(code); this._pressed.add(code); }
  _debugRelease(code) { this._down.delete(code); this._released.add(code); }
}
