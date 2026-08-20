/* Weather. GDD §7 Milestone 5: "traffic/work zones, weather modifiers".
 *
 * ── WHAT WEATHER IS ALLOWED TO BE ────────────────────────────────────────────────────
 * A grip multiplier and a light level. That is all, and it is enough.
 *
 * The temptation with weather is a particle system and a shader; the reason to resist it is that
 * neither changes a single decision the player makes. What changes decisions is the ground being
 * worse — a job in the rain is the same job with 20% less grip everywhere, which moves the parking
 * spot that works, the rig that holds, and whether the truck stays where you left it. That is one
 * number, it reaches the tire model, and the m5 suite measures it arriving.
 *
 * Night is the other one, and it is the same idea from the other side: it does not change any
 * force at all. It changes what you can SEE, which changes how confidently you can place a truck.
 * The renderer darkens and vignettes; the physics never knows.
 *
 * ── AND WHY IT IS NOT RANDOM AT RUN TIME ─────────────────────────────────────────────
 * A dispatch offer carries its weather. You can see it on the board before you take the job, and
 * a wet night pays more for exactly the reason it is worth more. Weather that rolled when the scene
 * loaded would be a difficulty dice roll after the decision, which is a different and worse thing.
 */

export const WEATHER = Object.freeze({
  dry:   { id: 'dry',   label: 'dry',            gripMul: 1.00, light: 1.00, feeMul: 1.00, blurb: '' },
  damp:  { id: 'damp',  label: 'damp',           gripMul: 0.92, light: 0.94, feeMul: 1.05,
           blurb: 'Been raining on and off.' },
  wet:   { id: 'wet',   label: 'wet',            gripMul: 0.80, light: 0.86, feeMul: 1.15,
           blurb: 'Steady rain. Everything is greasy.' },
  night: { id: 'night', label: 'after dark',     gripMul: 0.94, light: 0.42, feeMul: 1.20,
           blurb: 'Dark, and the only light is what you brought.' },
  fog:   { id: 'fog',   label: 'fog',            gripMul: 0.90, light: 0.70, feeMul: 1.18,
           blurb: 'You can hear the road more than you can see it.' },
});

export const WEATHER_IDS = Object.freeze(Object.keys(WEATHER));

export const weatherById = (id) => WEATHER[id] || WEATHER.dry;

/**
 * Pick weather for a job. Seeded, so a board shows the same forecast until a job is taken.
 *
 * Weighted toward dry, because bad weather is only interesting if it is not the default — a county
 * where it always rains is a county with one grip number, which is where this started.
 */
export function rollWeather(rnd) {
  const r = rnd();
  if (r < 0.42) return WEATHER.dry;
  if (r < 0.64) return WEATHER.damp;
  if (r < 0.80) return WEATHER.wet;
  if (r < 0.92) return WEATHER.night;
  return WEATHER.fog;
}
