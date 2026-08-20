/* Bootstrap — the only place mutable globals are allowed.
 *
 * Pattern from AirportBaggageCrew\src\main.js. The frame is deliberately dumb:
 *
 *   rAF -> game.frame(dt, input) -> clock.advance -> N x game.step
 *       -> camera.follow -> renderer.render(state) -> hud.update() -> audio.update()
 *
 * Simulation cannot advance anywhere else. That is the pause guarantee, and it is also why the
 * camera, the particles and the audio can all ease on REAL time without ever affecting a force.
 */

import { CONFIG } from './config.js';
import { Game, MODES } from './game.js';
import { Input } from './core/input.js';
import { Camera } from './render/camera.js';
import { Renderer } from './render/renderer.js';
import { Audio } from './render/audio.js';
import { Hud } from './ui/hud.js';
import { DebugOverlay } from './dev/debugOverlay.js';
import { WINCH } from './recovery/cable.js';

const canvas = document.getElementById('stage');
const uiRoot = document.getElementById('ui');

const game = new Game({ seed: CONFIG.sim.defaultSeed, seedLabel: CONFIG.sim.seedLabel });

const camera = new Camera({
  worldW: CONFIG.world.widthM,
  worldH: CONFIG.world.heightM,
  paddingM: CONFIG.render.fitPaddingM,
  maxPixelRatio: CONFIG.render.maxPixelRatio,
  viewWidthM: CONFIG.render.viewWidthM,
  followLerp: CONFIG.render.followLerp,
  minViewM: CONFIG.render.minViewM,
  maxViewM: CONFIG.render.maxViewM,
});

const renderer = new Renderer(canvas, camera).bind(game.bus, camera);
const input = new Input(window).attach();
const audio = new Audio().bind(game.bus);
const hud = new Hud(uiRoot, game, input);
const debug = new DebugOverlay(uiRoot, game, renderer);

/* Audio contexts may not start before a gesture, so the first key or click opens it. */
const wake = () => { audio.ensure(); };
window.addEventListener('keydown', wake, { once: true });
window.addEventListener('pointerdown', wake, { once: true });

/* Focus loss auto-pauses. Never auto-resumes. */
input.onBlur = () => game.pauseForBlur();
document.addEventListener('visibilitychange', () => { if (document.hidden) game.pauseForBlur(); });

function startJob() {
  game.startJob();
  const p = game.state.player;
  camera.follow(p.x, p.y, 0);
}
hud.onStart = startJob;
hud.onReset = startJob;

/* Screen-level keys go on the real keydown rather than through the per-step edge buffer:
 * pausing must work on the frame it is pressed, including while the simulation is stopped and
 * therefore consuming no steps. */
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') {
    e.preventDefault();
    if (game.state.mode === MODES.TITLE) startJob();
    else game.togglePause();
  }
  // Reset is always available (GDD §4) but takes two taps, because losing a rig you spent two
  // minutes building to a mistyped key would be its own kind of consequence.
  if (e.code === 'KeyR' && game.state.mode !== MODES.TITLE) {
    e.preventDefault();
    if (hud.armReset()) startJob();
  }
  if (e.code === 'Equal') { e.preventDefault(); camera.zoomBy(1 / 1.18); }
  if (e.code === 'Minus') { e.preventDefault(); camera.zoomBy(1.18); }
  if (e.code === 'KeyM') { audio.ensure(); audio.toggleMute(); }
});

let last = performance.now();

function frame(now) {
  const dtMs = now - last;
  last = now;
  const dtSec = Math.min(dtMs, 100) / 1000;

  camera.resize(canvas);
  if (input.pointer.seen) input.pointerWorld = camera.screenToWorld(input.pointer.x, input.pointer.y);

  game.frame(dtMs, input);

  const st = game.state;

  /* The camera follows whoever is acting, and leans toward the far end of the line when it is
   * loaded — because the interesting thing during a pull is usually happening at the other end
   * from the thing you are holding. Presentation only; it feeds nothing back. */
  const p = st.player;
  let cx = p.x, cy = p.y;
  if (p.inVehicleId) { const b = st.vehicles[p.inVehicleId].body; cx = b.x; cy = b.y; }
  if (st.winch.state === WINCH.ATTACHED && st.winch.tensionFrac > 0.04) {
    const s = st.vehicles.sedan.body;
    const k = Math.min(0.42, st.winch.tensionFrac * 0.9);
    cx += (s.x - cx) * k; cy += (s.y - cy) * k;
  }
  camera.follow(cx, cy, dtSec);

  // Showing where the attachment zones are only while the hook is in hand keeps the car clean
  // to look at the rest of the time.
  renderer.showZones = p.holdingHook || st.winch.state === WINCH.LOOSE;

  renderer.render(st, dtSec);
  hud.update();
  audio.update(st, dtSec);
  debug.update(dtMs);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener('mousemove', (e) => {
  input.pointer.x = e.clientX; input.pointer.y = e.clientY; input.pointer.seen = true;
});

/* Debug/test handle. Mirrors `__ABC` in Airport Baggage Crew and `__SD` in Something's
 * Different: the smoke-test harness drives the real objects through this rather than reaching
 * into module scope. */
window.__TB = { game, camera, renderer, hud, debug, input, audio, CONFIG, startJob };
