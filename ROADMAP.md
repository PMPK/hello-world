# PLANET X — Roadmap

## ✅ Phase 0 — MVP (this release)
Strategic map ↔ tactical battle loop; production chain economy with people/power/storage/convoys;
9 building types; infantry, jeeps, tanks from modular components; strategic and tactical AI;
standoff/hostility tension; versioned saves; PWA; GitHub Pages deployment.

## Phase 1 — Depth of the current loop
Done since the MVP: MG bunkers and AT gun emplacements that fight in base battles; supply trucks with
field resupply; founding new bases with supply convoys; relief landings; AI fog of war and difficulty
levels; task force split/merge; continuous production; save slots and export/import; procedural audio;
day/night; battle unit card; non-blocking auto-resolve; tier-1 research (Research Lab, ATGM Teams).

Still open:
- Battle: smoke/artillery-free simple doctrine improvements, formations, waypoint queues, unit stances,
  better building cover (garrisoning infantry in structures), destructible bridges/roads.
- Fortifications: bunkers, AT guns, walls, sandbag positions as buildings that fight in battles.
- Logistics: supply trucks attached to armies (field resupply), fuel/ammo depots, convoy escorts and
  convoy battles, interceptable supply lines.
- Multiple bases per faction: founding outposts that grow into bases; transferring people between bases.
- Strategic fog of war for the AI (currently omniscient), AI scouting.
- Diplomacy events, prisoner exchange, cease-fires; more than two expeditions.
- UX: unit/army split & merge, rally points, production repeat, notifications centre, tutorial missions.
- Audio: radio chatter, ambience, weapons.

## Phase 2 — Earth goes dark
- Scripted narrative beats: Earth war hints → loss of contact → independence.
- Ideologies/governments for expeditions; morale and loyalty of the population.
- Research system: tier 1 done (labs, research points, 7 techs); later tiers per Phase 3.

## Phase 3 — New technology
- AI, robotics, drones; unit designer UI on top of the component model (Imperium Galactica 2 / MoO2 /
  Stellaris inspired): chassis, engine, armour, sensors, weapons, electronics, AI cores, power systems.
- Custom vehicles; later mechs.

## Phase 4 — The player in the world
- Player character as a physical entity (Mount & Blade / X4): travels with armies, can be wounded/captured.
- Direct control: command through radio range, take control of a soldier, crew a vehicle, pilot a mech.
- Consciousness transfer into machines; command span growing with technology.

## Phase 5 — Scale
- Alien technology and discoveries.
- Large armies: aggregate battle representation, LOD simulation, worker-thread battle simulation.
- Visual growth of civilisation on the strategic map (towns, rail, airfields).

## Technical backlog
- Move battle simulation and auto-resolve to a Web Worker.
- Spatial hashing for targeting/separation when unit counts grow.
- GPU-instanced campaign buildings; texture atlas for terrain detail; shoreline foam.
- Save slots UI, cloud sync (optional, later).
