# AGENTS.md — instructions for coding agents (Codex, Claude Code, …)

**PLANET X** is a mobile-first web strategy game: Vite + TypeScript + Three.js (WebGL2), installable PWA,
no backend, no UI framework. A continuous strategic map (economy, construction, production, task forces)
leads into real-time tactical battles generated from the same campaign state (including the real base
buildings); battle results are written back into the persistent campaign.

`CLAUDE.md` carries the same rules for Claude Code sessions. Keep the two files in sync.

## Read first (in this order)

1. [CURRENT_STATE.md](CURRENT_STATE.md) — what works, known issues, **best next tasks**, dev tools.
2. [GAME_DESIGN.md](GAME_DESIGN.md) — mechanics, numbers, intent (economy, buildings, units, research, AI).
3. [ARCHITECTURE.md](ARCHITECTURE.md) — module map, data flow, performance budgets, extension recipes.
4. [ROADMAP.md](ROADMAP.md) — where the game is going.

## Rules

- **Keep the core loop intact**: strategic map → contact → tactical battle (or auto-resolve) → results
  persist → strategic map. Read the design docs before changing mechanics.
- **Save compatibility**: `CampaignState` (`src/campaign/types.ts`) is persisted as JSON. When its shape
  changes, bump `STATE_VERSION` and add a migration in `src/persistence/migrations.ts` plus a test.
  Never silently break existing saves. (Current schema: v8.)
- **Mobile first**: landscape Android Chrome is the primary target. Touch targets ≥ 42 px, nothing
  hover-only, keep triangle counts and draw calls low (budgets in ARCHITECTURE.md), test the `low`
  quality profile. Desktop also supports mouse + keyboard.
- **Simulation ≠ rendering**: `campaign/ economy/ ai/ battle/ world/ units/ data/ persistence/ research/`
  must not import Three.js or touch the DOM. Views (`rendering/`, `ui/`) only read state.
- **Determinism**: campaign simulation uses the seeded `Rng` in `SimContext` (never `Math.random()` in
  sim code) and fixed steps (`SIM_STEP`). Rendering may use `Math.random()` for cosmetics.
- **Data-driven content**: buildings, unit components/designs, factions, resources, difficulty and techs
  live in `src/data/` and `src/research/`. Unit stats are derived from components (`src/units/stats.ts`) —
  never hard-code per-unit stats elsewhere.
- **Don't replace working systems** without a reason and tests; extend data tables and existing modules.
- **Rename the game** only via `src/config/gameInfo.ts`.
- **Before every push**: `npm run check` (typecheck + unit tests + production build) must pass. For UI
  or flow changes also run `npm run test:e2e`. Fix failures first.
- **After meaningful work** update CURRENT_STATE.md (what changed, new known issues, next tasks) and the
  design/architecture docs where mechanics or modules changed.

## Commands

```bash
npm ci                          # install (Node 20.19+, 22 recommended)
npm run dev                     # dev server http://localhost:5173
npm run check                   # typecheck + vitest + production build   ← must pass
npm run test:e2e                # Playwright smoke tests (builds + serves on :4173; phone-landscape touch + desktop)
                                #   first time: npx playwright install chromium
npm run sim:campaign -- 1234 30 # headless campaign, battles auto-resolved (BATTLE_DETAIL=1 for forces)
npm run sim:battle              # AI-vs-AI unit match-up matrix (ONLY=<label> filters lines)
npm run sim:trace -- '{"mbt":2}' '{"rifle_squad":4}' [seed]   # trace one AI-vs-AI field battle
npm run build:artifact          # optional: single-file HTML build (claude.ai Artifact); not needed for Pages
```

Write long headless output to a file (`> out.txt`); piped `npx` output is buffered.

## Where things are

| Area | Files |
|---|---|
| Bootstrap, main loop, mode switching, debug API `window.__PX` | `src/main.ts`, `src/app/app.ts` |
| Strategic mode (input → commands, fixed-step sim, overlay, autosave, battle hand-off) | `src/app/campaignMode.ts` |
| Tactical mode (selection, orders, camera, audio) | `src/app/battleMode.ts` |
| Campaign state types + `STATE_VERSION` | `src/campaign/types.ts` |
| New campaign / world rebuild on load | `src/campaign/newCampaign.ts` |
| Campaign step order (economy → convoys → armies → AI → diplomacy → events → encounters → defeat → relief) | `src/campaign/sim.ts` |
| Armies: movement, supply, rations, trucks, split/merge | `src/campaign/armies.ts` |
| Construction, outposts, roads / production queues | `src/campaign/construction.ts`, `src/campaign/production.ts` |
| Founding bases, supply convoys, relief landings | `src/campaign/expansion.ts`, `src/campaign/convoys.ts`, `src/campaign/relief.ts` |
| Contacts → pending battles, outpost capture | `src/campaign/encounters.ts` |
| Diplomacy (standoff → hostile tension), random events, Earth shuttles | `src/campaign/diplomacy.ts`, `src/campaign/events.ts` |
| Per-base economy (workforce, power, recipes, extraction, research, food, population) | `src/economy/economy.ts` |
| Strategic AI (build plan, research, recruitment, raids, assaults, expansion, fog of war) | `src/ai/strategicAI.ts` |
| Battle: setup from campaign, simulation, tactical AI, auto-resolve, result → campaign | `src/battle/{setup,sim,ai,autoresolve,result,terrain,types}.ts` |
| Data tables | `src/data/{buildings,components,unitDesigns,factions,resources,difficulty,lore}.ts` |
| Research (techs, multipliers, unlocks) | `src/research/research.ts` |
| Derived unit / defence stats | `src/units/stats.ts`, `src/units/defense.ts` |
| Terrain, map generation, pathfinding, navigation | `src/world/` |
| Saves (IndexedDB → localStorage → memory), envelope, migrations | `src/persistence/` |
| Rendering (Three.js scenes, models, effects, daylight, water, overlay symbols) | `src/rendering/` |
| Input (pointer gestures, keyboard, RTS camera) | `src/input/` |
| DOM UI (HUDs, menus, modals, saves, minimap, styles) | `src/ui/` |
| Procedural audio | `src/audio/audio.ts` |
| Unit tests (Vitest) / browser smoke tests (Playwright) | `tests/`, `e2e/smoke.spec.ts` |
| Dev scripts (headless sims, icons, artifact build) | `scripts/` |
| CI + GitHub Pages deploy | `.github/workflows/ci.yml`, `.github/workflows/deploy.yml` |

## Debugging in the browser

`window.__PX` exposes `app`, `state()`, `battle()`, `debugContact('field' | 'base_assault')` (spawns a
hostile force next to your army/base and opens the contact dialog) and `debugFortify(types?)` (places
finished buildings, e.g. `['research_lab']`, in the player's base). The e2e tests use these.

## Git and deployment

- Pushing to `main` runs `.github/workflows/deploy.yml` → `gh-pages` branch → GitHub Pages
  (`https://pmpk.github.io/hello-world/`). Pages must be set once: *Settings → Pages → Deploy from a
  branch → gh-pages / (root)*. `ci.yml` runs typecheck, unit tests and build on every push.
- Work on a feature branch and open a PR to `main` unless the owner says otherwise. Don't rewrite
  published history. Use meaningful commit messages.

## Open decisions for the owner

- The original MVP brief said "no research system yet" and "only infantry, jeeps and tanks". After the
  MVP, a small year-2000 research tier (Research Lab, 7 techs, ATGM Teams) and supply trucks (family
  `support`) were added. The owner asked to keep going; if they ask to remove them, research lives in
  `src/research/research.ts`, the `research_lab` building and `atgm_team` design in `src/data/`, and
  their uses are found by searching for `research` / `atgm` / `supply_truck`.
