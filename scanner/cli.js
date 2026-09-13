#!/usr/bin/env node
// godsplan check <folder-or-file>   scan anything, before you install it
// godsplan check --registry         scan every registry entry (CI runs this)
// godsplan review <slug> --by <github-user> [--notes "..."]
//                                   record a human review pinned to the current content hash
import { readFileSync, writeFileSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { scan } from './core/scan.js';
import { readFolder, listEntries, loadEntry, REGISTRY_DIR, META_FILE, SCANNER_VERSION } from './registry.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const json = args.includes('--json');
const color = process.stdout.isTTY && !json;
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const SEV = { error: paint(31, 'ERROR'), warn: paint(33, 'WARN '), info: paint(36, 'INFO ') };

function printReport(label, report, extra = '') {
  const badge = { clean: paint(32, 'CLEAN'), 'needs-attention': paint(33, 'NEEDS A LOOK'), blocked: paint(31, 'BLOCKED') }[report.status];
  console.log(`\n${paint(1, label)}  ${badge}  (${report.kind})${extra}`);
  for (const f of report.findings) {
    const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '';
    const allowed = f.allowed ? paint(2, ` [allowed: ${f.allowed}]`) : '';
    console.log(`  ${f.allowed ? paint(2, 'ALLOW') : SEV[f.severity]} ${where}  ${f.message}${allowed}`);
    if (!f.allowed && f.severity !== 'info') {
      console.log(paint(2, `         why: ${f.why}`));
      if (f.evidence) console.log(paint(2, `         >   ${f.evidence}`));
    }
  }
  const c = report.counts;
  console.log(paint(2, `  ${c.error} errors, ${c.warn} warnings, ${c.info} notes${c.allowed ? `, ${c.allowed} allowed` : ''}`));
}

function cmdCheck() {
  if (args.includes('--registry')) {
    const results = listEntries().map((slug) => loadEntry(slug));
    if (json) console.log(JSON.stringify(results.map(({ slug, report, trust, hash }) => ({ slug, trust, hash, report })), null, 2));
    else results.forEach((e) => printReport(e.slug, e.report, `  trust: ${e.trust}`));
    const blocked = results.filter((e) => e.trust === 'blocked');
    if (!json) console.log(`\n${results.length} entries, ${blocked.length} blocked`);
    return blocked.length ? 1 : 0;
  }
  const target = args.find((a, i) => i > 0 && !a.startsWith('--'));
  if (!target) {
    console.error('usage: godsplan check <folder-or-file> | --registry');
    return 2;
  }
  const path = resolve(target);
  const report = scan({ files: readFolder(path), dirName: basename(path) });
  if (json) console.log(JSON.stringify(report, null, 2));
  else printReport(target, report);
  return report.status === 'blocked' ? 1 : 0;
}

function cmdReview() {
  const slug = args[1];
  const by = flag('--by');
  if (!slug || !by) {
    console.error('usage: godsplan review <slug> --by <github-user> [--notes "what you checked"]');
    return 2;
  }
  const entry = loadEntry(slug);
  if (entry.trust === 'blocked') {
    printReport(slug, entry.report);
    console.error('\nRefusing to review: fix or explicitly allow every error first.');
    return 1;
  }
  const metaPath = join(REGISTRY_DIR, slug, META_FILE);
  const doc = parseDocument(readFileSync(metaPath, 'utf8'));
  doc.set('review', {
    by,
    date: new Date().toISOString().slice(0, 10),
    hash: entry.hash,
    scanner: SCANNER_VERSION,
    ...(flag('--notes') ? { notes: flag('--notes') } : {}),
  });
  writeFileSync(metaPath, doc.toString());
  console.log(`Reviewed ${slug} by ${by} at ${entry.hash.slice(0, 19)}…`);
  return 0;
}

const commands = { check: cmdCheck, review: cmdReview };
const run = commands[args[0]];
if (!run) {
  console.error('usage: godsplan <check|review> ...');
  process.exit(2);
}
process.exit(run());
