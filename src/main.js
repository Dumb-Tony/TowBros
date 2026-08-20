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
import { Input, CREW_BINDINGS } from './core/input.js';
import { Camera } from './render/camera.js';
import { Renderer } from './render/renderer.js';
import { Audio } from './render/audio.js';
import { Hud } from './ui/hud.js';
import { DebugOverlay } from './dev/debugOverlay.js';
import { WINCH } from './recovery/cable.js';
import { seatOf } from './player/player.js';
import { CommandLink, LoopbackTransport } from './net/commands.js';
import { NetSession, NET } from './net/session.js';
import {
  BroadcastChannelPeer, ManualWebRtcPeer, broadcastAvailable, webRtcAvailable,
} from './net/transports.js';

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

/* One Input per crew seat, all listening to the same keyboard through different binding maps.
 * Seat 0 is the local player and owns the WASD cluster; seat 1 is on the arrows. Seats past the
 * end of CREW_BINDINGS get no keyboard at all: those are the seats a network drives, and they are
 * fed through the command link below rather than from here. */
const inputs = CREW_BINDINGS.slice(0, CONFIG.crew.count)
  .map((bindings) => new Input(window, bindings).attach());
const input = inputs[0];        // the local player, for the HUD's on-screen winch buttons

/* Everything goes through the command seam, including the keyboards in front of you.
 *
 * GDD §6 wants multiplayer authority above "deterministic-ish simulation commands", and the way
 * to make sure that actually holds is to have no second path: the local seats are sampled into
 * command frames and delivered back through a loopback transport at zero delay, so a single-player
 * session exercises the same plumbing a networked one would. Swap LoopbackTransport for a real
 * one and nothing else here changes. See src/net/commands.js. */
const link = new CommandLink(CONFIG.crew.maxCount, new LoopbackTransport(CONFIG.crew.maxCount, 0));
inputs.forEach((inp, seat) => link.bindLocal(seat, inp));
game.link = link;
const audio = new Audio().bind(game.bus);
const hud = new Hud(uiRoot, game, input);
const debug = new DebugOverlay(uiRoot, game, renderer);

/* Audio contexts may not start before a gesture, so the first key or click opens it. */
const wake = () => { audio.ensure(); };
window.addEventListener('keydown', wake, { once: true });
window.addEventListener('pointerdown', wake, { once: true });

/* Focus loss auto-pauses. Never auto-resumes. */
for (const i of inputs) i.onBlur = () => game.pauseForBlur();
document.addEventListener('visibilitychange', () => { if (document.hidden) game.pauseForBlur(); });

function startJob() {
  game.startJob();
  const p = game.state.player;
  camera.follow(p.x, p.y, 0);
}
hud.onStart = startJob;
hud.onReset = startJob;

/* Co-op. main.js owns the transports because it is the only place mutable globals are allowed;
 * the HUD collects the intent and a blob of text and knows nothing else about it.
 *
 * Returns the text to hand to the other player, '' when there is nothing left to exchange, or
 * null when this browser cannot do it at all. */
let peer = null;
hud.onCoop = async (kind, blob) => {
  try {
    if (kind === 'tab') {
      if (!broadcastAvailable()) return null;
      peer = new BroadcastChannelPeer('lobby');
      // Whoever opens the tab FIRST is the host, and both tabs press the same button — so the
      // rule has to be decidable without asking. First one to speak into an empty room hosts:
      // a guest announces itself and, if nothing answers within a beat, promotes itself.
      startSession(peer, { host: false });
      setTimeout(() => {
        if (session && session.state === NET.JOINING) {
          session.close();
          startSession(new BroadcastChannelPeer('lobby'), { host: true });
          hud._coopSay('Hosting. Open the page again in another tab and press the same button.');
        }
      }, 600);
      return '';
    }
    if (kind === 'host') {
      if (!webRtcAvailable()) return null;
      peer = new ManualWebRtcPeer({ host: true });
      const offer = await peer.createOffer();
      peer.onOpen = () => startSession(peer, { host: true });
      return offer;
    }
    if (kind === 'host-answer') {
      await peer.acceptRemote(blob);
      return '';
    }
    if (kind === 'join') {
      if (!webRtcAvailable()) return null;
      peer = new ManualWebRtcPeer({ host: false });
      const answer = await peer.acceptOffer(blob);
      peer.onOpen = () => startSession(peer, { host: false });
      return answer;
    }
  } catch (e) {
    return null;      // a mistyped blob is a normal thing to do, not an exception to throw
  }
  return null;
};

let session = null;
function startSession(p, { host }) {
  session = new NetSession(game, p, {
    host,
    seats: CONFIG.crew.maxCount,
    stepDelay: CONFIG.net.stepDelay,
    crewCount: CONFIG.crew.count,
  });
  game.net = session;
  session.onChange = (s) => {
    if (s.state !== NET.PLAYING) return;
    // The HOST rebuilds the world on connect so both ends start from the same step 0. The guest
    // already did it inside the welcome handler, from the host's own seed and attempt.
    if (host) game.startJob({ reroll: false });
    session.hostReady();
    hud.el.title.classList.remove('on');
    hud.el.coopPanel.classList.remove('on');
  };
  session.start();
}

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

  // No inputs argument: game.link supplies one per seat, pumped inside each fixed step.
  game.frame(dtMs);

  const st = game.state;

  /* The camera follows whoever is acting, and leans toward the far end of the line when it is
   * loaded — because the interesting thing during a pull is usually happening at the other end
   * from the thing you are holding. Presentation only; it feeds nothing back. */
  const p = st.player;
  const seated = seatOf(st, p);
  let cx = p.x, cy = p.y;
  if (seated) { cx = seated.body.x; cy = seated.body.y; }
  // With a crew, the camera also has to keep the others in frame — otherwise seat 1 walks off the
  // edge of the world. Pull toward the crew's midpoint, weighted so the local player still leads.
  if (st.crew.length > 1) {
    let mx = 0, my = 0;
    for (const q of st.crew) { mx += q.x; my += q.y; }
    mx /= st.crew.length; my /= st.crew.length;
    cx += (mx - cx) * 0.35; cy += (my - cy) * 0.35;
  }
  if (st.winch.state === WINCH.ATTACHED && st.winch.tensionFrac > 0.04) {
    const s = st.vehicles.sedan.body;
    const k = Math.min(0.42, st.winch.tensionFrac * 0.9);
    cx += (s.x - cx) * k; cy += (s.y - cy) * k;
  }
  camera.follow(cx, cy, dtSec);

  // Showing where the attachment zones are only while the hook is in hand keeps the car clean
  // to look at the rest of the time. Anybody's hand, not just the local player's.
  renderer.showZones = st.winch.heldBy !== null || st.winch.state === WINCH.LOOSE;

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
window.__TB = {
  game, camera, renderer, hud, debug, input, inputs, link, audio, CONFIG, startJob,
  get session() { return session; },
};
