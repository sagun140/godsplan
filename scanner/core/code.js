// Risky-code checks for bundled scripts and for shell/code blocks inside markdown
// (a SKILL.md that says "run this" is as dangerous as a script that does it).
import { clip } from './injection.js';

const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1|php|go|lua)$/i;
const BINARY_EXT = /\.(exe|dll|so|dylib|bin|pyc|pyo|class|jar|wasm|o|a|apk|dmg|pkg|msi|deb|rpm)$/i;

const RULES = [
  {
    rule: 'code/pipe-to-shell',
    severity: 'error',
    re: /\b(curl|wget|iwr|invoke-webrequest|fetch)\b[^|\n]*\|\s*(sudo\s+)?(ba|z|da|fi)?sh\b|\b(curl|wget)\b[^|\n]*\|\s*(python3?|node|perl|ruby|iex)\b/i,
    message: 'Downloads code from the internet and runs it immediately',
    why: '"curl | bash" runs whatever the server sends today, which can differ from what anyone reviewed. It was the most common payload in Snyk\'s study of malicious skills.',
  },
  {
    rule: 'code/decode-and-execute',
    severity: 'error',
    re: /(base64\s+(-d|--decode)[^\n]*\|\s*(ba)?sh|eval\s*\(\s*(atob|Buffer\.from)|exec\s*\(\s*(base64\.b64decode|codecs\.decode|bytes\.fromhex)|eval\s*\(\s*compile\s*\(|python3?\s+-c\s+["']import\s+base64)/i,
    message: 'Decodes hidden data and executes it',
    why: 'Encoding a command before running it has one purpose: stopping a reviewer from reading it.',
  },
  {
    rule: 'code/destructive-delete',
    severity: 'error',
    re: /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(--no-preserve-root\s+)?(\/|~|\$HOME|\/\*|\*)(\s|$|["'])/i,
    message: 'Recursively deletes your home folder or root',
    why: 'No skill needs to wipe these directories.',
  },
  {
    rule: 'code/reads-credentials',
    severity: 'error',
    re: /(cat|type|open|readFile(Sync)?|read_text|Get-Content)\b[^\n]{0,40}(\.ssh[\\/]|id_(rsa|ed25519)|\.aws[\\/]credentials|\.git-credentials|\.netrc|\.npmrc|mcp\.json|claude_desktop_config|Login Data|\.config[\\/]gcloud)/i,
    message: 'Reads SSH keys, cloud credentials or agent configs',
    why: 'This is the core move of credential-stealing skills. A skill that touches these files needs a very clear reason.',
  },
  {
    rule: 'code/env-dump',
    severity: 'info',
    re: /(\bprintenv\b|\benv\s*(\||>)|os\.environ(?!\s*(\.get|\[))|process\.env(?![.\[])|JSON\.stringify\(\s*process\.env|Get-ChildItem\s+env:)/i,
    message: 'Copies all environment variables',
    why: 'Usually just passing the environment to a subprocess. It becomes a warning when the same file also makes network requests.',
  },
  {
    rule: 'code/network',
    severity: 'info',
    re: /\b(curl|wget|requests\.(get|post|put)|httpx\.|urllib\.request|fetch\(|axios\.|http\.request|XMLHttpRequest|Invoke-WebRequest|nc\s+-|socket\.connect)/i,
    message: 'Makes network requests',
    why: 'Not bad on its own. Check where the data goes.',
  },
  {
    rule: 'code/privilege',
    severity: 'warn',
    re: /\bsudo\s+|\bchmod\s+(-R\s+)?777\b|\bchown\s+-R\s+root|Set-ExecutionPolicy\s+(Bypass|Unrestricted)/i,
    message: 'Asks for admin rights or opens up file permissions',
    why: 'Admin rights let a mistake or a bad actor change anything on your machine.',
  },
  {
    rule: 'code/persistence',
    severity: 'warn',
    re: /\b(crontab\s|LaunchAgents|launchctl\s+load|systemctl\s+enable|\.bashrc|\.zshrc|\.profile\b|HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run|schtasks\s+\/create)/i,
    message: 'Sets something to run automatically later',
    why: 'Cron jobs, launch agents and shell-profile edits keep running after the skill finishes, which is how malware stays around.',
  },
  {
    rule: 'code/unpinned-install',
    severity: 'warn',
    re: /\b(npx\s+(-y\s+)?(@[\w.-]+\/)?[\w.-]+(?!@)(\s|$)|pip3?\s+install\s+(?!-r\b)(?![\w.-]+==)[\w.-]+(\s|$)|npm\s+i(nstall)?\s+(-g\s+)?(@[\w.-]+\/)?[\w.-]+(?!@)(\s|$))/i,
    message: 'Installs a package without pinning a version',
    why: 'An unpinned package gets whatever is newest when you run it, which may not be the version anyone checked.',
  },
];

const OBFUSCATED = /[A-Za-z0-9+/]{200,}={0,2}|(\\x[0-9a-f]{2}){30,}/i;

export function isScript(path) {
  return SCRIPT_EXT.test(path);
}

export function checkBinary(file) {
  if (!BINARY_EXT.test(file.path)) return [];
  return [{
    rule: 'code/binary-file',
    severity: 'error',
    file: file.path,
    line: 1,
    message: 'Contains a compiled or binary file',
    why: 'Nobody can review a binary by reading it. godsplan only lists skills whose code can be read.',
  }];
}

// For scripts, every line is code. For markdown, only fenced code blocks are.
export function checkCode(file) {
  const findings = [];
  const lines = file.content.split('\n');
  const script = isScript(file.path);
  let inFence = false;
  let networkSeen = false;

  lines.forEach((line, i) => {
    if (!script && /^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    // Inline `code` spans in markdown count too: "run `curl x | sh`" is still an instruction.
    const code = script || inFence ? line : (line.match(/`[^`]+`/g) || []).join(' ');
    if (!code) return;
    for (const r of RULES) {
      if (!r.re.test(code)) continue;
      if (r.rule === 'code/network') {
        if (networkSeen) continue; // one note per file is enough
        networkSeen = true;
      }
      findings.push({ rule: r.rule, severity: r.severity, file: file.path, line: i + 1, message: r.message, why: r.why, evidence: clip(line) });
    }
    if (OBFUSCATED.test(code)) {
      findings.push({
        rule: 'code/obfuscated-blob',
        severity: 'warn',
        file: file.path,
        line: i + 1,
        message: 'Long encoded blob (base64 or hex)',
        why: 'Large encoded strings can hide code or data from a reviewer. Legitimate uses exist (embedded images, fonts), so check what it decodes to.',
        evidence: clip(line, 80),
      });
    }
  });
  // Grabbing every env var is normal on its own; together with network access it is how keys leave.
  const net = findings.find((f) => f.rule === 'code/network');
  for (const f of findings) {
    if (f.rule === 'code/env-dump' && net) {
      f.severity = 'warn';
      f.message = `Copies all environment variables in a file that also makes network requests (line ${net.line})`;
      f.why = 'Environment variables hold your API keys. Check that the copied environment is never sent over the network.';
    }
    // Install lines in docs are suggestions for the reader; in scripts they run for real.
    if (f.rule === 'code/unpinned-install' && !script) f.severity = 'info';
  }
  return findings;
}
