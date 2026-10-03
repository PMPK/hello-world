# CURRENT STATE

*Last updated: post-MVP iteration (defences, battle unit card, async auto-resolve).*

## What works

- **Full gameplay loop**: main menu (live 3D map preview) → intro → strategic map → contact report →
  tactical battle *or* auto-resolve → after-action report → results persisted → campaign continues.
- **Strategic map**: seeded continent (plains, forests, hills, mountains, coasts, lakes), two expeditions,
  resource sites, roads, bases with real building models, army tokens with banners, convoy trucks,
  perimeter rings, NATO-style symbols and labels, strategic fog of war, pan/zoom/rotate (touch + mouse + keys).
- **Time**: real-time with pause, 1×/2×/4×; fixed-step deterministic simulation; frozen during battles;
  clock advanced by battle duration afterwards.
- **Economy**: workforce allocation, power grid with fuel-burning plants, storage caps, recipes with
  Auto/fixed modes and stock targets, extractor outposts with buffers and convoys, food and population
  growth, Earth supply shuttles, garrison resupply/replacements/field repairs, building repair/rebuild.
- **Construction**: 10 buildable types with placement preview (valid/invalid ghost), cancel/refund,
  outposts on resource sites with automatic roads.
- **Defences**: MG bunker and AT gun emplacement — crewed from the workforce, supplied from base AMMO,
  fight on their own in any battle at their base (traversing AT gun, armour/profile/crew exposure),
  lose crew when hit or destroyed; counted in base strength; the AI fortifies when tension rises.
- **Units**: rifle squads, recon jeeps, main battle tanks derived from modular components; production
  consumes people + materials; garrison → task force deployment; garrison/reinforce at bases.
- **Armies**: pathfinding on terrain/roads, rations, fuel consumption, resupply near bases, attack/pursuit,
  return; named commanders.
- **Diplomacy**: standoff with rising tension → AI goes weapons-free at 100%; player attacks start hostilities.
- **Battles**: battlefield generated from the campaign terrain; base buildings mapped in at real positions;
  deployment from approach direction; fog of war with LOS and concealment; directional armour; cover;
  suppression; ammo & fuel; reserves; building damage/destruction; withdraw; end battle; minimap;
  touch selection (tap, ALL, TYPE, BOX, double-tap same type) and commands (tap, long-press attack-move,
  HOLD, STOP, FALL BACK); mouse/keyboard RTS controls. **Unit card**: tappable selection grid, single-unit
  details (men, HP, ammo, fuel, weapons and ranges, current order, cover/suppression/ammo flags),
  follow camera (V) and clear selection.
- **Tactical AI**: memory under fog, recon, tank stand-off/high ground, infantry cover & AT ambushes,
  flanking group, focus fire, fallback, wait-when-outmatched, withdrawal; siege defence; reduces enemy
  fortifications with the right arm (tanks vs bunkers, infantry vs AT gun pits).
- **Strategic AI**: needs-based build order, staffing/manpower-aware recruitment, raids on outposts,
  base assaults, defence recalls, fuel/readiness checks, refits after defeats.
- **Results**: casualties, rescued crews returning to population, damage/ammo/fuel persisted, buildings
  destroyed/damaged, base and outpost capture, loser retreats, stats and log.
- **Saves**: IndexedDB (fallbacks), versioned envelope + migrations, autosave (timer, app hidden, battles),
  manual save, continue, reset.
- **PWA**: manifest (fullscreen, landscape), generated icons, Workbox precache (offline), install prompt button.
- **Quality settings**: low / medium / high (pixel ratio, shadows, tree density); FPS counter option.
- **Auto-resolve** runs in time slices with a progress dialog (no main-thread freeze on phones).
- **Tests**: 41 Vitest unit tests; Playwright smoke tests on phone-landscape touch and desktop mouse profiles
  (full loop incl. unit card, save/continue; fortified base assault).
- **Deployment**: GitHub Actions CI + Pages deploy workflow (gh-pages branch). A single-file build is also
  published as a claude.ai Artifact (https://claude.ai/artifact/7qGUMq5vWjnaNKRHEyempW).

## Deployment status (end of the MVP session)

- The Claude GitHub App had **no write access** to `PMPK/hello-world` (git push and the GitHub connector both
  returned 403), so the MVP commits could not be pushed from the session. The full history was handed over as
  a git bundle. Once access exists (or the bundle is pushed by hand), pushing `claude/planet-x-mvp-1f1t2m`
  and/or `main` triggers the deploy workflow.
- GitHub Pages must be switched on once: *Settings → Pages → Source: Deploy from a branch → gh-pages / (root)*.

## Known issues / limitations

- Strategic AI has full knowledge of the map (no fog of war for the AI).
- Field armies cannot resupply away from a base (no supply trucks yet); tanks on long marches can run dry —
  intended logistics pressure. The army panel shows fuel range and the map flags LOW FUEL / LOW AMMO.
- Battle unit separation is simple; large groups can jostle around obstacles. Paths are re-planned when blocked.
- Infantry squads are drawn as up to 6 figures; there are no death animations (squads shrink).
- Buildings block movement as circles; no garrisoning of infantry inside buildings.
- Only one pending battle at a time; simultaneous contacts are resolved sequentially.
- The campaign continues after a faction is broken (sandbox) but there is no "recover expedition" flow
  for a player who lost every base and army other than starting a new campaign.
- No audio.
- AI difficulty is not configurable yet.
- Defences only fight inside the 800 m battlefield around the contact point; positions have no firing arcs
  (they traverse freely) and silenced positions are re-crewed by the economy after the battle.
- Headless Chromium uses SwiftShader in tests; real-device performance has been budgeted (≈100k triangles on
  medium) but not profiled on a physical phone in this session.

## Unfinished systems (extension points only)

- Research/technology (`src/research/research.ts` registry is empty).
- Unit designer (component model ready, no UI).
- Player character direct control (data model in `src/characters/`).
- Multiple bases per faction (data model supports it; no "found a base" action yet).

## Best next tasks

1. Supply trucks / field resupply (fuel range is already shown; no way to refuel in the field yet).
2. Defences: let the player see/attack enemy positions from the campaign map (intel), and garrison
   infantry inside bunkers.
3. Infantry garrisoning buildings in battle (cover + capture mechanics).
4. AI scouting and strategic fog of war for the AI; difficulty setting.
5. Founding new bases from outposts; transferring population.
6. Battle simulation in a Web Worker; spatial hash for targeting.
7. Audio (radio chatter, gunfire, ambience).
8. Tutorial scenario using the directive system in `CampaignHud.updateDirective`.
