/* Canvas 2D renderer. Reads state, draws, and decides nothing.
 *
 * GDD pillar 5: "Readable force. Cable shape, vibration, colour, sound, tire slip, component
 * flex, and vehicle motion should explain outcomes before UI does." So this file spends its
 * effort on exactly three things:
 *
 *  1. THE SLOPE. A top-down game has to make a hill visible or the whole design collapses.
 *     The terrain is painted once per attempt from the same height field the physics uses
 *     (src/data/terrain.js), with hillshading and half-metre contour lines. Contours are the
 *     device: a player reads spacing as steepness within seconds and never thinks about it
 *     again. If the contours and the forces ever came from different code the game would lie,
 *     so they come from heightAt() and nothing else.
 *
 *  2. THE LINE. Slack bows, tension straightens, load colours it, and near the limit it
 *     vibrates. Tension is on screen as a SHAPE before it is anywhere as a number.
 *
 *  3. WHAT THE TIRES ARE DOING. Spray, smoke and persistent tracks, coloured by the surface
 *     they came from. A spinning wheel throwing wet grass is the reason the truck is not
 *     winning, and it should be obvious without reading anything.
 *
 * One rule, from Dev\INDEX.md: no external requests. Everything here is drawn.
 */

import { CONFIG } from '../config.js';
import { WINCH, cablePath, fairleadPos, hookPos } from '../recovery/cable.js';
import { clamp, clamp01, lerp, unit, norm } from '../core/vec.js';
import { GEAR } from '../data/equipment.js';

/** Resolution of the painted terrain, pixels per metre. The height field is smooth, so this
 *  is a sharpness/build-time trade: 16 px/m paints a 92x48 m site in ~150 ms. */
const TERRAIN_PPM = 16;
/** Tire tracks accumulate on their own layer at lower resolution — they are smudges. */
const TRACK_PPM = 9;

const COL = {
  sky: '#0b0a12',
  roadLine: '#d8cf9a',
  roadEdge: '#b9b6ad',
  rail: '#9aa0a8',
  railPost: '#7c828a',
  trunk: '#4b3b2c',
  canopy: 'rgba(58,92,46,0.72)',
  canopyRim: 'rgba(96,138,72,0.5)',
  truckBody: '#c3453a',
  truckCab: '#d8574a',
  truckBed: '#8f8a86',
  sedanBody: '#5a7fa8',
  sedanRoof: '#4a6b90',
  glass: 'rgba(190,220,240,0.42)',
  tire: '#1b1b20',
  hub: '#8b8f96',
  player: '#f2ead9',
  playerCoat: '#e0a33c',
  hook: '#cfd6de',
  cableOk: '#b9c2cc',
  cableWarn: '#f2c14e',
  cableDanger: '#ff5a5a',
  zoneDot: 'rgba(242,234,217,0.55)',
  shadow: 'rgba(4,6,10,0.30)',
};

export class Renderer {
  constructor(canvas, camera) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.camera = camera;

    this.terrainCanvas = null;
    this.trackCanvas = null;
    this.trackCtx = null;
    this._builtFor = null;      // terrain identity, so a reset repaints and nothing else does
    this.buildMs = 0;

    this.particles = [];
    this.showZones = false;     // true while the hook is in hand
    this.showForces = CONFIG.debug.showForces;
    this.showGrid = false;
    this._t = 0;                // real seconds, for vibration and shimmer
    this._trackFadeAcc = 0;
  }

  /* ── the painted world ─────────────────────────────────────────────────── */

  /**
   * Paint the terrain once. Height comes from terrain.heightAt for EVERY pixel; the gradient
   * used for hillshading and contours is a central difference of those same values, so there
   * is no second, disagreeing model of the ground.
   */
  buildTerrain(terrain) {
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    const W = Math.round(terrain.world.widthM * TERRAIN_PPM);
    const H = Math.round(terrain.world.heightM * TERRAIN_PPM);

    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const cx = cv.getContext('2d');
    const img = cx.createImageData(W, H);
    const px = img.data;

    // Pass 1: the height field.
    const hf = new Float32Array(W * H);
    for (let j = 0; j < H; j++) {
      const wy = (j + 0.5) / TERRAIN_PPM;
      for (let i = 0; i < W; i++) {
        hf[j * W + i] = terrain.heightAt((i + 0.5) / TERRAIN_PPM, wy);
      }
    }

    // Pass 2: colour. Light from the north-west, which is where a low sun would be for a road
    // running east-west and is also the direction that makes the embankment read as falling
    // away rather than rising.
    const Lx = -0.62, Ly = -0.78;
    const step = CONFIG.render.contourM;
    const perPx = 1 / TERRAIN_PPM;

    for (let j = 0; j < H; j++) {
      const wy = (j + 0.5) / TERRAIN_PPM;
      const jm = Math.max(0, j - 1) * W, jp = Math.min(H - 1, j + 1) * W;
      for (let i = 0; i < W; i++) {
        const wx = (i + 0.5) / TERRAIN_PPM;
        const k = j * W + i;
        const im = Math.max(0, i - 1), ip = Math.min(W - 1, i + 1);

        const h = hf[k];
        const gx = (hf[j * W + ip] - hf[j * W + im]) / (2 * perPx);
        const gy = (hf[jp + i] - hf[jm + i]) / (2 * perPx);
        const gmag = Math.hypot(gx, gy);

        const surf = terrain.surfaceAt(wx, wy);
        // Two-tone dither by a cheap integer hash: texture without a noise function and
        // without Math.random.
        let s = (i * 73856093) ^ (j * 19349663);
        s = (s ^ (s >>> 13)) & 0xffff;
        const mix = (s / 65535) * 0.55;
        let r = hex(surf.tint, 0) * (1 - mix) + hex(surf.tint2, 0) * mix;
        let g = hex(surf.tint, 1) * (1 - mix) + hex(surf.tint2, 1) * mix;
        let b = hex(surf.tint, 2) * (1 - mix) + hex(surf.tint2, 2) * mix;

        // Hillshade. Slopes facing the light brighten; slopes facing away darken.
        const shade = 1 + clamp((-gx * Lx - gy * Ly) / Math.sqrt(1 + gmag * gmag), -0.85, 0.85) * 0.46;
        // Depth tint: the bottom of the ditch is in its own shadow, which reads as "down".
        const depth = 1 - clamp01(-h / 6.2) * 0.30;
        r *= shade * depth; g *= shade * depth; b *= shade * depth;

        // Contour lines, at constant screen width regardless of steepness: a line appears
        // where the height passes a multiple of `step`, and "passes" is judged against how
        // much height one pixel covers here.
        if (gmag > 0.02) {
          const band = h / step;
          const d = Math.abs(band - Math.round(band)) * step;   // metres to the nearest contour
          const wide = gmag * perPx * 0.85;
          if (d < wide) {
            const strength = (1 - d / wide) * 0.42;
            // Every metre is a heavier line, the way a real map does it.
            const major = Math.abs(h / 1.0 - Math.round(h / 1.0)) < 0.06;
            const kk = strength * (major ? 1.55 : 1);
            r *= 1 - kk * 0.75; g *= 1 - kk * 0.7; b *= 1 - kk * 0.55;
          }
        }

        const o = k * 4;
        px[o] = clamp(r, 0, 255); px[o + 1] = clamp(g, 0, 255);
        px[o + 2] = clamp(b, 0, 255); px[o + 3] = 255;
      }
    }
    cx.putImageData(img, 0, 0);

    // Road markings, as vectors on top of the paint.
    const road = terrain.road;
    cx.save();
    cx.scale(TERRAIN_PPM, TERRAIN_PPM);
    cx.strokeStyle = COL.roadEdge; cx.lineWidth = 0.12; cx.globalAlpha = 0.75;
    line(cx, road.x0, road.y0 + 0.34, road.x1, road.y0 + 0.34);
    line(cx, road.x0, road.y1 - 0.34, road.x1, road.y1 - 0.34);
    cx.globalAlpha = 0.9;
    cx.strokeStyle = COL.roadLine; cx.lineWidth = 0.14;
    cx.setLineDash([2.6, 2.6]);
    line(cx, road.x0, road.centreY, road.x1, road.centreY);
    cx.setLineDash([]);
    cx.restore();

    this.terrainCanvas = cv;

    const tw = Math.round(terrain.world.widthM * TRACK_PPM);
    const th = Math.round(terrain.world.heightM * TRACK_PPM);
    const tc = document.createElement('canvas');
    tc.width = tw; tc.height = th;
    this.trackCanvas = tc;
    this.trackCtx = tc.getContext('2d');

    this._builtFor = terrain;
    this.particles.length = 0;
    this.buildMs = Math.round(((typeof performance !== 'undefined' && performance.now)
      ? performance.now() : 0) - t0);
    return this.buildMs;
  }

  /** Subscribe to the events that deserve a visual. Called once at boot. */
  bind(bus, camera) {
    bus.on('IMPACT', (e) => {
      const k = clamp01(e.impulseNs / CONFIG.damage.impactDetachNs);
      this.burst(e.x, e.y, 8 + Math.round(k * 22), '#cfc9b6', 2 + k * 5);
      camera.kick(0.05 + k * 0.42);
    });
    bus.on('CABLE_SNAPPED', (e) => {
      const k = clamp01(e.tensionN / CONFIG.winch.cableBreakN);
      this.burst(this._lastHook.x, this._lastHook.y, 26, '#ffd9a0', 7 * k, 0.55);
      camera.kick(0.85);
    });
    bus.on('COMPONENT_DETACHED', () => camera.kick(0.22));
    bus.on('ZONE_FAILED', () => camera.kick(0.16));
    bus.on('GUARDRAIL_BENT', () => camera.kick(0.2));
    bus.on('SIM_RESET', () => { this.particles.length = 0; this._builtFor = null; });
    return this;
  }

  /** Throw a handful of particles. */
  burst(x, y, n, colour, speed = 3, life = 0.42) {
    for (let i = 0; i < n; i++) {
      if (this.particles.length >= CONFIG.render.maxParticles) break;
      const a = (i / n) * Math.PI * 2 + (x + y) * 0.7;
      const sp = speed * (0.35 + ((i * 37) % 11) / 11);
      this.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life, max: life, size: 0.07 + ((i * 13) % 7) / 60, colour,
      });
    }
  }

  /* ── the frame ─────────────────────────────────────────────────────────── */

  render(st, dtSec = 1 / 60) {
    const ctx = this.ctx, cam = this.camera;
    this._t += dtSec;

    if (this._builtFor !== st.terrain) this.buildTerrain(st.terrain);

    cam.resetTransform(ctx);
    ctx.fillStyle = COL.sky;
    ctx.fillRect(0, 0, cam.cssW, cam.cssH);

    cam.applyTo(ctx);

    const w = st.terrain.world;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.terrainCanvas, 0, 0, w.widthM, w.heightM);
    if (this.trackCanvas) {
      ctx.globalAlpha = 0.85;
      ctx.drawImage(this.trackCanvas, 0, 0, w.widthM, w.heightM);
      ctx.globalAlpha = 1;
    }

    this._fadeTracks(dtSec);
    this._layTracks(st);

    if (this.showGrid) this._drawGrid(w);

    this._drawRail(ctx, st.terrain);
    this._drawGear(ctx, st);
    this._drawDebris(ctx, st);

    // The sedan first: when the truck slides into it, the truck should be on top.
    this._drawVehicle(ctx, st, st.vehicles.sedan);
    this._drawVehicle(ctx, st, st.vehicles.truck);

    this._drawTrees(ctx, st.terrain);       // canopies overhang everything on the ground
    this._drawCable(ctx, st);
    this._drawPlayer(ctx, st);
    this._spawnTireFx(st, dtSec);
    this._drawParticles(ctx, dtSec);

    if (this.showForces) this._drawForces(ctx, st);

    cam.resetTransform(ctx);
  }

  /* ── layers ────────────────────────────────────────────────────────────── */

  _drawGrid(w) {
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 0.03;
    for (let x = 0; x <= w.widthM; x += 5) line(ctx, x, 0, x, w.heightM);
    for (let y = 0; y <= w.heightM; y += 5) line(ctx, 0, y, w.widthM, y);
  }

  _drawRail(ctx, terrain) {
    for (const s of terrain.railSegments) {
      if (s.broken) continue;
      const bendAlpha = 1 - clamp01(s.bend) * 0.4;
      ctx.strokeStyle = COL.rail;
      ctx.globalAlpha = bendAlpha;
      ctx.lineWidth = 0.17 + s.bend * 0.05;
      line(ctx, s.ax, s.ay, s.bx, s.by);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = COL.railPost;
    for (const p of terrain.railPosts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 0.12, 0, Math.PI * 2);
      ctx.fill();
    }
    // A broken section leaves the ends visible, twisted out of line.
    ctx.strokeStyle = '#6d737a'; ctx.lineWidth = 0.14;
    for (const s of terrain.railSegments) {
      if (!s.broken) continue;
      const mx = (s.ax + s.bx) / 2, my = (s.ay + s.by) / 2;
      line(ctx, s.ax, s.ay, mx + 0.3, my + 0.7);
      line(ctx, s.bx, s.by, mx - 0.3, my + 0.55);
    }
  }

  _drawTrees(ctx, terrain) {
    for (const t of terrain.trees) {
      ctx.fillStyle = COL.shadow;
      ctx.beginPath(); ctx.arc(t.x + 0.35, t.y + 0.45, t.canopy * 0.92, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = COL.canopy;
      ctx.beginPath(); ctx.arc(t.x, t.y, t.canopy, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = COL.canopyRim; ctx.lineWidth = 0.12;
      ctx.beginPath(); ctx.arc(t.x, t.y, t.canopy * 0.98, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = COL.trunk;
      ctx.beginPath(); ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2); ctx.fill();
    }
  }

  _drawGear(ctx, st) {
    for (const item of st.gear) {
      if (item.carriedBy) continue;
      const def = GEAR[item.kind];
      if (!def) continue;
      ctx.save();
      ctx.translate(item.x, item.y);
      ctx.rotate(item.angle);
      ctx.fillStyle = COL.shadow;
      rect(ctx, -def.sizeM.x / 2 + 0.06, -def.sizeM.y / 2 + 0.07, def.sizeM.x, def.sizeM.y, true);
      ctx.fillStyle = def.tint;

      if (item.kind === 'chock') {
        // A wedge, drawn as a wedge, pointing the way it resists.
        ctx.beginPath();
        ctx.moveTo(-def.sizeM.x / 2, -def.sizeM.y / 2);
        ctx.lineTo(def.sizeM.x / 2, 0);
        ctx.lineTo(-def.sizeM.x / 2, def.sizeM.y / 2);
        ctx.closePath(); ctx.fill();
      } else if (item.kind === 'snatchBlock') {
        ctx.beginPath(); ctx.arc(0, 0, def.sizeM.x / 2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#2c3542';
        ctx.beginPath(); ctx.arc(0, 0, def.sizeM.x / 5, 0, Math.PI * 2); ctx.fill();
        if (item.attachedTo) {
          ctx.strokeStyle = '#cfd6de'; ctx.lineWidth = 0.06;
          ctx.beginPath(); ctx.arc(0, 0, def.sizeM.x / 2 + 0.09, 0, Math.PI * 2); ctx.stroke();
        }
      } else if (item.kind === 'jack') {
        rect(ctx, -def.sizeM.x / 2, -def.sizeM.y / 2, def.sizeM.x, def.sizeM.y, true);
        // The ram, wound out as far as it has been pumped.
        const f = item.liftStep / CONFIG.gear.jack.liftSteps;
        ctx.fillStyle = '#f0e2a6';
        rect(ctx, -0.06, -def.sizeM.y / 2 - f * 0.26, 0.12, f * 0.3 + 0.02, true);
      } else if (item.kind === 'strap' || item.kind === 'chain') {
        ctx.lineWidth = item.kind === 'chain' ? 0.13 : 0.16;
        ctx.strokeStyle = def.tint;
        ctx.beginPath();
        ctx.moveTo(-def.sizeM.x / 2, 0);
        ctx.quadraticCurveTo(0, def.sizeM.y * 0.9, def.sizeM.x / 2, 0);
        ctx.stroke();
      } else {
        rect(ctx, -def.sizeM.x / 2, -def.sizeM.y / 2, def.sizeM.x, def.sizeM.y, true);
        ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 0.04;
        rect(ctx, -def.sizeM.x / 2, -def.sizeM.y / 2, def.sizeM.x, def.sizeM.y, false);
      }
      ctx.restore();
    }
  }

  _drawDebris(ctx, st) {
    for (const d of st.debris) {
      const b = d.body;
      ctx.save();
      ctx.translate(b.x, b.y); ctx.rotate(b.angle);
      ctx.fillStyle = COL.shadow;
      rect(ctx, -b.halfL + 0.05, -b.halfW + 0.06, b.halfL * 2, b.halfW * 2, true);
      if (d.kind.startsWith('wheel')) {
        ctx.fillStyle = COL.tire;
        ctx.beginPath(); ctx.arc(0, 0, b.halfL, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = COL.hub;
        ctx.beginPath(); ctx.arc(0, 0, b.halfL * 0.42, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = d.kind.startsWith('bumper') ? '#7d8ea0' : COL.sedanBody;
        rect(ctx, -b.halfL, -b.halfW, b.halfL * 2, b.halfW * 2, true);
        ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 0.04;
        rect(ctx, -b.halfL, -b.halfW, b.halfL * 2, b.halfW * 2, false);
      }
      ctx.restore();
    }
  }

  _drawVehicle(ctx, st, veh) {
    const b = veh.body;
    const isTruck = veh.def.driven;
    const L = b.halfL, W = b.halfW;

    // Shadow, offset downhill so a vehicle on the bank looks like it is on the bank.
    const slope = st.terrain.slopeAt(b.x, b.y);
    ctx.save();
    ctx.translate(b.x - slope.gx * 0.5 + 0.12, b.y - slope.gy * 0.5 + 0.16);
    ctx.rotate(b.angle);
    ctx.fillStyle = COL.shadow;
    roundRect(ctx, -L, -W, L * 2, W * 2, 0.34, true);
    ctx.restore();

    // Wheels first, so the body overlaps them.
    for (let i = 0; i < veh.def.wheels.length; i++) {
      const wdef = veh.def.wheels[i];
      const ws = veh.wheelState[i];
      const p = b.toWorld(wdef.local.x, wdef.local.y);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(b.angle + (wdef.steer ? veh.steerRad : 0));
      if (ws.attached) {
        ctx.fillStyle = COL.tire;
        const r = wdef.radiusM;
        roundRect(ctx, -r, -r * 0.42, r * 2, r * 0.84, r * 0.28, true);
        if (ws.lifted) {
          ctx.strokeStyle = '#f0e2a6'; ctx.lineWidth = 0.05;
          roundRect(ctx, -r, -r * 0.42, r * 2, r * 0.84, r * 0.28, false);
        }
      } else {
        ctx.fillStyle = COL.hub;
        ctx.beginPath(); ctx.arc(0, 0, 0.15, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }

    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.angle);

    if (isTruck) {
      ctx.fillStyle = COL.truckBed;
      roundRect(ctx, -L, -W * 0.92, L * 1.05, W * 1.84, 0.16, true);
      ctx.fillStyle = COL.truckBody;
      roundRect(ctx, -L * 0.1, -W * 0.95, L * 1.1, W * 1.9, 0.3, true);
      ctx.fillStyle = COL.truckCab;
      roundRect(ctx, L * 0.16, -W * 0.86, L * 0.66, W * 1.72, 0.24, true);
      ctx.fillStyle = COL.glass;
      roundRect(ctx, L * 0.52, -W * 0.72, L * 0.24, W * 1.44, 0.1, true);
      // The boom and the drum, at the end the cable actually leaves from.
      ctx.fillStyle = '#6f7681';
      rect(ctx, -L * 0.98, -0.34, L * 0.9, 0.68, true);
      ctx.fillStyle = '#4a5058';
      rect(ctx, -L * 0.99, -0.52, 0.3, 1.04, true);
      // Amber beacon, blinking on real time.
      const on = (this._t % 1.1) < 0.5;
      ctx.fillStyle = on ? '#ffb43a' : '#6d5320';
      ctx.beginPath(); ctx.arc(L * 0.12, 0, 0.17, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.fillStyle = veh.rolled ? '#4a5f75' : COL.sedanBody;
      roundRect(ctx, -L, -W, L * 2, W * 2, 0.42, true);
      ctx.fillStyle = COL.sedanRoof;
      roundRect(ctx, -L * 0.42, -W * 0.82, L * 0.92, W * 1.64, 0.26, true);
      ctx.fillStyle = COL.glass;
      roundRect(ctx, L * 0.3, -W * 0.66, L * 0.2, W * 1.32, 0.1, true);
      roundRect(ctx, -L * 0.52, -W * 0.66, L * 0.16, W * 1.32, 0.1, true);
      if (veh.rolled) {
        ctx.strokeStyle = 'rgba(20,24,30,0.55)'; ctx.lineWidth = 0.08;
        for (let i = -2; i <= 2; i++) line(ctx, -L, i * 0.42, L, i * 0.42 + 0.5);
      }
    }

    // Bumpers, unless they are lying in the road somewhere.
    ctx.fillStyle = '#7d8ea0';
    if (veh.damage.parts.bumperFront !== 'lost') rect(ctx, L - 0.1, -W * 0.86, 0.22, W * 1.72, true);
    if (veh.damage.parts.bumperRear !== 'lost') rect(ctx, -L - 0.12, -W * 0.8, 0.22, W * 1.6, true);

    // Dents: deterministic from the count, so the same damage looks the same every frame.
    if (veh.damage.dents > 0) {
      ctx.fillStyle = 'rgba(20,20,26,0.42)';
      for (let i = 0; i < Math.min(veh.damage.dents, 7); i++) {
        const s = (i * 2654435761) >>> 0;
        const dx = ((s & 0xff) / 255 - 0.5) * L * 1.7;
        const dy = (((s >>> 8) & 0xff) / 255 - 0.5) * W * 1.7;
        ctx.beginPath(); ctx.arc(dx, dy, 0.14 + ((s >>> 16) & 7) * 0.02, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();

    // Attachment zones, while the hook is in hand. Every zone the SAME colour and size: GDD
    // §4 forbids a correct-answer glow, so this shows where things are and says nothing about
    // which is wise.
    if (this.showZones) {
      for (const z of veh.def.zones) {
        const gone = veh.zoneMod[z.id] === 0;
        const p = b.toWorld(z.local.x, z.local.y);
        ctx.fillStyle = gone ? 'rgba(120,110,110,0.35)' : COL.zoneDot;
        ctx.beginPath(); ctx.arc(p.x, p.y, 0.15, 0, Math.PI * 2); ctx.fill();
        if (veh.rigging[z.id]) {
          ctx.strokeStyle = CONFIG.rigging[veh.rigging[z.id]] && veh.rigging[z.id] === 'chain'
            ? '#8f939c' : '#c8552f';
          ctx.lineWidth = 0.07;
          ctx.beginPath(); ctx.arc(p.x, p.y, 0.26, 0, Math.PI * 2); ctx.stroke();
        }
      }
    }
  }

  _drawCable(ctx, st) {
    const w = st.winch;
    const truck = st.vehicles.truck;
    if (w.state === WINCH.STOWED) {
      const fl = fairleadPos(truck);
      this._lastHook = fl;
      this._drawHook(ctx, fl.x, fl.y, truck.body.angle);
      return;
    }

    const path = cablePath(w, truck, st.vehicles, st.blocksById);
    const hp = path[path.length - 1];
    this._lastHook = hp;

    let total = 0;
    for (let i = 1; i < path.length; i++) total += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    const slack = w.lineM - total;
    const frac = w.tensionFrac;

    // Colour by load: steel, then hot, then about to go.
    let stroke = COL.cableOk;
    if (frac >= CONFIG.winch.tensionDangerFrac) stroke = COL.cableDanger;
    else if (frac >= CONFIG.winch.tensionWarnFrac) stroke = COL.cableWarn;

    ctx.lineCap = 'round';
    // A shadow line underneath sells the line as being above the ground.
    for (const pass of [{ c: 'rgba(0,0,0,0.35)', o: 0.06, wd: 0.11 }, { c: stroke, o: 0, wd: 0.075 + frac * 0.055 }]) {
      ctx.strokeStyle = pass.c;
      ctx.lineWidth = pass.wd;
      ctx.beginPath();
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i];
        const segLen = Math.hypot(b.x - a.x, b.y - a.y);
        ctx.moveTo(a.x, a.y + pass.o);
        if (slack > 0.05) {
          // Slack bows to one side — the top-down reading of a cable lying on the ground.
          const n = unit(-(b.y - a.y), b.x - a.x);
          const sag = Math.min(CONFIG.winch.slackSagM, slack * 0.45) * (segLen / Math.max(segLen, 1));
          ctx.quadraticCurveTo((a.x + b.x) / 2 + n.x * sag, (a.y + b.y) / 2 + n.y * sag + pass.o, b.x, b.y + pass.o);
        } else if (frac > 0.25) {
          // Taut and loaded: it sings. Amplitude tracks tension, so the line is a gauge.
          const n = unit(-(b.y - a.y), b.x - a.x);
          const amp = 0.02 + frac * 0.09;
          const v = Math.sin(this._t * (26 + frac * 40)) * amp;
          ctx.quadraticCurveTo((a.x + b.x) / 2 + n.x * v, (a.y + b.y) / 2 + n.y * v + pass.o, b.x, b.y + pass.o);
        } else {
          ctx.lineTo(b.x, b.y + pass.o);
        }
      }
      ctx.stroke();
    }

    // The rigging at the attachment, drawn as what it is.
    if (w.state === WINCH.ATTACHED && w.rig !== 'bare') {
      ctx.strokeStyle = w.rig === 'chain' ? '#8f939c' : '#c8552f';
      ctx.lineWidth = w.rig === 'chain' ? 0.12 : 0.17;
      ctx.beginPath(); ctx.arc(hp.x, hp.y, 0.3, 0, Math.PI * 2); ctx.stroke();
    }

    this._drawHook(ctx, hp.x, hp.y, Math.atan2(hp.y - path[path.length - 2].y, hp.x - path[path.length - 2].x));
  }

  _drawHook(ctx, x, y, angle) {
    ctx.save();
    ctx.translate(x, y); ctx.rotate(angle);
    ctx.fillStyle = COL.hook;
    ctx.beginPath();
    ctx.arc(0, 0, 0.17, Math.PI * 0.25, Math.PI * 1.75);
    ctx.lineTo(0.16, 0.02);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  _drawPlayer(ctx, st) {
    const p = st.player;
    if (p.inVehicleId) return;      // in the cab; the truck is the avatar now
    ctx.fillStyle = COL.shadow;
    ctx.beginPath(); ctx.arc(p.x + 0.08, p.y + 0.1, p.radiusM, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = COL.playerCoat;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.radiusM, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = COL.player;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.radiusM * 0.55, 0, Math.PI * 2);
    ctx.fill();
    // Facing wedge: which way "place it ahead of me" means.
    ctx.strokeStyle = 'rgba(242,234,217,0.8)'; ctx.lineWidth = 0.07;
    line(ctx, p.x, p.y, p.x + Math.cos(p.facing) * 0.55, p.y + Math.sin(p.facing) * 0.55);

    if (p.carryingGearId) {
      const item = st.gear.find((g) => g.id === p.carryingGearId);
      if (item) {
        const def = GEAR[item.kind];
        const cx = p.x + Math.cos(p.facing) * 0.42, cy = p.y + Math.sin(p.facing) * 0.42;
        ctx.fillStyle = def.tint;
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(p.facing);
        rect(ctx, -def.sizeM.x / 2, -def.sizeM.y / 2, def.sizeM.x, def.sizeM.y, true);
        ctx.restore();
      }
    }
  }

  /* ── tire spray and tracks ─────────────────────────────────────────────── */

  _spawnTireFx(st, dtSec) {
    for (const id of ['truck', 'sedan']) {
      const veh = st.vehicles[id];
      for (const ws of veh.wheelState) {
        if (!ws.attached) continue;
        if (ws.slipMps < CONFIG.vehicle.slipVisibleMps) continue;
        const heavy = ws.slipMps > CONFIG.vehicle.slipHeavyMps;
        const n = heavy ? 3 : 1;
        const surf = st.terrain.surfaceAt(ws.x, ws.y);
        const colour = surf.id === 'pavement' ? 'rgba(200,200,205,0.5)'
          : surf.id === 'mud' ? '#5c4936'
          : surf.id === 'wetGrass' ? '#5d7a44' : '#8a7d63';
        for (let i = 0; i < n; i++) {
          if (this.particles.length >= CONFIG.render.maxParticles) break;
          const a = veh.body.angle + Math.PI + (((i * 97 + this._t * 37) % 10) / 10 - 0.5) * 1.5;
          const sp = 1.2 + ws.slipMps * 0.7;
          this.particles.push({
            x: ws.x, y: ws.y,
            vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
            life: 0.34 + surf.soft * 0.3, max: 0.64,
            size: 0.06 + surf.soft * 0.09, colour,
          });
        }
      }
    }
  }

  /** Persistent tire marks on soft ground. Drawn into their own layer so they survive frames
   *  and fade slowly — the record of where everybody has already tried. */
  _layTracks(st) {
    const tc = this.trackCtx;
    if (!tc) return;
    for (const id of ['truck', 'sedan']) {
      const veh = st.vehicles[id];
      if (veh.body.speed < 0.05) continue;
      for (const ws of veh.wheelState) {
        if (!ws.attached || ws.soft <= 0.05) continue;
        tc.fillStyle = `rgba(28,22,16,${0.10 + ws.soft * 0.16 + clamp01(ws.slipMps / 3) * 0.18})`;
        const r = 0.19 * TRACK_PPM;
        tc.beginPath();
        tc.ellipse(ws.x * TRACK_PPM, ws.y * TRACK_PPM, r, r * 0.7, veh.body.angle, 0, Math.PI * 2);
        tc.fill();
      }
    }
  }

  _fadeTracks(dtSec) {
    const tc = this.trackCtx;
    if (!tc) return;
    this._trackFadeAcc += dtSec;
    // Batched: fading every frame with a tiny alpha rounds to nothing and never clears.
    if (this._trackFadeAcc < 0.5) return;
    const drop = CONFIG.render.trackFadePerSec * this._trackFadeAcc;
    this._trackFadeAcc = 0;
    tc.save();
    tc.globalCompositeOperation = 'destination-out';
    tc.fillStyle = `rgba(0,0,0,${clamp01(drop)})`;
    tc.fillRect(0, 0, this.trackCanvas.width, this.trackCanvas.height);
    tc.restore();
  }

  _drawParticles(ctx, dtSec) {
    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life -= dtSec;
      if (p.life <= 0) { ps.splice(i, 1); continue; }
      p.x += p.vx * dtSec; p.y += p.vy * dtSec;
      p.vx *= 0.90; p.vy *= 0.90;
      ctx.globalAlpha = clamp01(p.life / p.max);
      ctx.fillStyle = p.colour;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** Debug: every force applied this step, as an arrow. F3 then F. */
  _drawForces(ctx, st) {
    const scale = 1 / 9000;   // metres per newton
    for (const id of ['truck', 'sedan']) {
      for (const f of st.vehicles[id].body.appliedForces) {
        const m = Math.hypot(f.fx, f.fy);
        if (m < 200) continue;
        ctx.strokeStyle = f.tag.startsWith('cable') ? '#ff7a5a'
          : f.tag === 'slope' ? '#7fb3ff'
          : f.tag === 'bogged' ? '#c08bff'
          : f.tag === 'chock' ? '#ffd24a' : '#9fe870';
        ctx.lineWidth = 0.05;
        line(ctx, f.x, f.y, f.x + f.fx * scale, f.y + f.fy * scale);
      }
    }
  }
}

/* ── tiny canvas helpers ─────────────────────────────────────────────────── */

function line(ctx, x0, y0, x1, y1) {
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
}

function rect(ctx, x, y, w, h, fill) {
  ctx.beginPath(); ctx.rect(x, y, w, h);
  if (fill) ctx.fill(); else ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r, fill) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y); ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr); ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr); ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
  if (fill) ctx.fill(); else ctx.stroke();
}

/** One channel of a #rrggbb string. Called once per pixel during the terrain bake, so it is
 *  kept to two parseInts and no allocation. */
function hex(s, ch) {
  return parseInt(s.substr(1 + ch * 2, 2), 16);
}
