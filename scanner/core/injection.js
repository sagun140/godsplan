// Instruction-level checks: text that tries to take over the agent, hide what it
// does from you, or point it at your secrets. Heuristics, not proof. Every hit
// is shown to a human reviewer with the line, never silently auto-rejected.

const RULES = [
  {
    rule: 'injection/override-instructions',
    severity: 'error',
    re: /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier|preceding|system|other)\s+(instructions|prompts?|rules|messages|guidelines)/i,
    message: 'Tells the agent to ignore its other instructions',
    why: 'This is the classic prompt-injection opener. A legitimate skill adds to what the agent does; it never needs to cancel your instructions.',
  },
  {
    rule: 'injection/conceal-from-user',
    severity: 'error',
    re: /\b(do\s+not|don'?t|never|without)\s+(tell(ing)?|inform(ing)?|notify(ing)?|mention(ing)?|reveal(ing)?|show(ing)?|alert(ing)?)\s+(it\s+to\s+|this\s+to\s+)?(the\s+)?user\b/i,
    message: 'Tells the agent to hide something from you',
    why: 'Invariant Labs\' MCP tool-poisoning attack worked exactly this way: "do not mention this to the user". Anthropic\'s skill review checklist flags any instruction to hide actions.',
  },
  {
    rule: 'injection/silent-action',
    severity: 'warn',
    re: /\b(silently|secretly|covertly|quietly)\s+(send|upload|post|delete|remove|install|run|execute|modify|change|copy|add|write|commit|push|download|forward|collect|read)\b|\bwithout\s+the\s+user\s+(knowing|noticing|seeing)/i,
    message: 'Asks the agent to act silently or secretly',
    why: 'Legitimate skills rarely need to hide what they are doing. Check what the silent action is.',
  },
  {
    rule: 'injection/role-hijack',
    severity: 'warn',
    re: /\byou\s+are\s+now\s+(in\s+)?(developer|dan|jailbreak|unrestricted|god)\b|<\/?\s*(system|IMPORTANT|instructions)\s*>/i,
    message: 'Tries to redefine the agent\'s role or inject a fake system block',
    why: 'Fake <system> or <IMPORTANT> tags make injected text look like it came from the platform. Invariant\'s poisoned tool used an <IMPORTANT> block.',
  },
  {
    rule: 'secrets/sensitive-path',
    severity: 'warn',
    re: /(^|[\s\"'`(=:~\\/])\.(ssh|aws|gnupg|kube|docker)[\\/]|id_(rsa|ed25519|ecdsa)\b|\.aws\/credentials|mcp\.json\b|claude_desktop_config\.json|\.npmrc\b|\.netrc\b|\.git-credentials|keychain|login\s+data/i,
    message: 'Mentions a credential or config file on your machine',
    why: 'SSH keys, cloud credentials and other agents\' MCP configs are what real malicious skills go after. Fine for an SSH-setup skill; suspicious anywhere else.',
  },
  {
    rule: 'secrets/dotenv',
    severity: 'info',
    re: /(^|[\s"'`/])\.env(\.local|\.production)?\b/i,
    message: 'Mentions .env files',
    why: 'Often harmless (many dev skills touch .env). Check the skill never sends its contents anywhere.',
  },
  {
    rule: 'injection/exfil-instruction',
    severity: 'error',
    re: /\b(send|post|upload|exfiltrate|transmit|forward|leak)\b[^\n]{0,60}\b(api[\s_-]?keys?|tokens?|secrets?|credentials?|passwords?|private\s+keys?|env(ironment)?\s+variables?|\.env)\b[^\n]{0,60}\b(to|via)\s+(https?:\/\/|a\s+(webhook|server|url|endpoint)|this\s+(url|endpoint|webhook))/i,
    message: 'Instructs the agent to send secrets to an outside address',
    why: 'Sending your keys or tokens to a URL is credential theft, whatever the stated reason.',
  },
];

export function checkInjection(file) {
  const findings = [];
  const lines = file.content.split('\n');
  lines.forEach((line, i) => {
    for (const r of RULES) {
      if (r.re.test(line)) {
        findings.push({ rule: r.rule, severity: r.severity, file: file.path, line: i + 1, message: r.message, why: r.why, evidence: clip(line) });
      }
    }
  });

  // HTML comments render as nothing on GitHub and in most markdown viewers, but the model reads them.
  if (!/\.(md|mdc)$/i.test(file.path)) return findings;
  const unfenced = file.content.replace(/^(```|~~~)[\s\S]*?^\1/gm, (block) => block.replace(/[^\n]/g, ' '));
  const commentRe = /<!--([\s\S]*?)-->/g;
  let m;
  while ((m = commentRe.exec(unfenced))) {
    const text = m[1].trim();
    if (text.split(/\s+/).length >= 6) {
      findings.push({
        rule: 'hidden/html-comment',
        severity: 'warn',
        file: file.path,
        line: file.content.slice(0, m.index).split('\n').length,
        message: 'Long HTML comment: invisible when rendered, visible to the agent',
        why: 'Instructions in comments do not show up when you read the skill on GitHub, but the agent still sees them.',
        evidence: clip(text),
      });
    }
  }
  return findings;
}

export const clip = (s, n = 160) => {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
