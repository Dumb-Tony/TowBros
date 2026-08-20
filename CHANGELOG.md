# Changelog

## Milestone 6 — heavy and procedural recovery — 2026-08-20

**GDD §7:** *"Add heavy wreckers/rotators, multiple winches and outriggers, large vehicles, richer
anchors, water recovery, and procedural situation generation from vehicle + incident + terrain +
damage + conditions."*

All seven, and the question the whole milestone had to answer was whether a bigger job is a
**different** job or the same job with bigger numbers. A seven-tonne box truck that just needed a
longer pull would have been the second thing, and would not have been worth building.

### Three casualties, and the numbers you know stop being enough

| | mass | downslope pull | bogged in | one drum stalls at |
|---|---|---|---|---|
| sedan | 1.4 t | 6.6 kN | 4.0 kN | 26 kN |
| panel van | 2.6 t | 12.2 kN | 7.5 kN | 26 kN |
| box truck | 7.2 t | **33.8 kN** | 20.8 kN | 26 kN |

The light wrecker stops a van at 3/4 corners, stalling on half of every second. Against a box truck
it is itself dragged 14 m down the road. Nothing about it was nerfed — the casualty simply weighs
more, and every force that scales with mass scales.

### So there is a heavy wrecker, and it is a different machine

| | what it buys | what it costs |
|---|---|---|
| **15 t instead of 6.8** | it holds where the light one slides | 9.2 m of it, and it turns like it |
| **two drums** | two people, two lines, two fairleads 1.44 m apart | two lines to keep track of |
| **four outriggers** | 260 kN of static hold — measured: dragged 13.7 m on its tyres against a box truck, 0.52 m on its legs | **it cannot move at all**: 0.000 m in three seconds at full throttle |
| **a slewing boom** | the fairleads sweep a 2.4 m arc, so the pull direction is something you steer | two more keys |

The legs are the decision the milestone is built around. A light wrecker that is losing an argument
can back up and try a better angle. A heavy one on its legs has committed, and what it can still
change is where the line leaves the machine.

**And a box truck still needs two parks.** One pull brings it up the bank and leaves it at −70°
across the road; a second park 16 m east swings it round to 4/4. That is Milestone 1's geometry
lesson — *a winch pulls its load to the drum* — arriving again at a scale where it cannot be
ignored. 67 seconds of work, and every second of it a decision.

### Anchors can let go

`anchorStrengthN` has been authored on every tree since the first commit and read by nothing. A
snatch block folds the line back on itself, so the anchor holds the vector sum of both legs — up to
**twice** the line tension, and the sharper the redirect the more of it.

Judged in newton-seconds, like the guardrail and the wheel lift before it, for the reason this
codebase has now learned three times: a threshold on force fails on the first spike, and a snatch
load *is* a spike. A tree past its rating leans, holds, and then goes over — and takes the block,
the routing and the redirect with it.

**Driven ground anchors** are the portable answer, and they are worth exactly what the ground under
them is worth:

| | a driven anchor holds |
|---|---|
| wet grass | 22 kN |
| gravel | 12 kN |
| mud | 7.7 kN |
| loose rock | 6.6 kN |
| tarmac | **nothing at all** |

Measured through a live rig: on wet grass the line spikes to 15 kN and the anchor never gets near
coming out; the same anchor in mud reaches 40% of the way out of the ground; driven into tarmac it
is gone in 2.5 seconds. Nothing validates the placement — the ground decides.

The quarry still has no answer, because loose rock holds nothing either. That site's whole identity
is that the side pull does not exist there.

### Water is not a wetter kind of mud

The ford has had standing water since Milestone 5, with its own grip and a lot of drag. What was
missing is the thing that makes it a different problem: **it carries weight.** A partly submerged
vehicle presses on the ground with less than its own weight, so it has less grip — the same sedan
has **4.4 kN of grip on the bank and 1.5 kN standing in the brook**. It skates rather than digs,
and where it goes is decided by where the line points.

And the ford's casualty is now *in* the water rather than on the bank above it, because a ford whose
car never touches it is a blue puddle painted next to a recovery. The same pull that takes 39
seconds at the bend takes 52 at the ford. A crew member wades at less than half speed, so walking
the hook out is a slog.

### Procedural situations, from five independent axes

Vehicle × incident × terrain × damage × conditions, rolled from one seeded stream. The obvious
version of this is one difficulty dial smeared across every axis, so a hard job is a heavy vehicle
on the steepest site in the dark, badly damaged, dug in — and that produces a ramp rather than a set
of situations.

So the axes are **independent**. Over 200 rolls: 3 vehicles, 5 incidents, 4 sites, 3 arrival states,
5 forecasts, and the box-truck jobs are not all in bad weather or all at the same place. What is
bounded is plausibility (a seven-tonner does not go through a narrow bridge parapet) and reach:
reputation decides which vehicles are sent to you, and that is the only gate.

A generated job emits **the same offer shape** an authored one does and touches only the same six
modifier keys, so nothing downstream can tell which is which — and neither can the simulation, which
is what keeps GDD §4's "no scripted sequence and no mandatory tool" true. One slot on the board is
generated, not the whole board: the authored shapes are its spine.

### One sign bug, and one architecture change

**`winch.targetId` said 'van' while the slot was `vehicles.sedan`**, so the cable looked up a vehicle
that did not exist and every big-casualty pull produced exactly 0 N. `createVehicle` now takes the
vehicle's identity in the WORLD separately from its type: the casualty slot is `sedan` and what is
standing in it may be a box truck.

**And the drum is a list.** `st.winches` is one entry on a light wrecker and two on the heavy;
`st.winch` is a plain reference to the first of them, so five milestones of code that says
`st.winch` goes on meaning the primary drum and goes on working unchanged. Fifteen files, and 900
prior assertions passed on the first run afterwards.

**1055 assertions** across six suites — 265, 219, 160, 128, 128, 155.


## Milestone 5 — the county — 2026-08-20

Four places instead of one, weather that reaches the tyres, a carriageway with other people on it,
and a day that ends whether or not you took the work.

**GDD §7:** *"connect job scenes with a regional map or compact open county, dynamic dispatch,
traffic/work zones, weather modifiers, and rival-job persistence."*

### The county is four problems, not four skins

| | takes away | leaves you |
|---|---|---|
| **the bend on Cold Ash Hill** | nothing — the Milestone 1 site, untouched to the last decimal | five trees, mud at the bottom |
| **the ford at Marle Brook** | four of the five trees | the shallowest bank and the widest gap in the rail |
| **the quarry approach** | every tree in the county | the steepest drop, loose rock, and five boulders to work around |
| **the bridge abutment on Wenn Lane** | the width of the gap — 7.5 m against the bend's 15.9 | two trees and clean grass |

A site is a **multiplier on the authored profile**, never a rewrite of it, which is what lets the
bend still be the bend: `baseHeightAt(x, y)` and `baseHeightAt(x, y, 1)` are the same function and
four suites of prior assertions still measure the same ground.

The quarry is the interesting one. It has no trees at all, so the snatch-block side pull — the
answer to half of Milestone 1 — simply does not exist there, and the steepest bank in the county is
the one where you cannot have it.

### Weather is one grip number and one light level

Five forecasts, each of which is exactly two facts that reach the simulation and one that reaches
the fee. Wet takes 20% off the grip everywhere, and the truck is the one that gives ground:
**63.4 kN dry → 50.7 kN wet**, and in the same pull the wrecker slides 7.77 m instead of 7.41.

Night barely touches grip, because darkness is not slippery. What it takes is **sight**, and sight
is a traffic decision: a driver who cannot see you commits later. Measured, on a truck left across
the road — the worst single arrival goes from **4 464 N·s in daylight to 14 989 N·s after dark**.

Worse conditions pay more, and the board says which is which before you take it.

### The road uses itself

Cars, driven along the carriageway from the FX random stream — the one stream no rule reads, so
adding traffic cannot shift where the mud or the casualty is. They are real bodies in the contact
pass, they brake for what they can see, they queue, they cross the centre line to get round a
stopped wrecker, and they eventually creep past anything that will not move.

**Cones are the mechanic.** A work zone is a request rather than a wall, and it works:

| | speed past the site |
|---|---|
| bare road | 78 km/h |
| one cone | 63 km/h |
| three cones | 40 km/h |

Leave the truck across the road and you get hit — eleven times in a two-minute afternoon, hard
enough to dent, and almost nobody gets past. That is a cost in money, through the damage, through
the payout.

### And a day that ends

Two slots. Taking a job spends one; running out ends the day, and whatever was still on the board
goes to somebody else — by name, with the fee, printed on tomorrow's board. The only thing that
makes choosing between three jobs a choice is that the other two go away.

The calendar advances when the *player* does something. A wall clock in a meta-layer is a game that
plays itself while nobody is looking, and nothing in this project reads real time except
presentation.

### One bug, and one decision it forced

**A hatchback was a wall with a number plate.** `stepTraffic` drives a car along x itself and read
its own speed back as `Math.abs(b.vx)`, so a car shoved *backwards* read as one doing the same speed
*forwards*, and `Math.max(0, next)` then threw the shove away entirely. Measured: a 6.8-tonne
wrecker at full throttle, nose against a stopped 1 400 kg car, moved **0.24 m in two seconds** and
got free only when the car's own creep logic took it round. Read signed, the driver can only claw a
shove back at their own acceleration and the truck wins — 9.45 m in three seconds, with the car
pushed 29 m up the road. It is the same class of mistake as the damping-sign inversion in
Milestone 3: a magnitude used where a signed quantity was meant.

It surfaced as *two* failures in the Milestone 1 suite, which is what forced the decision:

**Milestone 1 and Milestone 3 now measure on an empty road, on purpose.** Those suites assert
kilonewtons and centimetres — a comparison of two peak tensions flipped (23.7 against 32.9 kN) and
"the drum stops taking line" landed 4.8 cm the wrong side of its bound, neither of which says
anything about a winch. The claims themselves are re-made in section AE of the Milestone 5 suite,
**with traffic live**: the far-lane recovery still finishes in the same 34 s, no park anywhere
across the road parts the cable (9/9), and a load towed home in its own lane arrives with the
numbers unchanged.

Which turned up the one place the two milestones genuinely disagree, and it is worth keeping: tow a
car down the **centre line** of a live carriageway and a westbound car meets it head-on at
15 374 N·s and takes the load off the yoke after 17 m. Tow it in your own lane and it comes home.
The lane you choose is now a decision.

**900 assertions** across five suites — 265, 219, 160, 128, 128.


## Milestone 4 — the company — 2026-08-20

The layer above the job: money, a truck that wears out, an equipment cupboard, a reputation, and a
board with three jobs on it.

**The rule the whole milestone is built on: every number has to reach the simulation, or it is
bookkeeping with a user interface.**

| | reaches | measured |
|---|---|---|
| truck condition | drive force, brakes | worn out does 3.82 m/s where new does 6.08 |
| winch condition | what the cable holds | 42 kN → 29 kN |
| equipment stock | the pile on the ground | own one chock, and there is one chock at the site |
| reputation | which jobs exist at all | the fleet contract is not offered to an outfit nobody trusts |
| money | all of the above | and it comes from the payout you earned |

Nothing punishes you, and the penalties are deliberately not total — GDD §4 says no instant fail, so
a written-off truck still drives at 65% and its cable still holds 29 kN. Neglect makes a job harder
to do well, never impossible to attempt.

**An offer may change how the car arrived and nothing else.** Six keys: how deep it is in, whether a
hub has seized, how battered it turned up, how it is lying. A test asserts exactly that list, because
GDD §4's "no scripted sequence and no mandatory tool" is a Milestone 1 promise and a dispatch board
does not get to erode it with content.

**The board is seeded from the save, not from a clock.** Same company, same three jobs, until one is
taken. A board that rerolled on refresh would be a board you refresh until you like it.

**The save file never takes the game down.** Corrupt JSON, a version from the future, a half-written
object, a browser that refuses to store anything — each returns a playable company and a sentence
saying what happened. A game that will not start because of its own save file is worse than a game
with no save file.

### Two bugs the tests found

**The board advertised £1890 and paid £1320.** `computePayout` read `CONFIG.job.baseFee` straight out
of config and never saw the offer's multiplier, so every job that paid more paid the standard fee
instead. The board's number and the results card's number are the same promise.

**The payout was charging the operator for the crash.** A car arrives with a damage state (GDD §4),
and docking somebody for the dents it turned up with is not a consequence of any decision they made.
The arriving damage is baselined now and only the difference comes off the fee — the same job went
from £1810 to the £1890 it advertised.

### Numbers

| | |
|---|---|
| M1 suite | **264 / 264** |
| M2 suite | **219 / 219** |
| M3 suite | **160 / 160** |
| M4 suite | **126 / 126** |
| a new outfit | £900, reputation 20, one truck, the starter pile |
| a written-off truck | drive 65%, brakes 70%, cable 29 kN |


## Milestone 3 — a complete job — 2026-08-20

Getting the car out of the ditch turned out to be the middle of the job. GDD §7 asks for "a flatbed
or wheel-lift workflow, physical load securement, short transport route, destination, damage-based
payout, and job recap", so the recovery is now the first of four phases and there is a second
machine to get wrong.

**A wheel lift, not a flatbed**, because a flatbed is the winch that already exists plus an
animation and a wheel lift is a different machine: a yoke under one axle, and from then on the two
vehicles are one articulated thing pivoting about it. Four presses of the same context key, decided
by geometry rather than by a mode. A car lying across the yoke cannot be picked up.

**Securement is a force.** The cradle holds 11 kN alone; each strap adds 9. Overload is judged as an
accumulated impulse in newton-seconds, not as a force over a threshold — because measuring showed
that towing round a bend puts a bare yoke over its capacity for 33 ms at a time with a 22 kN peak,
and any duration long enough to ignore that ignores everything.

| | peak through the yoke | overload accumulated | outcome |
|---|---|---|---|
| straight tow | 3.1 kN | 0 N·s | 84 m, arrives |
| swerving, bare cradle | 16.3 kN vs an 11 kN cap | 141 N·s | **the car comes off at 26 m** |
| swerving, one strap | 22.1 kN vs a 20 kN cap | 35 N·s | arrives |
| swerving, two straps | never exceeds | 0 N·s | arrives |

One strap is the difference between keeping the car and not.

**A load changes the truck**: 45% of the car's mass moves onto the wrecker, so it gains grip
(63.4 → 69.2 kN) while the car loses it (13.0 → 7.2 kN). That is most of why the tow works, and the
tire model now accounts for airborne axles properly — a lifted pair carries nothing and its share of
the weight goes to the wheels still down, instead of vanishing.

**168 m of road**, with the Milestone 1 site untouched in the western 92 m and the embankment graded
flat into a paved yard at the east end over 20 m of continuous blend. The terrain bake is a
per-pixel loop, so resolution comes from a pixel budget now rather than a fixed 20 px/m — the world
nearly doubled and the bake went 1110 → 1527 ms instead of to 2.7 seconds.

**A payout, not a grade.** Itemised, every line naming a decision, with a minimum callout floor
because a job that pays nothing teaches nothing.

### Six bugs, and what each one actually was

**Engaging across a metre of slack is 1.1 MN.** `engageM` is a reach tolerance and the constraint is
stiff; leaving the gap for the spring to resolve threw the car three metres down the road. A yoke
that has picked an axle up has the axle *in* it — so the geometry snaps closed on engage, once, at
the player's request.

**⚠ The damping sign was inverted.** `closing` was actually the *separation* rate, so the damper
cancelled the spring instead of opposing the gap. Measured: the gap opened to 27 mm with the
reported force still at zero, then the spring caught up all at once and the pair rang between 0 and
the 120 kN solver cap. A sign, and it looked exactly like an instability.

**⚠ The cable's damping clamp is wrong for a rigid hinge.** A rope clamps damping to a fraction of
its spring term, which is right for a rope. On a hinge it leaves almost no damping at small
displacement — exactly when it is needed — so the constraint accumulates gap before anything opposes
it. Measured: a tow needing 2.8 kN ramped 0.3 → 0.9 → 1.7 → 2.9 → 5.2 → 7.8 → 10.1 → 11.2 kN over
nine steps and peaked at 106 kN. Absolute cap, near-critical damping.

**⚠ THE WORLD EDGE WAS A TRAMPOLINE.** `clampToWorld` pinned position and scaled *both* velocity
components by −0.2, so a body driven into the fence was re-clamped every step with a live velocity
into it. With a car on the lift that opened the hitch by 30 cm per step and pinned the constraint at
94 kN. Three rounds of stiffness tuning went into "fixing" that before an instrumented run showed
the truck was at y=46.2 in a 48 m world. A positional correction is a teleport, and this is the
third place in this codebase that lesson has surfaced.

**Two records of one fact, again.** `CONFIG.world` restated the world size, so widening the terrain
to 168 m left the camera clamping its centre to the old 92 — it simply refused to follow the truck
into the yard. It showed up as a screenshot of the recovery site with a HUD describing the yard.
CONFIG imports `WORLD` now.

**A stowed yoke sits where the fairlead sits.** Offering the lift there unconditionally stole the
drum: at the back of the truck with the hook stowed, E swung the lift out instead of handing you the
hook, and every step of the M1 rigging sequence after it failed. A folded lift is only offered when
there is a car parked behind the truck to put it under.

And one test bug worth recording: the M1 tow tests were passing *because* the world used to be 92 m
wide. The truck ran into the east edge within a few seconds, which is what let the sedan settle;
with 168 m the same loop drove for 90 seconds and dragged the car down the road. The loop now stops
when the car is up, which is what a player does — and the numbers got better and more honest for it
(last third of the road 5/6 → 6/6, mid-road 41.8 → 35.5 s).

### Numbers

| | |
|---|---|
| M1 suite | **264 / 264** |
| M2 suite | **219 / 219** |
| M3 suite | **158 / 158** |
| far-lane recovery, re-measured | 38 s at 10.7 kN, unchanged |
| straight tow through the yoke | 3.1 kN, 8.8 mm of sag |
| world | 168 × 48 m at 17.25 px/m, 1527 ms to bake |


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
