/* Starter gear. GDD §4: "Physical starter gear: strap, chain, hydraulic jack, two wheel
 * chocks, four cribbing blocks, and a snatch block." Data only.
 *
 * GDD pillar 7 is "boring equipment becomes exciting", and the way that is earned is by
 * every item having a real, small, mechanical effect that the player can name afterwards.
 * So each kind below declares:
 *
 *   use      what the context key does with it, as a verb the interaction system switches on
 *   target   what it needs to be near for that verb to mean anything
 *   effect   a one-line statement of the mechanical change, for the inspect card
 *
 * There is no inventory grid and no item count in the HUD — GDD §5: "The player carries
 * one physical object." Everything else is lying on the ground where it was left.
 */

/** Verbs the context key can perform. src/player/player.js switches on exactly these. */
export const USE = Object.freeze({
  PLACE:  'place',    // set it down in the world where it will do its job
  RIG:    'rig',      // wrap it round an attachment zone, then hook to it
  MOUNT:  'mount',    // secure it to an anchor (the snatch block on a tree)
  OPERATE: 'operate', // pump it (the jack)
});

export const GEAR = Object.freeze({
  strap: {
    kind: 'strap', label: 'recovery strap', use: USE.RIG, target: 'zone',
    massKg: 4, sizeM: { x: 0.9, y: 0.34 }, tint: '#c8552f',
    inspect: 'Nylon web sling. Stretches under load, which is the point.',
    effect: 'Raises what an attachment can take by 40%, and softens the shock arriving at it.',
  },
  chain: {
    kind: 'chain', label: 'tow chain', use: USE.RIG, target: 'zone',
    massKg: 11, sizeM: { x: 0.8, y: 0.30 }, tint: '#8f939c',
    inspect: 'Grade 70 transport chain with a grab hook. No stretch in it at all.',
    effect: 'Raises what an attachment can take by 75%, but passes every shock straight through.',
  },
  jack: {
    kind: 'jack', label: 'hydraulic jack', use: USE.OPERATE, target: 'vehicle',
    massKg: 14, sizeM: { x: 0.42, y: 0.32 }, tint: '#d8b23a',
    inspect: 'Bottle jack. Lifts a corner, if it has something solid to stand on.',
    effect: 'A lifted chassis stops ploughing: much less ground drag, and much less dug in.',
  },
  chock: {
    kind: 'chock', label: 'wheel chock', use: USE.PLACE, target: 'wheel',
    massKg: 3, sizeM: { x: 0.30, y: 0.42 }, tint: '#e0a33c',
    inspect: 'A wedge. Only resists in the direction it is pointing.',
    effect: 'Anchors a wheel against being dragged one way. Placed the wrong way round it does nothing.',
  },
  cribbing: {
    kind: 'cribbing', label: 'cribbing block', use: USE.PLACE, target: 'vehicle',
    massKg: 8, sizeM: { x: 0.55, y: 0.26 }, tint: '#9a7b4f',
    inspect: 'Hardwood block. Spreads load onto ground that will not take a point load.',
    effect: 'Under a vehicle: less drag, less dug in, and it resists the body pivoting away.',
  },
  snatchBlock: {
    kind: 'snatchBlock', label: 'snatch block', use: USE.MOUNT, target: 'anchor',
    massKg: 9, sizeM: { x: 0.36, y: 0.36 }, tint: '#5f7fa8',
    inspect: 'A pulley in a hinged shackle. Turns a line without chewing it.',
    effect: 'Redirects the pull through wherever you mounted it, and multiplies it. Costs line speed.',
  },
});

/** The pile as staged beside the truck, in the order the player will meet it.
 *  Two chocks and four cribbing blocks, exactly as the GDD lists. */
export const STARTER_PILE = Object.freeze([
  'strap', 'chain', 'jack', 'chock', 'chock',
  'cribbing', 'cribbing', 'cribbing', 'cribbing', 'snatchBlock',
]);

/**
 * Lay the pile out on the ground beside the truck. A physical pile, not a menu — GDD §5:
 * "Equipment is picked up from the truck-side staging area and placed in the world."
 *
 * @param {{x:number,y:number}} at        the staging anchor
 * @param {import('../core/rng.js').Rng} rng
 */
/**
 * @param {string[]|null} loadout  what is actually in the truck. Milestone 4 gave the player a
 *   company with an equipment cupboard, so the pile on the ground is what they OWN rather than a
 *   fixed list — run out of straps and you rig it bare. Null means the starter pile, which is what
 *   every test and every single-job session gets.
 */
export function createGearPile(at, rng, loadout = null) {
  const items = [];
  const pile = loadout && loadout.length ? loadout : STARTER_PILE;
  pile.forEach((kind, i) => {
    // Two rough rows, jittered, so the pile looks dumped rather than shelved.
    const col = i % 5, row = Math.floor(i / 5);
    items.push({
      id: `gear_${i}_${kind}`,
      kind,
      x: at.x - col * 0.85 + rng.spread(0.14),
      y: at.y + row * 0.78 + rng.spread(0.12),
      angle: rng.range(0, Math.PI * 2),
      carriedBy: null,        // crew id while carried — see src/crew/authority.js
      placed: false,          // set down somewhere it does work
      attachedTo: null,       // vehicle id (cribbing/jack) or anchor id (snatch block)
      liftStep: 0,            // jack only
      pumpMs: 0,              // jack only
      usedAsRig: false,       // strap/chain consumed into a rigging
    });
  });
  return items;
}

export const gearDef = (kind) => GEAR[kind] || null;
