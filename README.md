# PLANET X

> **Year 2000.** A second habitable world has secretly been discovered within the Solar System.
> Officially, Planet X does not exist.

A mobile-first web strategy game (working title — change it in [`src/config/gameInfo.ts`](src/config/gameInfo.ts)).
You command a classified expedition on a continuous strategic map — building a real production
chain, raising task forces and moving them across the terrain — and fight real-time tactical
battles on battlefields generated from the same campaign state, including your actual base
buildings. Battle results are permanent.

**Play:**
- GitHub Pages: https://pmpk.github.io/hello-world/ — published by GitHub Actions (see [Deployment](#deployment)).
  Installable as a PWA (Chrome on Android: menu → *Install app*); works offline after the first load.
- claude.ai Artifact build: https://claude.ai/artifact/7qGUMq5vWjnaNKRHEyempW — single-file build
  (`npm run build:artifact`), private to the owner until shared from its Share menu; no offline/PWA there.

## The loop

```
STRATEGIC MAP ──► economy / construction / production / army movement (real-time with pause)
      ▲                         │
      │                         ▼
 results applied ◄── TACTICAL BATTLE (RTS) ◄── contact: armies meet, or a base/outpost is attacked
 (casualties, damage, captures, time)
```

## Controls

| | Touch (phone, landscape) | Mouse & keyboard |
|---|---|---|
| Camera | 1-finger drag pan · pinch zoom · 2-finger twist rotate | drag pan · wheel zoom · right/middle-drag rotate · WASD/arrows · Q/E rotate · R/F zoom |
| Select | tap | left-click (battle: drag a box) |
| Move / attack | with a force selected, tap ground / tap enemy · long-press = attack-move (battle) | right-click ground / enemy |
| Help | Command menu → How to play · ? on the battle bar (shown automatically at the first battle) | same |
| Garrison (battle) | infantry selected → tap one of your buildings · nothing selected → tap it to select its garrison | same with clicks |
| Campaign time | ⏸ 1× 2× 4× buttons | Space pause · 1/2/4 speed |
| Battle | ALL · TYPE · BOX · ATK-MOVE · HOLD · STOP · FALL BACK buttons, minimap tap | Ctrl+A all · A attack-move · H hold · S stop · X fall back · C centre · Esc deselect |

## Features

- Seeded procedural continent: plains, forests, hills, mountains, coasts, lakes, mineral and hydrocarbon sites.
- Real-time-with-pause campaign with day/night; armies move physically along terrain-aware paths; roads speed movement.
- X4-flavoured economy: workforce, power grid, storage, recipes, convoys hauling ore/crude from outposts.
  Raw: minerals, hydrocarbons, food, energy · Processed: refined alloys, components, fuel, ammunition · People.
- 12 building types: HQ, Habitat, Power Plant, Extractor, Agri-Dome, Refinery, Industrial Factory, Barracks,
  Vehicle Depot, Research Lab, MG Bunker, AT Gun Emplacement (defences fight on their own in base battles).
- Units built from modular components (chassis/engine/armour/weapons/sensors): rifle squads, recon jeeps,
  main battle tanks, supply trucks, ATGM teams (research). Continuous production, task force split/merge.
- Expansion: found new bases (automatic supply convoys keep them stocked, or send supplies and colonists by
  hand); relief landings when an expedition loses every base.
- Research: one lab per base, seven tier-1 technologies (economy, logistics, defences, ATGM teams).
- Tactical battles: line of sight, fog of war, directional armour, cover and concealment, suppression, ammo and fuel,
  reserves, structures that can be damaged/destroyed, field resupply from trucks, unit card and follow camera;
  enemy AI that scouts, flanks, keeps tanks at standoff, ambushes with infantry, hunts lost contacts and
  retreats when beaten. Auto-resolve runs the same simulation headless (in time slices, no UI freeze).
- Standoff → hostilities diplomacy (tension), strategic AI (with fog of war and Easy/Normal/Hard difficulty)
  that builds, researches, fortifies, expands, recruits, patrols, raids and attacks.
- Intelligence under the strategic fog of war: contact reports with a jump-to button, last known positions of
  forces that slipped out of view, and dated reports on rival bases (defences, garrison) from when they were in sight.
- Versioned saves in IndexedDB (localStorage fallback), autosave, three manual slots, export/import, continue, reset.
- Procedural WebAudio sound and a generated ambient score; PWA: manifest, service worker, offline cache,
  fullscreen landscape.

## Development

Requires Node 20.19+ (22 recommended).

```bash
npm install
npm run dev          # local dev server (http://localhost:5173)
npm run check        # typecheck + unit tests + production build
npm run test:e2e     # Playwright smoke tests (builds + serves the production bundle)
npm run sim:campaign -- 1234 30   # headless 30-day campaign with auto-resolved battles
npm run sim:battle   # headless balance matrix of unit match-ups
npm run build:artifact   # single self-contained HTML (no service worker) for embedded hosting
```

PWA icons are generated procedurally by `scripts/generate-icons.mjs` (runs automatically before `dev`/`build`).

## Project layout

```
src/
  config/      game identity (title etc.)
  core/        RNG, noise, math, time, events
  data/        data-driven definitions: resources, buildings, unit components & designs, factions, lore
  world/       terrain generation, map layout, A* pathfinding, World runtime
  campaign/    campaign state types + simulation (armies, construction, production, convoys, diplomacy, encounters)
  economy/     per-base economy step (workforce, power, recipes, population, upkeep)
  ai/          strategic AI
  battle/      tactical battle: setup from campaign, terrain, simulation, tactical AI, results, auto-resolve
  units/       stats derived from modular components
  characters/  Character / Commander / ArmyCommander / PlayerCharacter data model
  research/    technologies, research state, multipliers and unlocks
  persistence/ IndexedDB store, versioned save format, migrations
  rendering/   Three.js views (campaign, battle), procedural low-poly models, effects, overlay
  input/       pointer gestures, keyboard, RTS camera rig
  ui/          DOM HUDs, menus, dialogs, minimap, styles
  app/         app shell, modes (menu, campaign, battle), settings
tests/         Vitest unit tests      e2e/  Playwright smoke tests      scripts/  dev tools
```

Read [GAME_DESIGN.md](GAME_DESIGN.md), [ARCHITECTURE.md](ARCHITECTURE.md), [ROADMAP.md](ROADMAP.md) and
[CURRENT_STATE.md](CURRENT_STATE.md) for details. Coding agents: start with [AGENTS.md](AGENTS.md)
(Codex and others) or [CLAUDE.md](CLAUDE.md) (Claude Code); [HANDOFF.md](HANDOFF.md) has a kickoff prompt.

## Deployment

`.github/workflows/deploy.yml` runs on every push to `main` (and to the MVP development branch
`claude/planet-x-mvp-1f1t2m`): install → typecheck → unit tests → build
(base path `/<repo>/` derived from `GITHUB_REPOSITORY`) → publish `dist/` to the `gh-pages` branch.

**One-time setting:** repository *Settings → Pages → Build and deployment → Source: Deploy from a branch →
Branch: `gh-pages` / `(root)` → Save.* After that every push to `main` updates the live site.

`.github/workflows/ci.yml` runs typecheck/tests/build on every branch (and the browser smoke test on PRs).

## License / assets

All code, models (procedural geometry) and icons are original to this project. No third-party game assets.

## Original repository note

> It is my first project over there, and I hope, not the last one
> I am going through the step three and was asked to write some more info about myself so that's what I do now.
