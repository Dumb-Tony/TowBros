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
import { WINCH, drumsOf } from './recovery/cable.js';
import { seatOf } from './player/player.js';
import { CommandLink, LoopbackTransport } from './net/commands.js';
import { NetSession, NET } from './net/session.js';
import { EVENTS } from './core/eventBus.js';
import { Garage } from './ui/garage.js';
import { LOAD } from './meta/save.js';
import {
  loadCompany, saveCompany, settleJob, conditionEffects, activeTruck, loadOutFor,
} from './meta/company.js';
import { acceptOffer, useSlot } from './meta/dispatch.js';
import { daylightAt, describeClock } from './meta/clock.js';
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

/* ── the company (Milestone 4) ───────────────────────────────────────────────
 *
 * The garage is the shell now: the title card leads to the yard, the yard hands out a job, the job
 * settles back into the company, and the money it paid is in the bank before the results card is
 * dismissed. Nothing about the simulation knows any of this exists — the company picks a seed and a
 * loadout and hands them over, and from that point the fixed step is on its own.
 */
const loaded = loadCompany();
let company = loaded.company;
let currentOffer = null;
let settled = false;

const garage = new Garage(uiRoot, company, takeJob);
garage.onChange = (c) => saveCompany(c);
if (loaded.status !== LOAD.LOADED && loaded.status !== LOAD.FRESH) {
  garage.note = `Save: ${loaded.note}.`;
}

/** Build the job packet the scene reads: the offer's modifiers plus what this outfit turned up in. */
function jobPacketFor(offer) {
  return {
    ...offer,
    loadout: loadOutFor(company),
    effects: conditionEffects(activeTruck(company)),
    /* WHICH MACHINE turned out (Milestone 6). The offer says what is off the road; the company
     * says what is going to it. Taking the little truck to a seven-tonner is a decision the player
     * is allowed to make, and the bank will explain it to them. */
    truckId: activeTruck(company).defId,
    /* And WHAT TIME IT IS (Milestone 7). A job taken at four in the afternoon is a job that gets
     * dark while you are still rigging — the light level is already wired to the traffic's sight
     * distance and to the renderer, so this is the whole of it. */
    daylight: daylightAt(company),
  };
}

function takeJob(offer) {
  currentOffer = offer;
  settled = false;
  acceptOffer(company, offer);
  // A slot, and the day turns when the last one goes — whatever is still on the board goes to an
  // outfit down the road. See meta/dispatch.js: the only thing that makes choosing between three
  // jobs a choice is that the other two go away.
  useSlot(company, offer);
  saveCompany(company);
  garage.hide();
  hud.el.title.classList.remove('on');
  game.job = jobPacketFor(offer);
  // reroll:false with an explicit seed: the offer's seed IS the job, and taking the same offer
  // twice would be the same site — which is why the board moves on when you accept one.
  game.startJob({ reroll: false, seed: offer.seed, seedLabel: offer.type, attempt: 1 });
  const p = game.state.player;
  camera.follow(p.x, p.y, 0);
}

/** Replay the job you are on. Costs nothing and settles nothing — GDD §4: reset is always there. */
function restartJob() {
  settled = false;
  game.job = currentOffer ? jobPacketFor(currentOffer) : null;
  game.startJob(currentOffer
    ? { reroll: false, seed: currentOffer.seed, seedLabel: currentOffer.type, attempt: 1 }
    : {});
  const p = game.state.player;
  camera.follow(p.x, p.y, 0);
}

/* Settling up. Fires once, when the job reaches DELIVERED — and once only, which is what `settled`
 * is for: the phase stays DELIVERED afterwards, so a check on the phase alone would bank the fee
 * every frame for the rest of the session. */
game.bus.on(EVENTS.JOB_DELIVERED, () => {
  if (settled) return;
  settled = true;
  const recap = game.recap();
  const st = game.state;
  const result = settleJob(company, recap, {
    impactsNs: st.fx.peakImpulse || 0,
    // The hardest-worked drum decides the service interval — Milestone 6 put two on the heavy.
    peakTensionN: Math.max(...drumsOf(st).map((w) => w.peakTensionN || 0), 0),
    cableSnaps: game.bus.count(EVENTS.CABLE_SNAPPED),
    /* How long the job took, so the day can be spent on it (Milestone 7, meta/clock.js). */
    simTimeMs: st.simTimeMs,
    // Gear destroyed rather than merely left lying about: what was strapped to a load that came off.
    gearLost: [],
  });
  saveCompany(company);
  hud.settlement = result;
  garage.refresh();
});

function toYard() {
  hud.el.title.classList.remove('on');
  hud.el.done.classList.remove('on');
  garage.show();
}

hud.onStart = toYard;
hud.onReset = restartJob;
hud.onYard = toYard;

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
    if (garage.visible) { garage.hide(); hud.el.title.classList.add('on'); }
    else if (game.state.mode === MODES.TITLE) toYard();
    else game.togglePause();
  }
  // Reset is always available (GDD §4) but takes two taps, because losing a rig you spent two
  // minutes building to a mistyped key would be its own kind of consequence.
  if (e.code === 'KeyR' && game.state.mode !== MODES.TITLE && !garage.visible) {
    e.preventDefault();
    if (hud.armReset()) restartJob();
  }
  // G is the yard. Available whenever a job is not the thing you are looking at.
  if (e.code === 'KeyG' && !garage.visible && game.state.mode !== MODES.TITLE) {
    e.preventDefault();
    toYard();
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
  // The busiest line pulls the camera toward the casualty. Any drum, whichever is loaded hardest.
  const busiest = drumsOf(st).reduce((a, b) => (b.tensionFrac > a.tensionFrac ? b : a), st.winch);
  if (busiest.state === WINCH.ATTACHED && busiest.tensionFrac > 0.04) {
    const s = st.vehicles.sedan.body;
    const k = Math.min(0.42, busiest.tensionFrac * 0.9);
    cx += (s.x - cx) * k; cy += (s.y - cy) * k;
  }
  camera.follow(cx, cy, dtSec);

  // Showing where the attachment zones are only while the hook is in hand keeps the car clean
  // to look at the rest of the time. Anybody's hand, not just the local player's.
  renderer.showZones = drumsOf(st).some((w) => w.heldBy !== null || w.state === WINCH.LOOSE);

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
  game, camera, renderer, hud, debug, input, inputs, link, audio, CONFIG,
  garage, toYard, restartJob, takeJob,
  get company() { return company; },
  get session() { return session; },
};
