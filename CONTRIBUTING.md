# Contributing to godsplan

## Add an entry

1. Create `registry/<name>/`. For a skill, `<name>` must equal the `name` in `SKILL.md`.
2. Put the files in it exactly as someone would install them:
   - **Skill:** `SKILL.md` plus any `scripts/`, `references/`, `assets/`
   - **Rules:** `AGENTS.md`, a Cursor `.mdc`, or `.cursorrules`
   - **MCP server:** `server.json` with `command` + `args` (version pinned) or `url`
3. Add `godsplan.yml`:

   ```yaml
   kind: skill            # skill | rules | mcp
   title: PDF Tools
   summary: One sentence a non-expert understands.
   tags: [pdf, documents]
   works_with: [Claude Code]
   source:
     repo: https://github.com/you/your-skills
     path: skills/pdf-tools
     commit: <full sha you copied from>
     license: MIT
     author: Your Name
   allow:                 # optional, every entry needs a reason
     - rule: secrets/sensitive-path
       file: SKILL.md
       reason: SSH setup skill. It edits ~/.ssh/config and never reads keys.
   ```

4. For MCP servers, capture what the tools say about themselves:

   ```sh
   node scanner/snapshot-mcp.js registry/<name>/server.json --set '<folder-you-allow>=/tmp'
   ```

5. Run `npm test && npm run check`, then open a pull request.

## Review (maintainers)

Read every file, including the warnings the scanner raised. Then:

```sh
node scanner/cli.js review <name> --by <your-github-user> --notes "what you checked"
```

This pins the review to a SHA-256 of every file in the entry. Any later change, even one byte or a renamed file, turns the entry back to "Review outdated" until someone reviews it again.

To check a remote MCP server hasn't changed since review:

```sh
node scanner/snapshot-mcp.js registry/<name>/server.json --diff
```

## Severity

- **Problem (error):** blocks the entry. Fix it, or add an `allow` with a reason. The reason is shown publicly on the entry page.
- **Look at this (warn):** does not block. The reviewer must read it.
- **Note (info):** context, such as "makes network requests".

## False positives

If the scanner flags something harmless, open an issue with the exact line. A fix comes with a regression test in `scanner/test/`, the same way the seven false alarms from the `anthropics/skills` field test were handled.
