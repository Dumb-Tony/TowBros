# Changelog

## Parking, and a graphics pass — 2026-08-19

### Where you park is a decision, not a gate

Measured on a 15-park grid instead of argued about. Before: one lane of three worked, and every
other park ran the line to 42 kN and parted it. After: the northern two thirds of the road all
recover the car, and **no park anywhere on the road costs you the cable**. A bad park stalls with
the line attached and the HUD red, and you drive forward or re-park.

The first diagnosis was wrong and the sweep said so. Widening the road (8.0 → 9.4 m, which is a
more honest rural two-lane anyway) helped but did not fix it, because the binding constraint was
never the road's width — it was that a winch will happily grind a car into an immovable object
until its own cable fails. Four model gaps, all found by instrumenting rather than guessing:

- **Winch overload relief.** A stalled drum stopped pulling but the geometry kept moving, walking
  tension from the 34 kN stall straight through the 42 kN break. The drum now gives line back to
  hold at the motor's limit, capped — so slow jams stall and genuine snatch loads still break.
- **Contact positional correction** was 80% with no slop, which teleports a body up to 2 cm in one
  step. A 520 kN/m cable reads a teleport as 10 kN of instant stretch, which outran any relief.
  Now 1 cm of slop resolved at 25%.
- **Cable damping** is clamped to 60% of the spring term, so a line parts because it is stretched
  too far rather than because of a velocity spike.
- **The guardrail** needed two separate failure tests. Per-step impulse only made a "weak
  guardrail" a 34 kN wall against a slow push; accumulating for both let a slow push snap it
  outright and the car ploughed through. A shunt breaks it, a lean folds it flat.
- **Yaw resistance is static-only** now, fading out above 0.4 m/s. Applied while moving it
  double-counts the per-wheel lateral forces and stops a dragged car swinging its nose toward the
  pull — worth 3x the line tension, and the reason a southern park looked impossible.

Section Hk keeps the sweep as an assertion so a retune cannot quietly put the gate back.

### Graphics

One light direction (`LIGHT`, north-west) now drives the terrain hillshade, vehicle bodies, tree
canopies, rail posts and the cable highlight, so the scene agrees with itself.

- Terrain baked at 20 px/m with two octaves of hash texture, asphalt grain on the pavement, and a
  specular sheen on wet mud. The mud bowl is 0.8 m deep so its own gradient can shade it — at
  0.42 m the hillshade could not see it and it painted as a flat brown stain.
- Contour lines as a light/heavy index pair. This took three attempts to balance: at 0.42 the set
  vanished and a 28° bank photographed as flat; at 0.68 for every line the same bank photographed
  as corduroy.
- Vehicles are lit with a gradient rotated into body space, plus wheel arches, treaded tires,
  glass with a specular streak, tail and head lights, and a two-beacon light bar on the wrecker.
- The guardrail is a W-beam on posts with cast shadows, and its damage state is visible: bent
  sections sag and darken, folded ones lie down, broken ones twist out of line.
- Trees are eleven small canopy lobes shaded by which way they face, not one green disc.
- A screen-space vignette, and a dark ring on the player so a 0.64 m figure is findable on a dark
  green hillside.

## Milestone 1 — One Vehicle, One Ditch, One Recovery — 2026-08-19

The GDD's first milestone, playable. 243 assertions passing.

### Delivered against GDD §4 "Completion criteria"

| Criterion | How it is met | Verified by |
|---|---|---|
| The sedan can reach the road without a predetermined interaction order | No sequence is checked anywhere; the objective is four corners on pavement and settled | `Ha1` |
| At least three meaningfully different approaches work | Four do: direct pull, brute-force-then-re-rig, snatch-block side pull, prepared recovery | `Hf1` |
| Truck position, surface, attachment and equipment change outcomes | Same rig on the road recovers the car; on the bank the truck slides 9 m instead | `He2`, `Hd2` |
| Tension visibly affects both vehicles | One tension applied equal-and-opposite at two offsets, both with torque | `E7`–`E9`, `Hi1`–`Hi2` |
| A poor plan can worsen the scene | Truck parked on wet grass loses the argument and ends up in the recovery zone | `He2`–`He4` |
| The player can continue after most mistakes | Every failure leaves the hook on the ground and the job open | `E13`, `F15`, `Hb4`–`Hb6` |
| Damage results from force and changes later behaviour | A wheel torn off at 14 kN ploughs afterwards: less climb, more line needed to finish | `F21`–`F23`, `Hh1`–`Hh5` |
| Clean, messy and catastrophic outcomes are all possible | Nothing broken; a torn bumper; a parted cable and a truck in the ditch | `Ha2`, `Hb1`, `He4` |
| Repeating the scenario does not feel identical | Mud, trees, rail gap, the car's lie, which wheels seized and how dug in it is all re-roll per attempt, from a seed | `Hg1`–`Hg3` |

### Bugs found by the suite, and what they taught

Each is documented at the site of the fix, with the measurement that caught it.

- **The cable was judged before the attachment.** `stepCable` checked its own 42 kN limit inside
  itself, so a single-step load spike parted the line while the 9 kN bumper it was hooked to
  survived. The weakest link has to go first or the GDD's attachment table is decoration. Split
  into `stepCableBreak`, called after `stepAttachment`.
- **Collision damage was measured in a unit nobody experienced.** Impulses were divided by the
  step to fake an "equivalent force" so one table could judge a cable tension and a crash. That
  turned a 1400 kg car brushing a guardrail post at 0.4 m/s into 34 kN, and the sedan shed its
  bumper on contact with anything. Contacts are now judged in newton-seconds.
- **Cable damping at 0.42 of critical** put ~20 kN into the line per m/s of closing speed, so any
  snatch load parted a 42 kN cable and the straightforward recovery was impossible. Measured: peak
  33 kN on a pull whose steady-state load was 11 kN. Now 0.16.
- **Rollover triggered on a single step** of lateral load, so a hard winch pull briefly worth 3 g
  at the tow eye flipped the car for no reason a player could see. Now requires 220 ms.
- **Static friction guarded translation but not yaw.** Four wheels each correcting their share of
  an external force sum to cancel it and contribute zero opposing torque, so a cable hooked 3 m
  behind the centre of a 6.8 t truck swung it 40° over half a minute on dry pavement, at 7 cm/s.
  Added `applyYawResistance`.
- **The paid-out line length was fiction while carrying the hook.** Walking it out faster than the
  drum paid cable left `lineM` far short of the real distance; hooking on then handed the spring
  metres of stretch it had not earned and parted the cable instantly. The line is a leash now.
- **The event log is a ring, and the recap was reading it**, so any recovery long enough to be
  worth recapping had already evicted the part where the player made their decisions. Added an
  append-only story log and a counter map that survives eviction.
- **The guardrail gap was at a fixed x**, which made no sense (the car made that hole) and broke
  the recovery: with the sedan 1.8 m off centre the natural pull line crossed the rail 10 cm
  outside the gap. The gap is centred on the car now.

### Two wrong measurements in the tests themselves, kept as notes

- Distance travelled is not progress. A sedan missing a wheel slews instead of tracking — 60° of
  yaw against 43° — so it covers *more* ground while climbing *less* of the bank. The assertion
  now measures climb.
- Gear effects measured after a pull read as zero, because by then the car has been dragged away
  from its own cribbing. Measured during the pull instead.

### Deliberately absent

Open world, economy, garage, procedural dispatch, ambient traffic, reputation, customisation,
broad content, matchmaking, weather, police, and production multiplayer — GDD §8. The
corresponding blocks in `src/config.js` are empty and labelled, rather than half-built.
