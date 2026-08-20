/* Pose the Milestone 6 heavy wrecker for a documentation screenshot.
 *
 * A seven-tonner in the ditch, the big machine on its legs with the boom slewed and both lines
 * out. Same approach as the other _shot scripts: everything goes through the real game, so what
 * is in the picture is what the simulation is doing.
 */
import { CONFIG } from '../src/config.js';
import { BANDS } from '../src/data/terrain.js';
import { findZone } from '../src/data/vehicles.js';
import { attachHook } from '../src/recovery/attach.js';
import { WINCH, cablePath, pathLength, drumsOf } from '../src/recovery/cable.js';
import { toggleOutriggers } from '../src/recovery/rig.js';

const TB = window.__TB;
const game = TB.game;

game.job = {
  siteId: 'bend', weatherId: 'damp', mods: {}, traffic: false,
  truckId: 'heavy', casualtyId: 'boxTruck', loadout: null, effects: null,
};
game.startJob({ reroll: false, seed: 4242, seedLabel: 'shot', attempt: 1 });

const st = game.state;
const sedan = st.vehicles.sedan;      // the casualty slot; a box truck is standing in it
const truck = st.vehicles.truck;

// Park the machine along the road, tail toward the casualty.
truck.body.x = sedan.body.x + 11.5;
truck.body.y = BANDS.roadN + 1.6;
truck.body.angle = 0;
truck.body.vx = 0; truck.body.vy = 0; truck.body.omega = 0;
truck.parkBrake = true;

// Legs down, boom slewed off the centreline.
toggleOutriggers(truck, game.bus, st.simTimeMs);
game.skipMs(3000);
truck.boomRad = -0.42;

// Both lines rigged, to two strong points at the front of the box truck.
const zones = ['towHook', 'frameFront'];
drumsOf(st).forEach((w, i) => {
  const zone = findZone(sedan.def, zones[i % zones.length]);
  const p = sedan.body.toWorld(zone.local.x, zone.local.y);
  w.hook.x = p.x; w.hook.y = p.y;
  w.state = WINCH.ATTACHED; w.targetId = 'sedan'; w.zoneId = zone.id;
  const len = pathLength(cablePath(w, truck, st.vehicles, st.blocksById));
  w.state = WINCH.LOOSE;
  attachHook(st, sedan, zone, game.bus, st.simTimeMs, w);
  w.lineM = len;
});

// Pull, so the lines are loaded and the box truck is on the move rather than parked.
for (let t = 0; t < 17000; t += 250) {
  for (const w of drumsOf(st)) w.motor = 1;
  game.skipMs(250);
}

// The crew, out where they would be: one at the drums, one down at the casualty.
if (st.crew[0]) {
  st.crew[0].x = truck.body.x - 5.6;
  st.crew[0].y = truck.body.y + 2.0;
  st.crew[0].facing = Math.PI * 0.75;
}
if (st.crew[1]) {
  st.crew[1].x = sedan.body.x + 2.6;
  st.crew[1].y = sedan.body.y - 2.2;
  st.crew[1].facing = Math.PI * 0.5;
}

TB.hud.el.title.classList.remove('on');
if (TB.garage) TB.garage.hide();

window.__TB_POSED = {
  truck: truck.def.id,
  casualty: sedan.def.id,
  drums: drumsOf(st).length,
  tension: drumsOf(st).map((w) => Math.round(w.tensionN)),
  legs: truck.outriggers ? truck.outriggers.frac : 0,
  boomDeg: Math.round((truck.boomRad || 0) * 180 / Math.PI),
};
