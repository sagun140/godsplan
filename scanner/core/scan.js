// Pure scanner: files in, report out. No filesystem, so the same code runs in the
// CLI, in CI, and in the "check your own skill" box on the website.
import { checkUnicode } from './unicode.js';
import { checkSkillFrontmatter, checkCursorRuleFrontmatter } from './frontmatter.js';
import { checkInjection } from './injection.js';
import { checkCode, checkBinary, isScript } from './code.js';
import { checkMcp, checkSecrets } from './mcp.js';

export const SCANNER_VERSION = '0.1.0';
const ASSET_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|ttf|otf|woff2?|eot|mp3|mp4|wav|zip|gz|tgz|docx|xlsx|pptx)$/i;
const TEXT_EXT = /\.(md|mdc|txt|json|ya?ml|toml|xml|html|csv|cursorrules)$|(^|\/)(AGENTS|CLAUDE|GEMINI)\.md$|\.cursorrules$/i;

export function detectKind(files) {
  const paths = files.map((f) => f.path);
  if (paths.includes('SKILL.md')) return 'skill';
  if (paths.includes('server.json')) return 'mcp';
  if (paths.some((p) => /\.mdc$|(^|\/)(AGENTS|CLAUDE|GEMINI)\.md$|\.cursorrules$|\.md$/i.test(p))) return 'rules';
  return 'unknown';
}

/**
 * @param {{ files: {path: string, content: string}[], kind?: string, dirName?: string, allow?: {rule: string, file?: string, reason: string}[] }} input
 */
export function scan({ files, kind, dirName, allow = [] }) {
  kind = kind || detectKind(files);
  const findings = [];

  if (kind === 'unknown') {
    findings.push({ rule: 'structure/unknown-kind', severity: 'error', file: '', line: 0, message: 'Could not tell what this is', why: 'Expected a SKILL.md (skill), server.json (MCP server), or a rules file (.mdc, AGENTS.md, .cursorrules).' });
  }
  if (kind === 'skill' && !files.some((f) => f.path === 'SKILL.md')) {
    findings.push({ rule: 'structure/no-skill-md', severity: 'error', file: '', line: 0, message: 'No SKILL.md at the top of the folder', why: 'Agents look for SKILL.md at the root of the skill folder.' });
  }

  const paths = new Set(files.map((f) => f.path));
  for (const file of files) {
    if (ASSET_EXT.test(file.path)) continue; // images, fonts, PDFs: not instructions, not code
    const binary = checkBinary(file);
    if (binary.length) {
      findings.push(...binary);
      continue;
    }
    findings.push(...checkUnicode(file), ...checkSecrets(file));

    if (isScript(file.path)) {
      findings.push(...checkCode(file));
      continue;
    }
    if (kind === 'mcp' && file.path === 'server.json') {
      findings.push(...checkMcp(file));
      continue;
    }
    if (!TEXT_EXT.test(file.path)) continue;

    findings.push(...checkInjection(file));
    if (/\.(md|mdc)$|\.cursorrules$/i.test(file.path)) findings.push(...checkCode(file));

    if (kind === 'skill' && file.path === 'SKILL.md') {
      findings.push(...checkSkillFrontmatter(file, dirName), ...checkLinks(file, paths));
    }
    if (kind === 'rules' && /\.mdc$/i.test(file.path)) findings.push(...checkCursorRuleFrontmatter(file));
  }

  for (const finding of findings) {
    const rule = allow.find((a) => a.rule === finding.rule && (!a.file || a.file === finding.file));
    if (rule) finding.allowed = rule.reason;
  }

  const active = findings.filter((x) => !x.allowed);
  const counts = {
    error: active.filter((x) => x.severity === 'error').length,
    warn: active.filter((x) => x.severity === 'warn').length,
    info: active.filter((x) => x.severity === 'info').length,
    allowed: findings.length - active.length,
  };
  const status = counts.error ? 'blocked' : counts.warn ? 'needs-attention' : 'clean';
  const order = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);

  return { scanner: SCANNER_VERSION, kind, status, counts, findings };
}

// SKILL.md often points at references/foo.md or scripts/bar.py. A missing target
// is the "outdated skill" failure: the agent follows the pointer and finds nothing.
function checkLinks(file, paths) {
  const findings = [];
  const re = /\]\((?!https?:|mailto:|#)([^)\s]+)\)|`((?:scripts|references|assets)\/[^`\s]+)`/g;
  let m;
  while ((m = re.exec(file.content))) {
    const target = (m[1] || m[2]).replace(/^\.\//, '').split('#')[0];
    // Only path-shaped targets: [text](URL) placeholders and bare words are not file references.
    if (!target || target.includes('*') || target.includes('{') || !/[/.]/.test(target)) continue;
    if (!paths.has(target) && ![...paths].some((p) => p.startsWith(`${target.replace(/\/$/, '')}/`))) {
      findings.push({
        rule: 'structure/broken-reference',
        severity: 'error',
        file: file.path,
        line: file.content.slice(0, m.index).split('\n').length,
        message: `Points to "${target}", which is not in the skill`,
        why: 'The agent will try to open this file mid-task and fail. Usually a sign the skill was copied without all its files, or went out of date.',
      });
    }
  }
  return findings;
}
