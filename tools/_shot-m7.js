/* Pose the Milestone 7 scene for a documentation screenshot.
 *
 * A car on its roof, late in the afternoon, with the owner standing on the verge watching. Three
 * of the milestone's four clauses in one frame â€” the wider library, the clock and its light, and
 * the person at the scene.
 */
import { CONFIG } from '../src/config.js';
import { BANDS } from '../src/data/terrain.js';
import { findZone } from '../src/data/vehicles.js';
import { attachHook } from '../src/recovery/attach.js';
import { WINCH, cablePath, pathLength, drumsOf } from '../src/recovery/cable.js';

const TB = window.__TB;
const game = TB.game;

game.job = {
  siteId: 'bend', weatherId: 'damp', mods: {}, traffic: false,
  truckId: 'truck', casualtyId: 'sedanRoof',
  // Late on: the light is most of the way gone, which is what a slow morning costs.
  daylight: 0.62,
  loadout: null, effects: null,
};
game.startJob({ reroll: false, seed: 4242, seedLabel: 'shot7', attempt: 1 });

const st = game.state;
const sedan = st.vehicles.sedan;
const truck = st.vehicles.truck;

truck.body.x = sedan.body.x + 10.5;
truck.body.y = BANDS.roadN + 1.5;
truck.body.angle = 0;
truck.body.vx = 0; truck.body.vy = 0; truck.body.omega = 0;
truck.parkBrake = true;

// Rig it to the exposed frame, which is the zone being on its roof actually hands you.
const zone = findZone(sedan.def, 'frameFront') || findZone(sedan.def, 'towHook');
const p = sedan.body.toWorld(zone.local.x, zone.local.y);
const w = drumsOf(st)[0];
w.hook.x = p.x; w.hook.y = p.y;
w.state = WINCH.ATTACHED; w.targetId = 'sedan'; w.zoneId = zone.id;
const len = pathLength(cablePath(w, truck, st.vehicles, st.blocksById));
w.state = WINCH.LOOSE;
attachHook(st, sedan, zone, game.bus, st.simTimeMs, w);
w.lineM = len;

/* Pull, so the line is loaded and the car is on the move.
 *
 * TRAFFIC IS OFF for this shot and that is what keeps the pose still: the harness lets the page run
 * for its virtual-time budget after this script, so anything that moves on its own keeps moving.
 * The first attempt had traffic on, ran to 1:32 of simulation, and a car had wedged itself into the
 * wrecker by the time the shutter fired. Pausing instead puts a pause panel over the picture. */
for (let t = 0; t < 11000; t += 250) {
  w.motor = 1;
  game.skipMs(250);
}
w.motor = 0;

// The crew, where they would be: one at the drum, one down at the casualty.
if (st.crew[0]) {
  st.crew[0].x = truck.body.x - 4.4;
  st.crew[0].y = truck.body.y + 1.8;
  st.crew[0].facing = Math.PI * 0.75;
}
if (st.crew[1]) {
  st.crew[1].x = sedan.body.x + 2.4;
  st.crew[1].y = sedan.body.y - 2.4;
  st.crew[1].facing = Math.PI * 0.55;
}

TB.hud.el.title.classList.remove('on');
if (TB.garage) TB.garage.hide();

/* FREEZE IT, and draw the frozen thing once.
 *
 * Dev\INDEX.md records this trap and it caught this shot twice: `frame()` re-schedules itself, so
 * the harness's virtual-time budget keeps the simulation running long after the pose script has
 * finished. The first attempt ran on to 1:32 and a traffic car had wedged itself into the wrecker;
 * the second ran to 2:24 and the casualty had been dragged off the bottom of the picture.
 *
 * Pausing through setMode puts a pause panel over the frame, so instead: stop the loop at the
 * source by stubbing rAF, aim the camera by hand, and render exactly one frame. */
window.requestAnimationFrame = () => 0;
// Weighted toward the casualty: the midpoint put it behind the bottom HUD strip.
const mid = {
  x: truck.body.x * 0.4 + sedan.body.x * 0.6,
  y: truck.body.y * 0.32 + sedan.body.y * 0.68,
};
TB.camera.follow(mid.x, mid.y, 0);
TB.renderer.render(st, 0);
TB.hud.update();


window.__TB_POSED = {
  casualty: sedan.def.id,
  rolled: sedan.rolled,
  light: st.terrain.light,
  customerMood: st.customer ? Math.round(st.customer.mood * 100) / 100 : null,
  tension: Math.round(w.tensionN),
};

