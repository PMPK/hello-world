# PLANET X — Architecture

TypeScript + Vite + Three.js (WebGL2), no UI framework, no backend. Everything runs client-side.

## Principles

1. **Simulation state is plain data.** `CampaignState` (`src/campaign/types.ts`) is JSON-serialisable:
   no classes, no Three.js objects, no Maps. Saving is `JSON.stringify`.
2. **Simulation ≠ rendering.** `campaign/`, `economy/`, `ai/`, `battle/`, `world/`, `units/`, `data/` and
   `persistence/` never import Three.js or touch the DOM. Views (`rendering/`, `ui/`) read state and draw it.
3. **Deterministic stepping.** The campaign advances in fixed 0.1 h steps with a seeded RNG whose state is
   stored in the save. Terrain/navigation are regenerated from the seed on load, so saves stay small.
4. **Data-driven content.** Factions, resources, buildings, unit components and designs are tables in
   `src/data/`. Adding content is mostly adding data.
5. **Small modules, explicit dependencies.** No module-level singletons holding game state.

## Module map

```
src/main.ts                 bootstrap (WebGL2 check, App, service worker)
src/app/
  app.ts                    App shell: renderer, main loop, save manager, mode switching, debug API (window.__PX)
  campaignMode.ts           strategic mode: input → commands, fixed-step sim, overlay, autosave, battle hand-off
  battleMode.ts             tactical mode: BattleSim + BattleView + BattleHud, selection & orders
  settings.ts               graphics quality etc. (localStorage)
src/config/gameInfo.ts      title / version (single place to rename the game)
src/core/                   rng (mulberry32), simplex noise, math, time formatting, event emitter
src/data/                   resources, buildings (+recipes), components, unit designs, factions, lore
src/units/stats.ts          derive UnitStats from a design's components (cached)
src/units/defense.ts        derive DefenseStats (weapons, power, vision) for defensive building types
src/world/
  terrain.ts                heightfield + biomes (pure data), sampling helpers
  mapgen.ts                 base/site placement
  pathfinding.ts            generic 8-way A* (typed-array heap), string-pulling smoothing
  world.ts                  World = terrain + road mask + army/road navigation graphs (rebuilt on load)
src/campaign/
  types.ts                  CampaignState and all entity types; STATE_VERSION
  newCampaign.ts            createCampaign(seed), worldForState(state)
  context.ts                SimContext {state, world, rng}, ids, log
  sim.ts                    stepCampaign / advanceCampaign (fixed step; stops when a battle is pending)
  armies.ts, construction.ts, production.ts, convoys.ts, diplomacy.ts, encounters.ts, events.ts, queries.ts, units.ts
src/economy/economy.ts      per-base economy step (workforce, power, recipes, extraction, units, food, population, upkeep)
src/ai/strategicAI.ts       enemy expedition AI (economy, recruitment, military)
src/battle/
  types.ts                  BattleSetup (JSON), runtime BUnit/BBuilding, BattleResult, constants
  setup.ts                  createBattleSetup(state, world, pending) — campaign → battle mapping
  terrain.ts                battle terrain derived from the strategic terrain around the contact point
  sim.ts                    BattleSim: deployment, orders, movement, visibility, combat, end conditions, results
  ai.ts                     TacticalAI (one per AI-controlled side)
  autoresolve.ts            headless BattleSim with AI on both sides
  result.ts                 applyBattleResult(ctx, setup, result) — battle → campaign mapping
src/characters/character.ts Character / Commander / ArmyCommander / PlayerCharacter (data model)
src/research/research.ts    TECHS registry, ResearchState (current project + shelved progress), multipliers, unlocks
src/persistence/            kvstore (IndexedDB → localStorage → memory), save envelope, migrations
src/rendering/
  renderer.ts               WebGLRenderer + quality profiles + light rig
  campaignView.ts           strategic map scene: terrain mesh, water, instanced trees, roads, bases, armies, convoys, picking
  battleView.ts             battlefield scene: terrain, forests, buildings, instanced units per faction, selection rings
  effects.ts                pooled tracers (1 draw call), flashes/explosions/smoke/dust (1 instanced draw call),
                            scorch-mark ring buffer (1 instanced draw call)
  daylight.ts               time-of-day keyframes: sun/moon, hemisphere light, sky and fog colours
  water.ts                  animated water shimmer injected into MeshStandardMaterial (onBeforeCompile)
  nightLights.ts            additive instanced lamps around structures, faded in by darkness
  settlement.ts             living bases: camp huts that grow with population, parked garrison vehicles
                            (4 instanced meshes, rebuilt only when a base changes)
  overlay.ts                2D canvas overlay: NATO-style symbols, labels, bars, selection box
  models/                   ModelBuilder (low-poly primitives → one geometry with vertex colours), unit/building models, cache
src/audio/music.ts          procedural ambient score (pad chords, plucks, battle pulse) on a lookahead scheduler
src/audio/audio.ts          procedural WebAudio (shared noise buffer + oscillators): spatial gunfire/explosions,
                            UI cues, wind ambience; lazy context on first gesture, voice/frame budgets
src/input/                  PointerInput (tap/double-tap/long-press/drag/pinch/wheel), Keyboard, CameraRig (RTS orbit camera)
src/ui/                     DOM HUDs (campaign, battle), minimap, screens (menu, intro, settings, modals, toasts), styles.css
```

## Data flow

```
             ┌──────────── CampaignMode (per frame) ────────────┐
input ──►    │ commands (orderMove, startConstruction, …)        │
             │ acc += dt·speed·0.5h → stepCampaign(0.1h) × n     │──► CampaignState (mutated)
             │ CampaignView.sync(state) · HUD.update (4 Hz)      │◄── read only
             └───────────────────────────────────────────────────┘
pendingBattle ─► createBattleSetup ─► BattleSetup (JSON)
                  ├─► BattleMode: BattleSim (+TacticalAI for the enemy) + BattleView → BattleResult
                  └─► autoResolve: BattleSim (AI vs AI, headless)              → BattleResult
BattleResult ─► applyBattleResult(ctx) ─► CampaignState (units, buildings, captures, retreats)
                                       └─► advanceCampaign(battle duration)
```

## Campaign ↔ battle mapping
- Units: every campaign `UnitInstance` becomes a `BattleUnitSpec` (with origin: army id or base garrison)
  and comes back as a `BattleUnitResult` (hp, men, ammo, fuel, status).
- Buildings: every campaign building inside the 800 m battlefield becomes a `BattleBuildingSpec` placed
  at `400 + (x − cx) × 20` m; results write hp/destroyed back by campaign id. Defensive types also carry
  `crew` (the building's assigned workers) and `ammo` (their share of the base AMMO stock); the result
  reports `ammoSpent` and `crewLost`, which come off the owning base's stock and population.
- Terrain: battle heights/forests/water sample the strategic terrain around the contact point.
- Time: `campaignHours = battleSeconds × BATTLE_TIME_SCALE / 3600`.
This mapping is generic: new building types or unit designs need no battle-specific code.

## Rendering & performance
- One `WebGLRenderer` shared by all modes. Pixel ratio capped per quality profile; shadows on medium/high.
- Models are built once from primitives into single non-indexed geometries with vertex colours and flat
  normals (`ModelBuilder`), cached per (model, faction colour). Faction colours are baked in, so each
  faction's units are one `InstancedMesh` per model; instance colour only darkens wrecks.
- Trees/rocks are `InstancedMesh`; the strategic map uses 6–8-triangle tree LODs.
- Typical budget (medium): ~100k triangles, ≤60 draw calls on the campaign map; ~100k / ~25 calls in battle.
  Measured (start of a campaign, 915×412): campaign 22 calls / 66k tris on low, 32 / 96k on medium;
  battle 14 / 51k on low, 20 / 81k on medium. Resource sites are 3 instanced meshes; each army token is
  baked into one geometry (+ shared banner parts); settlements are 4 instanced meshes.
- Labels and symbols are drawn on a 2D canvas overlay (no DOM churn). HUD DOM refreshes at 4–5 Hz and
  skips rebuilding while a finger is down or the panel scrolls.

## Input
`PointerInput` unifies mouse/touch/pen. Touch: tap = select/command (context), 1-finger drag = pan,
pinch = zoom + rotate + pan, long-press = attack-move (battle). Mouse: left = select / box select,
right = command, wheel = zoom, right/middle drag = rotate. Keyboard shortcuts per mode.

## Persistence
`SaveManager` stores a `SaveGame` envelope `{format, formatVersion, gameVersion, savedAt, slot, summary, state}`
in IndexedDB (fallback localStorage, then memory). Slots: `autosave`, `manual`. `deserializeSave` validates
and runs `migrateState` (state schema migrations keyed by `STATE_VERSION`).
**When changing `CampaignState`: bump `STATE_VERSION` and add a migration in `persistence/migrations.ts`.**

## Testing
- `tests/*.test.ts` (Vitest, node): RNG/terrain determinism, economy, construction, production, convoys,
  campaign time, army movement & fuel, diplomacy/encounters, save round-trips & migrations, battle setup
  (buildings mapped), sim/orders, auto-resolve determinism, result application.
- `e2e/smoke.spec.ts` (Playwright, Chromium with SwiftShader): full loop on a touch phone-landscape profile
  and a desktop mouse profile, plus base-assault building mapping. Uses `window.__PX` (see `app.ts`).
- `scripts/sim-campaign.ts`, `scripts/sim-battle.ts`: headless balance tools.

## Build & deploy
Vite production build (`base` = `/<repo>/` on GitHub Actions, `/` locally, `VITE_BASE` overrides).
`vite-plugin-pwa` generates the manifest and a Workbox service worker precaching all assets.
`.github/workflows/deploy.yml` publishes `dist/` to the `gh-pages` branch on pushes to `main`.

## Extension recipes
- **New building**: add to `BuildingTypeId` + `BUILDINGS` (`data/buildings.ts`), a model case in
  `rendering/models/buildings.ts`, optionally AI build rules. Battles pick it up automatically.
- **New defensive structure**: as above plus a `defense` block (weapon ids from `data/components.ts`,
  vision, ammo capacity, armour/profile/exposure); a traversing gun needs a case in `buildDefenseTurret`.
  The battle sim, AI targeting, base strength and HUD read everything from the data.
- **New unit**: add components to `data/components.ts` and a design to `data/unitDesigns.ts` (`producedAt`).
  For a new chassis visual, add a model and handle it in `BattleView` / `CampaignView.makeArmy`.
- **New faction**: add a `FactionDef` in `data/factions.ts` and wire it in `newCampaign.ts`.
- **Research**: add a `TechDef` to `TECHS` in `research/research.ts` (cost, prerequisites, effects).
  `modifier` effects are read with `researchMultiplier(research, target)` where the simulation applies them
  (targets: extraction, farm, industry, construction, logistics, defense); `unlock_*` effects gate data via
  `isUnlocked` (production lists, AI recruitment). Add it to `AI_TECH_ORDER` so the rival researches it.
- **Player character control**: extend `PlayerCharacterData.controlMode`; the battle sim already exposes
  per-unit orders that a direct-control mode can drive.
