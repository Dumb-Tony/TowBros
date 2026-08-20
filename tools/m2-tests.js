/* TOW BROS — Milestone 2 suite: a crew, not a player.
 *
 * Run it the same way as the M1 suite (Dev\INDEX.md -> "Tooling & testing"):
 *
 *   .\tools\smoketest.ps1 -Tests tools\m2-tests.js
 *
 * M1 asked "does the physics tell a story". M2 asks a narrower and nastier question: when two to
 * four people are on one site and there is exactly ONE winch hook, one jack and one snatch block,
 * does the game ever end up believing two of them have the same object?
 *
 * That is what this suite is for. It is mostly not about forces. Sections K and L hammer the
 * claim/release pairs in src/crew/authority.js directly and then through the real input path,
 * because the failure mode is not a crash — it is the cable quietly drawing to whichever of two
 * "holders" the renderer asked second, and nobody noticing for an hour.
 *
 *   K  the authority layer, called directly
 *   L  two crew on one keyboard, through Input and the fixed step
 *   M  stumble as punctuation, and what a knocked-down person drops
 *   N  the occupiable casualty: steering and braking the thing being recovered
 *   P  hygiene — the M1 invariants that the refactor could have broken
 *
 * MEASURED (M1, still true): headless Chrome in --dump-dom mode delivers only 1-3 rAF callbacks
 * in total, so nothing here waits for frames. Everything drives game.step()/skipMs() directly.
 */

import { CONFIG } from '../src/config.js';
import { EVENTS } from '../src/core/eventBus.js';
import { Input, CREW_BINDINGS, DEFAULT_BINDINGS } from '../src/core/input.js';
import { Game } from '../src/game.js';
import { WINCH, fairleadPos, cablePath, pathLength } from '../src/recovery/cable.js';
import { BANDS } from '../src/data/terrain.js';
import { attachHook, rigZone } from '../src/recovery/attach.js';
import { findZone } from '../src/data/vehicles.js';
import { closestOnBox } from '../src/sim/collision.js';
import { cornersOnRoad } from '../src/sim/vehicle.js';
import { nearestGear } from '../src/recovery/gear.js';
import {
  holdsHook, seatOf, carriedItem, knockDown, createCrewMember,
} from '../src/player/player.js';
import {
  ACTIONS, sampleFrame, packFrame, unpackFrame, CommandInput, LoopbackTransport, CommandLink,
} from '../src/net/commands.js';
import {
  UNOWNED, hookFree, claimHook, releaseHook, gearFree, claimGear, releaseGear,
  seatFree, claimSeat, releaseSeat, releaseAll, ownedBy, validateAuthority,
} from '../src/crew/authority.js';

/* ── reporting (same shape as tools/m1-tests.js, deliberately) ───────────── */

const lines = [];
let passes = 0, fails = 0;

function ok(name, cond, detail = '') {
  if (cond) { passes++; lines.push(`PASS  ${name}`); }
  else { fails++; lines.push(`FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
}
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const gt = (n, a, b) => ok(n, a > b, `got ${a}, wanted > ${b}`);
const lt = (n, a, b) => ok(n, a < b, `got ${a}, wanted < ${b}`);
const near = (n, a, b, tol) => ok(n, Math.abs(a - b) <= tol, `got ${a}, want ${b} +/- ${tol}`);
const note = (s) => lines.push(`      ${s}`);

let _pre = null;
function emit(status) {
  if (!_pre) {
    _pre = document.createElement('pre');
    _pre.id = 'test-out';
    _pre.style.cssText = 'position:fixed;inset:0;z-index:99999;overflow:auto;background:#06080c;'
      + 'color:#cfe;font:11px ui-monospace,Consolas,monospace;padding:12px;white-space:pre';
    document.body.appendChild(_pre);
  }
  const tail = status || (fails === 0
    ? `ALL-PASS  ${passes} assertions`
    : `FAILURES  ${fails} of ${passes + fails}`);
  _pre.textContent = '==TBTEST-BEGIN==\n' + lines.join('\n') + '\n\n' + tail + '\n==TBTEST-END==';
}

const STEP = CONFIG.sim.stepMs;

/* ── helpers ─────────────────────────────────────────────────────────────── */

function newGame(seed = 4242, attempt = 1) {
  const g = new Game({ seed, seedLabel: 'test' });
  g.attempt = attempt - 1;
  g.startJob();
  return g;
}

/** Two real Input objects on the two real seat binding maps — the local co-op case. */
function twoSeats() {
  return CREW_BINDINGS.slice(0, 2).map((b) => new Input(window, b));
}

/** Step the world with a set of inputs, consuming their edges exactly as game.frame does. */
function stepWith(g, inputs, ms) {
  const n = Math.max(1, Math.round(ms / STEP));
  for (let i = 0; i < n; i++) {
    g.step(STEP, g.state.simTimeMs + STEP, inputs);
    for (const inp of inputs) if (inp) inp.endStep();
  }
}

/** Press a code for one step, on whichever Input owns it. */
function tap(g, inputs, seat, code) {
  inputs[seat]._debugPress(code);
  stepWith(g, inputs, STEP);
  inputs[seat]._debugRelease(code);
}

/** Hold a code down for `ms`, re-pressing each step the way a real keyboard does. */
function hold(g, inputs, seat, codes, ms) {
  const list = Array.isArray(codes) ? codes : [codes];
  const n = Math.max(1, Math.round(ms / STEP));
  for (let i = 0; i < n; i++) {
    for (const c of list) inputs[seat]._debugPress(c);
    g.step(STEP, g.state.simTimeMs + STEP, inputs);
    for (const inp of inputs) if (inp) inp.endStep();
  }
  for (const c of list) inputs[seat]._debugRelease(c);
}

/** Put a crew member exactly where we want them, stationary. Teleporting a person is fine as long
 *  as they are not holding the hook — see the note on carryHook in src/player/player.js. */
function place(p, x, y, facing = 0) {
  p.x = x; p.y = y; p.vx = 0; p.vy = 0; p.facing = facing;
}

/** Stand a member at the driver's door of a vehicle. */
function atDoor(veh, p) {
  const side = veh.body.toWorld(0, -(veh.def.widthM / 2 + 0.55));
  place(p, side.x, side.y);
}

/** Rig the line to a zone without walking it there, for tests that are about the crew and not
 *  about the walk. Mirrors m1-tests' rigTo. */
function rigTo(g, zoneId = 'towHook', rig = null) {
  const st = g.state;
  const sedan = st.vehicles.sedan;
  const zone = findZone(sedan.def, zoneId);
  if (rig) rigZone(sedan, zoneId, rig, g.bus, st.simTimeMs);
  const at = sedan.body.toWorld(zone.local.x, zone.local.y);
  st.winch.hook.x = at.x; st.winch.hook.y = at.y;
  st.winch.heldBy = UNOWNED;
  st.winch.state = WINCH.ATTACHED;
  st.winch.targetId = 'sedan';
  st.winch.zoneId = zoneId;
  const len = pathLength(cablePath(st.winch, st.vehicles.truck, st.vehicles, st.blocksById));
  st.winch.state = WINCH.LOOSE;       // let attachHook do the real transition and event
  attachHook(st, sedan, zone, g.bus, st.simTimeMs);
  st.winch.lineM = len;               // exactly taut: zero stretch, zero tension
  return st.winch;
}

/* ── K. the authority layer, called directly ─────────────────────────────── */

function sectionK() {
  lines.push('--- K. object authority: one object, one owner (GDD §7) ---');

  const g = newGame();
  const st = g.state;
  const [a, b] = st.crew;

  eq('K1 the scene puts a real crew on site', st.crew.length, CONFIG.crew.count);
  gt('K2 which is more than one person', st.crew.length, 1);
  eq('K3 st.player IS crew[0], by reference not by copy', st.player, st.crew[0]);
  ok('K4 every member has their own identity', new Set(st.crew.map((c) => c.id)).size === st.crew.length);
  ok('K5 and their own tint, so they are told apart on a dark hillside',
     new Set(st.crew.map((c) => c.tint)).size === st.crew.length);
  ok('K6 they do not all spawn on the same spot', Math.hypot(a.x - b.x, a.y - b.y) > 0.5);

  // The hook.
  eq('K7 nothing owns the hook at the start', st.winch.heldBy, UNOWNED);
  ok('K8 so anyone may take it', hookFree(st, a.id) && hookFree(st, b.id));
  ok('K9 the first claim succeeds', claimHook(st, a.id, g.bus, 0));
  eq('K10 and the OBJECT records who has it', st.winch.heldBy, a.id);
  ok('K11 the second person is refused', !claimHook(st, b.id, g.bus, 0));
  eq('K12 and the claim did not move', st.winch.heldBy, a.id);
  ok('K13 re-claiming your own hook is not an error', claimHook(st, a.id, g.bus, 0));
  ok('K14 somebody else cannot put it down for you', !releaseHook(st, b.id, g.bus, 0));
  eq('K15 so it is still held', st.winch.heldBy, a.id);
  ok('K16 the holder can', releaseHook(st, a.id, g.bus, 0));
  eq('K17 and now it is free again', st.winch.heldBy, UNOWNED);
  ok('K18 for the person who was refused a moment ago', claimHook(st, b.id, g.bus, 0));
  releaseHook(st, b.id, g.bus, 0);

  // Gear.
  const item = st.gear[0];
  ok('K19 gear starts unowned', gearFree(item, a.id) && !item.carriedBy);
  ok('K20 one person picks it up', claimGear(st, item, a.id, g.bus, 0));
  eq('K21 recorded on the ITEM', item.carriedBy, a.id);
  ok('K22 picking it up cancels it being placed', !item.placed && item.attachedTo === null);
  ok('K23 the other person cannot take it out of their hands', !claimGear(st, item, b.id, g.bus, 0));
  ok('K24 nor drop it for them', !releaseGear(item, b.id));
  ok('K25 the carrier can drop it', releaseGear(item, a.id));
  eq('K26 and then it is free', item.carriedBy, UNOWNED);

  // Seats.
  const truck = st.vehicles.truck, sedan = st.vehicles.sedan;
  ok('K27 both seats start empty', seatFree(truck, a.id) && seatFree(sedan, a.id));
  ok('K28 one person gets in the truck', claimSeat(st, truck, a.id, g.bus, 0));
  eq('K29 recorded on the VEHICLE', truck.occupiedBy, a.id);
  eq('K30 and the derived `occupied` flag agrees', truck.occupied, true);
  ok('K31 the second person is refused that seat', !claimSeat(st, truck, b.id, g.bus, 0));
  ok('K32 but the casualty has its own seat', claimSeat(st, sedan, b.id, g.bus, 0));
  eq('K33 so two people can be in two vehicles', sedan.occupiedBy, b.id);
  ok('K34 nobody can be turfed out by somebody else', !releaseSeat(st, truck, b.id, g.bus, 0));
  eq('K35 the authority graph is clean with both seats full', validateAuthority(st).length, 0);

  // ownedBy is derived, never stored.
  claimHook(st, a.id, g.bus, 0);          // deliberately illegal-looking: holding it from a cab
  const bad = validateAuthority(st);
  ok('K36 holding the hook from inside a cab is REPORTED, not silently allowed',
     bad.some((s) => /holds the hook from inside/.test(s)), bad.join('; '));
  releaseHook(st, a.id, g.bus, 0);
  releaseSeat(st, truck, a.id, g.bus, 0);
  releaseSeat(st, sedan, b.id, g.bus, 0);
  eq('K37 and clean again once they get out', validateAuthority(st).length, 0);

  claimGear(st, st.gear[1], a.id, g.bus, 0);
  claimSeat(st, truck, a.id, g.bus, 0);
  const owned = ownedBy(st, a.id);
  eq('K38 ownedBy reports the seat', owned.seat, 'truck');
  eq('K39 and the gear', owned.gear.length, 1);
  eq('K40 and correctly says no hook', owned.hook, false);

  // releaseAll: the disconnect case. Without it, a departed member's id owns things forever,
  // because every claim checks "is it free" and a dead owner's id is not free.
  claimHook(st, b.id, g.bus, 0);
  const freed = releaseAll(st, a.id, g.bus, 0);
  eq('K41 releaseAll frees everything one member owned', freed, 2);
  eq('K42 their seat is empty', truck.occupiedBy, UNOWNED);
  eq('K43 their gear is on the ground', st.gear[1].carriedBy, UNOWNED);
  ok('K44 and it is placed, not floating', st.gear[1].placed);
  eq('K45 it did NOT take somebody else\'s hook away', st.winch.heldBy, b.id);
  eq('K46 the graph is still clean', validateAuthority(st).length, 0);

  // Two objects on one person is a bug, and has to be reported as one.
  st.gear[2].carriedBy = b.id;
  st.gear[3].carriedBy = b.id;
  ok('K47 two items on one person is caught',
     validateAuthority(st).some((s) => /is carrying 2 objects/.test(s)));
  st.gear[2].carriedBy = null; st.gear[3].carriedBy = null;

  // An owner who does not exist. This is the disconnect bug the whole layer exists to prevent.
  st.winch.heldBy = 'ghost';
  ok('K48 an unknown owner is caught',
     validateAuthority(st).some((s) => /unknown crew ghost/.test(s)));
  st.winch.heldBy = UNOWNED;
  eq('K49 and a clean scene reports nothing at all', validateAuthority(st).length, 0);

  // The telemetry the debug overlay reads.
  const d = g.describe();
  eq('K50 describe() reports one entry per crew member', d.crew.length, st.crew.length);
  eq('K51 with the authority audit attached', d.authority.ok, true);
  eq('K52 and no side table of owners anywhere in it', d.player, undefined);
}

/* ── L. two crew on one keyboard, through the real input path ─────────────── */

function sectionL() {
  lines.push('--- L. two people, one keyboard, one winch (GDD §5, §7) ---');

  // Bindings first: one seat cannot own both halves of the keyboard.
  const s0 = CREW_BINDINGS[0], s1 = CREW_BINDINGS[1];
  gt('L1 there is a binding map for more than one seat', CREW_BINDINGS.length, 1);
  const codes0 = new Set(Object.values(s0).flat());
  const codes1 = new Set(Object.values(s1).flat());
  const shared = [...codes0].filter((c) => codes1.has(c));
  eq('L2 the two seats share no key at all', shared.length, 0, shared.join(','));
  ok('L3 seat 0 is the WASD cluster', s0.moveUp.includes('KeyW'));
  ok('L4 seat 1 is the arrows', s1.moveUp.includes('ArrowUp'));
  ok('L5 both can reach the winch, because GDD §5 says it is always reachable',
     s0.winchIn.length > 0 && s1.winchIn.length > 0);
  eq('L6 seats past the bindings have no keyboard at all — that is the network case',
     CREW_BINDINGS[CONFIG.crew.maxCount - 1], undefined);

  const g = newGame();
  const st = g.state;
  const inputs = twoSeats();
  const [a, b] = st.crew;

  // Both walk, independently, at the same time.
  const a0 = { x: a.x, y: a.y }, b0 = { x: b.x, y: b.y };
  inputs[1]._debugPress('ArrowLeft');
  hold(g, inputs, 0, 'KeyD', 700);
  inputs[1]._debugRelease('ArrowLeft');
  gt('L7 seat 0 walked east on its own keys', a.x - a0.x, 0.4);
  lt('L8 seat 1 walked west on its own keys, in the same steps', b.x - b0.x, -0.4);

  // One hook, two people reaching for it. This is the case the whole layer exists for.
  const fl = fairleadPos(st.vehicles.truck);
  place(a, fl.x - 0.9, fl.y + 0.35);
  place(b, fl.x - 0.9, fl.y - 0.35);
  stepWith(g, inputs, STEP * 2);
  ok('L9 both are standing at the drum', !!a.contextHint && !!b.contextHint);

  // Same step, both press their own context key.
  inputs[0]._debugPress('KeyE');
  inputs[1]._debugPress('Slash');
  stepWith(g, inputs, STEP);
  inputs[0]._debugRelease('KeyE');
  inputs[1]._debugRelease('Slash');
  eq('L10 the hook came off the drum', st.winch.state, WINCH.HELD);
  ok('L11 exactly ONE of them has it', holdsHook(st, a) !== holdsHook(st, b),
     `a=${holdsHook(st, a)} b=${holdsHook(st, b)}`);
  eq('L12 and the authority graph is clean', validateAuthority(st).length, 0);

  const holder = holdsHook(st, a) ? a : b;
  const other = holder === a ? b : a;
  const otherSeat = other.seat;
  note(`L  ${holder.name} won the hook; ${other.name} was refused`);

  // The one who missed out is TOLD, rather than silently doing nothing.
  stepWith(g, inputs, STEP * 2);
  ok('L13 the person who missed it is not offered it again',
     !other.contextHint || !/take the winch hook/.test(other.contextHint.label),
     other.contextHint && other.contextHint.label);

  // The refused person pressing their key must not steal it.
  tap(g, inputs, otherSeat, otherSeat === 0 ? 'KeyE' : 'Slash');
  eq('L14 pressing E again does not transfer the hook', st.winch.heldBy, holder.id);

  // Contested drum: one reels in, the other pays out, in the same step.
  rigTo(g, 'towHook');
  st.winch.motor = 0;
  inputs[0]._debugPress('KeyI');
  inputs[1]._debugPress('BracketLeft');
  stepWith(g, inputs, STEP * 4);
  eq('L15 two hands fighting over the drum stops it', st.winch.motor, 0);
  eq('L16 and the game says so out loud, rather than picking a winner', st.winch.contested, true);
  inputs[1]._debugRelease('BracketLeft');
  stepWith(g, inputs, STEP * 2);
  eq('L17 when one of them lets go the drum turns again', st.winch.motor, 1);
  eq('L18 and it is no longer contested', st.winch.contested, false);
  inputs[0]._debugRelease('KeyI');
  stepWith(g, inputs, STEP * 2);
  eq('L19 releasing both stops it', st.winch.motor, 0);

  // Either seat can work the winch. That is the GDD §5 promise, not a seat-0 privilege.
  const line0 = st.winch.lineM;
  hold(g, inputs, 1, 'BracketRight', 500);
  lt('L20 seat 1 can reel the winch in on its own keys', st.winch.lineM, line0);

  // One seat each. The truck's cab is taken; the casualty has its own seat.
  const truck = st.vehicles.truck, sedan = st.vehicles.sedan;
  atDoor(truck, a); atDoor(truck, b);
  stepWith(g, inputs, STEP * 2);
  inputs[0]._debugPress('KeyV');
  inputs[1]._debugPress('ShiftRight');
  stepWith(g, inputs, STEP);
  inputs[0]._debugRelease('KeyV');
  inputs[1]._debugRelease('ShiftRight');
  const inTruck = st.crew.filter((c) => seatOf(st, c) === truck);
  eq('L21 two people reaching for one cab put exactly one in it', inTruck.length, 1);
  eq('L22 with the graph still clean', validateAuthority(st).length, 0);
  const left = st.crew.find((c) => !seatOf(st, c));
  stepWith(g, inputs, STEP * 2);
  ok('L23 the one left outside is told who is in there',
     !!left.inspect && /already in the seat/.test(left.inspect.lines.join(' ')),
     left.inspect && left.inspect.lines.join(' '));

  // And the second person can go and sit in the casualty instead.
  atDoor(sedan, left);
  stepWith(g, inputs, STEP * 2);
  tap(g, inputs, left.seat, left.seat === 0 ? 'KeyV' : 'ShiftRight');
  eq('L24 so they take the casualty\'s seat instead', seatOf(st, left), sedan);
  eq('L25 one person in each vehicle, cleanly', validateAuthority(st).length, 0);
  eq('L26 and both vehicles read as occupied', truck.occupied && sedan.occupied, true);
}

/* ── M. stumble as punctuation ───────────────────────────────────────────── */

function sectionM() {
  lines.push('--- M. stumble: punctuation, and a claim that cannot strand (GDD §7) ---');

  const g = newGame();
  const st = g.state;
  const inputs = twoSeats();
  const [a] = st.crew;

  eq('M1 nobody starts on the ground', st.crew.filter((c) => c.stumbleMs > 0).length, 0);
  ok('M2 a knock-down at walking pace puts somebody down', knockDown(st, a, 3.0, g.bus, 0));
  gt('M3 for a legible length of time', a.stumbleMs, 400);
  lt('M4 but not forever', a.stumbleMs, CONFIG.crew.stumbleMaxMs + 1);
  ok('M5 and it is in the job log, because it is part of the story',
     g.bus.count(EVENTS.CREW_STUMBLED) > 0);
  ok('M6 you cannot be knocked down twice while already down', !knockDown(st, a, 3.0, g.bus, 0));

  // A harder hit puts you down for longer. It is punctuation, so it should scale with the insult.
  const b = st.crew[1];
  knockDown(st, b, 1.7, g.bus, 0);
  const light = b.stumbleMs;
  b.stumbleMs = 0;
  knockDown(st, b, 6.0, g.bus, 0);
  gt('M7 a harder hit keeps you down longer', b.stumbleMs, light);

  // Getting up takes real time and cannot be walked off.
  const before = a.stumbleMs;
  hold(g, inputs, 0, 'KeyD', 200);
  lt('M8 the clock runs down while you are getting up', a.stumbleMs, before);
  gt('M9 and walking does not skip it', a.stumbleMs, 0);
  const during = { x: a.x, y: a.y };
  hold(g, inputs, 0, 'KeyD', 150);
  lt('M10 a person on the ground barely moves', Math.hypot(a.x - during.x, a.y - during.y), 0.25);
  stepWith(g, inputs, a.stumbleMs + STEP * 2);
  eq('M11 and then they are back on their feet', a.stumbleMs, 0);
  const up = { x: a.x, y: a.y };
  hold(g, inputs, 0, 'KeyD', 400);
  gt('M12 walking normally again', Math.hypot(a.x - up.x, a.y - up.y), 0.4);

  // The mechanical part: a stumble must not strand a claim.
  const fl = fairleadPos(st.vehicles.truck);
  place(a, fl.x - 0.9, fl.y + 0.35);
  stepWith(g, inputs, STEP * 2);
  tap(g, inputs, 0, 'KeyE');
  eq('M13 they pick the hook up', holdsHook(st, a), true);
  knockDown(st, a, 4.0, g.bus, st.simTimeMs);
  stepWith(g, inputs, STEP * 2);
  eq('M14 being flattened drops the hook', holdsHook(st, a), false);
  eq('M15 which is free for anybody, not stranded on a person who is down', st.winch.heldBy, UNOWNED);
  eq('M16 and the line is loose on the ground, not stowed', st.winch.state, WINCH.LOOSE);
  eq('M17 the graph is clean', validateAuthority(st).length, 0);
  stepWith(g, inputs, a.stumbleMs + STEP * 2);

  // Same for gear.
  const item = nearestGear(st, st.gear[0].x + 0.5, st.gear[0].y).item;
  place(a, item.x + 0.6, item.y);
  stepWith(g, inputs, STEP * 2);
  tap(g, inputs, 0, 'KeyE');
  eq('M18 they pick up a piece of gear', carriedItem(st, a) && carriedItem(st, a).id, item.id);
  knockDown(st, a, 4.0, g.bus, st.simTimeMs);
  stepWith(g, inputs, STEP * 2);
  eq('M19 and drop it when they go down', carriedItem(st, a), null);
  ok('M20 where it lands is a real placed object, not a deleted one',
     item.placed && item.carriedBy === UNOWNED);
  eq('M21 graph still clean', validateAuthority(st).length, 0);

  // And the thing that actually causes it in play: getting clipped by a moving vehicle.
  const g2 = newGame(777);
  const st2 = g2.state;
  const p = st2.crew[0];
  const truck = st2.vehicles.truck;
  truck.occupiedBy = 'crew1';
  truck.parkBrake = false;
  truck.throttle = 1;
  // Stand in front of it, off to one side of its path, and let it come.
  const ahead = truck.body.toWorld(truck.def.lengthM / 2 + 2.2, 0.2);
  place(p, ahead.x, ahead.y);
  let hit = false;
  for (let i = 0; i < 240 && !hit; i++) {
    truck.throttle = 1;
    g2.step(STEP, st2.simTimeMs + STEP, null);
    if (p.stumbleMs > 0) hit = true;
  }
  ok('M22 a moving truck knocks a crew member off their feet', hit);
  gt('M23 which the job log records', g2.bus.count(EVENTS.CREW_STUMBLED), 0);
  gt('M24 and the truck really was moving', truck.body.speed, CONFIG.crew.knockdownMps);

  // A parked one does not. Being able to lean on a stationary truck matters more than the gag.
  const g3 = newGame(777);
  const st3 = g3.state;
  const p3 = st3.crew[0];
  const side = st3.vehicles.truck.body.toWorld(0, -(st3.vehicles.truck.def.widthM / 2 + 0.1));
  place(p3, side.x, side.y);
  const in3 = twoSeats();
  hold(g3, in3, 0, 'KeyW', 600);
  eq('M25 walking into a parked truck does not knock you down', p3.stumbleMs, 0);
}

/* ── N. the occupiable casualty ──────────────────────────────────────────── */

function sectionN() {
  lines.push('--- N. the casualty has a seat too (GDD §7) ---');

  const g = newGame();
  const st = g.state;
  const inputs = twoSeats();
  const [a, b] = st.crew;
  const sedan = st.vehicles.sedan, truck = st.vehicles.truck;

  atDoor(sedan, b);
  stepWith(g, inputs, STEP * 2);
  const doorHint = b.contextHint
    ? b.contextHint.label + (b.contextHint.alt ? ' + ' + b.contextHint.alt.label : '')
    : '';
  ok('N1 standing at the casualty, the prompt offers the seat', /get in/.test(doorHint), doorHint);
  ok('N1b and the handbrake, on its own key, at the same spot', /parking brake/.test(doorHint), doorHint);
  tap(g, inputs, 1, 'ShiftRight');
  eq('N2 and you can get in the car you came to recover', seatOf(st, b), sedan);

  // The handbrake, from the inside this time.
  eq('N3 it arrived with the handbrake on', sedan.parkBrake, true);
  tap(g, inputs, 1, 'Backslash');
  eq('N4 the brake key releases it from the seat', sedan.parkBrake, false);
  tap(g, inputs, 1, 'Backslash');
  eq('N5 and puts it back on', sedan.parkBrake, true);

  // Steering. This is the M2 feature: a car being dragged can be pointed.
  eq('N6 the casualty starts with its wheels straight', sedan.steerRad, 0);
  hold(g, inputs, 1, 'ArrowRight', 400);
  gt('N7 somebody in the seat can turn its wheels', sedan.steerRad, 0.15);
  ok('N8 up to a car\'s lock, not a truck\'s', CONFIG.sedan.maxSteerRad !== CONFIG.truck.maxSteerRad);
  const steered = sedan.steerRad;
  hold(g, inputs, 1, 'ArrowLeft', 800);
  lt('N9 and back the other way', sedan.steerRad, -0.15);
  ok('N10 the front wheels are the ones that turn',
     sedan.def.wheels.filter((w) => w.steer).every((w) => w.local.x > 0));
  eq('N11 and there are two of them', sedan.def.wheels.filter((w) => w.steer).length, 2);

  // Getting out lets the wheels straighten, so an abandoned car does not hold full lock.
  hold(g, inputs, 1, 'ArrowRight', 400);
  const held = sedan.steerRad;
  tap(g, inputs, 1, 'ShiftRight');
  eq('N12 getting out empties the seat', seatOf(st, b), null);
  stepWith(g, inputs, 400);
  lt('N13 and the wheels return to centre on their own', Math.abs(sedan.steerRad), Math.abs(held));

  /* Does steering the casualty actually change the recovery? It has to, or the feature is a toy.
   *
   * Measured against the same pull with nobody in the seat and the same seed: a dragged car with
   * its wheels turned tracks somewhere different from one with them straight. This asserts a
   * DIFFERENCE, not a direction — which way it goes depends on the geometry of the pull, and a
   * test that demanded "steering left goes left" would be asserting something about a specific
   * seed rather than about the mechanic.
   */
  function pull(steerCode) {
    // Seed 4242 is the one P3 measures a full clean recovery on. Seed 5150 put the car through a
    // 124° pivot with almost no climb, which is a real outcome but tests the pivot, not steering.
    const gg = newGame(4242);
    const s = gg.state;
    const rider = s.crew[1];
    const ins = twoSeats();
    // Park the truck in the far lane, straight, brake on — the M1 "clean park" that recovers on
    // the winch alone (m1-tests Hk1). A near-lane park stalls by design, and a stalled pull would
    // make this test about the stall rather than about steering.
    const tb = s.vehicles.truck.body;
    tb.x = s.vehicles.sedan.body.x + 11; tb.y = BANDS.roadN + 1.4; tb.angle = 0;
    tb.vx = 0; tb.vy = 0; tb.omega = 0;
    s.vehicles.truck.parkBrake = true;
    // The handbrake stays ON, as it arrives. Releasing it on a 28° bank is the "car runs away
    // downhill" case the code warns about — measured here at -118° of yaw and 0.11 m of climb in
    // nine seconds, which tests the runaway rather than the steering. The front wheels are not
    // park wheels, so they roll and steer with the brake on, which is the whole mechanic.
    rigTo(gg, 'towHook', 'chain');
    s.vehicles.sedan.occupiedBy = rider.id;
    const b0 = s.vehicles.sedan.body;
    const y0 = b0.y, x0 = b0.x, ang0 = b0.angle;
    // 20 s, not 9. MEASURED: from this park the car spends its first ~10 s swinging round to line
    // up with the pull — 121 deg of yaw for 0.15 m of climb — and only then starts climbing. A 9 s
    // window measured the alignment phase and nothing else.
    const n = Math.round(20000 / STEP);
    for (let i = 0; i < n; i++) {
      // Through the KEY, not by poking winch.motor: with a real input attached stepCrew resolves
      // the drum from the crew's hands every step, so setting the field directly would be
      // overwritten. That is the point of the interlock, and the test has to respect it.
      ins[0]._debugPress('KeyI');
      if (steerCode) ins[1]._debugPress(steerCode);
      gg.step(STEP, s.simTimeMs + STEP, ins);
      for (const inp of ins) inp.endStep();
    }
    return {
      climb: y0 - s.vehicles.sedan.body.y,
      moved: Math.hypot(s.vehicles.sedan.body.x - x0, s.vehicles.sedan.body.y - y0),
      turn: s.vehicles.sedan.body.angle - ang0,
      steer: s.vehicles.sedan.steerRad,
      on: cornersOnRoad(s.vehicles.sedan, s.terrain).on,
    };
  }
  const straight = pull(null);
  const turned = pull('ArrowRight');
  note(`N  straight: moved ${straight.moved.toFixed(2)} m (climb ${straight.climb.toFixed(2)}), yawed ${(straight.turn * 57.3).toFixed(1)}°`);
  note(`N  steered:  moved ${turned.moved.toFixed(2)} m (climb ${turned.climb.toFixed(2)}), yawed ${(turned.turn * 57.3).toFixed(1)}° at ${turned.steer.toFixed(2)} rad lock`);
  gt('N14 the car moves under the line either way', straight.moved, 0.5);
  gt('N15 a rider holding lock really is holding it', Math.abs(turned.steer), 0.3);
  gt('N16 and it changes where the car ends up',
     Math.abs(turned.turn - straight.turn) + Math.abs(turned.moved - straight.moved), 0.05);


  /* A rider is not a driver: the casualty has no engine, so the throttle must not become one.
   *
   * Measured against the SAME roll with no throttle rather than against a fixed distance — with
   * the handbrake off on a 28° bank the car runs 3.3 m downhill in two seconds under gravity
   * alone, so any absolute threshold measures the slope and not the engine. (It did, first time
   * round: N17 read 3.29 m and looked like a driven car.) */
  function roll(pressThrottle) {
    const gg = newGame(8080);
    const s = gg.state;
    const ins = twoSeats();
    s.vehicles.sedan.occupiedBy = s.crew[1].id;
    s.vehicles.sedan.parkBrake = false;
    const b = s.vehicles.sedan.body;
    const p0 = { x: b.x, y: b.y };
    if (pressThrottle) hold(gg, ins, 1, 'ArrowUp', 2000);
    else stepWith(gg, ins, 2000);
    return Math.hypot(b.x - p0.x, b.y - p0.y);
  }
  const coasted = roll(false);
  const floored = roll(true);
  note(`N  coasting ${coasted.toFixed(2)} m vs flooring it ${floored.toFixed(2)} m — gravity, not an engine`);
  lt('N17 flooring it in the casualty adds nothing, because there is no engine in this car',
     Math.abs(floored - coasted), 0.15);
  gt('N17b and it did roll, so the comparison meant something', coasted, 0.5);
  eq('N18 no driven wheels on it at all', st.vehicles.sedan.def.wheels.filter((w) => w.drive).length, 0);
  ok('N19 unlike the truck, which has two', truck.def.wheels.filter((w) => w.drive).length === 2);
}

/* ── P. hygiene: what the refactor could have broken ─────────────────────── */

async function sectionP() {
  lines.push('--- P. hygiene after the crew refactor ---');

  // Determinism. A crew is more state; more state is more ways to leak wall-clock or Math.random.
  const g1 = newGame(31337, 3);
  const g2 = newGame(31337, 3);
  const in1 = twoSeats(), in2 = twoSeats();
  for (const [g, ins] of [[g1, in1], [g2, in2]]) {
    rigTo(g, 'towHook');
    const n = Math.round(4000 / STEP);
    for (let i = 0; i < n; i++) {
      g.state.winch.motor = 1;
      ins[0]._debugPress('KeyD');
      ins[1]._debugPress('ArrowLeft');
      g.step(STEP, g.state.simTimeMs + STEP, ins);
      for (const inp of ins) inp.endStep();
    }
  }
  const sig = (g) => JSON.stringify(g.state.crew.map((c) => [c.x.toFixed(6), c.y.toFixed(6)]))
    + JSON.stringify(g.state.vehicles.sedan.body.describe());
  eq('P1 two crew driven identically replay bit-for-bit', sig(g1), sig(g2));

  // No Math.random / wall clock in the new modules either.
  const files = ['src/crew/authority.js', 'src/player/player.js'];
  const bad = [];
  for (const f of files) {
    const src = await (await fetch(`../${f}`)).text();
    if (/Math\.random/.test(src)) bad.push(`${f}: Math.random`);
    if (/Date\.now|performance\.now/.test(src)) bad.push(`${f}: wall clock`);
  }
  eq('P2 no Math.random or wall clock in the crew modules', bad.length, 0, bad.join('; '));

  // A whole recovery, with a crew, ends with a clean authority graph and no leaked claims.
  // Park in the FAR lane — the M1-measured clean park (m1-tests Hk1). A near-lane park stalls by
  // design, so parking there would test the stall, not the crew.
  const g3 = newGame(4242);
  const st3 = g3.state;
  st3.vehicles.truck.body.x = st3.vehicles.sedan.body.x + 11;
  st3.vehicles.truck.body.y = BANDS.roadN + 1.4;
  st3.vehicles.truck.body.angle = 0;
  st3.vehicles.truck.body.vx = 0; st3.vehicles.truck.body.vy = 0; st3.vehicles.truck.body.omega = 0;
  st3.vehicles.truck.parkBrake = true;
  rigTo(g3, 'towHook');
  const problems = new Set();
  for (let t = 0; t < 60000 && !st3.goal.complete; t += 250) {
    st3.winch.motor = 1;      // no inputs attached, so the drum keeps what it is given
    g3.skipMs(250);
    for (const s of validateAuthority(st3)) problems.add(s);
  }
  ok('P3 a full crewed recovery still completes', st3.goal.complete,
     `${cornersOnRoad(st3.vehicles.sedan, st3.terrain).on}/4 corners`);
  eq('P4 and never broke the authority graph once, over the whole job', problems.size, 0,
     [...problems].join('; '));
  eq('P5 nobody is left holding anything', st3.crew.filter((c) => ownedBy(st3, c.id).hook).length, 0);

  // A member removed mid-job (the disconnect case) must not strand the site.
  const g4 = newGame();
  const st4 = g4.state;
  claimHook(st4, st4.crew[1].id, g4.bus, 0);
  claimGear(st4, st4.gear[0], st4.crew[1].id, g4.bus, 0);
  st4.crew.splice(1, 1);
  ok('P6 removing a member who owned things IS detected', validateAuthority(st4).length > 0);
  releaseAll(st4, 'crew1', g4.bus, 0);
  eq('P7 and releaseAll repairs it completely', validateAuthority(st4).length, 0);
  ok('P8 so the hook is claimable again by whoever is left',
     hookFree(st4, st4.crew[0].id) && claimHook(st4, st4.crew[0].id, g4.bus, 0));

  // The live page.
  const TB = window.__TB;
  ok('P9 the live game booted', !!TB);
  eq('P10 with one Input per seat, not one for everybody', TB.inputs.length, CONFIG.crew.count);
  ok('P11 and a crew on site', TB.game.state.crew.length === CONFIG.crew.count);
  eq('P12 no errors reached the crash banner', document.getElementById('err-banner'), null);

  // createCrewMember is the only way a member is made, and it must not need a scene to do it.
  const lone = createCrewMember('x', 3, { x: 1, y: 2 }, 'Nobody');
  eq('P13 a member can be built without a world', lone.id, 'x');
  eq('P14 with a tint from the palette', typeof lone.tint, 'string');
  eq('P15 and no field claiming to know what they own',
     [lone.holdingHook, lone.carryingGearId, lone.inVehicleId].filter((v) => v !== undefined).length, 0);
}

/* ── Q. the command seam: what a network would carry ─────────────────────── */

function sectionQ() {
  lines.push('--- Q. commands: the seam a network goes through (GDD §6, §7) ---');

  // The wire format. The index IS the bit, so its order is a compatibility promise.
  eq('Q1 the action list is frozen', Object.isFrozen(ACTIONS), true);
  eq('Q2 every action fits in 16 bits', ACTIONS.length <= 16, true);
  ok('Q3 movement comes first, so a walk vector is the low nibble',
     ACTIONS.slice(0, 4).join(',') === 'moveUp,moveDown,moveLeft,moveRight');
  ok('Q4 the winch is in the set, because GDD §5 makes it always reachable',
     ACTIONS.includes('winchIn') && ACTIONS.includes('winchOut'));

  const kb = new Input(window, CREW_BINDINGS[0]);
  kb._debugPress('KeyD');
  kb._debugPress('KeyE');
  const f = sampleFrame(kb);
  ok('Q5 a held key lands in the held mask', f.held !== 0);
  ok('Q6 and a fresh press lands in the pressed mask too', f.pressed !== 0);
  eq('Q7 a frame round-trips through the packed form', packFrame(unpackFrame(packFrame(f))), packFrame(f));
  const back = unpackFrame(packFrame(f));
  ok('Q8 with both masks intact', back.held === f.held && back.pressed === f.pressed);
  eq('Q9 no input at all is an empty frame, not a hole', sampleFrame(null).held, 0);

  // CommandInput must be indistinguishable from Input to everything downstream.
  const ci = new CommandInput(0).setFrame(f);
  eq('Q10 a command input reports the same held action', ci.isDown('moveRight'), kb.isDown('moveRight'));
  eq('Q11 and the same edge', ci.wasPressed('context'), kb.wasPressed('context'));
  const a1 = kb.driveAxis(), a2 = ci.driveAxis();
  ok('Q12 and the same drive axis', a1.steer === a2.steer && a1.throttle === a2.throttle);
  kb._debugPress('KeyW');
  const diag = new CommandInput(0).setFrame(sampleFrame(kb));
  near('Q13 diagonals are normalised the same way', diag.moveAxis().x, Math.SQRT1_2, 1e-9);
  ok('Q14 it exposes everything the step loop asks of an Input',
     ['isDown', 'wasPressed', 'moveAxis', 'driveAxis', 'endStep'].every((m) => typeof ci[m] === 'function'));

  // The transport.
  const t = new LoopbackTransport(4, 0);
  t.send(0, { held: 5, pressed: 0 });
  let got = t.receive();
  eq('Q15 at zero delay a frame arrives the same step', got[0].held, 5);
  eq('Q16 and seats nobody sent for are empty, not undefined', got[3].held, 0);

  const slow = new LoopbackTransport(2, 3);
  slow.send(0, { held: 9, pressed: 0 });      // due at step 3
  eq('Q17 a delayed transport holds the frame back', slow.receive()[0].held, 0);
  eq('Q17b for exactly the delay, not for a queue depth', slow.receive()[0].held, 0);
  eq('Q17c ...', slow.receive()[0].held, 0);
  eq('Q18 and then delivers it', slow.receive()[0].held, 9);
  // The important one: a seat with nothing due REPEATS its last frame rather than going blank.
  eq('Q19 a seat with nothing to deliver holds its last frame', slow.receive()[0].held, 9);
  eq('Q20 and one frame in means exactly one frame delivered', slow.received, 1);
  // A queue drains completely — the bug that queue-depth delay hid was the last N frames of a
  // session never arriving at all.
  const drain = new LoopbackTransport(1, 2);
  for (let i = 0; i < 5; i++) drain.send(0, { held: 1, pressed: 0 });
  for (let i = 0; i < 5 + 2; i++) drain.receive();
  eq('Q20b every frame sent is eventually delivered', drain.received, 5);
  eq('Q20c with nothing left queued', drain.pending[0], 0);

  /* And now the whole point: a seat driven entirely by commands does what a seat driven by a
   * keyboard does. Same seed, same key presses, one through Input and one through the link. */
  function run(useLink) {
    const g = newGame(2468);
    const ins = twoSeats();
    if (useLink) {
      const l = new CommandLink(2, new LoopbackTransport(2, 0));
      ins.forEach((inp, seat) => l.bindLocal(seat, inp));
      g.link = l;
    }
    const n = Math.round(1500 / STEP);
    for (let i = 0; i < n; i++) {
      ins[0]._debugPress('KeyD');
      ins[1]._debugPress('ArrowUp');
      if (useLink) { g.step(STEP, g.state.simTimeMs + STEP, null); for (const q of ins) q.endStep(); }
      else { g.step(STEP, g.state.simTimeMs + STEP, ins); for (const q of ins) q.endStep(); }
    }
    return g.state.crew.map((c) => `${c.x.toFixed(6)},${c.y.toFixed(6)}`).join('|');
  }
  const viaKeys = run(false);
  const viaLink = run(true);
  eq('Q21 a crew driven through the command link ends up EXACTLY where the keyboard put them',
     viaLink, viaKeys);
  ok('Q22 and they actually moved, so the comparison meant something', !/^0\.0*,/.test(viaKeys));

  // A four-seat session: seats with no keyboard are drivable by frames alone. This is the thing
  // "2-4 player networking" needs to be true before any wire exists.
  const g4 = newGame();
  const l4 = new CommandLink(CONFIG.crew.maxCount, new LoopbackTransport(CONFIG.crew.maxCount, 0));
  g4.link = l4;
  eq('Q23 a session can carry four seats', l4.seats, CONFIG.crew.maxCount);
  eq('Q24 with an input for each of them', l4.inputs.length, CONFIG.crew.maxCount);
  eq('Q25 and none of them local until something binds them', l4.localSeats.length, 0);

  // Drive seat 1 by pushing raw frames — no Input object anywhere in the path.
  const walkEast = { held: 1 << ACTIONS.indexOf('moveRight'), pressed: 0 };
  const p1 = g4.state.crew[1];
  const x0 = p1.x;
  for (let i = 0; i < Math.round(1200 / STEP); i++) {
    l4.transport.send(1, walkEast);
    g4.step(STEP, g4.state.simTimeMs + STEP, null);
  }
  gt('Q26 a seat with no keyboard walks on frames alone', p1.x - x0, 0.4);
  eq('Q27 and the crew member who was NOT sent frames stayed put',
     Math.abs(g4.state.crew[0].vx) < 0.01, true);
  eq('Q28 the authority graph survived being driven over the wire',
     validateAuthority(g4.state).length, 0);

  // Latency must not change the outcome, only when it happens. Same frames, six steps late.
  function delayed(steps) {
    const g = newGame(1357);
    const l = new CommandLink(2, new LoopbackTransport(2, steps));
    g.link = l;
    const total = Math.round(3000 / STEP);
    // Send `total` frames, then run on for `steps` more so the queue drains completely. Both runs
    // therefore deliver exactly `total` walk frames; the delayed one just starts later. The idle
    // steps at the front cost nothing, because the crew begin at rest.
    for (let i = 0; i < total + steps; i++) {
      if (i < total) l.transport.send(0, walkEast);
      g.step(STEP, g.state.simTimeMs + STEP, null);
    }
    return g.state.crew[0].x;
  }
  const now = delayed(0);
  const late = delayed(6);
  note(`Q  0 steps of delay: x=${now.toFixed(4)} · 6 steps: x=${late.toFixed(4)}`);
  near('Q29 six steps of latency delivers the same commands, so the same result', late, now, 1e-9);

  // The live page really is running through the seam, not around it.
  const TB = window.__TB;
  ok('Q30 the live game is driven by a command link', !!TB.game.link);
  eq('Q31 with every local keyboard bound to it', TB.game.link.localSeats.length, TB.inputs.length);
  gt('Q32 and frames have actually gone through it', TB.game.link.transport.sent, -1);
}

/* ── run ─────────────────────────────────────────────────────────────────── */

(async function run() {
  const sections = [['K', sectionK], ['L', sectionL], ['M', sectionM], ['N', sectionN], ['Q', sectionQ], ['P', sectionP]];
  for (const [name, fn] of sections) {
    try { await fn(); }
    catch (e) {
      fails++;
      lines.push(`FAIL  section ${name} threw: ${e && e.message}`);
      lines.push(`      ${(e && e.stack || '').split('\n').slice(1, 4).join('\n      ')}`);
    }
    emit(`... through section ${name}`);
  }
  emit();
})();
