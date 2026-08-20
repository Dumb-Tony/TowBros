# Changelog

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
