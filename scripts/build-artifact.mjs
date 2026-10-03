// Packages the artifact build (VITE_TARGET=artifact) into ONE self-contained HTML
// file suitable for hosting as a claude.ai Artifact: inline CSS + inline module JS,
// no service worker, no external files.
// Usage: VITE_TARGET=artifact npx vite build && node scripts/build-artifact.mjs <out.html>
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'dist-artifact';
const html = readFileSync(join(dir, 'index.html'), 'utf8');
const assets = readdirSync(join(dir, 'assets'));
const jsFiles = assets.filter((f) => f.endsWith('.js'));
const cssFiles = assets.filter((f) => f.endsWith('.css'));
if (jsFiles.length !== 1) throw new Error(`expected exactly one JS chunk, got ${jsFiles.join(', ')}`);
let js = readFileSync(join(dir, 'assets', jsFiles[0]), 'utf8');
const css = cssFiles.map((f) => readFileSync(join(dir, 'assets', f), 'utf8')).join('\n');
// keep the HTML parser out of the script body
js = js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const title = (html.match(/<title>([^<]*)<\/title>/) ?? [])[1] ?? 'PLANET X';
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[^>]*src=[^>]*><\/script>/g, '').trim();
const out = `<title>${title}</title>
<meta name="theme-color" content="#0b0f10">
<style>
${css}
</style>
${body}
<script type="module">
${js}
</script>
`;
const target = process.argv[2] ?? 'planet-x-artifact.html';
writeFileSync(target, out);
console.log(`wrote ${target} (${(out.length / 1024).toFixed(0)} KB) from ${jsFiles[0]}`);
