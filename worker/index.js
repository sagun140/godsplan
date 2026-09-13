// Cloudflare Worker: serves the static site and the wiki API (GitHub sign-in, community
// submissions, ratings, paid review requests) plus a pay-per-call x402 API for agents.
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { bazaarResourceServerExtension, declareDiscoveryExtension } from '@x402/extensions';
import {
  AGENTS, prepareSubmission, prepareRating, readSession, signSession,
  summarizeRatings, trustOf, usdcPaidTo, searchEntries,
} from './lib.js';

const PRICES = { search: '$0.002', entry: '$0.01' };
const SESSION = 'gp_session';

const app = new Hono();

// ---------- data ----------

let curated;
async function curatedEntries(c) {
  if (!curated) curated = await (await c.env.ASSETS.fetch(new URL('/_data/registry.json', c.req.url))).json();
  return curated;
}

function communityEntry(row, full) {
  const report = JSON.parse(row.report);
  const review = row.review ? JSON.parse(row.review) : undefined;
  const entry = {
    slug: row.slug,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    tags: JSON.parse(row.tags),
    works_with: JSON.parse(row.works_with),
    source: { repo: row.source_url || undefined, license: row.license, author: row.login },
    submitted_by: row.login,
    community: true,
    review,
    trust: trustOf(report, row.hash, review),
    hash: row.hash,
    updated_at: row.updated_at,
  };
  if (full) {
    entry.report = report;
    entry.files = JSON.parse(row.files).map((f) => ({ path: f.path, bytes: new TextEncoder().encode(f.content).length, skipped: false, content: f.content }));
  } else {
    entry.report = { status: report.status, counts: report.counts };
  }
  return entry;
}

async function allEntries(c) {
  const { results } = await c.env.DB.prepare('SELECT slug, kind, title, summary, tags, works_with, source_url, license, login, report, hash, review, updated_at FROM submissions ORDER BY updated_at DESC').all();
  return [...(await curatedEntries(c)), ...results.map((r) => communityEntry(r, false))];
}

async function findEntry(c, slug) {
  const repo = (await curatedEntries(c)).find((e) => e.slug === slug);
  if (repo) return repo;
  const row = await c.env.DB.prepare('SELECT * FROM submissions WHERE slug = ?').bind(slug).first();
  return row ? communityEntry(row, true) : null;
}

async function ratingsFor(c, slug) {
  const { results } = await c.env.DB.prepare('SELECT login, stars, worked, agent, body, updated_at FROM ratings WHERE slug = ? ORDER BY updated_at DESC').bind(slug).all();
  return { ...summarizeRatings(results), reviews: results.slice(0, 50) };
}

// ---------- auth ----------

const user = async (c) => readSession(c.env.SESSION_SECRET, getCookie(c, SESSION));
const isAdmin = (c, u) => Boolean(u) && String(c.env.ADMINS || '').split(',').map((s) => s.trim().toLowerCase()).includes(u.login.toLowerCase());

// Cookies are SameSite=Lax; also refuse cross-site writes outright.
const sameOrigin = async (c, next) => {
  if (c.req.method !== 'GET' && c.req.header('origin') !== new URL(c.req.url).origin) return c.json({ error: 'Cross-site request refused.' }, 403);
  return next();
};
const needUser = async (c, next) => {
  const u = await user(c);
  if (!u) return c.json({ error: 'Sign in with GitHub first.' }, 401);
  c.set('user', u);
  return next();
};

app.get('/auth/login', (c) => {
  if (!c.env.GITHUB_CLIENT_ID) return c.text('GitHub sign-in is not configured yet.', 503);
  const state = crypto.randomUUID();
  setCookie(c, 'gp_state', state, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/auth', maxAge: 600 });
  const back = c.req.query('back')?.startsWith('#') ? c.req.query('back') : '';
  setCookie(c, 'gp_back', back, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/auth', maxAge: 600 });
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', c.env.GITHUB_CLIENT_ID);
  url.searchParams.set('redirect_uri', new URL('/auth/callback', c.req.url).href);
  url.searchParams.set('state', state);
  url.searchParams.set('allow_signup', 'true');
  return c.redirect(url.href);
});

app.get('/auth/callback', async (c) => {
  const state = getCookie(c, 'gp_state');
  if (!state || state !== c.req.query('state') || !c.req.query('code')) return c.text('Sign-in expired. Go back and try again.', 400);
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: c.env.GITHUB_CLIENT_ID, client_secret: c.env.GITHUB_CLIENT_SECRET, code: c.req.query('code') }),
  });
  const { access_token: token } = await tokenRes.json();
  if (!token) return c.text('GitHub did not accept the sign-in. Try again.', 400);
  // Only the public profile is read; the token is not stored.
  const gh = await (await fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${token}`, 'user-agent': 'godsplan' } })).json();
  if (!Number.isInteger(gh.id) || !gh.login) return c.text('Could not read your GitHub profile.', 502);
  const now = new Date().toISOString();
  await c.env.DB.prepare('INSERT INTO users (id, login, created_at, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET login = excluded.login, last_seen = excluded.last_seen')
    .bind(gh.id, gh.login, now, now).run();
  setCookie(c, SESSION, await signSession(c.env.SESSION_SECRET, { id: gh.id, login: gh.login }), { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 30 * 86400 });
  const back = getCookie(c, 'gp_back') || '';
  deleteCookie(c, 'gp_state', { path: '/auth' });
  deleteCookie(c, 'gp_back', { path: '/auth' });
  return c.redirect(`/${back}`);
});

app.post('/auth/logout', sameOrigin, (c) => {
  deleteCookie(c, SESSION, { path: '/' });
  return c.json({ ok: true });
});

// ---------- site API (free) ----------

app.use('/api/site/*', sameOrigin);

app.get('/api/site/me', async (c) => {
  const u = await user(c);
  return c.json({
    user: u,
    admin: isAdmin(c, u),
    signin: Boolean(c.env.GITHUB_CLIENT_ID),
    wallet: { address: c.env.PAY_TO, network: 'Base', asset: 'USDC' },
    review_price_usdc: Number(c.env.REVIEW_PRICE_USDC),
    agents: AGENTS,
  });
});

app.get('/api/site/community', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT slug, kind, title, summary, tags, works_with, source_url, license, login, report, hash, review, updated_at FROM submissions ORDER BY updated_at DESC').all();
  const { results: stats } = await c.env.DB.prepare('SELECT slug, ROUND(AVG(stars), 1) AS avg, COUNT(*) AS count FROM ratings GROUP BY slug').all();
  return c.json({ entries: results.map((r) => communityEntry(r, false)), ratings: Object.fromEntries(stats.map((s) => [s.slug, { avg: s.avg, count: s.count }])) });
});

app.get('/api/site/entries/:slug', async (c) => {
  const entry = await findEntry(c, c.req.param('slug'));
  if (!entry) return c.json({ error: 'No such entry.' }, 404);
  const u = await user(c);
  const mine = u ? await c.env.DB.prepare('SELECT stars, worked, agent, body FROM ratings WHERE slug = ? AND user_id = ?').bind(entry.slug, u.id).first() : null;
  const { results: orders } = await c.env.DB.prepare('SELECT login, amount_usdc, created_at FROM review_orders WHERE slug = ? ORDER BY created_at DESC').bind(entry.slug).all();
  return c.json({ entry: entry.community ? entry : undefined, ratings: await ratingsFor(c, entry.slug), mine, review_orders: orders });
});

app.post('/api/site/submissions', needUser, async (c) => {
  const u = c.get('user');
  const recent = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM submissions WHERE user_id = ? AND updated_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')").bind(u.id).first();
  if (recent.n >= 10) return c.json({ error: 'Limit is 10 submissions a day.' }, 429);
  const sub = await prepareSubmission(await c.req.json().catch(() => null));
  if (sub.error) return c.json(sub, 400);
  if (sub.report.status === 'blocked') return c.json({ error: 'The scanner blocked this. Fix the problems below and submit again.', report: sub.report }, 422);
  if ((await curatedEntries(c)).some((e) => e.slug === sub.slug)) return c.json({ error: `"${sub.slug}" is already in the registry. Rename it.` }, 409);
  const existing = await c.env.DB.prepare('SELECT user_id, review FROM submissions WHERE slug = ?').bind(sub.slug).first();
  if (existing && existing.user_id !== u.id) return c.json({ error: `"${sub.slug}" was submitted by someone else. Rename it.` }, 409);
  const now = new Date().toISOString();
  await c.env.DB.prepare(`INSERT INTO submissions (slug, kind, title, summary, tags, works_with, source_url, license, files, hash, report, user_id, login, review, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET kind = excluded.kind, title = excluded.title, summary = excluded.summary, tags = excluded.tags, works_with = excluded.works_with,
      source_url = excluded.source_url, license = excluded.license, files = excluded.files, hash = excluded.hash, report = excluded.report, login = excluded.login, updated_at = excluded.updated_at`)
    .bind(sub.slug, sub.kind, sub.title, sub.summary, JSON.stringify(sub.tags), JSON.stringify(sub.works_with), sub.source_url, sub.license,
      JSON.stringify(sub.files), sub.hash, JSON.stringify(sub.report), u.id, u.login, now, now).run();
  // An update keeps the old review record, and trustOf shows it as outdated because the hash changed.
  return c.json({ slug: sub.slug, status: sub.report.status, report: sub.report, updated: Boolean(existing) }, existing ? 200 : 201);
});

app.post('/api/site/entries/:slug/ratings', needUser, async (c) => {
  const u = c.get('user');
  const entry = await findEntry(c, c.req.param('slug'));
  if (!entry) return c.json({ error: 'No such entry.' }, 404);
  if (entry.community && entry.submitted_by.toLowerCase() === u.login.toLowerCase()) return c.json({ error: "You can't rate your own submission." }, 403);
  const r = prepareRating(await c.req.json().catch(() => null));
  if (r.error) return c.json(r, 400);
  const now = new Date().toISOString();
  await c.env.DB.prepare(`INSERT INTO ratings (slug, user_id, login, stars, worked, agent, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug, user_id) DO UPDATE SET login = excluded.login, stars = excluded.stars, worked = excluded.worked, agent = excluded.agent, body = excluded.body, updated_at = excluded.updated_at`)
    .bind(entry.slug, u.id, u.login, r.stars, r.worked, r.agent, r.body, now, now).run();
  return c.json({ ratings: await ratingsFor(c, entry.slug) });
});

// Paying buys a human review, not the badge: the reviewer can still decline.
app.post('/api/site/entries/:slug/review-request', needUser, async (c) => {
  const u = c.get('user');
  const entry = await findEntry(c, c.req.param('slug'));
  if (!entry?.community) return c.json({ error: 'Only community submissions can request a paid review.' }, 404);
  const txHash = String((await c.req.json().catch(() => ({}))).tx_hash ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) return c.json({ error: 'Paste the 0x… transaction hash from your wallet.' }, 400);
  const used = await c.env.DB.prepare('SELECT slug FROM review_orders WHERE tx_hash = ?').bind(txHash).first();
  if (used) return c.json({ error: `That transaction was already used for "${used.slug}".` }, 409);
  const rpc = await fetch(c.env.BASE_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }),
  });
  const paid = usdcPaidTo((await rpc.json()).result, c.env.PAY_TO, Number(c.env.REVIEW_PRICE_USDC));
  if (paid.error) return c.json(paid, 400);
  await c.env.DB.prepare('INSERT INTO review_orders (tx_hash, slug, user_id, login, amount_usdc, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(txHash, entry.slug, u.id, u.login, paid.amount, new Date().toISOString()).run();
  return c.json({ ok: true, amount_usdc: paid.amount }, 201);
});

// ---------- maintainers ----------

app.get('/api/site/admin/queue', needUser, async (c) => {
  if (!isAdmin(c, c.get('user'))) return c.json({ error: 'Maintainers only.' }, 403);
  const { results } = await c.env.DB.prepare(`SELECT s.slug, s.title, s.login, s.hash, s.review, s.updated_at, COUNT(o.tx_hash) AS paid
    FROM submissions s LEFT JOIN review_orders o ON o.slug = s.slug GROUP BY s.slug ORDER BY paid DESC, s.updated_at ASC`).all();
  return c.json({ queue: results.filter((r) => !r.review || JSON.parse(r.review).hash !== r.hash) });
});

app.post('/api/site/admin/entries/:slug', needUser, async (c) => {
  const u = c.get('user');
  if (!isAdmin(c, u)) return c.json({ error: 'Maintainers only.' }, 403);
  const { decision, notes = '' } = await c.req.json().catch(() => ({}));
  const row = await c.env.DB.prepare('SELECT slug, hash, report FROM submissions WHERE slug = ?').bind(c.req.param('slug')).first();
  if (!row) return c.json({ error: 'No such submission.' }, 404);
  if (decision === 'remove') {
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM submissions WHERE slug = ?').bind(row.slug),
      c.env.DB.prepare('DELETE FROM ratings WHERE slug = ?').bind(row.slug),
    ]);
    return c.json({ removed: row.slug });
  }
  if (decision !== 'verified') return c.json({ error: 'decision must be "verified" or "remove".' }, 400);
  if (JSON.parse(row.report).status === 'blocked') return c.json({ error: 'Blocked entries cannot be verified.' }, 400);
  const review = { by: u.login, date: new Date().toISOString().slice(0, 10), notes: String(notes).slice(0, 500), hash: row.hash };
  await c.env.DB.prepare('UPDATE submissions SET review = ? WHERE slug = ?').bind(JSON.stringify(review), row.slug).run();
  return c.json({ review });
});

// ---------- agent API (x402) ----------

// The middleware syncs with the facilitator when created, and Workers cannot await I/O started by
// another request, so each request builds its own until one finishes that sync (same as Lexicon Planes).
let ready;
const payments = async (c, next) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(c.env.PAY_TO || '')) return c.json({ error: 'Payments are not configured.' }, 503);
  if (ready) return ready(c, next);
  const mw = buildPayments(c.env);
  const res = await mw(c, next);
  ready = mw;
  return res;
};

function buildPayments(env) {
  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: env.FACILITATOR_URL }))
    .register(env.NETWORK, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);
  const accepts = (price) => ({ scheme: 'exact', price, network: env.NETWORK, payTo: env.PAY_TO });
  return paymentMiddleware({
    'GET /api/v1/search': {
      accepts: accepts(PRICES.search),
      description: 'Search agent skills, rules files and MCP servers that passed a security scanner; returns trust level and community ratings',
      mimeType: 'application/json',
      extensions: declareDiscoveryExtension({
        input: { q: 'pdf', kind: 'skill' },
        inputSchema: { properties: { q: { type: 'string', description: 'search words' }, kind: { type: 'string', enum: ['skill', 'rules', 'mcp'] } }, required: ['q'] },
        output: { example: { results: [{ slug: 'webapp-testing', title: 'Webapp Testing', kind: 'skill', trust: 'unreviewed', rating: { avg: 4.5, count: 2 } }] } },
      }),
    },
    'GET /api/v1/entries/:slug': {
      accepts: accepts(PRICES.entry),
      description: 'One vetted agent skill, rules file or MCP server: every file, the security scan report, content hash, trust level and ratings',
      mimeType: 'application/json',
      extensions: declareDiscoveryExtension({
        output: { example: { slug: 'webapp-testing', kind: 'skill', trust: 'verified', hash: 'sha256:…', files: [{ path: 'SKILL.md', content: '---\nname: webapp-testing…' }], report: { status: 'clean' }, ratings: { avg: 4.5, count: 2 } } },
      }),
    },
  }, server);
}

app.get('/api/v1', (c) => c.json({
  name: 'godsplan agent API',
  about: 'Agent skills, rules files and MCP servers that passed a security scanner, with human reviews and community ratings.',
  payment: { protocol: 'x402', network: c.env.NETWORK, asset: 'USDC', payTo: c.env.PAY_TO },
  endpoints: [
    { path: '/api/v1/search?q={words}&kind={skill|rules|mcp}', price: PRICES.search, returns: 'Up to 20 matches with trust level and rating' },
    { path: '/api/v1/entries/{slug}', price: PRICES.entry, returns: 'All files, scan report, hash, trust, ratings' },
  ],
  source: 'https://github.com/sagun140/godsplan',
}));

app.use('/api/v1/*', payments);

app.get('/api/v1/search', async (c) => {
  const kind = ['skill', 'rules', 'mcp'].includes(c.req.query('kind')) ? c.req.query('kind') : undefined;
  const { results: stats } = await c.env.DB.prepare('SELECT slug, ROUND(AVG(stars), 1) AS avg, COUNT(*) AS count FROM ratings GROUP BY slug').all();
  const rating = Object.fromEntries(stats.map((s) => [s.slug, { avg: s.avg, count: s.count }]));
  const hits = searchEntries(await allEntries(c), c.req.query('q'), kind).filter((e) => e.trust !== 'blocked').slice(0, 20);
  return c.json({ results: hits.map((e) => ({ slug: e.slug, title: e.title, summary: e.summary, kind: e.kind, tags: e.tags, trust: e.trust, community: Boolean(e.community), rating: rating[e.slug] || { avg: null, count: 0 } })) });
});

app.get('/api/v1/entries/:slug', async (c) => {
  const e = await findEntry(c, c.req.param('slug'));
  if (!e) return c.json({ error: 'No such entry.' }, 404);
  const { reviews, ...ratings } = await ratingsFor(c, e.slug);
  return c.json({ slug: e.slug, title: e.title, summary: e.summary, kind: e.kind, tags: e.tags, source: e.source, trust: e.trust, review: e.review, hash: e.hash, report: e.report, files: e.files, ratings });
});

// ---------- static ----------

app.get('/_data/*', (c) => c.notFound());
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
