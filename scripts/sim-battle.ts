// Dev helper: run auto-resolved battles between custom forces for balance checks.
// Usage: npx tsx scripts/sim-battle.ts   (ONLY=<label substring> runs matching lines only)
import { createCampaign } from '../src/campaign/newCampaign';
import { makeContext } from '../src/campaign/context';
import { createArmy } from '../src/campaign/armies';
import { makeBuilding, suggestPlacement } from '../src/campaign/construction';
import { BUILDINGS, type BuildingTypeId } from '../src/data/buildings';
import { createUnit } from '../src/campaign/units';
import { basesOf } from '../src/campaign/queries';
import { createBattleSetup } from '../src/battle/setup';
import { BattleSim } from '../src/battle/sim';
import type { PendingBattle } from '../src/campaign/types';

const { state, world } = createCampaign(4242);
const ctx = makeContext(state, world);
// fight at noon so the matrix measures the units, not the light (campaign starts at 06:00)
state.time = Number(process.env.HOUR_OFFSET ?? 6);
const [pf, ef] = Object.keys(state.factions);
const pBase = basesOf(state, pf)[0];

function force(f: string, comp: Record<string, number>, x: number, z: number) {
  const units = [];
  for (const [d, n] of Object.entries(comp)) for (let i = 0; i < n; i++) units.push(createUnit(state, d));
  return createArmy(ctx, f, x, z, units, null);
}

/** Crewed defences on the side of the player base facing the attacker (+x,+z). Returns their ids. */
function fortify(bunkers: number, ats: number): string[] {
  const ids: string[] = [];
  const types: BuildingTypeId[] = [...Array(bunkers).fill('bunker'), ...Array(ats).fill('at_emplacement')];
  types.forEach((t, k) => {
    const a = Math.PI / 4 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.5;
    const spot = suggestPlacement(state, world, pBase, t, pBase.x + Math.cos(a) * 7, pBase.z + Math.sin(a) * 7);
    if (!spot) return;
    const b = makeBuilding(state, t, pBase, spot.x, spot.z, Math.atan2(Math.cos(a), Math.sin(a)), null, true);
    b.workers = BUILDINGS[t].workers;
    state.buildings[b.id] = b;
    ids.push(b.id);
  });
  pBase.stock.ammo = 200;
  return ids;
}

function run(label: string, a: Record<string, number>, b: Record<string, number>, kind: 'field' | 'base_assault', trials = 6, flip = 1, forts?: [number, number]) {
  if (process.env.ONLY && !label.includes(process.env.ONLY)) return;
  const fortIds = forts ? fortify(forts[0], forts[1]) : [];
  let wins = [0, 0, 0];
  let dur = 0;
  let lossA = 0, lossB = 0;
  const t0 = performance.now();
  for (let k = 0; k < trials; k++) {
    const x = pBase.x + 30, z = pBase.z + 20;
    const A = force(ef, a, kind === 'base_assault' ? pBase.x + 3 : x + flip, kind === 'base_assault' ? pBase.z + 3 : z);
    const B = force(pf, b, x - flip, z);
    const p: PendingBattle = {
      id: 'test' + k, kind, x: kind === 'base_assault' ? pBase.x : x, z: kind === 'base_assault' ? pBase.z : z,
      attackerFactionId: ef, defenderFactionId: pf, attackerArmyIds: [A.id], defenderArmyIds: [B.id],
      baseId: kind === 'base_assault' ? pBase.id : null, buildingId: null, createdAt: 0, seed: 1000 + k * 77,
    };
    if (kind === 'base_assault') { p.defenderArmyIds = [B.id]; B.x = pBase.x; B.z = pBase.z; }
    const setup = createBattleSetup(state, world, p);
    const sim = new BattleSim(setup, world.terrain, { aiSides: [0, 1] });
    while (!sim.finished && sim.time < 900) { sim.step(0.25); sim.events.length = 0; }
    if (!sim.finished) sim.finish(null, 'timeout');
    const r = sim.computeResult();
    wins[r.winner === null ? 2 : r.winner]++;
    dur += r.durationSeconds;
    lossA += r.sides[0].unitsLost / r.sides[0].unitsStart;
    lossB += r.sides[1].unitsLost / Math.max(1, r.sides[1].unitsStart);
    const bdest = r.buildings.filter((b) => b.destroyed).length;
    if (k === 0) console.log(`   sample: winner=${r.winner} reason=${r.reason} t=${r.durationSeconds.toFixed(0)}s lossA=${r.sides[0].unitsLost}/${r.sides[0].unitsStart} lossB=${r.sides[1].unitsLost}/${r.sides[1].unitsStart} ammoA=${r.sides[0].ammoSpent.toFixed(0)} fuelA=${r.sides[0].fuelSpent.toFixed(1)} bldDestroyed=${bdest}`);
    delete state.armies[A.id]; delete state.armies[B.id];
  }
  for (const id of fortIds) delete state.buildings[id];
  const ms = (performance.now() - t0) / trials;
  console.log(`${label.padEnd(36)} atkWins=${wins[0]} defWins=${wins[1]} draws=${wins[2]} avgDur=${(dur / trials).toFixed(0)}s lossA=${(lossA / trials * 100).toFixed(0)}% lossB=${(lossB / trials * 100).toFixed(0)}% ${ms.toFixed(0)}ms/battle`);
}

if (!process.env.FORTS_ONLY) run('4 inf vs 4 inf', { rifle_squad: 4 }, { rifle_squad: 4 }, 'field');
run('2 tank vs 6 inf', { mbt: 2 }, { rifle_squad: 6 }, 'field');
run('6 inf vs 2 tank', { rifle_squad: 6 }, { mbt: 2 }, 'field');
run('4 jeep vs 4 inf', { recon_jeep: 4 }, { rifle_squad: 4 }, 'field');
run('2 tank vs 4 jeep', { mbt: 2 }, { recon_jeep: 4 }, 'field');
run('2 tank vs 2 tank', { mbt: 2 }, { mbt: 2 }, 'field');
run('start army vs start army', { rifle_squad: 3, recon_jeep: 2, mbt: 1 }, { rifle_squad: 3, recon_jeep: 2, mbt: 1 }, 'field');
run('start army FLIPPED', { rifle_squad: 3, recon_jeep: 2, mbt: 1 }, { rifle_squad: 3, recon_jeep: 2, mbt: 1 }, 'field', 6, -1);
run('mixed 12 vs mixed 12', { rifle_squad: 6, recon_jeep: 3, mbt: 3 }, { rifle_squad: 6, recon_jeep: 3, mbt: 3 }, 'field');
run('mixed 12 FLIPPED', { rifle_squad: 6, recon_jeep: 3, mbt: 3 }, { rifle_squad: 6, recon_jeep: 3, mbt: 3 }, 'field', 6, -1);
run('base assault 8 vs garrison 4', { rifle_squad: 4, recon_jeep: 2, mbt: 2 }, { rifle_squad: 3, mbt: 1 }, 'base_assault');
run('3 ATGM vs 2 tank', { atgm_team: 3 }, { mbt: 2 }, 'field');
run('3 ATGM vs 4 inf', { atgm_team: 3 }, { rifle_squad: 4 }, 'field');
run('2 tank + 2 ATGM vs 3 tank', { mbt: 2, atgm_team: 2 }, { mbt: 3 }, 'field');
run('base assault 8 vs garrison 4 + 2 BNK 1 ATG', { rifle_squad: 4, recon_jeep: 2, mbt: 2 }, { rifle_squad: 3, mbt: 1 }, 'base_assault', 6, 1, [2, 1]);
run('base assault 8 vs 2 BNK 1 ATG only', { rifle_squad: 4, recon_jeep: 2, mbt: 2 }, {}, 'base_assault', 6, 1, [2, 1]);
run('6 inf assault vs 2 BNK only', { rifle_squad: 6 }, {}, 'base_assault', 6, 1, [2, 0]);
run('3 tank assault vs 1 BNK 2 ATG', { mbt: 3 }, {}, 'base_assault', 6, 1, [1, 2]);
run('big 30 vs 30', { rifle_squad: 16, recon_jeep: 6, mbt: 8 }, { rifle_squad: 16, recon_jeep: 6, mbt: 8 }, 'field', 2);
