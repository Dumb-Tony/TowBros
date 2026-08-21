# TOW BROS
## Game Design Document & Development Plan

**Document status:** Living design contract  
**Current target:** Milestone 9 — Righting it, and the one behind  
**Primary implementation:** Standalone HTML5 Canvas browser game  

> The game does not care how you got the car out of the ditch. It only cares that the car is no longer in the ditch.

## 1. Product thesis

Tow Bros is a cooperative, physics-led vehicle recovery game about arriving at a bad situation, arguing about the plan, using ordinary recovery equipment in clever or irresponsible ways, and living with whatever happens next. Jobs are physical situations, not authored puzzles. Tools create options; force creates consequences; failure usually creates a larger job.

The fantasy is not “press the tow button.” It is reading terrain, positioning machinery, rigging a pull, watching tension build, and realizing the tow truck is moving instead of the wreck.

### Design pillars

1. **Situations, not solutions.** A job defines a target state and physical starting conditions, never a required interaction sequence.
2. **The winch does not know who should win.** Cable forces affect every connected body. Position, traction, slope, mass, and rigging decide the result.
3. **Consequences beat fail screens.** Broken parts, a sliding truck, or a newly rolled vehicle should continue the story.
4. **Physical tools, approachable controls.** Equipment lives in the scene and has legible effects. The simulation may cheat whenever browser stability or fun benefits.
5. **Readable force.** Cable shape, vibration, color, sound, tire slip, component flex, and vehicle motion should explain outcomes before UI does.
6. **Friends create the roles.** Future multiplayer has no hard classes. Driver, rigger, winch operator, spotter, and professional horn operator emerge naturally.
7. **Boring equipment becomes exciting.** Chocks, wood blocks, jacks, straps, chains, and pulleys should unlock surprising strategies.

## 2. Tone

Grounded machinery with slapstick consequences. Vehicles feel heavy; bureaucracy is dry; player decisions are frequently terrible. Damage is visible and mechanically relevant, but never gruesome. The ideal story contains competence, rising tension, a metallic clang, a brief silence, and a worse problem.

## 3. Core loop

Long-term loop:

**Dispatch → prepare → drive → assess → recover → secure → transport → get paid → repair/upgrade → next disaster**

Milestone 1 deliberately contains only:

**Assess → position → rig → pull → react → recover**

## 4. Milestone 1: One Vehicle, One Ditch, One Recovery

### Scenario

A disabled sedan sits nose-down on a wet grassy embankment below a two-lane rural road. A drivable tow truck begins on the pavement. Trees, a weak guardrail, a muddy low point, and a physical equipment pile create options.

The single objective is: **get the sedan onto the road.**

### Required systems

- Drivable tow truck with weight, steering, braking, parking brake, terrain grip, lateral sliding, and visible tire slip.
- Disabled sedan with mass, slope gravity, rolling/locked-wheel resistance, rotation, damage state, and detachable components.
- A winch line that may be carried, routed, attached, reeled, stopped, overloaded, and broken.
- Equal-and-opposite winch force applied at physical attachment offsets, including torque.
- Forgiving attachment zones: frame, axle, tow hook, wheel, bumper, and body. Almost any plausible choice works until its strength does not.
- Terrain zones: pavement, dirt/shoulder, wet grass, and mud. Surface and slope modify grip and resistance without exposing simulation numbers.
- Physical starter gear: strap, chain, hydraulic jack, two wheel chocks, four cribbing blocks, and a snatch block.
- Component damage and detachment, with consequences that may make the recovery harder.
- No scripted sequence and no mandatory tool.
- No instant fail for damage or a worsening scene. Reset is always available, never imposed.

### Simplification contract

The browser build simulates believable relationships rather than engineering accuracy:

- Vehicles are damped planar rigid bodies with authored traction and drag curves.
- Terrain deformation is represented by grip, drag, spray, and tracks rather than a deformable mesh.
- Cables use a stable spring constraint with capped forces and visual sag; they are not a high-segment rope simulation.
- Chocks add directional resistance when sensibly placed.
- Cribbing reduces local drag and stabilizes the sedan.
- The jack raises the chassis state and reduces ground drag.
- A snatch block redirects force and grants an intentionally simplified mechanical advantage.
- Damage is component- and threshold-based rather than soft-body deformation.

These cheats are acceptable when the player can correctly say why an outcome occurred.

### Equipment behavior

| Tool | Player action | Simulation effect | Misuse / consequence |
|---|---|---|---|
| Winch hook | Carry and attach to a broad vehicle zone | Creates cable constraint | Weak zone tears away; cable can snap |
| Strap | Wrap around a target zone before hooking | Raises attachment tolerance and cushions shock | Still fails if attached to weak bodywork |
| Chain | Rig a target zone before hooking | Highest attachment tolerance; harsher shock transfer | More component damage under shock |
| Wheel chock | Carry and place beside tow truck | Adds directional anchor resistance | Poor placement has little effect |
| Cribbing | Place beside/under sedan | Reduces drag and limits rotation | Can be scattered by impacts |
| Hydraulic jack | Place by sedan and operate | Raises chassis and reduces ground drag | Unstable under large sideways loads |
| Snatch block | Secure at a tree and route hook through it | Redirects the pull and boosts effective force | Small/weak anchors can fail in later builds |

### Attachment zones

| Zone | Base strength | Behavior at failure |
|---|---:|---|
| Tow hook | Extreme | Usually outlasts starter cable |
| Frame | Extreme | Transfers force cleanly |
| Axle | Strong | May bend and add wheel drag |
| Wheel | Medium | May detach, sharply increasing drag |
| Bumper | Weak | Tears off as a physical object |
| Door/body | Very weak | Panel detaches; job continues |

Strength is communicated through inspection language and physical warning, not a “correct answer” glow.

### Supported approaches

- Direct pull from pavement using a frame or tow-hook attachment.
- Fast but risky pull with the truck partly down the slope.
- Side pull through a tree-mounted snatch block to rotate the sedan.
- Careful recovery using chocks, cribbing, a jack, and stronger rigging.
- Brute-force recovery from a weak attachment, accepting damage and re-rigging.
- Accidental escalation in which the tow truck slides into the recovery zone.

### Completion criteria

Milestone 1 succeeds only if:

- The sedan can reach the road without a predetermined interaction order.
- At least three meaningfully different approaches work.
- Truck position, ground surface, attachment choice, and equipment change outcomes.
- Tension visibly affects both vehicles.
- A poor plan can worsen the scene.
- The player can continue and recover after most mistakes.
- Damage results from force and changes later behavior.
- Clean, messy, and catastrophic outcomes are all possible.
- Repeating the scenario does not feel exactly identical.

## 5. Controls and interaction principles

Controls must remain small enough to remember after one glance. Walking and driving share directional input. The nearby world provides context-sensitive actions. Winch operation always remains available through both keys and large on-screen controls.

No inventory grid is required. The player carries one physical object. Equipment is picked up from the truck-side staging area and placed in the world. Inspection provides useful facts (“weak bumper,” “locked wheel”) without prescribing a solution.

## 6. Technical architecture

The prototype separates concerns so the browser build can grow without becoming the final game’s prison:

- **Simulation:** fixed-step planar rigid-body integration, terrain queries, traction, drag, slope, collision response.
- **Recovery systems:** cable path, force resolution, reel state, attachment thresholds, rigging, equipment effects.
- **World:** scene geometry, terrain regions, trees/anchors, props, recovery success detection.
- **Input/player:** on-foot movement, vehicle possession, contextual carrying and placement.
- **Presentation:** canvas rendering, particles, audio synthesis, camera, HUD, event log, onboarding.
- **Content data:** vehicle, terrain, attachment, and equipment definitions remain data-driven.

Future multiplayer authority should live above deterministic-ish simulation commands: drive input, equipment pickup/place, attach/detach, and winch state. The first networked version should use a server/host-authoritative physics scene with interpolated clients rather than trying to synchronize raw browser frame state.

## 7. Roadmap

### Milestone 1 — Recovery sandbox

Prove that one ditch produces stories. No economy, broad content, or network work.

### Milestone 2 — Crew recovery

Add 2–4 player networking, player stumble/ragdoll punctuation, shared equipment, an occupiable recovered vehicle for steering/braking, and robust object authority.

### Milestone 3 — Complete job

Add a flatbed or wheel-lift workflow, physical load securement, short transport route, destination, damage-based payout, and job recap.

### Milestone 4 — Garage/company

Add persistent garage lobby, a small fleet, equipment storage, repairs, money, organization reputation, and authored dispatch selection.

### Milestone 5 — Regional operations

Connect job scenes with a regional map or compact open county, dynamic dispatch, traffic/work zones, weather modifiers, and rival-job persistence.

### Milestone 6 — Heavy and procedural recovery

Add heavy wreckers/rotators, multiple winches and outriggers, large vehicles, richer anchors, water recovery, and procedural situation generation from vehicle + incident + terrain + damage + conditions.

### Milestone 7 — The scene, and everybody at it

*Authored after Milestone 6 shipped. Milestones 1–6 were written before a line of code existed;
this one is written knowing exactly what is on the ground, and it is drawn from §8's deferred list
rather than invented — police systems, a wider content library, and the parts of "open world" that a
compact county can honestly carry.*

Six milestones built the machinery of a recovery and the company around it. What the scene still
has is nobody in it. Traffic goes past, but nothing at the site cares how long you take, whether the
road is safe, or what the owner of the car thinks of the state it is in.

Add:

- **Scene safety and the authorities.** A formal road closure the crew sets up and takes down, built
  from the cones that already exist. A police unit that turns out to a carriageway left unprotected,
  and a citation that reaches the payout. The work zone stops being "traffic slows down" and becomes
  the difference between a clean job and one that costs you.
- **The customer, at the scene.** The person whose car it is, standing on the verge, watching. They
  have an opinion about the state it comes back in, and that opinion reaches reputation directly
  rather than through the damage table.
- **A wider casualty library.** A vehicle that arrived on its roof, and a motorcycle — two situations
  the existing rig cannot simply out-pull, because one has to be righted and the other weighs less
  than the cable's breaking strain.
- **A job clock.** The county's afternoon runs while you work. A job that takes all day costs the
  second slot, so "do it properly" and "do it now" are finally in tension with each other.

**Completion criteria.** Milestone 7 succeeds only if a player who leaves the road unprotected can
name what it cost them; if the customer's reaction is something they could have changed; if a car on
its roof requires a different plan rather than a longer pull; and if at least one job in a day is
lost to time rather than to a mistake.

### Milestone 8 — What the machine can actually lift

*Authored after Milestone 7 shipped, and not from §8's deferred list — that list is now spent. This
one is drawn from the README's own **Known limitations**, which is the honest place to look once the
roadmap runs out: three of those entries are not "content we have not made yet", they are places
where a machine in this game does less than the machine it is modelled on, and the difference is a
decision the player never gets to make.*

Milestone 6 put a rotator in the yard and Milestone 7 filled the scene around it. Both left the same
gap: the heavy machine is a light wrecker with more drums. Its boom slews and does nothing else. Its
wheel lift is the car yoke, which will not take a seven-tonne axle, so the biggest casualty in the
game is dragged home on the line rather than carried. And the road it all happens on is a conveyor —
cars brake for the recovery and for the cones, and for each other not at all.

Add:

- **A load chart.** The boom gets *reach* as well as slew, and a capacity that falls away with both.
  Whether the legs are down decides which chart applies. A load taken on the hook LEAVES THE GROUND —
  which is a different plan, not a stronger pull: a suspended car can be swung over a guardrail
  instead of dragged through the gap in it. The weight moves onto the machine while it hangs, and a
  machine asked for more moment than it has tips over. Nothing here is a mode: capacity is computed
  from the geometry every step, the same way a work zone is.
- **The heavy tows what it recovers.** A heavy underlift, rated in tonnes rather than in car axles,
  with chains instead of straps. Milestone 3 proved the shape — one strap is the difference between
  keeping the car and not — and the seven-tonne version of that decision is the one the big machine
  has never been allowed to make.
- **Traffic that sees traffic.** A driver brakes for the car in front. That is all — but it means a
  queue forms behind an unclosed scene, the queue is itself the hazard, and the cones stop being a
  speed modifier and become the reason the tailback is somewhere else.

**Completion criteria.** Milestone 8 succeeds only if there is a recovery that is *easier* suspended
than dragged and one that is not; if a player can overload the boom and say afterwards which number
they exceeded; if a box truck goes home on the machine rather than behind it; and if a tailback is
something the player can see forming and do something about.

### Milestone 9 — Righting it, and the one behind

*Two things this game has been describing rather than simulating. A car "on its roof" has been a
grip multiplier since Milestone 7 and a rollover has been a one-way door since Milestone 1 — you can
put a vehicle on its roof and you can never put it back. And every job to date has had exactly one
thing in the ditch, which is not what a bad afternoon looks like.*

Add:

- **A vehicle on its roof can be put back on its wheels, and there are two ways.** Pick it up on the
  rotator's boom and set it down — which the Milestone 8 chart already decides for you, so a car can
  be righted that way and a seven-tonner cannot. Or roll it with a side pull, which is the answer
  when there is no rotator and the answer when the chart says no: enough sideways impulse about its
  long axis and it comes over. Symmetrically, because that is what rolling is — keep pulling and it
  goes straight over onto its roof again. Neither is a button; both are the equipment that already
  exists, judged in newton-seconds like everything else.
- **Two vehicles, and an order the scene decides rather than a script.** A shunt: two casualties, one
  behind the other, both to be got onto the road. Nothing declares an order — the one nearer the road
  is physically in the way of the one below it, and the player reads that off the ground. It has to
  be possible to start with the wrong one and discover it, and *discovering it* has to be a number
  the player can see rather than a refusal: the cost of bulldozing one car up the bank with another
  is the LINE and not the clock, and it climbs straight at the drum's own limit.
- **Everything at the scene has to stop assuming there is exactly one.** The objective, the closure
  standard, the payout, the owner, the recap. A milestone that adds a second casualty and leaves nine
  systems quietly reading `st.vehicles.sedan` has not added a second casualty.

**Completion criteria.** Milestone 9 succeeds only if righting a car is a decision with two real
answers and a way to get it wrong; if over-rolling one is reachable and legible; if a two-vehicle job
can be started in the wrong order and recovered from; and if no system at the scene still behaves as
though there is one casualty.

## 8. Explicitly deferred

Open world, economy, garage upgrades, procedural dispatch, ambient traffic, reputation, customization, broad vehicle/content libraries, matchmaking, weather simulation, police systems, and production online multiplayer are not Milestone 1 work.

## 9. North-star playtest question

After a recovery, do players describe what *they did*—where they parked, what they attached to, what broke, and how they saved it—or do they describe what the mission told them to do?

Only the first answer is Tow Bros.

