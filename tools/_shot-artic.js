/* Pose the Milestone 10 artic for a documentation screenshot.
 *
 * A tractor unit and its trailer down the bank, still coupled and folded round, with the line on
 * the tractor's tow eye and the drum stalled. The whole milestone in one frame: 6.7 t of hinged
 * vehicle that weighs less than a box truck and will not come up for one drum, and a crew member
 * standing at the pin, which is the answer.
 */
import { BANDS } from '../src/data/terrain.js';
import { findZone } from '../src/data/vehicles.js';
import { attachHook } from '../src/recovery/attach.js';
import { WINCH, cablePath, pathLength, drumsOf } from '../src/recovery/cable.js';
import { couplingOf, jackKnifeRad, pinPos } from '../src/recovery/coupling.js';

const TB = window.__TB;
const game = TB.game;

game.job = {
  siteId: 'bend', weatherId: 'damp', mods: { seizedChance: 0 }, traffic: false,
  truckId: 'truck', casualtyId: 'tractorUnit', secondCasualtyId: 'semitrailer',
  secondLie: { x: -5.2, y: 0, angle: 0.9, coupled: true, jackKnifeRad: 0.9 },
  daylight: 0.88,
  loadout: null, effects: null,
};
game.startJob({ reroll: false, seed: 4242, seedLabel: 'shot10', attempt: 1 });

const st = game.state;
const tractor = st.vehicles.sedan;
const trailer = st.vehicles.second;
const truck = st.vehicles.truck;

truck.body.x = tractor.body.x + 2.4;
truck.body.y = BANDS.roadN + 1.5;
truck.body.angle = 0;
truck.body.vx = 0; truck.body.vy = 0; truck.body.omega = 0;
truck.parkBrake = true;

// The line on the tractor's tow eye — the obvious rig, and the one the milestone is about.
const zone = findZone(tractor.def, 'towHook');
const p = tractor.body.toWorld(zone.local.x, zone.local.y);
const w = drumsOf(st)[0];
w.hook.x = p.x; w.hook.y = p.y;
w.state = WINCH.ATTACHED; w.targetId = tractor.id; w.zoneId = zone.id;
const len = pathLength(cablePath(w, truck, st.vehicles, st.blocksById));
w.state = WINCH.LOOSE;
attachHook(st, tractor, zone, game.bus, st.simTimeMs, w);
w.lineM = len;

/* Reel until the drum is against its stop. The motor stays ON at the freeze: a tension gauge
 * photographed after the drum stopped is a picture of the wrong number.
 *
 * AND THE COMMAND LINK COMES OFF WHILE WE DO IT. In the live game `_asInputs` hands every step a
 * command frame from the link whatever was passed in, and `stepCrew` writes `w.motor` from that
 * frame — so `w.motor = 1` between two steps is overwritten by "nobody is holding the reel key"
 * on the next one. Thirty seconds of that is a photograph of a slack line reading 0.0 kN, which
 * is what the first two attempts at this shot were. */
const link = game.link;
game.link = null;
for (let t = 0; t < 30000; t += 250) {
  w.motor = 1;
  game.skipMs(250);
  if (w.tensionN > 16000) break;
}
game.link = link;

// One of them at the wrecker, one of them at the pin.
if (st.crew[0]) {
  st.crew[0].x = truck.body.x - 3.2; st.crew[0].y = truck.body.y + 1.9;
  st.crew[0].facing = Math.PI * 0.72;
}
if (st.crew[1]) {
  const pin = pinPos(trailer);
  st.crew[1].x = pin.x + 1.4; st.crew[1].y = pin.y + 1.2;
  st.crew[1].facing = Math.PI * 1.2;
}

TB.hud.el.title.classList.remove('on');
if (TB.garage) TB.garage.hide();

// Freeze, aim, draw once — see the note in _shot-m7.js for why rAF has to be stubbed.
window.requestAnimationFrame = () => 0;
TB.camera.setViewWidth(56);
TB.camera.follow((truck.body.x + trailer.body.x) / 2 - 1,
                 (truck.body.y + trailer.body.y) / 2 - 1.6, 0);
TB.renderer.render(st, 0);
TB.hud.update();

window.__TB_POSED = {
  tensionN: Math.round(w.tensionN),
  pinN: Math.round(couplingOf(st).forceN),
  foldDeg: Math.round(jackKnifeRad(st) * 57.3),
  simTimeMs: Math.round(st.simTimeMs),
};
