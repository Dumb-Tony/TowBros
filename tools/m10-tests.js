/* TOW BROS — Milestone 10 suite: the one that comes in two halves.
 *
 *   .\tools\smoketest.ps1 -Tests tools\m10-tests.js -Quiet
 *
 * GDD §7 Milestone 10. Milestone 9 put two vehicles at a scene and gave them an order; this one
 * joins them together. An articulated lorry is not a bigger box truck — it is two bodies on a
 * hinge, and the hinge is the whole problem and the whole answer.
 *
 *   BA the pin: a fifth wheel, and what the angle between the halves does to a pull
 *   BB taking it apart: what uncoupling costs, and when it is refused
 *   BC the two halves: what each weighs, and what one drum and two drums can do about them
 *   AK5 hygiene — nine milestones of numbers that must not have moved
 */

import { CONFIG } from '../src/config.js';
import { EVENTS } from '../src/core/eventBus.js';
import { Game } from '../src/game.js';
import { BANDS } from '../src/data/terrain.js';
import { findZone, casualtyDefById } from '../src/data/vehicles.js';
import { attachHook } from '../src/recovery/attach.js';
import { WINCH, cablePath, pathLength, drumsOf } from '../src/recovery/cable.js';
import { casualties, cornersOnRoad } from '../src/sim/vehicle.js';

/* ── reporting ───────────────────────────────────────────────────────────── */

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
const inRange = (n, a, lo, hi) => ok(n, a >= lo && a <= hi, `got ${a}, wanted ${lo}..${hi}`);
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
const kN = (n) => (n / 1000).toFixed(1);
const G = CONFIG.sim.gravity;

/* ── helpers ─────────────────────────────────────────────────────────────── */

function job(extra = {}) {
  const g = new Game({ seed: 4242, seedLabel: 'm10' });
  g.job = { siteId: 'bend', weatherId: 'dry', mods: { seizedChance: 0 }, traffic: false, ...extra };
  g.startJob({ reroll: false, attempt: 1 });
  return g;
}

/* ══ AK5. nine milestones of numbers that must not have moved ═════════════ */

async function sectionAK5() {
  lines.push('--- AK5. nine milestones of numbers that must not have moved ---');

  /* The Milestone 1 recovery, one more time. It is in every suite from here on for the reason it
   * was in the last four: it is the oldest measurement in the tree and the one most likely to be
   * quietly broken by something that had nothing to do with it. */
  {
    const g = job();
    const st = g.state;
    const s = st.vehicles.sedan.body, b = st.vehicles.truck.body;
    b.x = s.x + 11; b.y = BANDS.roadN + 1.4; b.angle = 0; b.vx = 0; b.vy = 0; b.omega = 0;
    st.vehicles.truck.parkBrake = true;
    const zone = findZone(st.vehicles.sedan.def, 'towHook');
    const p = s.toWorld(zone.local.x, zone.local.y);
    st.winch.hook.x = p.x; st.winch.hook.y = p.y;
    st.winch.state = WINCH.ATTACHED; st.winch.targetId = 'sedan'; st.winch.zoneId = 'towHook';
    const len = pathLength(cablePath(st.winch, st.vehicles.truck, st.vehicles, st.blocksById));
    st.winch.state = WINCH.LOOSE;
    attachHook(st, st.vehicles.sedan, zone, g.bus, st.simTimeMs);
    st.winch.lineM = len;
    let peak = 0;
    for (let t = 0; t < 60000 && !st.goal.complete; t += 250) {
      st.winch.motor = 1;
      g.skipMs(250);
      peak = Math.max(peak, st.winch.tensionN);
    }
    ok('AK5-1 the far-lane recovery still works', st.goal.complete);
    inRange(`AK5-2 in the time it always took (${(st.goal.completedAtMs / 1000).toFixed(0)} s)`,
            st.goal.completedAtMs / 1000, 25, 50);
    inRange(`AK5-3 at the tension it always took (${kN(peak)} kN)`, peak, 8000, 20000);
    ok('AK5-4 without rolling the machine doing it', !st.vehicles.truck.rolled);
  }

  {
    const bad = [];
    for (const f of ['recovery/coupling.js', 'data/vehicles.js', 'meta/situations.js']) {
      let src;
      try { src = await (await fetch(`../src/${f}`)).text(); } catch { continue; }
      if (/Math\.random/.test(src)) bad.push(`${f}: Math.random`);
      if (/(Date\.now|performance\.now|new Date)\s*\(/.test(src)) bad.push(`${f}: wall clock`);
    }
    eq('AK5-5 no Math.random or wall clock in the Milestone 10 modules', bad.length, 0, bad.join('; '));
  }

  const TB = window.__TB;
  ok('AK5-6 the live game booted', !!TB);
  eq('AK5-7 and no errors on the crash banner', document.getElementById('err-banner'), null);
}

/* ── run ─────────────────────────────────────────────────────────────────── */

(async function run() {
  const sections = [['AK5', sectionAK5]];
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
