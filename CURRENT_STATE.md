# CURRENT STATE

*Last updated: post-MVP iteration (research, ATGM teams, AI contact hunting, base supply reach).*

## What works

- **Full gameplay loop**: main menu (live 3D map preview) → intro → strategic map → contact report →
  tactical battle *or* auto-resolve → after-action report → results persisted → campaign continues.
- **Navigation**: expedition overview (all bases with shortage warnings and all task forces with orders,
  composition and fuel range; tap to jump), next-base / next-task-force buttons, event log; 10-step
  directive tutorial (economy → military → research → fortify → expand).
- **Strategic map**: seeded continent (plains, forests, hills, mountains, coasts, lakes), two expeditions,
  resource sites, roads, bases with real building models, army tokens with banners, convoy trucks,
  perimeter rings, NATO-style symbols and labels, strategic fog of war, pan/zoom/rotate (touch + mouse + keys).
- **Time**: real-time with pause, 1×/2×/4×; fixed-step deterministic simulation; frozen during battles;
  clock advanced by battle duration afterwards. **Day/night** lighting from the clock on the map and in
  battles; night shortens sight except for thermal (tanks) and recon optics.
- **Economy**: workforce allocation, power grid with fuel-burning plants, storage caps, recipes with
  Auto/fixed modes and stock targets, extractor outposts with buffers and convoys, food and population
  growth, Earth supply shuttles, garrison resupply/replacements/field repairs, building repair/rebuild.
- **Construction**: 11 buildable types with placement preview (valid/invalid ghost), cancel/refund,
  outposts on resource sites with automatic roads.
- **Defences**: MG bunker and AT gun emplacement — crewed from the workforce, supplied from base AMMO,
  fight on their own in any battle at their base (traversing AT gun, armour/profile/crew exposure),
  lose crew when hit or destroyed; counted in base strength; the AI fortifies when tension rises.
- **Research**: Research Lab (one per base, 1 RP/h) works on one project at a time; seven tier-1
  technologies (extraction, food, construction, industry, logistics, hardened defences, ATGM Teams) with
  prerequisites; switching projects keeps progress; tech descriptions shown on the lab panel's buttons.
  The AI builds a lab once its industry stands (after its first bunker when threatened) and researches the whole tier.
- **Units**: rifle squads, ATGM teams (research), recon jeeps, main battle tanks and supply trucks derived from modular components;
  production consumes people + materials, with **continuous production** (repeat a design); garrison →
  task force deployment; garrison/reinforce at bases; **split** a task force and **merge** nearby ones.
- **Armies**: pathfinding on terrain/roads, rations, fuel consumption, resupply at bases (inside the
  perimeter or within 4 km; "Supplied by …" in the army panel; a warning when rations run out), attack/pursuit,
  return; named commanders. **Supply trucks** keep task forces fuelled and armed in the field (pooled fuel
  range, extra rations, cargo shown in the army panel) and rearm nearby units in battle.
- **Diplomacy**: standoff with rising tension → AI goes weapons-free at 100%; player attacks start hostilities.
- **Battles**: battlefield generated from the campaign terrain; base buildings mapped in at real positions;
  deployment from approach direction; fog of war with LOS and concealment; directional armour; cover;
  suppression; ammo & fuel; reserves; building damage/destruction; withdraw; end battle; minimap;
  touch selection (tap, ALL, TYPE, BOX, double-tap same type) and commands (tap, long-press attack-move,
  HOLD, STOP, FALL BACK); mouse/keyboard RTS controls. **Unit card**: tappable selection grid, single-unit
  details (men, HP, ammo, fuel, weapons and ranges, current order, cover/suppression/ammo flags),
  follow camera (V) and clear selection. **Garrisons**: infantry occupy friendly buildings (tap the
  building; capacity 1–3 squads) for cover, height and concealment; heavy hits and collapses hurt them.
- **Tactical AI**: memory under fog, recon, tank stand-off/high ground, infantry cover & AT ambushes,
  flanking group, focus fire, fallback, wait-when-outmatched, withdrawal; siege defence; reduces enemy
  fortifications with the right arm (tanks vs bunkers, infantry vs AT gun pits); siege defenders garrison
  the buildings facing the attack and tanks shell spotted garrisons; missile teams stand off
  against armour; when contact is lost it probes last-known positions and sweeps the enemy's rear, and a
  beaten remnant withdraws even out of sight (no more stalled draws against a hidden, crippled tank).
- **Strategic AI**: needs-based build order, staffing/manpower-aware recruitment, raids on outposts,
  base assaults, defence recalls, fuel/readiness checks, refits after defeats; **strategic fog of war**
  (it only targets and reacts to player forces it can see).
- **Difficulty** (main menu, per campaign): Easy / Normal / Hard tune the rival's economy speed,
  caution, offensive tempo, tension drift and battlefield reaction time/flanking.
- **Results**: casualties, rescued crews returning to population, damage/ammo/fuel persisted, buildings
  destroyed/damaged, base and outpost capture, loser retreats, stats and log.
- **Saves**: IndexedDB (fallbacks), versioned envelope + migrations, autosave (timer, app hidden, battles),
  three manual slots, Load game (load/delete per slot), export to a file or clipboard and import from a
  file or pasted text (validated + migrated), continue, reset.
- **PWA**: manifest (fullscreen, landscape), generated icons, Workbox precache (offline), install prompt button.
- **Quality settings**: low / medium / high (pixel ratio, shadows, tree density); FPS counter option.
- **Visual polish**: animated water shimmer (map and battlefield), dust trails behind moving vehicles
  (medium/high), persistent scorch marks where heavy rounds and vehicles exploded, base lamps that come
  on after dusk — each a single extra draw call at most.
- **Audio**: procedural WebAudio — positional gunfire per weapon class, cannon/explosion booms, order
  acknowledgements, radio chirps for reports, contact alarm, wind ambience; Sound Off/Low/Medium/High in
  settings, M to mute.
- **Auto-resolve** runs in time slices with a progress dialog (no main-thread freeze on phones).
- **Tests**: 81 Vitest unit tests; Playwright smoke tests on phone-landscape touch and desktop mouse profiles
  (full loop incl. unit card, save/continue, save-slot listing and import; fortified base assault;
  task force split/merge; founding a base; research lab project switching; tap-to-garrison in a base battle).
- **Save schema v5** (Building.repeat in v2, CampaignState.difficulty in v3, research shelf in v4, relief
  landing state per faction in v5) with migrations from v1.
- **Deployment**: GitHub Actions CI + Pages deploy workflow (gh-pages branch). A single-file build is also
  published as a claude.ai Artifact (https://claude.ai/artifact/7qGUMq5vWjnaNKRHEyempW).

## Deployment status (end of the MVP session)

- The Claude GitHub App had **no write access** to `PMPK/hello-world` (git push and the GitHub connector both
  returned 403), so the MVP commits could not be pushed from the session. The full history was handed over as
  a git bundle. Once access exists (or the bundle is pushed by hand), pushing `claude/planet-x-mvp-1f1t2m`
  and/or `main` triggers the deploy workflow.
- GitHub Pages must be switched on once: *Settings → Pages → Source: Deploy from a branch → gh-pages / (root)*.

## Known issues / limitations

- Field armies without supply trucks cannot resupply away from a base; trucks themselves only refill at bases.
  The army panel shows fuel range and truck cargo; the map flags LOW FUEL / LOW AMMO.
- Battle unit separation is simple; large groups can jostle around obstacles. Paths are re-planned when blocked.
- Infantry squads are drawn as up to 6 figures; there are no death animations (squads shrink).
- Buildings block movement as circles. Garrisoned squads are invisible as figures (badge only) and fire
  from the building centre; there is no capturing of enemy buildings by infantry.
- Only one pending battle at a time; simultaneous contacts are resolved sequentially.
- Recovery is limited to two relief landings per expedition; after that a side that loses every base
  stays broken (the campaign continues as a sandbox).
- Audio is procedural and minimal (no music, no voice lines); browsers start it only after the first tap/key.
- Defences only fight inside the 800 m battlefield around the contact point; positions have no firing arcs
  (they traverse freely) and silenced positions are re-crewed by the economy after the battle.
- Headless Chromium uses SwiftShader in tests; real-device performance has been budgeted (≈100k triangles on
  medium) but not profiled on a physical phone in this session.

- **Recovery**: an expedition that loses every base gets a relief landing from Earth 3 days later (max
  twice): finished HQ/habitat/agri-dome, 30 colonists, supplies, two squads, on safe free ground. NO BASE
  chip with the countdown in the top bar; the camera jumps to the new base.
- **Expansion**: found new bases (base panel → Found new base…, pick a site on the map): colonists,
  starter supplies and a prefab command post leave the founding base; the terrain is flattened at
  runtime; a road links the bases and **supply convoys** keep the young base stocked. The AI founds a
  second base once established. Field-camp housing/storage until the HQ is assembled.

## Unfinished systems (extension points only)

- Research beyond tier 1 (AI, robotics, drones, alien technology… categories reserved in `src/research`).
- Unit designer (component model ready, no UI).
- Player character direct control (data model in `src/characters/`).

## Dev tools
`npm run sim:campaign -- <seed> <days>` (`BATTLE_DETAIL=1` prints each battle's forces; research progress
is listed per day), `npm run sim:battle` (`ONLY=<label>` filters matrix lines), `npm run sim:trace --
'{"mbt":2}' '{"rifle_squad":4}' [seed]` traces one AI-vs-AI field battle (positions, orders, tasks, shots).

## Best next tasks

1. Logistics depth: convoys that resupply field armies from bases; trucks as convoy escorts/targets.
2. Defences: let the player see/attack enemy positions from the campaign map (intel), and garrison
   infantry inside bunkers.
3. Infantry capturing enemy structures in battle; garrisoning bunkers (extra crew).
4. AI scouting behaviour (recon patrols) to make use of its fog of war; per-difficulty starting bonuses.
5. Manual supply/population transfers between bases; base specialisation.
6. Battle simulation in a Web Worker; spatial hash for targeting.
7. Audio polish: music stems, distant battle rumble on the campaign map, per-faction radio voices.
8. Tutorial scenario using the directive system in `CampaignHud.updateDirective`.
