# Open-source scanners

These scripts run in public CI. They never print a full secret, never place a live call, and never read `.env`.

Masking rule for every hit: first 4 characters + `…` + last 4 characters.

| Script | Purpose | Default exit |
|---|---|---|
| `secret-scan.mjs` | Scan git-tracked files for Twilio SIDs, auth-token shapes, OpenAI keys, private-key blocks, JWTs, E.164 (skipping `+1555…`), and emails | `1` if any hit is not in `allowlist.json` |
| `license-audit.mjs` | `pnpm licenses list --prod --json` vs the allowed SPDX set | `1` on copyleft or unknown licenses |

Run from the repository root:

```bash
node scripts/oss/secret-scan.mjs --workspace-only
node scripts/oss/license-audit.mjs
```

`allowlist.json` is the only place known-fake values belong. Each entry needs a `rule`, a `value` and/or `pattern`, and a reason naming the fixture.
