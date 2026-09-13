// MCP server entries. We check the config you would paste into your agent plus a
// snapshot of the tool descriptions the server advertised when it was reviewed.
// We do NOT audit the server's source code; the report says so.
import { checkInjection } from './injection.js';
import { checkUnicode } from './unicode.js';

const RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'uvx', 'pipx']);
const CHANGES_THINGS = /(^|_)(write|edit|create|delete|remove|move|rename|update|add|set|exec|execute|run|send|post|push|merge|drop|insert|upload|deploy|pay|transfer|purchase|order)(_|$)/i;

export function checkMcp(file) {
  let cfg;
  try {
    cfg = JSON.parse(file.content);
  } catch (e) {
    return [f(file, 'mcp/invalid-json', 'error', `server.json is not valid JSON: ${e.message}`, 'Your agent cannot load a config it cannot parse.')];
  }
  const findings = [];

  if (!cfg.command && !cfg.url) {
    findings.push(f(file, 'mcp/no-transport', 'error', 'Needs either "command" (local server) or "url" (remote server)', 'Without one the agent has no way to start or reach the server.'));
  }

  if (cfg.url) {
    if (!/^https:\/\//i.test(cfg.url) && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(cfg.url)) {
      findings.push(f(file, 'mcp/insecure-url', 'error', `Remote server uses an unencrypted URL: ${cfg.url}`, 'Over plain http anyone on the network can read or change what the server tells your agent.'));
    }
    findings.push(f(file, 'mcp/remote-can-change', 'info', 'Remote server: its behaviour can change without a new release', 'A remote server can change what its tools say or do at any time. godsplan compares tool descriptions against the reviewed snapshot but cannot watch the server live.'));
  }

  if (cfg.command) {
    const args = Array.isArray(cfg.args) ? cfg.args.map(String) : [];
    const base = String(cfg.command).split(/[\\/]/).pop();
    if (RUNNERS.has(base)) {
      const pkg = args.find((a) => !a.startsWith('-'));
      if (!pkg) {
        findings.push(f(file, 'mcp/no-package', 'error', `"${base}" is called without a package`, 'The config cannot start anything.'));
      } else if (!isPinned(base, pkg)) {
        findings.push(f(file, 'mcp/unpinned-package', 'error', `Package "${pkg}" is not pinned to an exact version`,
          'An unpinned server downloads the newest release every time it starts. If the package is taken over, a poisoned version reaches you with no review. This is the MCP "rug pull".'));
      }
    } else if (base === 'docker') {
      const image = dockerImage(args);
      if (image && !image.includes('@sha256:')) {
        findings.push(f(file, 'mcp/docker-unpinned', 'warn', `Docker image "${image}" is not pinned by digest`, 'Tags like :latest or :1.2 can be re-pushed. Only an @sha256: digest guarantees the reviewed image.'));
      }
    }
  }

  for (const [key, value] of Object.entries(cfg.env || {})) {
    if (looksLikeSecret(String(value))) {
      findings.push(f(file, 'secrets/hardcoded', 'error', `env.${key} contains what looks like a real secret`, 'Never ship a real key in a shared config. Use a placeholder like "<your-key>".'));
    }
  }

  if (!Array.isArray(cfg.tools) || cfg.tools.length === 0) {
    findings.push(f(file, 'mcp/no-tool-snapshot', 'warn', 'No snapshot of the server\'s tool descriptions',
      'Tool descriptions go straight into the agent\'s context, which is where tool-poisoning attacks hide. Without a snapshot there is nothing to review and nothing to compare later.'));
  } else {
    const powerful = cfg.tools.map((t) => t.name).filter((n) => CHANGES_THINGS.test(n));
    if (powerful.length) {
      findings.push(f(file, 'mcp/can-change-things', 'info', `Can change or delete things: ${powerful.join(', ')}`,
        'These tools modify data rather than just reading it. Scope the server as narrowly as you can and keep approval prompts on.'));
    }
    cfg.tools.forEach((tool, idx) => {
      const text = [tool.description || '', JSON.stringify(tool.inputSchema || {})].join('\n');
      const virtual = { path: `${file.path}#tools[${idx}] ${tool.name || ''}`.trim(), content: text };
      for (const hit of [...checkUnicode(virtual), ...checkInjection(virtual)]) findings.push({ ...hit, line: 1 });
      if ((tool.description || '').length > 1500) {
        findings.push(f(virtual, 'mcp/long-tool-description', 'warn', `Tool "${tool.name}" has a ${tool.description.length}-character description`, 'Very long tool descriptions are where hidden instructions tend to be buried. Read the whole thing.'));
      }
    });
  }
  return findings;
}

// `docker run [flags] IMAGE [cmd]`: the image is the first bare argument after run.
const DOCKER_VALUE_FLAGS = new Set(['-e', '--env', '-v', '--volume', '-p', '--publish', '--name', '--mount', '--network', '-w', '--workdir', '-u', '--user', '--env-file', '--entrypoint']);
function dockerImage(args) {
  const start = args.indexOf('run');
  if (start === -1) return null;
  for (let i = start + 1; i < args.length; i++) {
    const a = args[i];
    if (DOCKER_VALUE_FLAGS.has(a)) i++;
    else if (!a.startsWith('-')) return a;
  }
  return null;
}

function isPinned(runner, pkg) {
  if (runner === 'uvx' || runner === 'pipx') return /==\d/.test(pkg) || /@\d+\.\d+/.test(pkg);
  // npm: name@1.2.3 or @scope/name@1.2.3; ranges, tags and "latest" are not pins.
  const m = pkg.match(/^(@[^/]+\/)?[^@]+@(.+)$/);
  return Boolean(m && /^\d+\.\d+\.\d+([-+][\w.]+)?$/.test(m[2]));
}

const SECRET_PATTERNS = [
  /sk-ant-[\w-]{20,}/, /\bsk-(proj-)?[A-Za-z0-9]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bgithub_pat_\w{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/, /\bxox[baprs]-[\w-]{10,}/, /\bAIza[\w-]{35}\b/, /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
export const looksLikeSecret = (s) => SECRET_PATTERNS.some((re) => re.test(s));

export function checkSecrets(file) {
  const findings = [];
  file.content.split('\n').forEach((line, i) => {
    if (looksLikeSecret(line)) {
      findings.push({ ...f(file, 'secrets/hardcoded', 'error', 'Contains what looks like a real API key or private key', 'A leaked key in a shared skill is usable by anyone who installs it, and is often a sign the author copied from a live setup.'), line: i + 1 });
    }
  });
  return findings;
}

const f = (file, rule, severity, message, why) => ({ rule, severity, file: file.path, line: 1, message, why });
