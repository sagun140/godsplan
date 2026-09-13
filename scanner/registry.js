// Filesystem layer: reads folders, loads registry entries, computes content hashes,
// and decides the trust level shown on the site.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, basename, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { scan, SCANNER_VERSION } from './core/scan.js';

export const REGISTRY_DIR = new URL('../registry/', import.meta.url).pathname;
export const META_FILE = 'godsplan.yml';
const SKIP = new Set(['.git', 'node_modules', '.DS_Store', '__pycache__']);
const MAX_BYTES = 512 * 1024;

export function readFolder(dir) {
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      if (SKIP.has(name)) continue;
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else {
        const path = relative(dir, full).split(sep).join('/');
        if (path === META_FILE) continue;
        // Binary check needs only the name; big files are listed but not scanned.
        // raw keeps the exact bytes so the review hash covers them either way.
        const raw = readFileSync(full);
        const content = st.size > MAX_BYTES ? '' : raw.toString('utf8');
        files.push({ path, content, raw, bytes: st.size });
      }
    }
  };
  if (statSync(dir).isFile()) return [{ path: basename(dir), content: readFileSync(dir, 'utf8'), bytes: statSync(dir).size }];
  walk(dir);
  return files;
}

// The review is pinned to this hash. Change one byte of any file and the badge drops.
export function contentHash(files) {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    // Hash bytes, not decoded text: invalid UTF-8 all decodes to U+FFFD, and big files have no content.
    h.update(f.path).update('\0').update(f.raw ?? f.content).update('\0');
  }
  return `sha256:${h.digest('hex')}`;
}

export function listEntries() {
  if (!existsSync(REGISTRY_DIR)) return [];
  return readdirSync(REGISTRY_DIR).filter((n) => existsSync(join(REGISTRY_DIR, n, META_FILE))).sort();
}

export function loadEntry(slug) {
  const dir = join(REGISTRY_DIR, slug);
  const meta = parse(readFileSync(join(dir, META_FILE), 'utf8')) || {};
  const files = readFolder(dir);
  const report = scan({ files, kind: meta.kind, dirName: slug, allow: meta.allow || [] });
  const hash = contentHash(files);
  return { slug, dir, meta, files, report, hash, trust: trustLevel(meta, report, hash) };
}

/**
 * verified      scanner has no open errors AND a maintainer reviewed exactly these bytes
 * review-stale  was reviewed, but the files changed since
 * unreviewed    passes the scanner, waiting for a human
 * blocked       scanner found an unresolved error
 */
export function trustLevel(meta, report, hash) {
  if (report.status === 'blocked') return 'blocked';
  if (!meta.review?.hash) return 'unreviewed';
  if (meta.review.hash !== hash) return 'review-stale';
  return 'verified';
}

export { SCANNER_VERSION };
