# Handoff — continuing PLANET X with another coding agent

Everything an agent needs is in the repository: [AGENTS.md](AGENTS.md) (rules, commands, code map),
[CURRENT_STATE.md](CURRENT_STATE.md) (what works, known issues, best next tasks), [GAME_DESIGN.md](GAME_DESIGN.md),
[ARCHITECTURE.md](ARCHITECTURE.md) and [ROADMAP.md](ROADMAP.md). Codex reads `AGENTS.md` automatically.

## Before starting an agent

- The code is on GitHub: development happened on `claude/planet-x-mvp-1f1t2m`; `main` is the release
  branch (every push to `main` deploys to GitHub Pages) and carries all of it. Start the agent from `main`.
- GitHub Pages, one time: *Settings → Pages → Build and deployment → Deploy from a branch → `gh-pages` / (root)*.
- Agent environment: Node 22 and `npm ci`. Browser tests also need Chromium:
  `npx playwright install --with-deps chromium` (needs internet during setup).

## Kickoff prompt (copy and paste)

```text
You are taking over development of PLANET X, a mobile-first web strategy game in this repository
(Vite + TypeScript + Three.js, installable PWA, no backend). Another agent built it; everything you need
is in the repo.

1. Read AGENTS.md first (rules, commands, code map), then CURRENT_STATE.md, GAME_DESIGN.md,
   ARCHITECTURE.md and ROADMAP.md.
2. Verify the baseline before changing anything: `npm ci`, then `npm run check` (typecheck + Vitest +
   production build) must pass. If a browser can be installed (`npx playwright install --with-deps
   chromium`), also run `npm run test:e2e`.
3. Continue the work: take the next item from "Best next tasks" in CURRENT_STATE.md (or the task given
   below) and implement it end to end — simulation, UI, tests — keeping the core loop intact:
   strategic map → contact → tactical battle → results persist → strategic map.
4. Non-negotiables: preserve save compatibility (bump STATE_VERSION in src/campaign/types.ts, add a
   migration in src/persistence/migrations.ts and a test whenever CampaignState changes); no Three.js or
   DOM in simulation code; seeded Rng and fixed SIM_STEP in the campaign simulation; data-driven content
   in src/data; mobile-first touch UI (touch targets ≥ 42 px, nothing hover-only, few draw calls).
5. After each feature: `npm run check` green (plus `npm run test:e2e` for UI or flow changes), update
   CURRENT_STATE.md (and GAME_DESIGN.md / ARCHITECTURE.md when mechanics or modules change), commit with a
   clear message, push a branch and open a pull request to main. Merging to main deploys to GitHub Pages.
6. Work autonomously in small verified steps. Do not replace working systems without a reason and tests.
   Use `npm run sim:campaign` / `npm run sim:battle` / `npm run sim:trace` to check balance and AI.

Task for this session: the next item from "Best next tasks" in CURRENT_STATE.md.
```

Replace the last line with a concrete task when you have one (for example: "Intel: alert me when enemy
forces come into view and show what an enemy base holds", "Escorts and repeatable supply runs",
"Infantry can capture enemy buildings in battle", "Move the battle simulation into a Web Worker").

## Open decision

The MVP brief excluded a research system and limited units to infantry, jeeps and tanks. Post-MVP work
added a small research tier (Research Lab, 7 techs, ATGM Teams) and supply trucks. See "Open decisions
for the owner" in [AGENTS.md](AGENTS.md) for how to remove them if wanted.
