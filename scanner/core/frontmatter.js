// "Does it load at all" checks: SKILL.md frontmatter per the Agent Skills spec
// (agentskills.io/specification), plus the stricter Claude API rules and the
// extra fields only Claude Code understands. Also Cursor .mdc rule frontmatter.
import { parseDocument } from 'yaml';

const SPEC_FIELDS = new Set(['name', 'description', 'license', 'allowed-tools', 'metadata', 'compatibility']);
// Claude Code accepts these beyond the open spec (code.claude.com/docs/en/skills).
const CLAUDE_CODE_FIELDS = new Set([
  'when_to_use', 'argument-hint', 'disable-model-invocation', 'user-invocable', 'model',
  'context', 'agent', 'hooks', 'paths', 'version', 'effort', 'shell',
]);
const CURSOR_FIELDS = new Set(['description', 'globs', 'alwaysApply']);

export function splitFrontmatter(content) {
  const text = content.replace(/^\uFEFF/, '');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return null;
  const bodyStartLine = m[0].split('\n').length;
  return { raw: m[1], body: text.slice(m[0].length), bodyStartLine };
}

function parseYaml(raw, file) {
  const doc = parseDocument(raw, { uniqueKeys: true, prettyErrors: true });
  if (doc.errors.length) {
    const e = doc.errors[0];
    return {
      error: {
        rule: 'frontmatter/invalid-yaml',
        severity: 'error',
        file: file.path,
        line: (e.linePos?.[0]?.line ?? 0) + 1, // +1 for the opening ---
        message: `YAML does not parse: ${e.message.split('\n')[0]}`,
        why: 'Agents fail to load a skill with broken frontmatter, and some crash on it. The usual cause is an unquoted colon inside the description; wrap the value in quotes.',
      },
    };
  }
  const data = doc.toJS();
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { error: err(file, 'frontmatter/not-a-map', 'Frontmatter must be key: value pairs', 'The agent reads name and description as keys; anything else is ignored.') };
  }
  return { data };
}

export function checkSkillFrontmatter(file, dirName) {
  const findings = [];
  const fm = splitFrontmatter(file.content);
  if (!fm) {
    return [err(file, 'frontmatter/missing', 'SKILL.md has no --- frontmatter block at the top',
      'Without name and description in frontmatter the agent has nothing to decide when to use the skill, so it never triggers.')];
  }
  const { data, error } = parseYaml(fm.raw, file);
  if (error) return [error];

  const { name, description } = data;

  if (name === undefined) {
    findings.push(err(file, 'frontmatter/name-missing', 'Missing required field: name', 'The open Agent Skills spec requires a name; tools other than Claude Code reject skills without one.'));
  } else if (typeof name !== 'string') {
    findings.push(err(file, 'frontmatter/name-type', 'name must be a string', 'A non-string name fails validation.'));
  } else {
    const problems = [];
    if (name.length < 1 || name.length > 64) problems.push('must be 1-64 characters');
    if (!/^[a-z0-9-]+$/.test(name)) problems.push('only lowercase a-z, 0-9 and hyphens');
    if (/^-|-$/.test(name)) problems.push('cannot start or end with a hyphen');
    if (name.includes('--')) problems.push('cannot contain "--"');
    if (problems.length) findings.push(err(file, 'frontmatter/name-format', `name "${name}" is invalid: ${problems.join('; ')}`, 'These are the exact naming rules in the Agent Skills spec.'));
    if (dirName && name !== dirName) findings.push(err(file, 'frontmatter/name-dir-mismatch', `name "${name}" does not match its folder "${dirName}"`, 'The spec requires the folder name and skill name to match; installers use the folder name.'));
    if (/anthropic|claude/i.test(name)) findings.push(warn(file, 'frontmatter/name-reserved', `name "${name}" contains a reserved word (anthropic, claude)`, 'Works in Claude Code, but the Claude API rejects uploads whose name contains these words.'));
    if (/<[^>]+>/.test(name)) findings.push(err(file, 'frontmatter/xml-in-field', 'name contains XML tags', 'The Claude API rejects XML tags in name and description.'));
  }

  if (description === undefined || description === null || (typeof description === 'string' && !description.trim())) {
    findings.push(err(file, 'frontmatter/description-missing', 'Missing required field: description',
      'The description is the only thing the agent reads when deciding whether to use a skill. No description means it never triggers.'));
  } else if (typeof description !== 'string') {
    findings.push(err(file, 'frontmatter/description-type', 'description must be a string', 'A list or map here usually means an unquoted colon broke the YAML.'));
  } else {
    if (description.length > 1024) findings.push(err(file, 'frontmatter/description-too-long', `description is ${description.length} characters (max 1024)`, 'The spec caps descriptions at 1024 characters and some tools truncate or reject longer ones.'));
    if (/<[^>]+>/.test(description)) findings.push(err(file, 'frontmatter/xml-in-field', 'description contains XML tags', 'The Claude API rejects XML tags in name and description.'));
    if (description.length < 40) {
      findings.push(warn(file, 'trigger/description-too-short', `description is only ${description.length} characters`,
        'Agents pick skills by matching your request against the description. A short one rarely matches, so the skill silently never runs.'));
    } else if (!/\b(use (this|it|when|for|whenever)|when (the )?user|when you|whenever|trigger|invoke|for (tasks|requests|questions))\b/i.test(description)) {
      findings.push(warn(file, 'trigger/no-when-to-use', 'description does not say when to use the skill',
        'Descriptions that name the situations ("Use when the user asks to...") trigger far more reliably than ones that only describe what the skill is.'));
    }
  }

  if (data.compatibility !== undefined && (typeof data.compatibility !== 'string' || data.compatibility.length > 500)) {
    findings.push(err(file, 'frontmatter/compatibility', 'compatibility must be a string of at most 500 characters', 'Spec rule.'));
  }
  if (data.metadata !== undefined && (typeof data.metadata !== 'object' || Array.isArray(data.metadata) || data.metadata === null)) {
    findings.push(err(file, 'frontmatter/metadata', 'metadata must be a key: value map', 'Spec rule.'));
  }

  for (const key of Object.keys(data)) {
    if (SPEC_FIELDS.has(key)) continue;
    if (CLAUDE_CODE_FIELDS.has(key)) {
      findings.push(info(file, 'frontmatter/claude-code-only', `"${key}" only works in Claude Code`, 'Other Agent Skills tools (Codex, Cursor, Gemini CLI) will reject or ignore this field.'));
    } else {
      findings.push(warn(file, 'frontmatter/unknown-field', `Unknown frontmatter field "${key}"`, 'The reference validator rejects fields outside the spec. Check for a typo.'));
    }
  }
  if (data.hooks !== undefined) {
    findings.push(warn(file, 'code/frontmatter-hooks', 'Skill defines hooks, which run shell commands automatically',
      'Hooks execute without you asking each time. Read every command before installing.'));
  }

  const lineCount = file.content.split('\n').length;
  if (lineCount > 500) findings.push(warn(file, 'size/skill-too-long', `SKILL.md is ${lineCount} lines (spec recommends under 500)`, 'Long skills eat the agent\'s context. Move detail into references/ files.'));

  return findings;
}

export function checkCursorRuleFrontmatter(file) {
  const fm = splitFrontmatter(file.content);
  if (!fm) return []; // plain rules files and AGENTS.md need no frontmatter
  const { data, error } = parseYaml(fm.raw, file);
  if (error) return [error];
  const findings = [];
  for (const key of Object.keys(data)) {
    if (!CURSOR_FIELDS.has(key)) findings.push(warn(file, 'frontmatter/unknown-field', `Unknown Cursor rule field "${key}"`, 'Cursor reads description, globs and alwaysApply. Anything else is ignored.'));
  }
  if (data.alwaysApply !== undefined && typeof data.alwaysApply !== 'boolean') {
    findings.push(err(file, 'frontmatter/always-apply-type', 'alwaysApply must be true or false', 'A quoted "true" is a string, and the rule will not apply the way you expect.'));
  }
  if (!data.alwaysApply && !data.globs && !data.description) {
    findings.push(warn(file, 'trigger/rule-never-applies', 'Rule has no alwaysApply, globs, or description',
      'Cursor has no way to decide when to attach this rule, so it only runs if you @-mention it.'));
  }
  return findings;
}

const mk = (severity) => (file, rule, message, why) => ({ rule, severity, file: file.path, line: 1, message, why });
const err = mk('error');
const warn = mk('warn');
const info = mk('info');
