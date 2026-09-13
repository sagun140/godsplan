-- D1 schema. Apply with: npx wrangler d1 execute godsplan --remote --file worker/schema.sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,          -- GitHub user id
  login TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS submissions (
  slug TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags TEXT NOT NULL,              -- JSON array
  works_with TEXT NOT NULL,        -- JSON array
  source_url TEXT NOT NULL,
  license TEXT NOT NULL,
  files TEXT NOT NULL,             -- JSON [{path, content}]
  hash TEXT NOT NULL,              -- sha256 of files, same as scanner/registry.js
  report TEXT NOT NULL,            -- JSON scanner report, produced server-side
  user_id INTEGER NOT NULL,
  login TEXT NOT NULL,
  review TEXT,                     -- JSON {by, date, notes, hash}; trust drops when hash changes
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS submissions_by_user ON submissions (user_id, updated_at);

CREATE TABLE IF NOT EXISTS ratings (
  slug TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  login TEXT NOT NULL,
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  worked INTEGER CHECK (worked IN (0, 1)),
  agent TEXT,
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (slug, user_id)
);

CREATE TABLE IF NOT EXISTS review_orders (
  tx_hash TEXT PRIMARY KEY,        -- a Base USDC transfer can pay for one review only
  slug TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  login TEXT NOT NULL,
  amount_usdc TEXT NOT NULL,
  created_at TEXT NOT NULL
);
