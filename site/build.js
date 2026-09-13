// Builds dist/index.html: one self-contained file (data, CSS and the bundled
// scanner inlined) so it can be hosted anywhere static, with no API behind it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import { listEntries, loadEntry } from '../scanner/registry.js';

const root = new URL('..', import.meta.url).pathname;
const MAX_SHOWN = 256 * 1024;
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|ttf|otf|woff2?|zip|gz|pyc|exe|so|dylib|wasm)$/i;

const entries = listEntries().map(loadEntry).map((e) => ({
  slug: e.slug,
  kind: e.report.kind,
  title: e.meta.title || e.slug,
  summary: e.meta.summary || '',
  tags: e.meta.tags || [],
  works_with: e.meta.works_with,
  setup: e.meta.setup,
  source: e.meta.source,
  review: e.meta.review,
  trust: e.trust,
  hash: e.hash,
  report: e.report,
  files: e.files.map((f) => {
    const skipped = BINARY.test(f.path) || f.bytes > MAX_SHOWN;
    return { path: f.path, bytes: f.bytes, skipped, content: skipped ? '' : f.content };
  }),
}));

const trustOrder = { verified: 0, unreviewed: 1, 'review-stale': 2, blocked: 3 };
entries.sort((a, b) => trustOrder[a.trust] - trustOrder[b.trust] || a.title.localeCompare(b.title));

const bundle = await build({
  entryPoints: [`${root}site/app.js`],
  bundle: true,
  format: 'iife',
  minify: true,
  write: false,
  target: 'es2020',
  charset: 'utf8',
});

// </script> inside skill text must not end the data block early.
const data = JSON.stringify({ built: new Date().toISOString(), entries }).replace(/</g, '\\u003c');
const js = bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = readFileSync(`${root}site/style.css`, 'utf8');
const counts = {
  total: entries.length,
  verified: entries.filter((e) => e.trust === 'verified').length,
};

const html = readFileSync(`${root}site/index.html`, 'utf8')
  .replace('/*CSS*/', () => css)
  .replace('<!--DATA-->', () => data)
  .replace('/*JS*/', () => js)
  .replaceAll('{{TOTAL}}', String(counts.total))
  .replaceAll('{{VERIFIED}}', String(counts.verified));

mkdirSync(`${root}dist/_data`, { recursive: true });
writeFileSync(`${root}dist/index.html`, html);
// The Worker reads this through its ASSETS binding; the public path itself returns 404.
writeFileSync(`${root}dist/_data/registry.json`, JSON.stringify(entries));
console.log(`dist/index.html  ${(html.length / 1024).toFixed(0)} KB  ${counts.total} entries, ${counts.verified} verified`);
