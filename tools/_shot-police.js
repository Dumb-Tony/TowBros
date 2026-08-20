/* Pose the Milestone 7 road-safety clause for a documentation screenshot.
 *
 * A wrecker stopped across a live carriageway with nothing out to protect it, long enough that a
 * unit has turned out and parked on the shoulder behind it. The fourth clause of the milestone,
 * and the one that is hardest to describe in a sentence: the cones were always there, and until
 * now the only thing that cared about them was the traffic.
 */
import { BANDS } from '../src/data/terrain.js';
import { findZone } from '../src/data/vehicles.js';
import { attachHook } from '../src/recovery/attach.js';
import { WINCH, cablePath, pathLength, drumsOf } from '../src/recovery/cable.js';

const TB = window.__TB;
const game = TB.game;

game.job = {
  siteId: 'bend', weatherId: 'dry', mods: {}, traffic: false,
  truckId: 'truck', casualtyId: 'sedan',
  daylight: 0.78,
  loadout: null, effects: null,
};
game.startJob({ reroll: false, seed: 4242, seedLabel: 'shot7p', attempt: 1 });

const st = game.state;
const sedan = st.vehicles.sedan;
const truck = st.vehicles.truck;

/* Across the road rather than in a lane — the pose the whole rule exists for. A player who parks
 * like this has made a real choice: it is the shortest line to the casualty and it blocks both
 * directions, and that trade is the mechanic. */
truck.body.x = sedan.body.x + 8.5;
truck.body.y = (BANDS.roadN + BANDS.roadS) / 2;
truck.body.angle = Math.PI * 0.42;
truck.body.vx = 0; truck.body.vy = 0; truck.body.omega = 0;
truck.parkBrake = true;

const zone = findZone(sedan.def, 'towHook');
const p = sedan.body.toWorld(zone.local.x, zone.local.y);
const w = drumsOf(st)[0];
w.hook.x = p.x; w.hook.y = p.y;
w.state = WINCH.ATTACHED; w.targetId = 'sedan'; w.zoneId = zone.id;
const len = pathLength(cablePath(w, truck, st.vehicles, st.blocksById));
w.state = WINCH.LOOSE;
attachHook(st, sedan, zone, game.bus, st.simTimeMs, w);
w.lineM = len;

// Long enough for a unit to have been called AND arrived: dispatchSec plus the drive in.
for (let t = 0; t < 56000; t += 250) {
  w.motor = 1;
  game.skipMs(250);
}
w.motor = 0;

if (st.crew[0]) {
  st.crew[0].x = truck.body.x - 3.6;
  st.crew[0].y = truck.body.y + 2.2;
  st.crew[0].facing = Math.PI * 0.8;
}
if (st.crew[1]) {
  st.crew[1].x = sedan.body.x + 2.6;
  st.crew[1].y = sedan.body.y - 2.6;
  st.crew[1].facing = Math.PI * 0.55;
}

TB.hud.el.title.classList.remove('on');
if (TB.garage) TB.garage.hide();

// Freeze, aim, draw once — see the note in _shot-m7.js for why rAF has to be stubbed.
window.requestAnimationFrame = () => 0;
const mid = {
  x: truck.body.x * 0.5 + (st.police.x || truck.body.x) * 0.5,
  y: truck.body.y * 0.42 + sedan.body.y * 0.58,
};
TB.camera.setViewWidth(58);
TB.camera.follow(mid.x, mid.y, 0);
TB.renderer.render(st, 0);
TB.hud.update();

window.__TB_POSED = {
  police: st.police.state,
  citations: st.police.citations,
  policeX: Math.round(st.police.x * 10) / 10,
  policeY: Math.round(st.police.y * 10) / 10,
  simTimeMs: Math.round(st.simTimeMs),
};
