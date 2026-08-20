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

/** Mud depth at which the ground counts as mud. The renderer fades its colour in over the next
 *  few centimetres above this, so the painted edge and the behavioural edge stay together. */
export const MUD_EDGE_M = 0.04;
export const MUD_FADE_M = 0.11;

/** Surface properties. `mu` is the peak friction coefficient the tire model clamps to;
 *  `crr` is rolling resistance. The two are independent on purpose: mud has poor grip AND
 *  huge drag, wet grass has poor grip and modest drag, and the difference between those
 *  two facts is a real recovery decision.
 *
 *  `tint`/`tint2` live here rather than in the renderer so that a patch of ground can
 *  never be drawn as grass while behaving like pavement. */
export const SURFACES = Object.freeze({
  pavement:  { id: 'pavement',  label: 'pavement',     mu: 0.95, crr: 0.014, soft: 0.00, tint: '#3b3d45', tint2: '#454750' },
  shoulder:  { id: 'shoulder',  label: 'gravel',       mu: 0.62, crr: 0.055, soft: 0.35, tint: '#6b6152', tint2: '#7a705e' },
  wetGrass:  { id: 'wetGrass',  label: 'wet grass',    mu: 0.34, crr: 0.090, soft: 0.70, tint: '#52683c', tint2: '#617a45' },
  mud:       { id: 'mud',       label: 'mud',          mu: 0.22, crr: 0.300, soft: 1.00, tint: '#41352a', tint2: '#4d3f30' },
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
export function baseHeightAt(x, y) {
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
    ? -0.42 - 4.15 * smoothstep((y - B.shoulderS) / (B.embankmentS - B.shoulderS))
    // The bottom: still falling, gently, so water (and vehicles) collect at the low point.
    : -4.57 - 0.34 * smoothstep((y - B.embankmentS) / 7.0);

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
export function createTerrain(rng) {
  // The muddy low point. A bowl, so it both grabs and holds: reduced grip, heavy drag,
  // and a gradient that points inward from every side.
  const mud = {
    x: 38.0 + rng.spread(6.0),
    y: 29.8 + rng.spread(1.6),
    rx: 6.6 + rng.range(0, 2.2),
    ry: 3.3 + rng.range(0, 1.1),
    // Deep enough for its own bowl to SHADE. At 0.42 m over a 7 m radius the gradient is 0.12
    // and the hillshade could not see it, so the mud painted as a flat brown stain rather than a
    // hollow. It is also a better trap at this depth, which is what it is for.
    depth: 0.80 + rng.range(0, 0.30),
  };

  const trees = TREE_PLAN.map((t) => ({
    ...t,
    x: t.x + rng.spread(1.7),
    y: t.y + rng.spread(1.0),
  }));

  // Where the sedan came to rest. Drawn BEFORE the guardrail, because the gap in the rail has
  // to be centred on where the car went through it — see below.
  const sedanX = ANCHOR_PLAN.sedan.x + rng.spread(2.4);
  const sedanY = ANCHOR_PLAN.sedan.y + rng.spread(1.1);
  const sedanA = ANCHOR_PLAN.sedan.angle + rng.spread(0.30);

  // The gap is centred on the sedan, not on a fixed x. This started as a fixed span and it was
  // wrong twice over: it made no sense (the car made this hole, so it is where the car is), and
  // it broke the recovery — with the sedan 1.8 m east of centre, the natural pull line crossed
  // the rail 10 cm outside the gap, and a 0.4 m/s brush with a post ended the job. Anchor the
  // hole to the story and the geometry follows.
  const gapW = (RAIL.gapX1 - RAIL.gapX0) + rng.spread(1.4);
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
    return baseHeightAt(x, y) - mudDepthAt(x, y);
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
    if (mudDepthAt(x, y) > MUD_EDGE_M) return SURFACES.mud;
    return bandSurfaceAt(x, y);
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
    world: WORLD, bands: BANDS, road: ROAD, surfaces: SURFACES,
    mud, trees, rail, railPosts, railSegments, anchors,
    yard: YARD,
    heightAt, slopeAt, surfaceAt, bandSurfaceAt, mudDepthAt, onRoad, clampToWorld, inYard, inBay,
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
