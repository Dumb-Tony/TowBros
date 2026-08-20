/* The scene: a two-lane rural road, a wet grassy embankment, and a muddy low point.
 * GDD §4 "Scenario". Pure data plus pure queries — no canvas, no DOM, no game state, so
 * the test suite reasons about the ground without a browser paint, and the renderer reads
 * the same records the physics does. Pattern from AirportBaggageCrew\src\data\airport.js.
 *
 * Coordinates are metres. +x east, +y SOUTH (screen-down, matching canvas). The origin is
 * the north-west corner of the site.
 *
 * ── WHY THERE IS A HEIGHT FIELD IN A TOP-DOWN GAME ────────────────────────────────────
 * The GDD's second pillar is "the winch does not know who should win… position, traction,
 * SLOPE and mass decide the result". A top-down game with no third axis cannot have
 * slope, so this file supplies one: h(x,y) in metres above the road surface. Everything
 * else follows from its gradient.
 *
 *   - in-plane gravity  = -m·g·∇h / sqrt(1+|∇h|²)   -> what drags a vehicle downhill
 *   - normal load scale =      1  / sqrt(1+|∇h|²)   -> why grip fails on the steep part
 *
 * Both fall out of resolving real gravity onto an inclined plane, so a vehicle parked
 * across the embankment loses grip and gains a downhill pull at the same time, in the
 * correct proportion, without either being special-cased.
 *
 * The renderer draws contour lines straight from this function (CONFIG.render.contourM),
 * which is the whole reason the player can read a slope on a flat screen. If the field and
 * the contours ever came from different code the game would become unreadable, so they
 * must not.
 *
 * Layout, north (top) to south (bottom):
 *   treed cut bank -> shoulder -> PAVEMENT -> shoulder + guardrail -> EMBANKMENT -> mud
 */

import { clamp, clamp01, smoothstep } from '../core/vec.js';

/* The world is 168 m of road.
 *
 * The recovery site is the western 92 m of it — exactly the Milestone 1 scene, unchanged, with
 * every anchor, tree and guardrail post where it was. East of that the embankment is graded flat
 * and the road runs on to a yard, because Milestone 3 asks for a "short transport route" and a
 * "destination" and a job that ends where the car is dropped off rather than where it stops being
 * in a ditch.
 *
 * Widening the world costs terrain-bake time, which is a per-pixel loop. TERRAIN_PPM in the
 * renderer is derived from a pixel budget rather than fixed at 20 now, so the bake stays about
 * where it was and the site loses about two pixels per metre nobody can see. */
export const WORLD = { widthM: 168, heightM: 48 };

/* Band edges in y. These are the scene's skeleton: the surface table, the height field
 * and the renderer all key off the same six numbers.
 *
 * ── WHY THE PAVEMENT IS 9.4 m WIDE ────────────────────────────────────────────────────
 * It was 8.0 m, and that turned out to be the difference between a recovery and a puzzle.
 * A winched car settles about 2.5 m short of the fairlead along the pull line — 0.45 m of
 * minimum line plus the 2.1 m from its tow eye back to its own centre — so with only 8 m
 * of pavement the objective (all four corners on the road) could only be met with the
 * wrecker parked as far north as it would go. Measured: a near-lane park finished at 3/4
 * corners every time, and the fix was a geometry insight the player had no way to see.
 *
 * 9.4 m is also just a more honest rural two-lane: two 3.5 m lanes and a metre of paved
 * edge either side. The shoulder and the embankment shift south with it, so the slope
 * profile, its steepness and every force in config.js are unchanged.
 */
export const BANDS = Object.freeze({
  bankTop:      3.0,    // north of this, the ground rises into the treed cut bank
  roadN:        5.2,    // north edge of pavement
  roadS:       14.6,    // south edge of pavement
  shoulderS:   17.0,    // south edge of the gravel shoulder; the embankment starts here
  embankmentS: 28.4,    // bottom of the embankment — 11.4 m of bank, as before
});

/** The road, as one rectangle. Success detection asks whether the sedan's four corners
 *  are inside this — GDD §4: "the single objective is get the sedan onto the road". */
export const ROAD = Object.freeze({
  x0: 0, x1: WORLD.widthM, y0: BANDS.roadN, y1: BANDS.roadS,
  centreY: (BANDS.roadN + BANDS.roadS) / 2,
  laneLineY: (BANDS.roadN + BANDS.roadS) / 2,
});

/* The yard at the east end — Milestone 3's destination.
 *
 * A paved apron on the south side, at shoulder level, with one marked bay. The job is not over
 * when the car is out of the ditch; it is over when the car is standing in that bay, which is what
 * turns a recovery into a JOB. Getting it there means loading it onto the wheel lift, strapping it
 * down, driving 60-odd metres, and reversing a truck with a car hanging off the back of it.
 *
 * The embankment does not stop at a wall. `blendX0..blendX1` is 20 m of ground being graded flat,
 * so the profile is continuous and a vehicle driven off the road anywhere along it behaves the way
 * the ground looks. A cliff at x=116 would have been much less code and a much worse scene.
 */
export const YARD = Object.freeze({
  blendX0: 96, blendX1: 116,          // the embankment fades out across these 20 m
  x0: 116, x1: 166,                   // the paved apron
  y0: BANDS.roadS, y1: 34.0,
  /** Where the casualty is set down. Generous — reversing a loaded wrecker is hard enough. */
  bay: Object.freeze({ x0: 132.0, x1: 147.0, y0: 21.5, y1: 30.0 }),
  /** Painted lane in from the road, for the renderer and for nothing else. */
  entryX: 120.0,
});

/** 0 at the recovery site, 1 in the yard. The one function that decides which profile applies. */
export function yardFrac(x) {
  return smoothstep(clamp01((x - YARD.blendX0) / (YARD.blendX1 - YARD.blendX0)));
}

/* Height of the road above the bottom of the ditch, for reference in the UI. */
export const DROP_M = 4.57;

/* ── the county: four places a car can end up (Milestone 5) ─────────────────
 *
 * GDD §7 Milestone 5: "connect job scenes with a regional map or compact open county".
 *
 * ── WHAT MAKES A SITE A DIFFERENT PLACE ──────────────────────────────────────────────
 * Not scenery. The four below differ in the things that change which APPROACHES work, and each
 * one takes away or adds something the player was relying on:
 *
 *   the bend     the Milestone 1 site, unchanged to the last decimal. Wooded, muddy bottom.
 *   the ford     shallow, wide gap, standing water at the foot, and ONE tree. A side pull is
 *                still possible but there is only one place to hang the block.
 *   the quarry   the steepest drop, loose rock, and NO TREES AT ALL — so the snatch block is
 *                dead weight and the answer has to come from parking and rigging alone.
 *   the bridge   a narrow gap in the rail, so the pull line has to thread it, and a hard
 *                abutment to bring the car past.
 *
 * `dropMul` scales the embankment, which scales the downslope force directly: at 1.25 the quarry
 * pulls ~7.7 kN against the bend's 6.2. Everything else in config.js is untouched, so the tuning
 * that made the bend work is the tuning that makes all four work.
 */
export const SITES = Object.freeze([
  Object.freeze({
    id: 'bend', name: 'the bend on Cold Ash Hill',
    blurb: 'Wooded cut bank, wet grass, and a muddy hollow at the bottom.',
    dropMul: 1.0, gapMul: 1.0, hazard: 'mud', trees: 'all', boulders: 0,
    map: { x: 0.35, y: 0.60 }, short: 'Cold Ash Hill',
  }),
  Object.freeze({
    id: 'ford', name: 'the ford at Marle Brook',
    blurb: 'Shallow bank down to standing water. Only one tree worth rigging to.',
    dropMul: 0.78, gapMul: 1.45, hazard: 'water', trees: 'one', boulders: 0,
    /* IN the brook, not on the bank above it (Milestone 6). A ford whose casualty never touches
     * the water would be a site with a blue puddle painted on it — the buoyancy that makes a water
     * recovery a different problem only exists where the vehicle is actually standing in it. */
    casualtyDy: 6.2,
    map: { x: 0.09, y: 0.22 }, short: 'Marle Brook',
  }),
  Object.freeze({
    id: 'quarry', name: 'the quarry approach',
    blurb: 'The steepest drop in the county, loose rock, and nothing to hang a block on.',
    dropMul: 1.28, gapMul: 0.75, hazard: 'scree', trees: 'none', boulders: 5,
    map: { x: 0.63, y: 0.20 }, short: 'the quarry',
  }),
  Object.freeze({
    id: 'bridge', name: 'the bridge abutment on Wenn Lane',
    blurb: 'It went through a short section of rail. Threading the line back out is the job.',
    dropMul: 1.08, gapMul: 0.55, hazard: 'none', trees: 'two', boulders: 2,
    map: { x: 0.55, y: 0.78 }, short: 'Wenn Lane',
  }),
]);

export const siteById = (id) => SITES.find((s) => s.id === id) || SITES[0];

/** Mud depth at which the ground counts as mud. The renderer fades its colour in over the next
 *  few centimetres above this, so the painted edge and the behavioural edge stay together. */
export const MUD_EDGE_M = 0.04;
export const MUD_FADE_M = 0.11;

/** Surface properties. `mu` is the peak friction coefficient the tire model clamps to;
 *  `crr` is rolling resistance. The two are independent on purpose: mud has poor grip AND
 *  huge drag, wet grass has poor grip and modest drag, and the difference between those
 *  two facts is a real recovery decision.
 *
 *  `anchorHoldMul` (Milestone 6) is what a driven ground anchor is worth in this stuff, and it is
 *  authored per surface rather than derived from `soft` because the relationship is not monotonic:
 *  you need ground a spike will go INTO and then be held BY. Tarmac takes no spike at all (0), wet
 *  grass is the best of them (1.0), and mud lets it shear straight out (0.35). Loose rock is the
 *  worst thing that is not tarmac, which is why the quarry still has no answer.
 *
 *  `tint`/`tint2` live here rather than in the renderer so that a patch of ground can
 *  never be drawn as grass while behaving like pavement. */
export const SURFACES = Object.freeze({
  pavement:  { id: 'pavement',  label: 'pavement',     mu: 0.95, crr: 0.014, soft: 0.00, anchorHoldMul: 0.00, tint: '#3b3d45', tint2: '#454750' },
  shoulder:  { id: 'shoulder',  label: 'gravel',       mu: 0.62, crr: 0.055, soft: 0.35, anchorHoldMul: 0.55, tint: '#6b6152', tint2: '#7a705e' },
  wetGrass:  { id: 'wetGrass',  label: 'wet grass',    mu: 0.34, crr: 0.090, soft: 0.70, anchorHoldMul: 1.00, tint: '#52683c', tint2: '#617a45' },
  mud:       { id: 'mud',       label: 'mud',          mu: 0.22, crr: 0.300, soft: 1.00, anchorHoldMul: 0.35, tint: '#41352a', tint2: '#4d3f30' },
  /* Milestone 5. A ford or a flooded hollow: better grip than mud and far more drag, because water
   * does not hold a tyre the way clay does but it takes a great deal more to push a car through.
   * The two together make it a different problem rather than a worse one. */
  water:     { id: 'water',     label: 'standing water', mu: 0.30, crr: 0.420, soft: 0.85, anchorHoldMul: 0.25, tint: '#2c3f4a', tint2: '#35505e' },
  /* Loose rock on a quarry approach. Grips reasonably and drags like gravel, but the site it
   * belongs to has no trees on it, which is where the difficulty actually lives. */
  scree:     { id: 'scree',     label: 'loose rock',   mu: 0.52, crr: 0.130, soft: 0.45, anchorHoldMul: 0.30, tint: '#5a5650', tint2: '#69645c' },
});

/* Trees. Solid, and the only anchors a snatch block can be mounted to in Milestone 1.
 * `anchorStrengthN` is unused this milestone — GDD §4 defers "small/weak anchors can fail"
 * to a later build — but it is authored now so the later change is a threshold, not a
 * schema migration. Positions are jittered per attempt by createTerrain(). */
const TREE_PLAN = [
  // north cut bank: high ground, so a pull through one of these lifts as well as drags
  { id: 'tree_n1', x: 22.0, y: 1.6, r: 0.62, canopy: 3.4, anchorStrengthN: 60000 },
  { id: 'tree_n2', x: 63.0, y: 1.2, r: 0.55, canopy: 3.0, anchorStrengthN: 52000 },
  // the useful one: east of where the sedan lies, at the foot of the slope. Routing
  // through it turns a hopeless up-slope pull into a sideways one along the contour.
  { id: 'tree_e1', x: 62.5, y: 24.0, r: 0.70, canopy: 4.1, anchorStrengthN: 74000 },
  { id: 'tree_s1', x: 30.0, y: 31.5, r: 0.58, canopy: 3.2, anchorStrengthN: 56000 },
  { id: 'tree_s2', x: 74.0, y: 33.0, r: 0.66, canopy: 3.7, anchorStrengthN: 64000 },
];

/* The weak guardrail, as posts joined by rail segments. It runs along the south shoulder
 * with a GAP: the gap is the story of how the sedan got down there, and it is also the
 * clear lane a recovery can be pulled back through. Pull the sedan up anywhere else and
 * the rail is in the way — bendable, at a price. */
const RAIL_Y = 15.85;   // 1.25 m south of the pavement edge, on the shoulder
const RAIL = Object.freeze({
  y: RAIL_Y,
  x0: 18.0, x1: 74.0,
  // The gap is 15 m because a car that leaves the road at speed takes out a run of rail, and
  // because the gap has to be wide enough to bring the car back through at an angle: a sedan
  // crossing the rail line on a 55-degree pull has a ~4.8 m footprint, and it does not cross at
  // the point it left. Measured against the m1 Ha recovery, which needs ~5 m of clear rail
  // either side of the crossing. Narrow the gap and the only way back up is through the rail.
  gapX0: 34.5, gapX1: 49.5,   // jittered per attempt
  postSpacingM: 3.5,
  heightM: 0.62,              // how tall it stands, for the renderer
});

/** Where things start. Jittered per attempt by createTerrain(). */
const ANCHOR_PLAN = Object.freeze({
  truck:    { x: 57.0, y: 9.4, angle: Math.PI },   // on the pavement, facing west
  sedan:    { x: 42.0, y: 22.4, angle: 1.35 },     // mid-embankment, nose down the slope
  player:   { x: 55.0, y: 12.4 },                  // stepping out of the cab
  gearPile: { x: 61.5, y: 15.3 },                  // staged on the shoulder behind the truck
});

/* ── the height field ─────────────────────────────────────────────────────── */

/** Base height, before per-attempt features. Depends on y alone plus a road crown.
 *  Kept separate from createTerrain so tests can assert the profile on its own. */
/**
 * @param {number} dropMul  how deep this site's embankment is, relative to the bend's 4.15 m.
 *   Milestone 5 gave the county four sites and this is the only thing that varies about the
 *   PROFILE — which is enough, because the drop scales the downslope force directly. Defaults to 1,
 *   so every existing caller and every Milestone 1 assertion measures exactly what it always did.
 */
export function baseHeightAt(x, y, dropMul = 1) {
  const B = BANDS;

  // North cut bank: rises away from the road. Not decoration — it is why the north side
  // of the road is a wall rather than a second place to fall off.
  if (y < B.bankTop) {
    return 0.10 + 1.30 * smoothstep((B.bankTop - y) / B.bankTop);
  }

  // Shoulder and pavement: flat, with a 5 cm crown so water would run off. The crown is
  // a ~830 N sideways nudge on a parked truck against ~63 kN of grip: flavour, not force.
  if (y < B.roadS) {
    const t = (y - B.bankTop) / (B.roadS - B.bankTop);
    return 0.05 * Math.sin(Math.PI * clamp01(t));
  }

  // South shoulder: begins to fall away. Common to both profiles — the yard sits at the bottom
  // of this same 42 cm, which is why a truck can drive off the road onto it without a lip.
  const shoulder = -0.42 * smoothstep(clamp01((y - B.roadS) / (B.shoulderS - B.roadS)));
  if (y < B.shoulderS) return shoulder;

  // The embankment. Peak gradient is 1.5x the average by the shape of smoothstep:
  // 4.15 m over 11.4 m averages 0.364, so the steepest part is ~0.546 -> 28.6 degrees.
  const bank = y < B.embankmentS
    ? -0.42 - 4.15 * dropMul * smoothstep((y - B.shoulderS) / (B.embankmentS - B.shoulderS))
    // The bottom: still falling, gently, so water (and vehicles) collect at the low point.
    : -0.42 - 4.15 * dropMul - 0.34 * smoothstep((y - B.embankmentS) / 7.0);

  /* East of the site that whole drop is graded away into the yard apron, blended over 20 m so the
   * ground is continuous everywhere and a vehicle driven along it behaves the way it looks. At the
   * site `t` is exactly 0 and this returns the Milestone 1 profile bit for bit. */
  const t = yardFrac(x);
  return t === 0 ? bank : bank + (shoulder - bank) * t;
}

/**
 * Build the scene for one attempt.
 *
 * Everything seeded here answers the GDD completion criterion "repeating the scenario
 * does not feel exactly identical": the mud moves, the trees shift, the guardrail gap
 * changes width, and the sedan lies at a different angle. What does NOT change is the
 * shape of the problem — the road is still up, the ditch is still down, and every
 * approach that worked last time still works. Variation, not randomised difficulty.
 *
 * @param {import('../core/rng.js').Rng} rng  the world stream
 */
/**
 *  {object} site  one of SITES. Defaults to the bend, which is the Milestone 1 scene laid out
 *   to the last decimal — so every prior assertion still measures exactly what it measured.
 */
export function createTerrain(rng, site = SITES[0]) {
  /* The hazard at the bottom. One bowl, four meanings.
   *
   * The same machinery — a smooth bowl with zero gradient at its rim — carries mud at the bend,
   * standing water at the ford and loose rock at the quarry, and is simply absent at the bridge.
   * Reusing it rather than writing three hazards is not laziness: the bowl is what makes the low
   * point a TRAP rather than a stain, and that property is what all three have in common. */
  const hazardSurface = site.hazard === 'none' ? null : SURFACES[site.hazard];
  const mud = {
    surface: hazardSurface,
    kind: site.hazard,
    x: 38.0 + rng.spread(6.0),
    y: 29.8 + rng.spread(1.6),
    rx: 6.6 + rng.range(0, 2.2),
    ry: 3.3 + rng.range(0, 1.1),
    // Deep enough for its own bowl to SHADE. At 0.42 m over a 7 m radius the gradient is 0.12
    // and the hillshade could not see it, so the mud painted as a flat brown stain rather than a
    // hollow. It is also a better trap at this depth, which is what it is for.
    depth: hazardSurface ? (0.80 + rng.range(0, 0.30)) * (site.hazard === 'water' ? 1.25 : 1) : 0,
  };

  /* Trees, and how many of them there are is a DESIGN decision per site rather than decoration.
   * A snatch block needs something to hang on, so a site with no trees has no side pull — the
   * quarry's whole difficulty is that the answer has to come from parking and rigging alone.
   * The useful one (tree_e1, at the foot of the slope east of the car) is kept wherever a site has
   * any at all, because taking it away as well would make the ford unwinnable rather than harder. */
  const treeCount = { all: 5, two: 2, one: 1, none: 0 }[site.trees] ?? 5;
  const treeOrder = ['tree_e1', 'tree_n1', 'tree_s1', 'tree_n2', 'tree_s2'];
  const keep = new Set(treeOrder.slice(0, treeCount));
  const trees = TREE_PLAN.filter((t) => keep.has(t.id)).map((t) => ({
    ...t,
    x: t.x + rng.spread(1.7),
    y: t.y + rng.spread(1.0),
    /* Per-attempt anchor state (Milestone 6). It lives on the instance and not on TREE_PLAN for
     * the same reason zone damage lives on the vehicle: the plan is shared frozen data, and one
     * attempt's uprooted tree must not follow the player into the next. */
    pullNs: 0,
    fallen: false,
  }));

  // Where the sedan came to rest. Drawn BEFORE the guardrail, because the gap in the rail has
  // to be centred on where the car went through it — see below.
  const sedanX = ANCHOR_PLAN.sedan.x + rng.spread(2.4);
  const sedanY = ANCHOR_PLAN.sedan.y + (site.casualtyDy || 0) + rng.spread(1.1);
  const sedanA = ANCHOR_PLAN.sedan.angle + rng.spread(0.30);

  // The gap is centred on the sedan, not on a fixed x. This started as a fixed span and it was
  // wrong twice over: it made no sense (the car made this hole, so it is where the car is), and
  // it broke the recovery — with the sedan 1.8 m east of centre, the natural pull line crossed
  // the rail 10 cm outside the gap, and a 0.4 m/s brush with a post ended the job. Anchor the
  // hole to the story and the geometry follows.
  const gapW = ((RAIL.gapX1 - RAIL.gapX0) + rng.spread(1.4)) * (site.gapMul || 1);
  const gapC = sedanX + rng.spread(1.2);
  const rail = { ...RAIL, gapX0: gapC - gapW / 2, gapX1: gapC + gapW / 2 };

  // Posts, skipping the gap. Each carries its own damage state, so bending one section of
  // rail does not quietly bend the rest of it.
  const railPosts = [];
  for (let x = rail.x0; x <= rail.x1 + 1e-6; x += rail.postSpacingM) {
    if (x > rail.gapX0 - 0.1 && x < rail.gapX1 + 0.1) continue;
    railPosts.push({ x, y: rail.y, bend: 0, broken: false });
  }
  // Rail segments join consecutive surviving posts that are actually adjacent.
  const railSegments = [];
  for (let i = 0; i < railPosts.length - 1; i++) {
    const a = railPosts[i], b = railPosts[i + 1];
    if (b.x - a.x > rail.postSpacingM * 1.6) continue;   // that is the gap; leave it open
    railSegments.push({ id: `rail_${i}`, ax: a.x, ay: a.y, bx: b.x, by: b.y, bend: 0, broken: false });
  }

  /* Boulders. Solid, immovable, and NOT anchors — a snatch block needs something to wrap a strap
   * round and a rock the size of a suitcase is not it. They exist to make the quarry approach and
   * the bridge abutment obstacle courses rather than open ground, and they are drawn from the same
   * rng as everything else so a site is reproducible from its seed.
   *
   * Kept off the pavement deliberately. A rock in the road would be a different game. */
  const boulders = [];
  for (let i = 0; i < (site.boulders || 0); i++) {
    boulders.push({
      id: `rock_${i}`,
      x: 20 + rng.range(0, 60),
      y: BANDS.shoulderS + 1.5 + rng.range(0, 9),
      r: 0.55 + rng.range(0, 0.65),
      angle: rng.range(0, Math.PI),
    });
  }

  const anchors = {
    truck: {
      x: ANCHOR_PLAN.truck.x + rng.spread(2.2),
      y: ANCHOR_PLAN.truck.y + rng.spread(0.5),
      angle: ANCHOR_PLAN.truck.angle + rng.spread(0.04),
    },
    // The sedan's lie is the single biggest source of attempt-to-attempt variety: at 1.1
    // rad it is nose-down and a straight pull works; at 1.7 it is across the slope and
    // wants rotating first. Drawn above, before the guardrail gap that it made.
    sedan: { x: sedanX, y: sedanY, angle: sedanA },
    player: { ...ANCHOR_PLAN.player },
    gearPile: { x: ANCHOR_PLAN.gearPile.x + rng.spread(1.0), y: ANCHOR_PLAN.gearPile.y },
  };
  anchors.player.x = anchors.truck.x - 2.4;

  /** Depth of the mud bowl at (x,y): 0 outside, `depth` at the centre. */
  function mudDepthAt(x, y) {
    const dx = (x - mud.x) / mud.rx, dy = (y - mud.y) / mud.ry;
    const d2 = dx * dx + dy * dy;
    if (d2 >= 1) return 0;
    return mud.depth * (1 - d2);       // smooth bowl, zero gradient at the rim
  }

  /** Height in metres above the road surface. THE function this file exists for. */
  function heightAt(x, y) {
    return baseHeightAt(x, y, site.dropMul) - mudDepthAt(x, y);
  }

  /**
   * Slope at a point, by central difference — 5 cm apart, which is fine because the field
   * is smooth everywhere (smoothstep is C1 and the mud bowl is C1 at its rim).
   *
   * `normalFrac` is cos of the slope angle: the fraction of a body's weight that presses
   * into the ground rather than pulling it downhill. Grip scales by it, so a steep slope
   * takes traction away at exactly the rate it adds pull.
   */
  function slopeAt(x, y) {
    const e = 0.05;
    const gx = (heightAt(x + e, y) - heightAt(x - e, y)) / (2 * e);
    const gy = (heightAt(x, y + e) - heightAt(x, y - e)) / (2 * e);
    const mag = Math.hypot(gx, gy);
    return { gx, gy, mag, normalFrac: 1 / Math.sqrt(1 + mag * mag) };
  }

  /** The surface a y-band implies, ignoring the mud. The renderer needs this to fade the mud
   *  into the grass at its rim instead of stamping a hard-edged ellipse on the hillside. */
  function bandSurfaceAt(x, y) {
    const B = BANDS;
    if (y >= B.roadN && y <= B.roadS) return SURFACES.pavement;
    if (y >= B.bankTop && y < B.roadN) return SURFACES.shoulder;
    if (y > B.roadS && y <= B.shoulderS) return SURFACES.shoulder;
    // East end: the apron is paved, and the 20 m of graded ground leading to it is gravel. Both
    // reuse surfaces that already exist rather than adding a fourth set of grip numbers to tune.
    if (y > B.roadS && y <= YARD.y1) {
      if (x >= YARD.x0) return SURFACES.pavement;
      if (x > YARD.blendX0) return SURFACES.shoulder;
    }
    return SURFACES.wetGrass;
  }

  /** On the yard apron. */
  const inYard = (x, y) => x >= YARD.x0 && x <= YARD.x1 && y > BANDS.roadS && y <= YARD.y1;

  /** In the marked bay — the one place the job can end. */
  const inBay = (x, y) =>
    x >= YARD.bay.x0 && x <= YARD.bay.x1 && y >= YARD.bay.y0 && y <= YARD.bay.y1;

  /** Which surface is underfoot. THE authority — physics and success detection both ask this.
   *  Mud wins wherever the bowl is deeper than a token 4 cm, so the mud's painted edge and its
   *  behaviour are within a few centimetres of each other. */
  function surfaceAt(x, y) {
    if (hazardSurface && mudDepthAt(x, y) > MUD_EDGE_M) return hazardSurface;
    return bandSurfaceAt(x, y);
  }

  /**
   * How deep the standing water is here, in metres, or 0 anywhere that is not a ford.
   *
   * The hazard bowl is the same shape whatever is in it — the bend has mud in it and the ford has
   * water — so this is `mudDepthAt` asked a different question, and it returns 0 at every site
   * whose hazard is not water. Read by the tire model for buoyancy (Milestone 6) and by the crew's
   * legs; nothing caches it.
   */
  function waterDepthAt(x, y) {
    if (!hazardSurface || hazardSurface.id !== 'water') return 0;
    return mudDepthAt(x, y);
  }

  /** Is a point on the road? Used by success detection and by the HUD. */
  function onRoad(x, y) {
    return y >= ROAD.y0 && y <= ROAD.y1 && x >= ROAD.x0 && x <= ROAD.x1;
  }

  /** Keep bodies inside the site. The scene has no fence, so this is the last resort that
   *  stops a snapped-cable launch from putting the sedan somewhere unreachable. */
  function clampToWorld(x, y, r = 0) {
    const cx = clamp(x, r, WORLD.widthM - r);
    const cy = clamp(y, r, WORLD.heightM - r);
    // WHICH axis was clamped, not just whether one was. The caller has to kill the velocity
    // component that hit the fence and leave the other one alone — see stepVehicle.
    return { x: cx, y: cy, clamped: cx !== x || cy !== y, clampedX: cx !== x, clampedY: cy !== y };
  }

  return {
    world: WORLD, bands: BANDS, road: ROAD, surfaces: SURFACES, site,
    boulders,
    /* Weather, as the single number it is allowed to be. Written by buildScene from the job's
     * forecast and read by the tire model; 1 is a dry day, which is what every prior milestone
     * measured and still measures. */
    gripMul: 1,
    weather: null,
    mud, trees, rail, railPosts, railSegments, anchors,
    yard: YARD,
    heightAt, slopeAt, surfaceAt, bandSurfaceAt, mudDepthAt, waterDepthAt, onRoad, clampToWorld,
    inYard, inBay,
    /** Steepest gradient anywhere on the embankment, for the debug overlay and tests. */
    describe() {
      let worst = 0, worstY = 0;
      for (let y = BANDS.roadS; y < BANDS.embankmentS + 2; y += 0.1) {
        const s = slopeAt(WORLD.widthM * 0.25, y);
        if (s.mag > worst) { worst = s.mag; worstY = y; }
      }
      return {
        maxGradient: Math.round(worst * 1000) / 1000,
        maxAngleDeg: Math.round(Math.atan(worst) * 180 / Math.PI * 10) / 10,
        atY: Math.round(worstY * 10) / 10,
        dropM: Math.round((heightAt(46, 2) - heightAt(46, 34)) * 100) / 100,
      };
    },
  };
}
