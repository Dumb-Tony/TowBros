/* Pose the Milestone 9 shunt for a documentation screenshot.
 *
 * Two cars on the bank, one behind the other, and the line on the DEEP one — the wrong order,
 * caught at the moment the gauge says so. The whole clause in one frame: nothing is refused, and
 * it costs twice the line.
 */
import { BANDS } from '../src/data/terrain.js';
import { findZone } from '../src/data/vehicles.js';
import { attachHook } from '../src/recovery/attach.js';
import { WINCH, cablePath, pathLength, drumsOf } from '../src/recovery/cable.js';
import { cornersOnRoad } from '../src/sim/vehicle.js';

const TB = window.__TB;
const game = TB.game;

game.job = {
  siteId: 'bend', weatherId: 'damp', mods: { seizedChance: 0 }, traffic: false,
  truckId: 'truck', casualtyId: 'sedan', secondCasualtyId: 'sedan',
  daylight: 0.88,
  loadout: null, effects: null,
};
game.startJob({ reroll: false, seed: 4242, seedLabel: 'shot9', attempt: 1 });

const st = game.state;
const deep = st.vehicles.sedan;
const near = st.vehicles.second;
const truck = st.vehicles.truck;

truck.body.x = deep.body.x + 2.4;
truck.body.y = BANDS.roadN + 1.5;
truck.body.angle = 0;
truck.body.vx = 0; truck.body.vy = 0; truck.body.omega = 0;
truck.parkBrake = true;

// The line on the deep one, past the car in front of it.
const zone = findZone(deep.def, 'towHook');
const p = deep.body.toWorld(zone.local.x, zone.local.y);
const w = drumsOf(st)[0];
w.hook.x = p.x; w.hook.y = p.y;
w.state = WINCH.ATTACHED; w.targetId = 'sedan'; w.zoneId = zone.id;
const len = pathLength(cablePath(w, truck, st.vehicles, st.blocksById));
w.state = WINCH.LOOSE;
attachHook(st, deep, zone, game.bus, st.simTimeMs, w);
w.lineM = len;

// Pull until the deep one is hard up against the one in front and the gauge says what that costs.
// The motor stays ON at the freeze: a tension gauge photographed after the drum stopped is a
// picture of the wrong number.
for (let t = 0; t < 24000; t += 250) {
  w.motor = 1;
  game.skipMs(250);
  if (w.tensionN > 18000) break;
  if (cornersOnRoad(deep, st.terrain).all) break;
}

if (st.crew[0]) {
  st.crew[0].x = truck.body.x - 3.2; st.crew[0].y = truck.body.y + 1.9;
  st.crew[0].facing = Math.PI * 0.72;
}
if (st.crew[1]) {
  st.crew[1].x = near.body.x + 3.0; st.crew[1].y = near.body.y - 1.4;
  st.crew[1].facing = Math.PI * 1.15;
}

TB.hud.el.title.classList.remove('on');
if (TB.garage) TB.garage.hide();

// Freeze, aim, draw once — see the note in _shot-m7.js for why rAF has to be stubbed.
window.requestAnimationFrame = () => 0;
TB.camera.setViewWidth(46);
TB.camera.follow((truck.body.x + deep.body.x) / 2 - 1,
                 (truck.body.y + deep.body.y) / 2 + 0.5, 0);
TB.renderer.render(st, 0);
TB.hud.update();

window.__TB_POSED = {
  tensionN: Math.round(w.tensionN),
  deepOn: cornersOnRoad(deep, st.terrain).on,
  nearOn: cornersOnRoad(near, st.terrain).on,
  simTimeMs: Math.round(st.simTimeMs),
};
