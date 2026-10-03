# CLAUDE.md — instructions for future Claude Code sessions

This repository is **PLANET X**, a mobile-first web strategy game (Vite + TypeScript + Three.js, PWA,
no backend). Read this file first, then:

1. [CURRENT_STATE.md](CURRENT_STATE.md) — what works, known bugs, best next tasks.
2. [GAME_DESIGN.md](GAME_DESIGN.md) — mechanics, numbers, intent.
3. [ARCHITECTURE.md](ARCHITECTURE.md) — modules, data flow, extension recipes.
4. [ROADMAP.md](ROADMAP.md) — where the game is going.

## Rules

- **Read the design documents before changing mechanics.** Keep the core loop intact:
  strategic map → contact → tactical battle → results persist → strategic map.
- **Preserve save compatibility.** `CampaignState` is persisted. If you change its shape, bump
  `STATE_VERSION` in `src/campaign/types.ts` and add a migration in `src/persistence/migrations.ts`
  (plus a test). Never silently break existing saves.
- **Prioritise mobile.** Landscape Android Chrome is the primary target. Touch targets ≥ 42 px, no hover-only
  UI, keep triangle counts and draw calls low (see budgets in ARCHITECTURE.md), test the `low` quality profile.
- **Keep campaign state separate from rendering.** Simulation code (`campaign/`, `economy/`, `ai/`, `battle/`,
  `world/`, `units/`, `data/`, `persistence/`) must not import Three.js or touch the DOM. Views only read state.
- **Do not replace functioning systems unnecessarily.** Extend data tables and existing modules; refactor
  only with a reason and with tests.
- **Data-driven content.** New buildings/units/factions/resources go in `src/data/`. Unit stats are derived
  from components — never hard-code per-unit stats elsewhere.
- **Determinism.** Campaign simulation uses the seeded `Rng` in `SimContext` (never `Math.random()` in sim code)
  and fixed steps (`SIM_STEP`). Rendering may use `Math.random()` for cosmetics.
- **Test before pushing.** Run `npm run check` (typecheck + unit tests + build). For UI/flow changes also run
  `npm run test:e2e` (Playwright; Chromium is preinstalled in Claude Code cloud sessions). Fix failures first.
- **Update CURRENT_STATE.md** after meaningful work (what changed, new known bugs, next tasks).
- Rename the game only via `src/config/gameInfo.ts`.

## Useful commands

```bash
npm run dev                     # dev server
npm run check                   # typecheck + vitest + production build
npm run test:e2e                # browser smoke tests (phone-landscape touch + desktop mouse)
npm run sim:campaign -- 1234 30 # headless campaign (battles auto-resolved) for balance/AI checks
npm run sim:battle              # headless unit match-up matrix
```

When piping long headless runs, write output to a file (`> out.txt`) — `npx` output through pipes is buffered.

## Debugging in the browser
`window.__PX` exposes `app`, `state()`, `battle()` and `debugContact('field' | 'base_assault')` (spawns a hostile
force next to your army/base and opens the contact dialog). The e2e test uses these.

## Artifact build
`npm run build:artifact` produces `dist-artifact/planet-x.html`: one self-contained HTML (inline CSS/JS,
service worker stubbed out via `src/pwa/stub.ts`) for hosting as a claude.ai Artifact. The published artifact
is https://claude.ai/artifact/7qGUMq5vWjnaNKRHEyempW — republish to that URL (pass it as `url`) to update it.

## Deployment
Pushing to `main` runs `.github/workflows/deploy.yml` → publishes to the `gh-pages` branch → GitHub Pages
(`https://pmpk.github.io/hello-world/`). Pages must be set to *Deploy from a branch: gh-pages / (root)* once.
