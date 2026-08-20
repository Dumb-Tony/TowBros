/* Top-down camera.
 *
 * COPIED from AirportBaggageCrew\src\render\camera.js (Dev\INDEX.md "Simulation loop,
 * time & state" -> top-down Canvas 2D camera). Kept whole: world drawn in METRES,
 * DPR-capped backing store, eased follow, world<->screen, edge clamping.
 *
 * ADDED for Tow Bros: setViewWidth (the player needs to zoom out to see where the far
 * end of a 30 m cable is going) and shake (a cable parting or a wheel tearing off is the
 * loudest thing that will ever happen in this game; the GDD asks for readable force, and
 * a frame of camera kick reads faster than any HUD element can).
 *
 * Pure maths + a canvas transform. No game rules here. Shake is presentation state and
 * must never feed back into the simulation.
 */

export class Camera {
  constructor({ worldW, worldH, paddingM = 0, maxPixelRatio = 2,
                viewWidthM = 62, followLerp = 7, minViewM = 18, maxViewM = 110 }) {
    this.worldW = worldW;
    this.worldH = worldH;
    this.paddingM = paddingM;
    this.maxPixelRatio = maxPixelRatio;
    this.viewWidthM = viewWidthM;
    this.followLerp = followLerp;
    this.minViewM = minViewM;
    this.maxViewM = maxViewM;

    this.cssW = 1; this.cssH = 1;   // CSS pixels
    this.dpr = 1;
    this.scale = 1;                 // screen pixels per metre
    this.centre = { x: worldW / 2, y: worldH / 2 };
    this.mode = 'follow';           // 'follow' | 'fit'
    this.shakeM = 0;                // current shake amplitude, metres
    this._shakePhase = 0;
    this._shakeOff = { x: 0, y: 0 };
  }

  setMode(mode) {
    this.mode = mode;
    this._recomputeScale();
    if (mode === 'fit') this.centre = { x: this.worldW / 2, y: this.worldH / 2 };
    return mode;
  }

  /** Zoom by setting how many metres fit across the window. Clamped to a readable band. */
  setViewWidth(m) {
    this.viewWidthM = Math.min(this.maxViewM, Math.max(this.minViewM, m));
    this._recomputeScale();
    return this.viewWidthM;
  }
  zoomBy(factor) { return this.setViewWidth(this.viewWidthM * factor); }

  /** Kick the view. Amplitude in metres so it scales with zoom the way an impact should:
   *  zoomed in on the hook, a snap fills the screen; zoomed out, it is a twitch. */
  kick(metres) { this.shakeM = Math.max(this.shakeM, metres); }

  /**
   * Ease the view toward a target and keep it inside the world.
   * @param {number} dtSec  use 0 to snap instantly (restart, teleport)
   */
  follow(x, y, dtSec) {
    const vis = this.visibleM;
    const k = dtSec > 0 ? 1 - Math.exp(-this.followLerp * dtSec) : 1;
    this.centre.x += (x - this.centre.x) * k;
    this.centre.y += (y - this.centre.y) * k;

    const halfW = vis.w / 2, halfH = vis.h / 2;
    this.centre.x = vis.w >= this.worldW ? this.worldW / 2
      : Math.min(this.worldW - halfW, Math.max(halfW, this.centre.x));
    this.centre.y = vis.h >= this.worldH ? this.worldH / 2
      : Math.min(this.worldH - halfH, Math.max(halfH, this.centre.y));

    // Decay the kick on REAL time and resolve it to an offset applied at draw time only.
    if (this.shakeM > 1e-4) {
      this._shakePhase += (dtSec || 0) * 47;
      this._shakeOff.x = Math.sin(this._shakePhase * 1.7) * this.shakeM;
      this._shakeOff.y = Math.cos(this._shakePhase * 2.3) * this.shakeM;
      this.shakeM *= Math.exp(-9 * (dtSec || 0));
      if (this.shakeM < 1e-4) { this.shakeM = 0; this._shakeOff.x = 0; this._shakeOff.y = 0; }
    }
  }

  /** Size the backing store to the element, DPR-aware but capped. @returns {boolean} changed */
  resize(canvas) {
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width  || canvas.clientWidth  || 1));
    const cssH = Math.max(1, Math.round(rect.height || canvas.clientHeight || 1));
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);

    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    if (canvas.width === w && canvas.height === h && this.cssW === cssW && this.cssH === cssH) {
      return false;
    }
    canvas.width = w; canvas.height = h;
    this.cssW = cssW; this.cssH = cssH; this.dpr = dpr;
    this._recomputeScale();
    return true;
  }

  _recomputeScale() {
    if (this.mode === 'fit') {
      const w = this.worldW + this.paddingM * 2;
      const h = this.worldH + this.paddingM * 2;
      this.scale = Math.min(this.cssW / w, this.cssH / h);
    } else {
      this.scale = this.cssW / this.viewWidthM;
    }
  }

  /** The scale a 'fit' camera would use, without switching mode. */
  fitScale() {
    return Math.min(this.cssW / (this.worldW + this.paddingM * 2),
                    this.cssH / (this.worldH + this.paddingM * 2));
  }

  get viewport() { return { w: this.cssW, h: this.cssH }; }

  /** Apply world->screen to a 2D context. Everything drawn after this is in METRES. */
  applyTo(ctx) {
    const s = this.scale * this.dpr;
    const cx = this.centre.x + this._shakeOff.x;
    const cy = this.centre.y + this._shakeOff.y;
    const ox = (this.cssW * this.dpr) / 2 - cx * s;
    const oy = (this.cssH * this.dpr) / 2 - cy * s;
    ctx.setTransform(s, 0, 0, s, ox, oy);
    return s;
  }

  /** Reset to raw device pixels — for HUD drawn on the canvas, and for clearing. */
  resetTransform(ctx) { ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); }

  worldToScreen(x, y) {
    const s = this.scale;
    return {
      x: this.cssW / 2 + (x - this.centre.x - this._shakeOff.x) * s,
      y: this.cssH / 2 + (y - this.centre.y - this._shakeOff.y) * s,
    };
  }

  screenToWorld(sx, sy) {
    const s = this.scale;
    return {
      x: this.centre.x + this._shakeOff.x + (sx - this.cssW / 2) / s,
      y: this.centre.y + this._shakeOff.y + (sy - this.cssH / 2) / s,
    };
  }

  /** Metres visible across the viewport — used to decide label density. */
  get visibleM() { return { w: this.cssW / this.scale, h: this.cssH / this.scale }; }
}
