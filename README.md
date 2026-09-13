# godsplan

**Agent skills, rules and MCP servers that someone actually checked.**

Finding a good skill today means digging through GitHub repos, Discord threads and Reddit comments. Half of what you find is out of date, some of it has broken YAML, and some of it hides instructions you can't see. godsplan is a registry where every entry:

1. **passes an automated scanner:** does it load, will it trigger, hidden Unicode, prompt injection, risky scripts, unpinned MCP packages
2. **is reviewed by a named person:** the review is pinned to a SHA-256 of the exact files, so if one byte changes the badge comes off
3. **explains itself in plain English:** every finding says why it matters

## Check anything, right now

```sh
npx godsplan check ./some-skill-folder      # once published to npm
node scanner/cli.js check ./some-skill-folder
```

Or open the site and paste a `SKILL.md`, `AGENTS.md`, `.mdc` or `server.json` into the checker. It runs in your browser and uploads nothing.

## What is checked

| Area | Examples |
|---|---|
| Does it load | Agent Skills spec: `name` format and folder match, `description` ≤ 1024 chars, unknown fields, YAML that won't parse, links to missing `references/` files, Cursor rule fields |
| Will it trigger | descriptions too short or never saying *when* to use the skill |
| Hidden text | Unicode Tag smuggling (decoded and shown), bidi controls, zero-width chars, variation-selector smuggling, HTML comments |
| Injection | "ignore previous instructions", "don't tell the user", fake `<IMPORTANT>` blocks, send-secrets-to-URL |
| Risky code | `curl \| bash`, decode-and-exec, reading `~/.ssh` or cloud credentials, env copy + network, persistence, `sudo`, binaries, hardcoded keys |
| MCP | exact version pins, https only, Docker digests, tool-description snapshot + `--diff` for rug pulls, what the server can change |

The scanner is pattern-based and runs fully offline. A clean scan is not a guarantee, which is why a human review is required for "Verified".

## Field test

Run over all 19 skills in [anthropics/skills@34040c9](https://github.com/anthropics/skills/tree/34040c9c568585f6929bedeaad110ad08f079624): 14 no issues, 4 need a look (3 descriptions with no "when to use", 1 unpinned install in a script), 1 blocked (`claude-api` description is 1,068 characters, over the 1,024 limit). The first run raised 7 false alarms; each is now a regression test.

## Layout

```
registry/<name>/        an entry: the installable files + godsplan.yml
scanner/core/           pure checks (files in, report out), shared by CLI, CI and the site
scanner/cli.js          godsplan check | review
scanner/snapshot-mcp.js capture or diff an MCP server's advertised tools
site/                   static site, built into one self-contained dist/index.html
```

```sh
npm install
npm test          # scanner tests, including the attack corpus
npm run check     # scan the registry; fails if any entry is blocked
npm run build     # dist/index.html
```

See [CONTRIBUTING.md](CONTRIBUTING.md) to add an entry or review one.

## Licenses

Scanner and site: MIT. Registry entries keep their original licenses, listed in each `godsplan.yml` and in the entry's own files.
