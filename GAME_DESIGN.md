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

Construction pays the full cost up front; cancelling refunds 75%. Destroyed buildings stay as ruins and
can be rebuilt for 60% of the cost. Buildings below 50% HP work at reduced efficiency; *Repair* consumes
alloys over time. The refinery and factory can be set to *Auto* or a fixed recipe.

Extractors and refinery cost no alloys on purpose: an expedition can always restart its economy from ore.

### 4.5 Military units (modular)

Units are **designs** assembled from components (`src/data/components.ts`, `src/data/unitDesigns.ts`):
chassis (family, mobility, crew, base HP, slots, fuel/ammo capacity, vision), engine (power, fuel use),
armour, weapons, sensors, electronics. All stats are derived (`src/units/stats.ts`).

| Unit | People | Cost | Build | HP | Armour | Speed (m/s) | Map speed | Vision | Weapons | Fuel | Ammo |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Rifle Squad | 6 | 4 ALY · 3 CMP · 6 AMMO | 8h | 240 | 0 | 3.4 | 4.6 | 230 | rifles/LMG (160 m), disposable AT launchers (135 m) | — | 12 |
| Recon Jeep | 3 | 16 ALY · 8 CMP · 10 FUEL · 4 AMMO | 13h | 200 | 4 | 16.5 | 9.5 | 320 | 12.7 mm HMG (175 m) | 20 | 16 |
| Main Battle Tank | 3 | 48 ALY · 32 CMP · 25 FUEL · 10 AMMO | 47h | 900 | 520 | 7.1 | 4.7 | 190 | 120 mm gun (270 m), coax MG (170 m) | 60 | 24 |

Roles: infantry are cheap in materials but expensive in people, see well, hide in forests, and kill tanks
from the flank; jeeps scout and shred infantry in the open but die to anything heavy; tanks dominate open
ground and other vehicles but are half-blind and vulnerable to infantry in cover and from the sides/rear.

### 4.6 Armies (task forces)
- Formed from a base garrison (*Deploy task force*), up to 24 units. Each has a named **commander**
  (character data), units, rations, position, path/destination, speed (slowest unit × terrain), faction.
- Orders: move, attack army (pursuit), attack base, attack outpost (capture), return, stop; garrison /
  reinforce at a base.
- Strategic fog of war: enemy forces are visible only near your bases, outposts and armies.

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
- **Structures** take damage (explicit orders, AI demolition of military production in sieges, and stray
  heavy rounds) and can be destroyed.
- **End**: a side is eliminated or withdraws; timeouts (15 min) — field battles draw, sieges go to whoever
  holds the objective area. The player can withdraw (engaged units may be caught) or end a won battle.

### Tactical AI (`src/battle/ai.ts`)
Respects fog of war (memory of last-seen enemies). Picks objectives; jeeps scout ahead and avoid tanks;
tanks seek high ground at stand-off range and back away from infantry that could carry AT weapons;
infantry advance through cover and ambush vehicles; a flanking group swings around known enemy
concentrations; focus fire on the most dangerous / most damaged targets it can hurt; damaged and dry
units fall back; holds and waits when outmatched; withdraws when the fight is lost. Siege defenders hold
around their buildings and counter-attack when clearly superior.

## 6. Strategic AI (`src/ai/strategicAI.ts`)
Build order driven by needs (housing, food, refinery, oil, power, industry, depot, barracks, more
extractors), staffing-aware; recruits within manpower limits; keeps a home guard; launches raids on
outposts and assaults on bases when its strike force is strong enough **and has the fuel to get there**;
recalls forces to defend; beaten or dry forces return home to refit.

## 7. Persistence
Versioned save envelope + state schema version with migrations, IndexedDB (localStorage fallback),
autosave every 2 minutes (configurable), on hiding the app, and around battles.

## 8. Future systems (architected, not implemented)
- **Player character** (`src/characters`): Character, Commander, ArmyCommander, PlayerCharacter with a
  `controlMode` for future direct control (soldier, vehicle crew, remote uplink, transferred mind).
- **Research** (`src/research`): TechDef/TechEffect registry; `isUnlocked()` already consulted for designs.
- **Unit designer**: designs are data; new chassis/engines/weapons/AI cores slot into the component model.
- Real physical logistics (convoys already exist), multiple bases per faction (supported by the data model),
  aliens, Earth war events, mechs.

## 9. Balance knobs
`src/data/*.ts` (costs, rates, weapons), `economy/economy.ts` (food, growth, storage), `campaign/diplomacy.ts`
(tension), `battle/types.ts` (battle scale/time), `ai/*`. Use `npm run sim:campaign` and `npm run sim:battle`.
