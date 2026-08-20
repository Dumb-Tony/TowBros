# Changelog

## The wire — 2026-08-20

Milestone 2's last piece, and the decision behind it made out loud.

**Lockstep, because the simulation was already deterministic.** M1's suite replays a whole recovery
bit-for-bit from a seed; M2's does it with a crew. When that is true the cheapest correct network is
the one that sends nothing but intent — every peer runs the same steps from the same seed with the
same commands and arrives at the same world. No authority, no reconciliation, no snapshots. The
price is that nobody may step until every seat's commands for that step have arrived, and it is paid
with four steps (67 ms) of input delay rather than with prediction. `LoopbackTransport.delaySteps`
had modelled exactly that since the seam was built, so the delay path was tested before the wire.

**No server, because that was the constraint.** The standing rule is zero external requests, and the
usual answer to browser multiplayer — PeerJS, a socket relay, a lobby — is somebody else's computer.
So there are two transports and neither has one:

- **BroadcastChannel** between two tabs of one browser. Zero network, and a real transport rather
  than a mock: the session cannot tell it from a wire, which is what makes co-op testable alone.
- **WebRTC with the handshake passed by the players.** `iceServers: []`, so only host candidates are
  gathered and the pair must share a network. One copies about a thousand characters of base64 and
  sends it however they already talk. Verified live in a browser: 1036-character offer, channel
  open, command frame across intact, nothing fetched from anywhere.

Crossing a NAT needs STUN, which is an external request. It is available as an explicit argument
rather than a default, because spending the project's one hard rule should be a decision somebody
makes on purpose.

**The proof.** `tools/m2-tests.js` §R runs two complete simulations in one headless page, wired
together by a real BroadcastChannel, each driving its own seat from its own keyboard. Every step
either side runs is recorded against its step number, and every step both machines ran is compared:

| | |
|---|---|
| steps compared | **286** |
| of which under a loaded cable | 220 |
| network outages survived | 1 |
| disagreements | **0** |

### Three bugs, and the last one matters

**The wire was write-only.** `NetSession` owns the peer's single `onMessage` hook, so I built the
scheduler with `peer = null` to stop two objects fighting over it — and removed its ability to
transmit at the same time. Both ends ran their four steps of input delay and then deadlocked
forever. The scheduler now takes a send-only `transmit` function, which makes the ownership
unambiguous instead of implicit.

**Comparing two peers at one instant is the wrong test.** Input delay means either end may be up to
`stepDelay` steps ahead, and after any asymmetry they settle at exactly that offset and stay there —
leapfrogging along in perfect agreement while a naive comparison screams desync. They are not out of
sync; one has already computed what the other is about to. The suite now records each world against
its STEP NUMBER and compares step N to step N, which is the actual claim determinism makes.

**⚠ Lockstep deadlocks if both ends stall at once.** This one is real and it was not obvious.
Frames are produced by *stepping*, because sampling happens inside the step — so a peer whose gate
is closed transmits nothing. Measured: a one-sided outage of eight steps left the host needing the
guest's frame for step N and the guest needing the host's for step N+4. **Both had already sampled
the frame the other needed.** Neither could deliver it, because delivering required stepping and
stepping required delivery.

The fix is not to produce new frames — a stalled peer has none — but to re-send the ones it has. The
moment the gate closes, the whole 24-frame redundancy window goes out again. It costs nothing in the
normal case, because in the normal case the gate never closes.

Related, and found the same way: **delay a frame by AGE, not by queue depth**. "Hold it back until
more than N are waiting" reads correctly and never drains — the queue keeps N frames forever, so the
last N commands of a session are never delivered at all.

### Numbers

| | |
|---|---|
| M1 suite | **264 / 264** |
| M2 suite | **219 / 219** |
| input delay | 4 steps · 67 ms |
| wire | 4 bytes per seat per step, plus a 24-frame redundancy window |
| survivable outage | ~400 ms; longer stops the game rather than desyncing it |


## Milestone 2 — a crew, not a player — 2026-08-20

Two to four people on one site, and exactly one winch hook between them. The whole milestone is
that sentence: the interesting problems in co-op are not about drawing a second person, they are
about what happens when both of them reach for the same object in the same simulation step.

**Ownership lives on the object.** `winch.heldBy`, `item.carriedBy`, `vehicle.occupiedBy` — and
nowhere else. `src/crew/authority.js` is a set of guarded transitions on those three fields and
nothing more. The obvious design is a parallel `owners` map, and it is the wrong one for the same
reason `recovery/gear.js` recomputes its multipliers every step instead of caching them: two
records of one fact will eventually disagree, and the disagreement is invisible until something
reads the stale half. There is nowhere else to look here, so there is nothing to desync.

`validateAuthority()` runs in the F3 overlay every frame, not just in the tests. An authority bug
is far easier to see live than to reconstruct from a trace afterwards — the lesson from Airport
Baggage Crew's `validateChain`.

**One drum, several hands.** GDD §5 makes the winch reachable by anyone at any time, so two people
can fight over it. When they do — one reeling in, one paying out, in the same step — the drum stops
and the HUD says `TWO HANDS ON THE DRUM`. It does not pick a winner. Silently resolving that in
somebody's favour is worse than a stopped winch, because you cannot see it happen.

**The casualty has a seat.** Its front wheels now steer, which they did not before. Measured on the
standard far-lane pull over 20 s:

| | travelled | climbed | yaw |
|---|---|---|---|
| nobody at the wheel | 5.41 m | 3.91 m | −131° |
| full right lock held | 7.55 m | 3.29 m | −137° |

You trade climb for lateral travel. There is no engine in it — flooring the throttle moves the car
2.77 m in two seconds, and so does not touching it, because all of that is gravity.

**Getting knocked down drops what you are holding.** A moving vehicle puts you on the ground for
0.4–2.4 s scaled by how fast it hit you; a parked one you just bump into. The mechanically
load-bearing half is the dropping: a crew member flattened while carrying the hook releases the
claim, so the hook is never stranded on somebody who is face-down. Done on the way *down*, not on
the way up.

**Everything goes through a command seam.** GDD §6 asks for multiplayer authority above
"deterministic-ish simulation commands", so `src/net/commands.js` is that and nothing else: a
two-mask frame per seat per step (`held`, `pressed`), an adapter that is duck-typed to `Input` so
`stepCrew` cannot tell the difference, and a transport interface. Four bytes per seat per step.
Frames carry intent, never state — the simulation is seeded and fixed-step, so the same commands
give the same world everywhere, and sending positions would throw that away.

The local keyboards go through it too. A local seat that bypassed the command path would be the one
seat whose bugs nobody found until the first real session.

**No wire yet, deliberately.** The transport is the least interesting part of multiplayer and the
only part that cannot be playtested alone, so it is last. It is also a genuine conflict rather than
a gap: the standing rule for this project is zero external requests, and WebRTC needs a signalling
server to introduce two browsers. `LoopbackTransport` is a real implementation of the interface with
a settable delay, so latency is testable today with no server at all — six steps of delay delivers
the same commands and therefore the same result, asserted to 1e-9.

### Bugs found on the way, all of them by measuring

**A queue-depth delay never drains.** `LoopbackTransport` first held a frame back "until more than
N are waiting", which reads correctly and is quietly wrong: the queue then keeps N frames forever,
so the last N commands of a session are never delivered at all. Stamping each frame with the step
it is due on fixed it, and made the delay exact rather than approximate.

**Two sends per step halve the duty cycle.** The screenshot harness pushed its own winch frame and
`link.pump()` pushed the keyboard's, and the transport delivers at most one per step — so the drum
ran on 330 of 660 steps and 660 frames backed up unqueued. The fix was to hold a virtual button
instead, which is the real path. One send per seat per step is the rule.

**No input must not mean "everybody let go".** With the drum resolved from the crew's hands every
step, a headless harness that sets `winch.motor` directly had it zeroed the next step, and every
M1 pull measured 0 kN. `stepCrew` now leaves the drum and the drive controls alone when a seat has
no input source at all — which is also what a remote seat looks like between packets, and holding
the last command is what a held key means.

**`occupied` had to stop being writable.** It is derived from `occupiedBy` now, so the M1 suite's
`truck.occupied = true` threw. Worth it: two records of one fact, again.

**The door prompt hid a whole mechanic.** Standing at the casualty satisfies both "reach in for the
handbrake" (`E`) and "get in" (`V`), and the hint chain returned only the first. A prompt can now
name two keys, and does.

### Numbers

| | |
|---|---|
| M1 suite | **264 / 264** — every recovery number unchanged |
| M2 suite | **175 / 175** |
| far lane, winch only | 36 s @ 12 kN |
| mid-road | 42 s, winch then tow |
| near lane | 40–45 s |
| parks that cost you the cable | 0 of 9 |


## The mid-road pull, and a drum that knows when to stop — 2026-08-19

The mid-road recovery was taking 56–67 seconds against the far lane's 36, and most of that was a
juddering grind at the winch's stall limit. **It was not the stall force.** I dropped that too, as
asked, and measured it first: at 26 kN the centre pull got *slower* (59–67 s), because a weaker
motor grinds for longer.

What it actually was: the drum kept reeling after the car had come up against the truck's own
flank. There was nowhere left to pull it, so tension stick-slipped across the stall limit at 38 kN
while the last corner inched onto the pavement.

**The drum now stops when the load is against the truck**, and says so — `AGAINST THE TRUCK`, in
red, distinct from `STALLED` because they are different facts: one means nowhere left to go, the
other means the motor cannot win. An operator stops winching when the casualty is on the deck.

| | before | after |
|---|---|---|
| far lane, winch only | 36 s @ 38 kN | **36 s @ 12 kN** |
| mid-road | 56–67 s @ 38 kN, grinding | **42 s @ 13 kN**, winch then tow |
| near lane | ~130 s | **40–45 s** |

The stall force came down to 26 kN as well, and now means something: with the grind gone, a normal
recovery peaks at 12–17 kN, so 26 kN sits about 1.6× a working pull and the 42 kN cable about 2.6×.
The gauge's stall marker is computed from those two numbers now instead of being a hardcoded 81% in
the stylesheet, which would have silently lied the moment either was retuned.

**One coupling bug found on the way.** The overload relief rate was scaled by `over / motorMaxN` —
so dropping the stall force doubled the payout at the same real tension and quietly made the cable
almost impossible to part by towing. A brake band's slip depends on the force on it, not on what
the motor beside it is rated for; it divides by a fixed reference force now.

**What the interlock cost, recorded rather than asserted away.** Flooring the tow used to part a
42 kN cable, because the car was jammed when the tow started. With the car no longer jammed, full
throttle is simply the faster tow — 8.3 s against 13 s gentle, cable intact. That is honest, and it
does mean impatience is no longer punished *on that move*. A snatch still parts the line.

264 assertions. Two of my own claims were corrected against measurement again: "the northern two
thirds recover on the winch" became "the far lane does", and "flooring it parts the line" became
the note above.

## The near lane, and grass that looks like grass — 2026-08-19

### Every park on the road can now finish the job

Instrumented rather than guessed at, and the instrumentation killed the obvious answer: a winch
pulls its load **to the drum**, so from the last few metres of pavement the car can never finish
on the road by winching — measured over fourteen parks, every one ends against the truck's own
flank. No amount of widening or retuning changes that; it is what winching *is*.

So the last third finishes the way a real job would. The winch gets the car up the bank, and then:

- **The casualty's handbrake can be released from outside**, through the door, on the context key.
  It is not the occupiable-vehicle feature GDD §7 defers to Milestone 2 — nobody gets in and
  nobody steers. A rolling car tows clear in about half the time a braked one does (9.4 s vs
  15.6 s, measured). It also runs away downhill if you drop it in the wrong place, which is the
  half of the feature worth having: ~6 kN of downhill pull against ~1.2 kN of rolling resistance.
  Chock it first, or hold it on the line.
- **Fixed: the handbrake was inert.** The scene marked the rear wheels *seized* as well as
  handbrake-held, so they were locked twice and only one lock was the player's to undo. The comment
  there had claimed the distinction for three commits without the code making it.
- **The drum's brake now slips faster the harder it is pulled**, as a brake band does. A flat slip
  rate was enough to stop a slow jam destroying the line but not enough to *tow* on it — driving
  away built tension faster than 0.55 m/s of payout could shed, so any tow above a crawl parted the
  cable. Flooring it still does.

Section Hk now asserts all of it: 6/6 for the northern two thirds on the winch, 6/6 for the last
third by tow, 9/9 that no park costs you the cable. 258 assertions.

Two assertions of mine were wrong along the way and are recorded as such in the suite: towing was
*not* impossible with the brake on (a 6.8 t truck will drag a braked car if it insists), and a
rolling car does *not* tow at lower peak tension — it snatches as it takes up, so the peak is
slightly higher and the *time* is what halves.

### Looks

- **Grass tufts.** 26,000 deterministic blades over everything that is not pavement, which is what
  finally makes the bank read as a field rather than a shaded gradient. The first version drew a
  few dozen: a hand-rolled hash multiplied a 32-bit state without `Math.imul`, ran past 2^53, and
  lost its low bits before the next xor could use them. It uses `mulberry32` from `core/rng.js`
  now, which is what the reuse rule said to do in the first place.
- Worn wheel paths polished into the asphalt, and reeds instead of grass at the mud's edge.
- A world-edge fade, so the site recedes into the dark instead of stopping at a rectangle.

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
