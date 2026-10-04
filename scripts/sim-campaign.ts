// Dev helper: run a campaign headless (battles auto-resolved) and print economy/AI stats.
// Usage: npx tsx scripts/sim-campaign.ts [seed] [days]
//        PLAYER_ATTACKS=1 npx tsx scripts/sim-campaign.ts 1234 30
//        BATTLE_DETAIL=1 also prints each battle's forces and outcome
import { createCampaign } from '../src/campaign/newCampaign';
import { makeContext } from '../src/campaign/context';
import { advanceCampaign } from '../src/campaign/sim';
import { armiesOf, basesOf } from '../src/campaign/queries';
import { orderAttack } from '../src/campaign/armies';
import { BUILDINGS } from '../src/data/buildings';
import { createBattleSetup } from '../src/battle/setup';
import { autoResolve } from '../src/battle/autoresolve';
import { applyBattleResult } from '../src/battle/result';

const seed = Number(process.argv[2] ?? 1234);
const days = Number(process.argv[3] ?? 12);
const t0 = performance.now();
const { state, world } = createCampaign(seed);
console.log('created in', Math.round(performance.now() - t0), 'ms');
const ctx = makeContext(state, world);
let lastLog = 0;
for (let d = 1; d <= days; d++) {
  let guard = 0;
  while (state.time < d * 24 && guard++ < 1000) {
    advanceCampaign(ctx, d * 24 - state.time);
    if (state.pendingBattle) {
      const setup = createBattleSetup(state, world, state.pendingBattle);
      const res = autoResolve(setup, world.terrain);
      const sum = applyBattleResult(ctx, setup, res);
      console.log(`  [battle t=${state.time.toFixed(1)} ${setup.kind} @${setup.locationName}] ${sum.title} | ${sum.lines.join(' | ')}`);
      if (process.env.BATTLE_DETAIL) {
        setup.sides.forEach((s, k) => console.log(`     side ${k} ${s.factionId}: ${s.units.map((u) => `${u.designId}(hp${Math.round(u.hp)} a${Math.round(u.ammo)} f${Math.round(u.fuel)})`).join(' ')}`));
        console.log(`     winner=${res.winner} reason=${res.reason} t=${res.durationSeconds.toFixed(0)}s lost=${res.sides.map((s) => `${s.unitsLost}/${s.unitsStart}`).join(' vs ')}`);
      }
    }
  }
  if (process.env.PLAYER_ATTACKS && d === 3) {
    const pa = Object.values(state.armies).find((a) => state.factions[a.factionId].isPlayer);
    const target = Object.values(state.buildings).find((b) => !state.factions[b.factionId].isPlayer && b.typeId === 'extractor');
    if (pa && target) console.log('  player attack order:', orderAttack(ctx, pa.id, { kind: 'building', id: target.id }));
  }
  for (const f of Object.values(state.factions)) {
    for (const b of basesOf(state, f.id)) {
      const bl = Object.values(state.buildings).filter((x) => x.baseId === b.id);
      const types = bl.map((x) => `${BUILDINGS[x.typeId].short}${x.state === 'construction' ? '*' : x.state === 'destroyed' ? '!' : ''}`).join(' ');
      const st = Object.entries(b.stock).map(([k, v]) => `${k.slice(0, 4)}=${Math.round(v)}`).join(' ');
      console.log(
        `day ${d} ${f.id.padEnd(8)} ${b.name.slice(0, 22).padEnd(22)} pop=${b.population} need=${b.econ.workersNeeded} hous=${b.econ.housing} pwr=${b.econ.energyProduced.toFixed(0)}/${b.econ.energyDemand.toFixed(0)} food/h=${b.econ.foodPerHour.toFixed(2)} gar=${b.garrison.length} armies=${armiesOf(state, f.id).map((a) => a.units.length + ':' + a.order.type).join(',')}`,
      );
      console.log(`         ${st}`);
      console.log(`         ${types}`);
    }
  }
  for (const f of Object.values(state.factions)) {
    const r = f.research;
    if (r && (r.completed.length || r.current)) console.log(`         ${f.id} research: done=[${r.completed.join(',')}] current=${r.current ? `${r.current.techId} ${r.current.progress.toFixed(1)}` : '-'}`);
  }
  const rel = state.relations[0];
  console.log(`         tension=${rel.tension.toFixed(1)} status=${rel.status} convoys=${Object.keys(state.convoys).length}`);
  for (const e of state.log.slice(lastLog)) console.log(`   LOG t=${e.t.toFixed(1)} ${e.text}`);
  lastLog = state.log.length;
}
console.log('total ms', Math.round(performance.now() - t0));
