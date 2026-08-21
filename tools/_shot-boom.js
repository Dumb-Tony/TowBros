/* Pose the Milestone 8 load chart for a documentation screenshot.
 *
 * A van in the air on the rotator's boom, legs down, with the chart showing what it is holding
 * against what it can hold. The one frame that says what the clause is: the casualty is not being
 * dragged anywhere, it is off the ground.
 */
import { BANDS } from '../src/data/terrain.js';
import { findZone } from '../src/data/vehicles.js';
import { attachHook } from '../src/recovery/attach.js';
import { WINCH, cablePath, pathLength, drumsOf } from '../src/recovery/cable.js';
import { describeRig } from '../src/recovery/rig.js';

const TB = window.__TB;
const game = TB.game;

game.job = {
  siteId: 'bend', weatherId: 'dry', mods: {}, traffic: false,
  truckId: 'heavy', casualtyId: 'van', daylight: 0.85,
  loadout: null, effects: null,
};
game.startJob({ reroll: false, seed: 4242, seedLabel: 'shot8', attempt: 1 });

const st = game.state;
const truck = st.vehicles.truck;
const cas = st.vehicles.sedan;

truck.body.x = 62; truck.body.y = BANDS.roadN + 2.4; truck.body.angle = 0;
truck.body.vx = 0; truck.body.vy = 0; truck.body.omega = 0;
truck.parkBrake = true;
const gap = (truck.def.lengthM + cas.def.lengthM) / 2 + 1.4;
cas.body.x = truck.body.x - gap; cas.body.y = truck.body.y;
cas.body.angle = 0; cas.body.vx = 0; cas.body.vy = 0; cas.body.omega = 0;
cas.boggedN0 = 0; cas.boggedFactor = 0; cas.parkBrake = false;

truck.outriggers.down = true;
game.skipMs(3200);

const zone = findZone(cas.def, 'towHook') || findZone(cas.def, 'frameFront');
const w = drumsOf(st)[0];
const p = cas.body.toWorld(zone.local.x, zone.local.y);
w.hook.x = p.x; w.hook.y = p.y;
w.state = WINCH.ATTACHED; w.targetId = 'sedan'; w.zoneId = zone.id;
const len = pathLength(cablePath(w, truck, st.vehicles, st.blocksById));
w.state = WINCH.LOOSE;
attachHook(st, cas, zone, game.bus, st.simTimeMs, w);
w.lineM = len;

for (let t = 0; t < 40000 && !cas.suspended; t += 250) { w.motor = 1; game.skipMs(250); }
w.motor = 0;
// A moment of hanging, so the swing has settled and the pose is still.
game.skipMs(2500);

if (st.crew[0]) {
  st.crew[0].x = truck.body.x + 2.2; st.crew[0].y = truck.body.y + 2.4;
  st.crew[0].facing = Math.PI * 0.9;
}
if (st.crew[1]) {
  st.crew[1].x = cas.body.x - 1.0; st.crew[1].y = cas.body.y + 2.6;
  st.crew[1].facing = -Math.PI * 0.4;
}

TB.hud.el.title.classList.remove('on');
if (TB.garage) TB.garage.hide();

// Freeze, aim, draw once — see the note in _shot-m7.js for why rAF has to be stubbed.
window.requestAnimationFrame = () => 0;
TB.camera.setViewWidth(29);
TB.camera.follow((truck.body.x + cas.body.x) / 2, (truck.body.y + cas.body.y) / 2, 0);
TB.renderer.render(st, 0);
TB.hud.update();

window.__TB_POSED = { ...describeRig(truck, st), suspended: !!cas.suspended };
