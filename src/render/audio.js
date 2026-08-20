/* Synthesised audio. No files, no CDN, no external requests.
 *
 * `tone` is COPIED from Chameleon\chameleon3d.html:2190 (Dev\INDEX.md "Audio" — it exists
 * twice already in the tree and the rule is to take the better version, not write a fifth).
 * The envelope, the exponential ramps and the 0.22 base gain are all from there.
 *
 * ── WHY THIS IS MILESTONE 1 WORK ──────────────────────────────────────────────────────
 * GDD pillar 5: "Readable force. Cable shape, vibration, colour, SOUND, tire slip, component
 * flex, and vehicle motion should explain outcomes before UI does."
 *
 * The single most important number in this game is cable tension, and it is the one a player
 * cannot afford to be looking at a bar for — they are watching the vehicles. So tension is a
 * PITCH. The line hums when it loads and sings when it is near parting, and players learn
 * that curve in one session without anyone explaining it. Everything else here is support:
 *
 *   engine   sawtooth, pitch tracks throttle          "the truck is trying"
 *   winch    triangle whine, present only while reeling "the drum is turning"
 *   cable    sine, 90 Hz -> 620 Hz across tension      "how close am I to losing the line"
 *   slip     filtered noise, gain tracks tire slip     "that wheel is not gripping"
 *   clang    two-tone metallic hit, force-scaled       something just broke
 *
 * Browsers refuse to start an AudioContext before a gesture, so ensure() is called from the
 * first key or click and everything before that is a no-op.
 */

import { CONFIG } from '../config.js';
import { clamp01, lerp } from '../core/vec.js';

export class Audio {
  constructor() {
    this.ac = null;
    this.master = null;
    this.muted = !CONFIG.audio.enabled;
    this.ready = false;
    this._voices = null;
  }

  /** Create the context. Safe to call repeatedly; call it from a real user gesture. */
  ensure() {
    if (this.ac) { if (this.ac.state === 'suspended') this.ac.resume(); return this.ready; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ac = new AC();
      this.master = this.ac.createGain();
      this.master.gain.value = this.muted ? 0 : CONFIG.audio.masterVol;
      this.master.connect(this.ac.destination);
      this._buildVoices();
      this.ready = true;
    } catch (e) { this.ready = false; }
    return this.ready;
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : CONFIG.audio.masterVol;
    return this.muted;
  }

  /** The continuous voices. Built once and left running at zero gain, because starting and
   *  stopping oscillators per frame clicks. */
  _buildVoices() {
    const ac = this.ac;
    const mk = (type, freq) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type; o.frequency.value = freq; g.gain.value = 0;
      o.connect(g); g.connect(this.master); o.start();
      return { o, g };
    };

    // Filtered noise for tire slip. One buffer, looped — cheap and it never repeats audibly
    // under a lowpass this aggressive.
    const len = Math.floor(ac.sampleRate * 1.4);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    // A fixed pseudo-random fill: no Math.random anywhere in this project (see core/rng.js).
    let s = 0x9e3779b9;
    for (let i = 0; i < len; i++) {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      d[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
    }
    const src = ac.createBufferSource();
    src.buffer = buf; src.loop = true;
    const bp = ac.createBiquadFilter();
    bp.type = 'lowpass'; bp.frequency.value = 900; bp.Q.value = 0.7;
    const sg = ac.createGain(); sg.gain.value = 0;
    src.connect(bp); bp.connect(sg); sg.connect(this.master);
    src.start();

    this._voices = {
      engine: mk('sawtooth', 46),
      engineHi: mk('square', 92),
      winch: mk('triangle', 240),
      cable: mk('sine', CONFIG.audio.cableHzLow),
      cableHarm: mk('triangle', CONFIG.audio.cableHzLow * 2),
      slip: { g: sg, f: bp },
    };
  }

  /**
   * One-shot tone. Copied from Chameleon's `tone`, argument order and all.
   * @param {number} freq Hz @param {number} dur seconds
   */
  tone(freq, dur, type = 'sine', volMul = 1, delay = 0) {
    if (!this.ready || this.muted) return;
    const t0 = this.ac.currentTime + delay;
    const o = this.ac.createOscillator(), g = this.ac.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.22 * volMul), t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }

  /** Sweep a tone's pitch — the sound of something letting go. */
  sweep(fromHz, toHz, dur, type = 'sawtooth', volMul = 1) {
    if (!this.ready || this.muted) return;
    const t0 = this.ac.currentTime;
    const o = this.ac.createOscillator(), g = this.ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(fromHz, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, toHz), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.22 * volMul), t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }

  /* ── the game's vocabulary ─────────────────────────────────────────────── */

  /** Metal on metal, scaled by how hard. The GDD's "metallic clang, a brief silence, and a
   *  worse problem" — this is the clang. */
  clang(forceN = 12000) {
    const k = clamp01(forceN / 30000);
    this.tone(lerp(320, 130, k), 0.16 + k * 0.2, 'sawtooth', 0.5 + k * 0.5);
    this.tone(lerp(880, 420, k), 0.10 + k * 0.1, 'square', 0.25 + k * 0.3, 0.015);
    this.tone(lerp(1600, 700, k), 0.07, 'triangle', 0.2 * k, 0.03);
  }

  /** A cable parting: a crack, then the whip, then nothing. */
  snap() {
    this.tone(2200, 0.05, 'square', 1.0);
    this.sweep(1800, 90, 0.42, 'sawtooth', 0.85);
    this.tone(70, 0.5, 'sine', 0.7, 0.04);
  }

  /** Something tearing off a car: lower, longer, less bright than a snap. */
  tear() {
    this.sweep(520, 120, 0.34, 'square', 0.55);
    this.tone(160, 0.28, 'sawtooth', 0.45, 0.05);
  }

  thud(forceN = 8000) {
    const k = clamp01(forceN / 24000);
    this.tone(lerp(150, 70, k), 0.18 + k * 0.16, 'sine', 0.5 + 0.4 * k);
  }

  click() { this.tone(760, 0.05, 'square', 0.35); this.tone(1140, 0.05, 'sine', 0.2, 0.03); }
  ratchet() { this.tone(240, 0.05, 'square', 0.4); this.tone(180, 0.07, 'sawtooth', 0.3, 0.04); }
  chime() { this.tone(660, 0.14, 'sine', 0.7); this.tone(990, 0.16, 'sine', 0.6, 0.11); this.tone(1320, 0.24, 'sine', 0.5, 0.23); }

  /**
   * Continuous voices, once per render frame. Presentation only — it reads state and never
   * writes it.
   * @param {number} dtSec real frame time; gains are smoothed on real time so pausing holds
   *   the current sound rather than cutting it dead.
   */
  update(st, dtSec) {
    if (!this.ready || this.muted || !this._voices) return;
    const v = this._voices;
    const now = this.ac.currentTime;
    const glide = (node, target, hz) => {
      node.gain.setTargetAtTime(Math.max(0.0001, target), now, hz);
    };
    const pitch = (node, target) => { node.frequency.setTargetAtTime(target, now, 0.06); };

    const truck = st.vehicles.truck;
    const running = st.mode === 'playing';

    // Engine: audible only with someone in the cab, because an unattended truck is silent and
    // that silence is information.
    const thr = truck.occupied ? Math.abs(truck.throttle) : 0;
    const idle = truck.occupied ? 1 : 0;
    pitch(v.engine.o, 44 + thr * 46 + Math.min(12, truck.body.speed * 1.6));
    pitch(v.engineHi.o, 88 + thr * 92);
    glide(v.engine.g, running ? idle * CONFIG.audio.engineVol * (0.4 + thr * 0.6) : 0, 0.08);
    glide(v.engineHi.g, running ? idle * CONFIG.audio.engineVol * 0.22 * thr : 0, 0.08);

    // Winch: only while the drum turns. A stalled winch drops in pitch and gets louder, which
    // is exactly what a stalled winch does.
    const w = st.winch;
    const reeling = w.motor !== 0 && w.state === 'attached';
    const stallDrop = w.stalled ? 0.55 : 1;
    pitch(v.winch.o, (w.motor > 0 ? 260 : 190) * stallDrop);
    glide(v.winch.g, running && reeling ? CONFIG.audio.winchVol * (w.stalled ? 1.25 : 1) : 0, 0.05);

    // The line. THE important voice: pitch is tension, directly.
    const f = w.tensionFrac;
    const hz = lerp(CONFIG.audio.cableHzLow, CONFIG.audio.cableHzHigh, Math.pow(f, 0.8));
    pitch(v.cable.o, hz);
    pitch(v.cableHarm.o, hz * (2 + f));
    glide(v.cable.g, running ? f * 0.30 : 0, 0.07);
    // The harmonic only appears near the limit, so "close to parting" has its own timbre.
    glide(v.cableHarm.g, running ? Math.max(0, f - 0.55) * 0.36 : 0, 0.06);

    // Tire slip, from whichever wheel is losing worst.
    const slip = Math.max(truck.maxSlipMps || 0, st.vehicles.sedan.maxSlipMps || 0);
    v.slip.f.frequency.setTargetAtTime(520 + Math.min(1600, slip * 420), now, 0.08);
    glide(v.slip.g, running ? clamp01(slip / 3.2) * 0.20 : 0, 0.07);
  }

  /** Wire the event bus to the noises. Called once at boot. */
  bind(bus) {
    bus.on('CABLE_SNAPPED', () => this.snap());
    bus.on('COMPONENT_DETACHED', () => this.tear());
    bus.on('ZONE_FAILED', (e) => { if (e.mode === 'bent') this.clang(20000); });
    bus.on('IMPACT', (e) => { if (e.impulseNs > CONFIG.damage.impactMinNs) this.thud(e.impulseNs * 3); });
    bus.on('GUARDRAIL_BENT', (e) => this.clang(e.broken ? 30000 : 16000));
    bus.on('HOOK_ATTACHED', () => this.ratchet());
    bus.on('HOOK_TAKEN', () => this.click());
    bus.on('GEAR_PICKED_UP', () => this.click());
    bus.on('GEAR_PLACED', () => this.thud(3000));
    bus.on('GEAR_USED', () => this.ratchet());
    bus.on('BLOCK_MOUNTED', () => this.ratchet());
    bus.on('RECOVERY_COMPLETE', () => this.chime());
    bus.on('WINCH_SPOOL_END', () => this.tone(180, 0.12, 'square', 0.4));
    return this;
  }
}
