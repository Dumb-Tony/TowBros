/* Pose the Milestone 3 scene for a documentation screenshot: a loaded wrecker in the yard.
 *
 * Injected by tools\shot.ps1 AFTER main.js, so window.__TB exists. Everything goes through the
 * real objects — the car is on the lift because the lift picked it up, not because it was drawn
 * there.
 *
 * MEASURED (Dev\INDEX.md): headless Chrome hands out 1-3 rAF callbacks in total, so the pose has
 * to be complete before the first one and the simulation advanced by stepping rather than waiting.
 */
import { CONFIG } from '../src/config.js';
import { YARD, BANDS } from '../src/data/terrain.js';
import { extendLift, engageLift, strapLoad, axleMid, yokePos } from '../src/recovery/lift.js';

const TB = window.__TB;
const g = TB.game;
g.attempt = 0;
g.startJob({ reroll: false });

const st = g.state;
const sedan = st.vehicles.sedan, truck = st.vehicles.truck;
const s = sedan.body, t = truck.body;

/* Reversing into the bay: the truck is out on the apron nose-north, the car hanging off its tail
 * and swung round behind it. This is the shape of the manoeuvre the whole milestone builds to. */
const bay = YARD.bay;
s.x = (bay.x0 + bay.x1) / 2 + 1.2;
s.y = bay.y0 - 3.4;
s.angle = -Math.PI / 2 + 0.28;
s.vx = 0; s.vy = 0; s.omega = 0;
sedan.parkBrake = false;
sedan.boggedN = 0; sedan.boggedFactor = 0;
sedan.damage.dents = 2;                        // it has had a day

// Put the yoke exactly on the sedan's front axle, with the truck lined up ahead of it.
t.angle = s.angle + 0.22;
const reach = truck.def.lengthM / 2 + CONFIG.lift.reachM + CONFIG.lift.yokeOffsetM;
const axle = axleMid(sedan, 'front');
t.x = axle.x + Math.cos(t.angle) * reach;
t.y = axle.y + Math.sin(t.angle) * reach;
t.vx = 0; t.vy = 0; t.omega = 0;
truck.parkBrake = true;

extendLift(st, g.bus, 0);
engageLift(st, g.bus, 0);

// Two straps across it — the difference between keeping the car and not, and the thing the
// picture should show.
for (const kind of ['strap', 'chain']) {
  const item = st.gear.find((q) => q.kind === kind && !q.attachedTo);
  if (item) strapLoad(st, item, g.bus, 0);
}

// Let it settle on the constraint so the geometry in the picture is the geometry the sim holds.
for (let i = 0; i < 60; i++) g.step(CONFIG.sim.stepMs, st.simTimeMs + CONFIG.sim.stepMs, null);

/* The crew: one walking the load in, one at the bay line where a spotter stands. */
const poses = [
  { x: t.x - 3.4, y: t.y + 2.6 },
  { x: (bay.x0 + bay.x1) / 2 - 2.0, y: bay.y1 - 1.2 },
];
st.crew.forEach((c, i) => {
  const q = poses[i % poses.length];
  c.x = q.x; c.y = q.y; c.vx = 0; c.vy = 0;
  c.facing = Math.atan2(s.y - c.y, s.x - c.x);
});

/* Point the camera at the yard, and PIN it there.
 *
 * main.js re-aims the camera at the crew every frame and eases toward it, and headless Chrome hands
 * out one to three frames in total — so a follow() call from a setup script gets lerped a few
 * percent of the way back toward wherever the camera already was, and the shot comes out looking at
 * the recovery site with a HUD describing the yard. Freezing follow() is the honest fix for a
 * screenshot harness: the pose is the point, and the camera is not part of what is being tested.
 *
 * resize() FIRST, and that is not optional. follow() clamps the centre to the visible rectangle,
 * and before the first resize the camera thinks its viewport is nothing — so the clamp decides the
 * whole world is on screen and pins the centre to the middle of it. The shot then comes out looking
 * at the recovery site with a HUD describing the yard, which is exactly what it did. */
TB.camera.resize(document.getElementById('stage'));
TB.camera.setViewWidth(46);
TB.camera.follow((s.x + t.x) / 2, (s.y + t.y) / 2 + 1.5, 0);
TB.camera.follow = () => {};
window.__TB_POSED = {
  liftForceN: Math.round(truck.lift.forceN),
  straps: truck.lift.straps.length,
  phase: st.job.phase,
  bayCorners: st.job.bayCorners,
};
