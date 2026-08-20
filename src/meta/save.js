/* The save file. GDD §7 Milestone 4: "persistent garage lobby, a small fleet, equipment storage,
 * repairs, money, organization reputation, and authored dispatch selection."
 *
 * ── ONE FILE, VERSIONED, AND IT NEVER THROWS ─────────────────────────────────────────
 * localStorage, JSON, one key. No server, because the project has no server and this is the fourth
 * milestone in a row where that has not cost anything.
 *
 * The rule that matters is that loading a save can NEVER take the game down. A corrupt string, a
 * quota error, a private-browsing window that refuses to store anything, a save written by a
 * version that does not exist yet — all of those return a fresh company and say so, rather than
 * throwing on the first line of main.js. A game that will not start because of its own save file is
 * worse than a game with no save file.
 *
 * ── WHY THIS IS THE ONLY MODULE ALLOWED TO READ THE CLOCK ────────────────────────────
 * `savedAt` is a wall-clock timestamp, for the player's benefit, and the m1 hygiene sweep exempts
 * this one file for it. Nothing in the simulation reads it and nothing may: the whole determinism
 * argument in core/clock.js still applies, and a save's timestamp is presentation.
 */

export const SAVE_KEY = 'towbros.save';
export const SAVE_VERSION = 1;

/** Why a load returned what it did. The garage shows this once, so a lost save is not a mystery. */
export const LOAD = Object.freeze({
  FRESH: 'fresh',            // nothing was stored
  LOADED: 'loaded',
  UNREADABLE: 'unreadable',  // corrupt JSON, or storage refused to answer
  TOO_NEW: 'too-new',        // written by a later version of the game
  MIGRATED: 'migrated',
});

/** Is there somewhere to save to at all? Private windows and file:// sometimes say no. */
export function storageAvailable() {
  try {
    const k = '__tb_probe__';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the save.
 *
 * @returns {{ status: string, data: object|null, note: string }} — `data` is the raw stored object,
 *   validated only as far as "it is an object with a version we understand". Turning it into a
 *   company is meta/company.js's job, because that is where the defaults live and there should not
 *   be two copies of them.
 */
export function loadRaw(key = SAVE_KEY) {
  let text = null;
  try {
    text = window.localStorage.getItem(key);
  } catch {
    return { status: LOAD.UNREADABLE, data: null, note: 'this browser will not let the page store anything' };
  }
  if (!text) return { status: LOAD.FRESH, data: null, note: 'no save yet' };

  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    return { status: LOAD.UNREADABLE, data: null, note: 'the save file could not be read' };
  }
  if (!obj || typeof obj !== 'object') {
    return { status: LOAD.UNREADABLE, data: null, note: 'the save file was not a save file' };
  }
  const v = obj.version | 0;
  if (v > SAVE_VERSION) {
    // Forward compatibility is a promise this project has not made. Say so rather than guessing.
    return { status: LOAD.TOO_NEW, data: null, note: `saved by a newer version (${v})` };
  }
  if (v < SAVE_VERSION) {
    return { status: LOAD.MIGRATED, data: migrate(obj, v), note: `brought forward from version ${v}` };
  }
  return { status: LOAD.LOADED, data: obj, note: '' };
}

/**
 * Bring an older save forward.
 *
 * There is only one version so far, so this is a placeholder with a real shape rather than a real
 * migration — but the shape is the point. The alternative is discovering at version 2 that every
 * existing save has to be thrown away, which is how a save file stops being a save file.
 */
export function migrate(obj, fromVersion) {
  const out = { ...obj };
  // v0 -> v1: nothing shipped as v0. Kept so the chain has somewhere to start.
  out.version = SAVE_VERSION;
  return out;
}

/** Write it. Returns false rather than throwing when storage refuses (quota, private mode). */
export function saveRaw(data, key = SAVE_KEY) {
  try {
    window.localStorage.setItem(key, JSON.stringify({
      ...data,
      version: SAVE_VERSION,
      savedAt: new Date().toISOString(),
    }));
    return true;
  } catch {
    return false;
  }
}

/** Throw the save away. The garage offers this, because a player should be able to start again. */
export function clearSave(key = SAVE_KEY) {
  try { window.localStorage.removeItem(key); return true; } catch { return false; }
}
