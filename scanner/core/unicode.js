// Hidden-character checks. These are the "Rules File Backdoor" and Unicode Tag
// smuggling attacks: text a human reviewer cannot see but a model still reads.

const TAG = [0xe0000, 0xe007f]; // Unicode Tags: each maps 1:1 to an invisible ASCII char
const VS_SUPPLEMENT = [0xe0100, 0xe01ef]; // variation selectors used for byte smuggling
const BIDI = new Set([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c]);
const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xfeff, 0x180e]);

const inRange = (cp, [lo, hi]) => cp >= lo && cp <= hi;
const isEmoji = (ch) => ch !== undefined && /\p{Extended_Pictographic}/u.test(ch);

export function checkUnicode(file) {
  const findings = [];
  const lines = file.content.split('\n');

  lines.forEach((line, i) => {
    const chars = [...line];
    let tagRun = '';
    let tagStart = 0;
    const flushTags = () => {
      if (!tagRun) return;
      // Subdivision flags (England, Scotland, Wales) are a black flag followed by tag letters.
      if (chars[tagStart - 1] === '\u{1F3F4}' && /^[a-z0-9]{2,6}$/.test(tagRun)) {
        tagRun = '';
        return;
      }
      findings.push({
        rule: 'unicode/tag-smuggling',
        severity: 'error',
        file: file.path,
        line: i + 1,
        message: `Invisible Unicode Tag characters spell out hidden text: "${tagRun}"`,
        why: 'Unicode Tag characters are invisible in editors and on GitHub, but AI models read them as instructions. This is a known way to hide a prompt injection inside a skill.',
      });
      tagRun = '';
    };

    chars.forEach((ch, col) => {
      const cp = ch.codePointAt(0);
      if (inRange(cp, TAG)) {
        if (!tagRun) tagStart = col;
        // Tag chars mirror ASCII; U+E0001 (language tag) and U+E007F (cancel) have no printable twin.
        const ascii = cp - 0xe0000;
        tagRun += ascii >= 0x20 && ascii < 0x7f ? String.fromCharCode(ascii) : '';
        return;
      }
      flushTags();

      if (inRange(cp, VS_SUPPLEMENT)) {
        findings.push(hidden(file, i, col, 'unicode/variation-selector-smuggling', 'error',
          `Supplementary variation selector U+${hex(cp)}`,
          'These invisible selectors can encode arbitrary bytes after a visible character, hiding data from a human reviewer.'));
      } else if (BIDI.has(cp)) {
        findings.push(hidden(file, i, col, 'unicode/bidi-control', 'error',
          `Bidirectional control character U+${hex(cp)}`,
          'Bidi controls make text display in a different order than a model reads it, so what you review is not what the agent gets.'));
      } else if (ZERO_WIDTH.has(cp)) {
        // A zero-width joiner between two emoji is how family/skin-tone emoji are built. That is fine.
        if (cp === 0x200d && isEmoji(chars[col - 1]) && isEmoji(chars[col + 1])) return;
        if (cp === 0xfeff && i === 0 && col === 0) return; // byte-order mark at file start
        findings.push(hidden(file, i, col, 'unicode/zero-width', 'error',
          `Zero-width character U+${hex(cp)}`,
          'Zero-width characters are invisible and can split or hide words so a reviewer and a keyword filter both miss them.'));
      }
    });
    flushTags();
  });

  return dedupe(findings);
}

function hidden(file, i, col, rule, severity, message, why) {
  return { rule, severity, file: file.path, line: i + 1, column: col + 1, message, why };
}

const hex = (cp) => cp.toString(16).toUpperCase().padStart(4, '0');

// One finding per rule per line keeps a file full of joiners readable.
function dedupe(findings) {
  const seen = new Map();
  for (const f of findings) {
    const key = `${f.rule}:${f.line}`;
    if (seen.has(key)) seen.get(key).count++;
    else seen.set(key, { ...f, count: 1 });
  }
  return [...seen.values()].map(({ count, ...f }) =>
    count > 1 ? { ...f, message: `${f.message} (+${count - 1} more on this line)` } : f);
}
