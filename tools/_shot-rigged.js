/* Pose the scene for a documentation screenshot, then let the frame draw.
 *
 * Injected by tools\shot.ps1 AFTER main.js, so window.__TB exists. Everything here goes
 * through the real objects — this is the game mid-recovery, not a mock-up.
 *
 * MEASURED (Dev\INDEX.md): headless Chrome hands out 1-3 rAF callbacks in total, so the pose
 * has to be complete before the first one and the simulation has to be advanced by
 * game.skipMs() rather than by waiting for frames.
 */
import { WINCH, cablePath, pathLength } from '../src/recovery/cable.js';
import { attachHook } from '../src/recovery/attach.js';
import { findZone } from '../src/data/vehicles.js';
import { placeGear, mountBlock, routeThroughBlock, pumpJack } from '../src/recovery/gear.js';
import { CONFIG } from '../src/config.js';

const TB = window.__TB;
const g = TB.game;
g.attempt = 0;
g.startJob();

const st = g.state;
const sedan = st.vehicles.sedan, truck = st.vehicles.truck;
const s = sedan.body, t = truck.body;

// The operator park from tools\m1-tests.js: on the pavement, tail to the job, 11 m along.
t.x = s.x + 11; t.y = 6.6; t.angle = 0; t.vx = 0; t.vy = 0; t.omega = 0;
truck.parkBrake = true;

// Gear actually in use, so the shot shows the equipment doing its job rather than in a pile:
// cribbing under the sedan, the jack wound out, chocks behind the truck's rear wheels.
const take = (kind) => st.gear.find((q) => q.kind === kind && !q.placed);
placeGear(st, take('cribbing'), s.x + 0.7, s.y + 0.8, 0.4, g.bus, 0);
placeGear(st, take('cribbing'), s.x - 0.8, s.y + 0.9, 1.1, g.bus, 0);
const jack = take('jack');
placeGear(st, jack, s.x + 1.5, s.y + 0.6, 0, g.bus, 0);
for (let i = 0; i < CONFIG.gear.jack.liftSteps; i++) {
  jack.pumpMs = CONFIG.gear.jack.pumpMs;
  pumpJack(st, jack, 0.001, g.bus, 0);
}
const back = t.dirToWorld(-1, 0);
for (const wi of [2, 3]) {
  const w = t.toWorld(truck.def.wheels[wi].local.x, truck.def.wheels[wi].local.y);
  placeGear(st, take('chock'), w.x + back.x * 0.62, w.y + back.y * 0.62, t.angle, g.bus, 0);
}
// The strap is wrapped, so the rigging is visible at the attachment.
const strap = take('strap');
if (strap) { strap.usedAsRig = true; strap.placed = true; }
sedan.rigging.towHook = 'strap';

// Rig the line and take up the slack, the way walking the hook out then reeling does.
const zone = findZone(sedan.def, 'towHook');
const p = s.toWorld(zone.local.x, zone.local.y);
st.winch.hook.x = p.x; st.winch.hook.y = p.y;
st.winch.state = WINCH.ATTACHED; st.winch.targetId = 'sedan'; st.winch.zoneId = 'towHook';
const len = pathLength(cablePath(st.winch, truck, st.vehicles, st.blocksById));
st.winch.state = WINCH.LOOSE;
attachHook(st, sedan, zone, g.bus, 0);
st.winch.lineM = len;
/* Pull for a while, so the line is loaded, the tires have laid tracks, and the car is on its way
 * up the bank. This is the frame worth showing.
 *
 * Held through the LOCAL INPUT, not by setting winch.motor and not by pushing frames at the
 * transport by hand. Two reasons, both learned the hard way:
 *
 *   winch.motor  the live page drives every seat through the command link, so stepCrew resolves
 *                the drum from the crew's hands every step and overwrites anything set directly.
 *   raw frames   link.pump() already sends one frame per seat per step, and the transport
 *                delivers at most one per step. A second hand-rolled send per step therefore
 *                interleaves with the keyboard's, halving the duty cycle (measured: the drum ran
 *                on 330 of 660 steps) and backing up 660 frames that never arrive.
 *
 * A virtual button is exactly what the HUD's on-screen winch control does, so this is the real
 * path with no extra machinery.
 */
TB.inputs[0].virtualDown('winchIn');
for (let i = 0; i < Math.round(11000 / CONFIG.sim.stepMs); i++) {
  g.step(CONFIG.sim.stepMs, st.simTimeMs + CONFIG.sim.stepMs, null);
}
TB.inputs[0].virtualUp('winchIn');

/* The crew stand beside the rig, watching, which is where they would be: one at the winch end and
 * one down by the car, because that is how two people actually cover a recovery. */
const poses = [
  { x: s.x + 4.6, y: s.y - 6.4 },
  { x: s.x - 2.2, y: s.y - 3.1 },
];
st.crew.forEach((c, i) => {
  const q = poses[i % poses.length];
  c.x = q.x; c.y = q.y; c.vx = 0; c.vy = 0;
  c.facing = Math.atan2(s.y - c.y, s.x - c.x);
});

TB.camera.setViewWidth(58);
TB.camera.follow((s.x + t.x) / 2, (s.y + t.y) / 2 + 2.5, 0);
window.__TB_POSED = {
  tensionN: Math.round(st.winch.tensionN),
  cornersOnRoad: st.goal.cornersOnRoad,
  simTimeMs: Math.round(st.simTimeMs),
};
