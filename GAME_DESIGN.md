# PLANET X — Game Design

*Working title. Living document — update it when mechanics change.*

## 1. Vision

Year 2000. Humanity has secretly found a habitable **Planet X** inside the Solar System. A handful of
governments run small classified expeditions there. Earth officially knows nothing. The expeditions are
told to avoid conflict — while communication with Earth slowly fails.

The long game (not in the MVP): Earth slides toward global war, the expeditions lose contact, become
independent societies with their own ideologies, AI, robotics, consciousness transfer, alien technology,
mechs and enormous armies — and the player character goes from expedition director to something else.

The **MVP** establishes the foundation all of that grows from: a persistent strategic layer and a
tactical layer that read and write the same world.

Inspirations (not clones): early Total War campaign maps, Mount & Blade, Civilization, Heroes of Might &
Magic, X4 (economy), WARNO (tactical feel), Imperium Galactica 2 (future unit designer).

### Pillars

1. **One world, two scales.** The battlefield is generated from the campaign: terrain, forests, coast,
   and the actual buildings of the base under attack. Battle outcomes are permanent.
2. **Logistics over money.** There is no generic currency. Everything is made from something,
   moved by someone, and consumed by something.
3. **People are the scarcest resource.** Every soldier and worker is a person from a small population.
   There is no infinite manpower pool.
4. **Mobile first.** Every action works by touch in landscape on a phone; desktop adds mouse/keyboard.
5. **Sandbox.** No victory screen. Expeditions can collapse, survive, recover.

## 2. Core loop

```
STRATEGIC MAP (real-time with pause)
  build · produce · move task forces · haul resources
        │  armies meet / a base or outpost is attacked
        ▼
CONTACT REPORT → Command battle (tactical) or Auto-resolve (same simulation, headless)
        ▼
TACTICAL BATTLE (real-time RTS; campaign is frozen)
        ▼
RESULTS APPLIED: casualties, damaged/destroyed units & buildings, ammo/fuel spent,
crews rescued, bases/outposts captured, armies retreat, campaign clock advances
        ▼
back to the STRATEGIC MAP — nothing resets
```

## 3. Setting & lore presentation (MVP)

Short intro (YEAR 2000 … Earth communication is becoming increasingly unstable). Flavour comes through
supply shuttles from Earth that become rarer and stranger, uplink outages, and intelligence reports.
No aliens, no Earth war, no futuristic tech yet — year-2000 military hardware only.

Expeditions are data-driven factions (`src/data/factions.ts`): **MERIDIAN** (player) and **VANTAGE** (AI).
Replacing them with nations later is a data change.

## 4. Strategic layer

### 4.1 Map
- One continuous continent, procedurally generated from a seed (`src/world/terrain.ts`, `mapgen.ts`):
  plains, forests, hills, mountains (with a mountain spine), peaks, coasts, lakes, surrounding ocean.
- 240 × 240 map units ("km"); the player's landing site is placed in the south-west, the enemy's far away
  in the north-east. Each base gets guaranteed nearby mineral and hydrocarbon sites; more sites are
  scattered and contested.
- Terrain affects army speed (forest/hills slow, mountains very slow, water impassable). **Roads**
  (built automatically to every outpost) make movement and convoys faster.

### 4.2 Time
- Real-time with pause: ⏸ / 1× / 2× / 4×. At 1×, 1 real second = 30 campaign minutes (`CAMPAIGN_HOURS_PER_SECOND`).
- Fixed simulation step of 0.1 h (deterministic, save/load safe).
- During a tactical battle the strategic simulation is **completely frozen**. Afterwards the campaign
  clock is advanced by the battle duration × `BATTLE_TIME_SCALE` (12: one battle second represents 12 s
  of campaign time — battles are time-compressed). The world then catches up normally.
- **Day and night** follow the campaign clock (the expedition lands at 06:00): sun path, sky, fog and
  ambient light are keyframed by hour (moonlit nights stay readable on phones). Battles inherit the
  hour at contact and advance it with the compressed battle clock. At night vision shrinks by up to
  45% — thermal sights (tanks) ignore it, recon optics halve it, infantry suffer it fully; base
  sentries and defence optics are partly affected.

### 4.3 Economy (X4-flavoured, kept small)

| Category | Resources |
|---|---|
| Raw | Minerals (ORE), Hydrocarbons (HYD), Food, Energy (flow, MW) |
| Processed | Refined alloys (ALY), Components (CMP), Fuel, Ammunition |
| Human | Population (civilians), workforce (employed civilians), soldiers (inside units) |

Production chain:

```
Mine (outpost) ─ore─► convoy ─► Refinery ─alloys─► Factory ─components─► Vehicle Depot ─► tanks / jeeps
Oil well (outpost) ─crude─► convoy ─► Refinery ─fuel─► vehicles     Factory ─ammunition─► every unit
                         └─► Power Plant (burns crude) ─► power grid ─► all industry
Agri-Dome ─food─► population & garrisons        Barracks: people + gear + ammo ─► rifle squads
```

Rules:
- **Storage**: each base has per-resource capacity from its buildings (HQ provides the bulk). Recipes don't
  start when outputs can't be stored. In *Auto* mode, intermediate goods stop at stock targets
  (components 120, ammo 160, fuel 150) so upstream materials aren't all converted.
- **Workforce**: buildings need workers (priority: HQ, power, food, extraction, refining, industry, military,
  housing); construction sites need 4. Understaffed buildings run proportionally slower.
- **Power**: generation vs demand per base. Deficits scale down powered buildings. Power plants burn
  hydrocarbons in proportion to the load they carry. The HQ has a small free generator.
- **Extractors** are outposts on resource sites with a 40-unit local buffer. **Convoys** (trucks)
  carry the output along the road to the base. Hostile armies intercept convoys.
- **Population** eats food (0.02/person/h, garrison soldiers too) and grows slowly when fed and housed.
  Starvation and overcrowding lose people. **Earth supply shuttles** occasionally bring a few people and
  supplies — fewer each time, then they stop.
- **Units cost people**: squads take 6 civilians, vehicles take crews. Depleted squads at a base take
  replacements from the population. Destroyed vehicles' surviving crews return to the population.
- Field armies carry **rations** (food) and units carry **fuel and ammunition**; they resupply only near a
  friendly base. Vehicles burn fuel per km on the map and per metre in battle. Out of fuel = towed/crawling
  on the map, immobile in battle. Out of ammo = cannot fire.

### 4.4 Buildings

| Building | Cost | Build | Workers | HP | Power | Notes |
|---|---|---|---|---|---|---|
| Headquarters | 200 ORE · 150 ALY · 40 CMP | 96h | 4 | 2600 | +12 MW | housing 30, main storage (not buildable in the MVP) |
| Habitat | 30 ORE · 20 ALY | 18h | 1 | 800 | −2 MW | housing 30 |
| Power Plant | 40 ORE · 25 ALY | 24h | 4 | 1100 | +32 MW | burns up to 1 HYD/h |
| Extractor | 40 ORE | 20h | 4 | 700 | 0 | on a site: Mine 2.5 ORE/h or Oil Well 2.5 HYD/h × richness |
| Agri-Dome | 25 ORE · 15 ALY | 16h | 5 | 600 | −4 MW | 6 FOOD / 2.5h |
| Refinery | 60 ORE | 30h | 5 | 1200 | −8 MW | 4 ORE → 4 ALY or 4 HYD → 4 FUEL per 1.5h |
| Industrial Factory | 60 ORE · 40 ALY | 36h | 7 | 1400 | −10 MW | 2 ALY → 2 CMP, or 1 ALY + 1 HYD → 5 AMMO per 1.5h |
| Barracks | 40 ORE · 20 ALY | 24h | 3 | 1000 | −3 MW | trains rifle squads |
| Vehicle Depot | 80 ORE · 60 ALY · 20 CMP | 48h | 6 | 1800 | −8 MW | builds jeeps and tanks |
| MG Bunker | 35 ORE · 30 ALY | 16h | 3 crew | 1800 | 0 | twin 12.7 mm MG (215 m), 30 rds, concrete (−60% structural damage) |
| AT Gun Emplacement | 25 ORE · 35 ALY · 12 CMP | 20h | 4 crew | 1300 | 0 | 90 mm AT gun (285 m, vehicles only), 16 rds, hard to hit, crew exposed |
| Research Lab | 60 ORE · 50 ALY · 20 CMP | 30h | 5 | 900 | −6 MW | 1 RP/h at full staffing and power; one per base (see 4.9) |

Construction pays the full cost up front; cancelling refunds 75%. Destroyed buildings stay as ruins and
can be rebuilt for 60% of the cost. Buildings below 50% HP work at reduced efficiency; *Repair* consumes
alloys over time. The refinery and factory can be set to *Auto* or a fixed recipe.

Extractors and refinery cost no alloys on purpose: an expedition can always restart its economy from ore.

**Defensive structures** (`defense` block in `src/data/buildings.ts`, stats derived in `src/units/defense.ts`)
fight automatically whenever their base is part of a battle. Their workers are their **crew** (crewed with
high priority); without a crew they are silent. When a battle starts each crewed position draws up to its
ammunition capacity from the base's AMMO stock (shared evenly); what it fires is deducted afterwards and
crew killed at their post or in a destroyed position are lost from the population. The bunker shreds
infantry and jeeps and only tank guns or massed AT rockets crack it; the dug-in AT gun out-ranges tank
guns and is hard to hit but cannot engage infantry, and its exposed crew can be shot down by small arms.
Armed positions count towards base strength for AI planning, and a base is not taken while any of them
still fights.

Bases grow visibly on the map: camp blocks of prefab huts appear as the population rises (one per 4
people) and garrisoned vehicles park beside the vehicle depot (or the HQ).

### 4.4b Expansion
- **Found new base** (base panel): costs 160 ORE · 110 ALY · 30 CMP · 60 FOOD · 20 FUEL · 10 AMMO and 16
  colonists (12 must stay). The site must be 40–150 km away, at least 40 km from any base, dry, not too
  rough, clear of resource sites and hostile forces. Max 4 bases per expedition.
- The new base starts with part of that as supplies, a prefab HQ at 45% (assembled by its colonists),
  field-camp housing (24) and storage (+90 each) until the HQ works, and a road to the founding base.
- **Supply convoys** run along that road whenever the young base runs short of ore, alloys, food,
  components, fuel or ammo that the founding base has spare (one convoy in flight, can be intercepted).
- The AI founds one extra base once its first is well established (~day 13–20), sited near unclaimed
  resources and away from the player.
- **Hand-sent convoys** (base panel → *Send convoy…*, with two or more bases): up to 120 units of any
  stock and 12 colonists (the sending base keeps at least 8 people) travel along the road between the
  bases, or cross-country, at convoy speed; colonists join the destination's population on arrival
  (overflowing storage is left behind). Convoys can be intercepted — cargo and colonists are lost.
- **Relief landings** (`src/campaign/relief.ts`): an expedition that has lost every base gets a relief landing
  from Earth 3 days later (at most twice per campaign): a finished HQ, habitat and agri-dome, 30 colonists,
  starter supplies and two rifle squads, on free ground at least 90 km from hostile bases and forces, near
  unclaimed resources and its surviving task forces. Both sides get it. The top bar shows NO BASE with the
  countdown, and the camera jumps to the new base when it lands.

### 4.5 Military units (modular)

Units are **designs** assembled from components (`src/data/components.ts`, `src/data/unitDesigns.ts`):
chassis (family, mobility, crew, base HP, slots, fuel/ammo capacity, vision), engine (power, fuel use),
armour, weapons, sensors, electronics. All stats are derived (`src/units/stats.ts`).

| Unit | People | Cost | Build | HP | Armour | Speed (m/s) | Map speed | Vision | Weapons | Fuel | Ammo |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Rifle Squad | 6 | 4 ALY · 3 CMP · 6 AMMO | 8h | 240 | 0 | 3.4 | 4.6 | 230 | rifles/LMG (160 m), disposable AT launchers (135 m) | — | 12 |
| Recon Jeep | 3 | 16 ALY · 8 CMP · 10 FUEL · 4 AMMO | 13h | 200 | 4 | 16.5 | 9.5 | 320 | 12.7 mm HMG (175 m) | 20 | 16 |
| Main Battle Tank | 3 | 48 ALY · 32 CMP · 25 FUEL · 10 AMMO | 47h | 900 | 520 | 7.1 | 4.7 | 190 | 120 mm gun (270 m), coax MG (170 m) | 60 | 24 |
| Supply Truck | 2 | ALY · CMP · 60 FUEL · 30 AMMO (cargo) | ~14h | 220 | 0 | ~10 | ~6.3 | 150 | none | 140 (25 own reserve) | 60 cargo |
| ATGM Team *(research)* | 4 | 7 ALY · 9 CMP · 10 AMMO | 10h | 160 | 0 | 3.1 | 4.5 | 230 | rifles/LMG (160 m), guided AT missiles (300 m, vehicles only, 1 per 13 s) | — | 16 |

Roles: infantry are cheap in materials but expensive in people, see well, hide in forests, and kill tanks
from the flank; jeeps scout and shred infantry in the open but die to anything heavy; tanks dominate open
ground and other vehicles but are half-blind and vulnerable to infantry in cover and from the sides/rear;
supply trucks (family `support`, no weapons, combat power 0) carry the task force's fuel, ammunition and
extra rations; ATGM teams out-range tank guns from cover but reload slowly and lose to rifle squads.

### 4.6 Armies (task forces)
- Formed from a base garrison (*Deploy task force*), up to 24 units. Each has a named **commander**
  (character data), units, rations, position, path/destination, speed (slowest unit × terrain), faction.
- Orders: move, attack army (pursuit), attack base, attack outpost (capture), return, stop; garrison /
  reinforce at a base; split off chosen units into a new task force (rations shared by head count, new
  commander); merge task forces within 2.5 km (up to 24 units; the other commander joins the staff).
- Strategic fog of war: enemy forces are visible only near your bases, outposts and armies.
- **Logistics**: at a friendly base (inside its perimeter or within 4 km of it) the task force draws rations
  and units refill from the base stock (trucks load cargo 3× faster); the army panel shows "Supplied by …".
  In the field it lives on its rations; when they run out you get one warning and infantry slowly weaken.
  Away from bases, supply trucks top up the neediest units (8 FUEL and 4 AMMO per truck-hour), never
  giving away their own 25-fuel reserve; each truck adds 40 rations. The army's fuel range pools truck
  cargo with the vehicles' tanks. Each expedition starts with one truck in its task force; the AI adds
  one per ~8 fighting units.
- In battle trucks trail the force out of the line of fire and rearm/refuel units within 45 m; dry AI
  units drive back to a truck instead of leaving the field. Trucks cannot hold the field alone.

### 4.7 Diplomacy: standoff → hostilities
- Starts as an armed **standoff**: armies pass each other without fighting.
- **Tension** rises over time (failing Earth comms) and when forces loiter near the other side's bases.
  At 60% an intelligence warning; at 100% the AI expedition goes weapons-free.
- Ordering any attack ends the standoff immediately.

### 4.8 Contact
- Hostile armies within 2.4 km fight (cooldown after a battle lets the loser disengage).
- An army entering a hostile base perimeter triggers a **base assault** (garrison + nearby friendly armies defend).
- An attack on an outpost: undefended → captured immediately (or destroyed if the attacker has no base);
  defended → outpost battle.
- The player chooses **Command battle** or **Auto-resolve** (with no friendly units present: outcome only).

### 4.9 Research (`src/research/research.ts`)
A **Research Lab** produces research points (RP) for its expedition's current project (1 RP/h at full
staffing, scaled by power and damage like any building). One project at a time; switching keeps the
progress made (it resumes when picked again). Completed technologies apply immediately to every base.

| Technology | RP | Requires | Effect |
|---|---|---|---|
| Deep-Core Drilling | 30 | — | extractors +25% |
| Hydroponics II | 25 | — | Agri-Domes +30% food |
| Prefab Construction | 40 | — | construction +35% speed |
| Automated Lines | 60 | Deep-Core Drilling | refineries and factories +20% speed |
| Logistics Doctrine | 35 | — | supply trucks transfer 60% faster in the field |
| Hardened Positions | 45 | Prefab Construction | bunkers and gun emplacements take 25% less damage |
| ATGM Teams | 70 | Logistics Doctrine | barracks can train ATGM Teams |

The AI builds a lab once its industry stands, after its first bunker when threatened (~day 10–12), and researches in a fixed order
(economy first, ATGM Teams last), then adds ATGM teams to its forces. Effects are data
(`TechEffect`: modifier / unlock design / component / building); tech categories for AI, robotics, drones,
alien technology, cybernetics, consciousness transfer, vehicles and mechs are reserved for later tiers.

## 5. Tactical layer

- 800 × 800 m battlefield derived from the campaign map around the contact point (20 m per map unit;
  heights × 6 m), with extra local relief, forest patches and water. Base layouts are reproduced at
  the same relative positions; buildings sit on flattened pads.
- Up to 30 deployed units per side; extra units wait as reserves and arrive as others fall.
- Attackers enter from the edge they approached from; base defenders start around their buildings.
- Units: move (A* on a 100×100 grid with terrain costs), attack, attack-move, hold, stop, fall back.
  Infantry don't fire while on a plain move; vehicles fire on the move with accuracy penalties.
- **Visibility**: per-side fog of war, vision ranges, terrain line of sight, concealment (infantry in
  forest are very hard to spot; firing reveals). Base structures give defenders sentry vision.
- **Damage**: hit chance from accuracy, range, movement, target cover, suppression and elevation;
  penetration vs armour with **directional armour** (front 100%, side 55%, rear 35%); infantry HP maps
  to soldiers (casualties remove men); cover in forests and near friendly buildings; suppression slows
  and degrades infantry.
- **Ammo and fuel** are tracked per unit and written back to the campaign.
- **Garrisons**: infantry (rifle squads, ATGM teams) can occupy their own side's structures — HQ 3 squads;
  habitat, factory, barracks, vehicle depot 2; power plant, refinery, research lab 1. Inside they fire from
  4.5 m up (longer sight), take 60% less damage and are hit about half as often, and stay concealed until
  they fire. Heavy rounds aimed at a garrison also damage the building, every hit on the building hurts
  the squads inside a little, and a collapse injures them badly and throws them out (suppressed). A move
  order brings them out. Tap one of your buildings with infantry selected to garrison it (vehicles move
  next to it); tap it with nothing selected to select its garrison. GARRISON n/cap badges mark occupied
  buildings (enemy garrisons once spotted).
- **Structures** take damage (explicit orders, AI demolition of military production in sieges, and stray
  heavy rounds) and can be destroyed. **Defensive positions** acquire targets, traverse and fire on their
  own, are engaged automatically by enemy units that can hurt them (armour, target profile and crew
  exposure decide which weapons can), spot with optics and line of sight, and are marked on the overlay
  (MG NEST / AT GUN, condition, our ammunition; SILENT when out of crew or ammo).
- **End**: a side is eliminated or withdraws; timeouts (15 min) — field battles draw, sieges go to whoever
  holds the objective area. The player can withdraw (engaged units may be caught) or end a won battle.

### Tactical AI (`src/battle/ai.ts`)
Respects fog of war (memory of last-seen enemies). Picks objectives; jeeps scout ahead and avoid tanks;
tanks seek high ground at stand-off range and back away from infantry that could carry AT weapons;
infantry advance through cover and ambush vehicles; a flanking group swings around known enemy
concentrations; focus fire on the most dangerous / most damaged targets it can hurt; damaged and dry
units fall back; holds and waits when outmatched; withdraws when the fight is lost (it remembers how strong
the enemy was, so a beaten remnant still pulls out after losing sight of it). When contact is lost it hunts:
units close in on last-known positions (a spot reached with nothing in sight is written off), then sweep
the enemy's half of the field and its rear, where damaged vehicles limp to. Missile teams hold in cover at
~85% of missile range from enemy armour and fight as riflemen when only infantry is around. Siege defenders hold
around their buildings, man the structures facing the attack (garrisons) and counter-attack when clearly
superior; attacking tanks shell buildings with a spotted garrison. Enemy defences are always known: tanks
shell bunkers (then gun pits), infantry rush exposed AT gun pits that cannot fire back at them, AT-armed
infantry take on bunkers only when no tanks are left, and jeeps keep clear of fortifications.

## 6. Strategic AI (`src/ai/strategicAI.ts`)
Build order driven by needs (housing, food, refinery, oil, power, industry, depot, barracks, more
extractors), staffing-aware; fortifies (bunker, then AT gun) on the side facing the enemy once tension
is high or hostilities begin; recruits within manpower limits; keeps a home guard; launches raids on
outposts and assaults on bases when its strike force is strong enough (garrison **and** defences
counted) **and has the fuel to get there**; recalls forces to defend; beaten or dry forces return home to refit.
The AI plays under the same **strategic fog of war** as the player: it only targets, pursues and reacts
to forces inside its vision (bases, outposts, armies); bases and outposts are always known.
**Recon patrols**: from day 3 a pair of fuelled jeeps roams watch points between the expeditions and
around its outposts (keeping 36 km from your bases during the standoff, circling your base at war). At
war a patrol cuts across the route of any convoy it sees, attacks forces much weaker than itself and
slips home from anything stronger, or when low on fuel, ammunition or health. Patrols only go out while
no offensive is ready, and are called home when their jeeps would complete a strike force.

**Difficulty** (chosen on the main menu, stored per campaign; `src/data/difficulty.ts`):

| | Easy | Normal | Hard |
|---|---|---|---|
| Rival economy speed | ×0.8 | ×1 | ×1.25 |
| Caution when attacking | +0.35 | ±0 | −0.15 |
| Pause between offensives | ×1.6 | ×1 | ×0.7 |
| Tension drift | ×0.7 | ×1 | ×1.25 |
| Battlefield decisions | every 1.6 s, no flanking | 1.0 s | 0.75 s |
| Rival's starting task force | no tank | standard | +1 tank, +1 rifle squad |

## 7. Persistence
Versioned save envelope + state schema version with migrations, IndexedDB (localStorage fallback),
autosave every 2 minutes (configurable), on hiding the app, and around battles.
Slots: autosave plus three manual slots (pause menu → Save game). Load game lists them (load/delete) and
imports a save from a file or pasted text; Save game can export the current campaign as a JSON file or
copy it to the clipboard, so campaigns can be backed up or moved between devices.

## 8. Future systems (architected, not implemented)
- **Player character** (`src/characters`): Character, Commander, ArmyCommander, PlayerCharacter with a
  `controlMode` for future direct control (soldier, vehicle crew, remote uplink, transferred mind).
- **Research**: tier 1 is in (4.9); further tiers plug into the same `TechDef`/`TechEffect` registry.
- **Unit designer**: designs are data; new chassis/engines/weapons/AI cores slot into the component model.
- Real physical logistics (convoys already exist), multiple bases per faction (supported by the data model),
  aliens, Earth war events, mechs.

## 9. Balance knobs
`src/data/*.ts` (costs, rates, weapons), `economy/economy.ts` (food, growth, storage), `campaign/diplomacy.ts`
(tension), `battle/types.ts` (battle scale/time), `ai/*`. Use `npm run sim:campaign` and `npm run sim:battle`.
