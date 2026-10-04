// Dev helper: trace one auto-resolved field battle (positions, tasks, fire) for AI debugging.
// Usage: npx tsx scripts/trace-battle.ts '{"mbt":2,"atgm_team":2}' '{"mbt":3}' [seed]
import { createCampaign } from '../src/campaign/newCampaign';
import { makeContext } from '../src/campaign/context';
import { createArmy } from '../src/campaign/armies';
import { createUnit } from '../src/campaign/units';
import { basesOf } from '../src/campaign/queries';
import { createBattleSetup } from '../src/battle/setup';
import { BattleSim } from '../src/battle/sim';
import type { PendingBattle } from '../src/campaign/types';

const a = JSON.parse(process.argv[2] ?? '{"mbt":2,"atgm_team":2}') as Record<string, number>;
const b = JSON.parse(process.argv[3] ?? '{"mbt":3}') as Record<string, number>;
const seed = Number(process.argv[4] ?? 1000);
const every = Number(process.env.EVERY ?? 10);
const { state, world } = createCampaign(4242);
const ctx = makeContext(state, world);
state.time = 6;
const [pf, ef] = Object.keys(state.factions);
const pBase = basesOf(state, pf)[0];
const force = (f: string, comp: Record<string, number>, x: number, z: number) => {
  const units = [];
  for (const [d, n] of Object.entries(comp)) for (let i = 0; i < n; i++) units.push(createUnit(state, d));
  return createArmy(ctx, f, x, z, units, null);
};
const x = pBase.x + 30;
const z = pBase.z + 20;
const A = force(ef, a, x + 1, z);
const B = force(pf, b, x - 1, z);
const p: PendingBattle = {
  id: 'trace', kind: 'field', x, z, attackerFactionId: ef, defenderFactionId: pf, attackerArmyIds: [A.id], defenderArmyIds: [B.id],
  baseId: null, buildingId: null, createdAt: 0, seed,
};
const sim = new BattleSim(createBattleSetup(state, world, p), world.terrain, { aiSides: [0, 1] });
let next = 0;
const fired = new Map<number, number>();
while (!sim.finished && sim.time < 900) {
  sim.step(0.25);
  for (const e of sim.events) if (e.type === 'shot') fired.set(e.shooter, (fired.get(e.shooter) ?? 0) + 1);
  sim.events.length = 0;
  if (sim.time >= next) {
    next += every;
    console.log(`t=${sim.time.toFixed(0)}`);
    for (const u of sim.units) {
      if (!u.alive) continue;
      console.log(`  s${u.side} #${u.id} ${u.stats.designId.padEnd(12)} (${u.x.toFixed(0)},${u.z.toFixed(0)}) hp ${u.hp.toFixed(0)}/${u.stats.maxHp} ammo ${u.ammo.toFixed(1)} ${u.order.type}${u.order.type === 'attack' ? ':' + u.order.target.id : ''} task=${u.task} seen0=${u.seenBy[0]} seen1=${u.seenBy[1]} fired=${fired.get(u.id) ?? 0}${u.retreated ? ' RETREATED' : ''}`);
    }
  }
}
const r = sim.computeResult();
console.log(`winner=${r.winner} reason=${r.reason} t=${r.durationSeconds.toFixed(0)} lossA=${r.sides[0].unitsLost}/${r.sides[0].unitsStart} lossB=${r.sides[1].unitsLost}/${r.sides[1].unitsStart}`);
