// Pure helpers for the Worker: no bindings, no network, so they run under node --test.
import { parse } from 'yaml';
import { scan, detectKind } from '../scanner/core/scan.js';
import { splitFrontmatter } from '../scanner/core/frontmatter.js';

export const AGENTS = ['Claude Code', 'Claude.ai', 'Claude API', 'Cursor', 'Codex', 'Gemini CLI', 'Copilot', 'Windsurf', 'Other'];
export const MAX_FILES = 60;
export const MAX_BYTES = 512 * 1024;
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Same bytes as scanner/registry.js contentHash, so a review pins identically for repo and community entries.
export async function contentHash(files) {
  const parts = [];
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) parts.push(f.path, '\0', f.content, '\0');
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(parts.join('')));
  return `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

export async function signSession(secret, { id, login }, now = Date.now()) {
  const body = b64url(enc.encode(JSON.stringify({ id, login, exp: now + 30 * 86400e3 })));
  return `${body}.${await hmac(secret, body)}`;
}

export async function readSession(secret, token, now = Date.now()) {
  if (!secret || !token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (sig !== (await hmac(secret, body))) return null;
  try {
    const data = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
    return data.exp > now && Number.isInteger(data.id) && typeof data.login === 'string' ? { id: data.id, login: data.login } : null;
  } catch {
    return null;
  }
}

const bad = (message) => ({ error: message });

// Validates a community submission, runs the real scanner server-side, and returns the row to store.
export async function prepareSubmission(input) {
  if (!input || typeof input !== 'object') return bad('Send a JSON body.');
  const title = String(input.title ?? '').trim();
  const summary = String(input.summary ?? '').trim();
  const license = String(input.license ?? '').trim();
  const sourceUrl = String(input.source_url ?? '').trim();
  if (title.length < 3 || title.length > 80) return bad('Title must be 3 to 80 characters.');
  if (summary.length < 10 || summary.length > 200) return bad('Summary must be 10 to 200 characters.');
  if (!license || license.length > 60) return bad('Say which license the files are under (for example MIT).');
  if (sourceUrl && (!/^https:\/\/[^\s]+$/.test(sourceUrl) || sourceUrl.length > 300)) return bad('Source must be an https:// link.');
  if (input.rights !== true) return bad('Confirm you have the right to share these files under that license.');

  const tags = [...new Set((Array.isArray(input.tags) ? input.tags : []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
  if (tags.length > 8 || tags.some((t) => !/^[a-z0-9][a-z0-9-]{0,23}$/.test(t))) return bad('Up to 8 tags, each lowercase letters, digits or dashes.');
  const worksWith = (Array.isArray(input.works_with) ? input.works_with : []).filter((a) => AGENTS.includes(a));

  const files = Array.isArray(input.files) ? input.files : [];
  if (!files.length || files.length > MAX_FILES) return bad(`Include 1 to ${MAX_FILES} files.`);
  const seen = new Set();
  let bytes = 0;
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') return bad('Each file needs a path and text content.');
    const p = f.path;
    if (!p || p.length > 200 || p.startsWith('/') || p.includes('\\') || p.split('/').some((s) => s === '..' || s === '.' || s === '') || seen.has(p)) {
      return bad(`Bad file path: ${p.slice(0, 80)}`);
    }
    seen.add(p);
    bytes += enc.encode(f.content).length;
  }
  if (bytes > MAX_BYTES) return bad('Files add up to more than 512 KB.');
  const clean = files.map((f) => ({ path: f.path, content: f.content }));

  const kind = detectKind(clean);
  let slug = slugify(title);
  if (kind === 'skill') {
    const fm = splitFrontmatter(clean.find((f) => f.path === 'SKILL.md').content);
    try {
      const name = fm && parse(fm.raw)?.name;
      if (typeof name === 'string' && name) slug = name;
    } catch { /* the scanner reports broken YAML */ }
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) return bad('Could not make a valid name. For a skill, the SKILL.md name must be lowercase letters, digits and dashes.');

  const report = scan({ files: clean, kind, dirName: slug });
  const hash = await contentHash(clean);
  return { slug, kind, title, summary, license, source_url: sourceUrl, tags, works_with: worksWith, files: clean, report, hash };
}

export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

export function prepareRating(input) {
  const stars = Number(input?.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return bad('Pick 1 to 5 stars.');
  const worked = input.worked === true ? 1 : input.worked === false ? 0 : null;
  const agent = input.agent ? String(input.agent) : null;
  if (agent && !AGENTS.includes(agent)) return bad('Unknown agent.');
  const body = String(input.body ?? '').trim();
  if (body.length > 500) return bad('Keep the review under 500 characters.');
  return { stars, worked, agent, body };
}

// Same four levels the repo registry uses (scanner/registry.js trustLevel).
export function trustOf(report, hash, review) {
  if (report.status === 'blocked') return 'blocked';
  if (!review?.hash) return 'unreviewed';
  return review.hash === hash ? 'verified' : 'review-stale';
}

export function summarizeRatings(rows) {
  const count = rows.length;
  const avg = count ? Math.round((rows.reduce((s, r) => s + r.stars, 0) / count) * 10) / 10 : null;
  const byAgent = {};
  for (const r of rows) {
    if (!r.agent || r.worked === null || r.worked === undefined) continue;
    byAgent[r.agent] ??= { worked: 0, failed: 0 };
    byAgent[r.agent][r.worked ? 'worked' : 'failed'] += 1;
  }
  return {
    avg,
    count,
    worked: rows.filter((r) => r.worked === 1).length,
    failed: rows.filter((r) => r.worked === 0).length,
    by_agent: byAgent,
  };
}

/**
 * Checks a Base transaction receipt for a USDC transfer of at least `minUsdc` to `payTo`.
 * Returns the amount paid in USDC (string) or an error.
 */
export function usdcPaidTo(receipt, payTo, minUsdc) {
  if (!receipt) return bad('Transaction not found on Base yet. Wait a few seconds and try again.');
  if (receipt.status !== '0x1') return bad('That transaction failed on-chain.');
  const to = `0x${payTo.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
  let units = 0n;
  for (const log of receipt.logs || []) {
    if (log.address?.toLowerCase() !== USDC_BASE) continue;
    if (log.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics?.[2]?.toLowerCase() !== to) continue;
    units += BigInt(log.data);
  }
  const min = BigInt(Math.round(minUsdc * 1e6));
  if (units === 0n) return bad('That transaction sent no USDC on Base to the project wallet.');
  if (units < min) return bad(`That transaction sent ${formatUsdc(units)} USDC; a review costs ${minUsdc} USDC.`);
  return { amount: formatUsdc(units) };
}

export function formatUsdc(units) {
  const whole = units / 1000000n;
  const frac = (units % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function searchEntries(entries, q, kind) {
  const words = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return entries
    .filter((e) => !kind || e.kind === kind)
    .map((e) => {
      const hay = [e.slug, e.title, e.summary, ...(e.tags || [])].join(' ').toLowerCase();
      const score = words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
      return { e, score };
    })
    .filter((x) => !words.length || x.score > 0)
    .sort((a, b) => b.score - a.score || a.e.title.localeCompare(b.e.title))
    .map((x) => x.e);
}
