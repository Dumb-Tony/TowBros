# TOW BROS
## Game Design Document & Development Plan

**Document status:** Living design contract  
**Current target:** Milestone 1 — One Vehicle, One Ditch, One Recovery  
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

## 8. Explicitly deferred

Open world, economy, garage upgrades, procedural dispatch, ambient traffic, reputation, customization, broad vehicle/content libraries, matchmaking, weather simulation, police systems, and production online multiplayer are not Milestone 1 work.

## 9. North-star playtest question

After a recovery, do players describe what *they did*—where they parked, what they attached to, what broke, and how they saved it—or do they describe what the mission told them to do?

Only the first answer is Tow Bros.

