// Dev helper: prints an ASCII preview of the generated terrain for a seed.
// Usage: npx vite-node scripts/terrain-preview.ts <seed>   (or via vitest)
import { generateTerrain, BIOME } from '../src/world/terrain';

const seed = Number(process.argv[2] ?? 12345);
const t = generateTerrain(seed);
const chars: Record<number, string> = {
  [BIOME.water]: '~',
  [BIOME.beach]: '.',
  [BIOME.plains]: ',',
  [BIOME.forest]: 'T',
  [BIOME.hills]: 'n',
  [BIOME.mountains]: 'M',
  [BIOME.snow]: '^',
};
const counts: Record<string, number> = {};
let out = '';
for (let j = 0; j < t.grid; j += 2) {
  for (let i = 0; i < t.grid; i += 1) {
    const b = t.biomes[j * t.grid + i];
    out += chars[b];
  }
  out += '\n';
}
for (let k = 0; k < t.biomes.length; k++) counts[chars[t.biomes[k]]] = (counts[chars[t.biomes[k]]] ?? 0) + 1;
console.log(out);
console.log(counts);
