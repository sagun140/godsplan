# godsplan

Registry of agent skills, rules and MCP servers, plus an offline scanner and a static site.

## Commands (verified on Node 24)

```sh
npm install
npm test                                        # node --test over scanner/test
npm run check                                   # scan every registry entry; exits 1 if any is blocked
npm run build                                   # writes dist/index.html (single self-contained file)
node scanner/cli.js check registry/<name>       # scan one folder
node scanner/cli.js check --registry --json     # machine-readable report incl. each entry's content hash
```

## Traps

- `scanner/test/scan.test.js` contains a fake `sk-ant-api03-...` key on purpose (the hardcoded-key test). It is not a leak.
- The review badge is pinned to `contentHash()` in `scanner/registry.js`. Any change to what it hashes changes
  every hash that covers the affected files, which turns reviewed entries into "Review outdated".
- `readFolder` does not scan files over 512 KB (their `content` is `''`); they are still hashed via `raw`.
- `dist/` is build output and is gitignored.
- CI (`.github/workflows/check.yml`) runs test, check and build, but GitHub Actions on this account currently
  fails before any step runs, so a red check says nothing about the code.
