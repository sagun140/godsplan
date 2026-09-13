#!/usr/bin/env node
// Start an MCP server from a server.json, ask it for its tools, and store exactly
// what it advertised. Re-run later with --diff to catch a server whose tool
// descriptions changed after review (the MCP "rug pull").
//
//   node scanner/snapshot-mcp.js registry/<slug>/server.json [--diff] [--set '<placeholder>=value']
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const [path, ...rest] = process.argv.slice(2);
const diff = rest.includes('--diff');
// --set swaps a placeholder arg (e.g. "<folder-you-allow>") for this run only; the file keeps the placeholder.
const sets = Object.fromEntries(rest.flatMap((a, i) => (a === '--set' ? [rest[i + 1].split(/=(.*)/s).slice(0, 2)] : [])));
if (!path) {
  console.error("usage: snapshot-mcp.js <server.json> [--diff] [--set '<placeholder>=value']");
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(path, 'utf8'));
if (!cfg.command) {
  console.error('Only local (command) servers can be snapshotted from the CLI for now.');
  process.exit(2);
}

// Placeholders like "<your-token>" stay placeholders; we never inject real secrets here.
const child = spawn(cfg.command, (cfg.args || []).map((a) => sets[a] ?? a), { env: { ...process.env, ...(cfg.env || {}) }, stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
  }
});
let nextId = 1;
const rpc = (method, params) => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});
const timer = setTimeout(() => {
  console.error('Server did not answer within 60s');
  child.kill();
  process.exit(1);
}, 60_000);

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'godsplan-snapshot', version: '0.1.0' } });
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
const tools = [];
let cursor;
do {
  const page = await rpc('tools/list', cursor ? { cursor } : {});
  tools.push(...page.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));
  cursor = page.nextCursor;
} while (cursor);
clearTimeout(timer);
child.kill();

if (diff) {
  const before = new Map((cfg.tools || []).map((t) => [t.name, JSON.stringify(t)]));
  const after = new Map(tools.map((t) => [t.name, JSON.stringify(t)]));
  const changes = [
    ...[...after.keys()].filter((n) => !before.has(n)).map((n) => `+ new tool: ${n}`),
    ...[...before.keys()].filter((n) => !after.has(n)).map((n) => `- removed tool: ${n}`),
    ...[...after.keys()].filter((n) => before.has(n) && before.get(n) !== after.get(n)).map((n) => `~ changed: ${n}`),
  ];
  console.log(changes.length ? changes.join('\n') : 'No change: the server advertises exactly the reviewed tools.');
  process.exit(changes.length ? 1 : 0);
}

cfg.tools = tools;
writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
console.log(`Captured ${tools.length} tools into ${path}`);
