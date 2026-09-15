# Contributing to Mishu (working name)

Thank you for contributing. This repository is the MIT-licensed engine, contracts, adapters, headless reference host, and desktop local engine. Mishu Cloud multi-tenant operations and the mobile app are not in this tree.

Please read `AUP.md`, `CODE_OF_CONDUCT.md`, and `TRADEMARK.md` first. Security reports go to `SECURITY.md`, never to a public issue.

These contribution rules are drafts pending counsel review of the public legal files.

## Developer Certificate of Origin

Every commit must be signed off under [DCO 1.1](https://developercertificate.org/):

```bash
git commit -s -m "Your change."
```

That adds `Signed-off-by: Your Name <you@example.com>` and certifies you have the right to submit the work under the MIT License. There is no CLA. Unsigned commits will be rejected.

## Prerequisites

- Node.js 22 or newer (`node:sqlite` is required)
- [pnpm](https://pnpm.io) 11.x (see `packageManager` in `package.json`)
- No OpenAI API key and no Twilio account for default development

Install from the repository root:

```bash
pnpm install
```

The command-line `/v1` client is `mishu` (`apps/cli` in the public tree).

## Mocks by default — no real calls in tests

`LIVE_PHONE_USE_MOCKS=1` is the default in unit tests, contract tests, example tests, and CI. Do not place PSTN calls, buy or release numbers, send SMS, enable paid lookups, or deploy Twilio Functions from a pull request.

Example and fixture numbers must be reserved fiction in the `+1555…` range (for example `+15555550100`). Never paste Account SIDs, auth tokens, access tokens, `.env` contents, customer prompts, or live transcripts.

## How to run checks

From the repository root:

```bash
pnpm check
```

`pnpm check` runs boundary lint, typecheck, unit tests (including `examples/**` when the root Vitest config collects them), the desktop build, a bundle boundary check, and Playwright Electron e2e with mocks.

Smaller loops while iterating:

```bash
pnpm typecheck
pnpm test
pnpm test -- examples/quickstart-api/quickstart.test.ts
pnpm lint:boundaries          # node scripts/check-core-imports.mjs
```

### Port-contract helpers

The same `/v1` cases run against two engines:

```bash
pnpm test:contract            # desktop local engine (Electron, mocks)
pnpm test:contract:cloud      # apps/cloud headless reference host (no Electron)
```

Both suites must stay green (14/14). `apps/cloud` is a single-tenant reference host only. Do not add billing, Trust Hub, or production webhook secrets there.

If you change a `/v1` field, update `tests/contract/` and keep both engines passing. 0.x may break, but the changelog must describe the migration and old schema fixtures should stay green for at least one minor.

## Boundary rules

Dependency direction is `apps/adapters → core → contracts`.

- `packages/core` must not import Electron, Node `fs`/`child_process`/`sqlite`, vendor SDKs, `src/`, `apps/`, or `spikes/`.
- `packages/contracts` must not import core, adapters, or app hosts.
- `@mishu/adapters-mock` must not open a network or import vendor telephony/model SDKs.
- `@mishu/adapters-cloud` may use vendor SDKs but not Electron or `src/spikes`.
- `apps/cloud` must not import Electron, the desktop entrypoint, or `src/renderer/`.
- Keep phone audio on WebRTC media tracks (or the documented Media Streams path). Do not tunnel audio through the app-server JSON-RPC channel.
- Guardrails (AI disclosure, calling hours, DNC, consent) are platform policy in `core`, not an adapter switch. Do not add a public API that turns disclosure off.

`node scripts/check-core-imports.mjs` must report 0 violations.

## English-only shipping code

Shipping source under `src/`, `cli/`, and `packages/*/src` must be English. CJK in those trees fails `src/shipping-language.test.ts`. Comments, identifiers, UI strings, and logs in shipping code stay English. Docs may add `docs/zh/` later; this private-tree ADR set is not a template for CJK in public shipping code.

## How to propose a connector

Connectors are MCP servers that expose tools to the engine. They are not a second plugin ABI.

1. Open a **Connector proposal** issue (template in `.github/ISSUE_TEMPLATE/`). Describe the MCP server source (signed release, fixed URL, or loopback), the tool names, the risk class of each tool, and whether it needs Owner approval or platform review.
2. Official OAuth connectors (calendar, mail, and similar) stay on the hosted Cloud side until they pass platform review. Do not land them as "official out-of-the-box" plugins in MIT core.
3. Implement against the existing `/v1` contract and `packages/core` risk mapping. Reuse `ApprovalPort`; do not invent a parallel approval UI.
4. Tests must run in mock mode with `+1555…` numbers and must not call the third-party production API.
5. High-risk device or payment tools require step-up Owner confirmation. A matching caller ID is never enough.

See ADR-0003 for channel vs connector vocabulary and ADR-0004 for the open-source boundary.

## Pull requests

Use the pull request template. Before you mark a PR ready:

- `git commit -s` on every commit
- `pnpm check` green
- `pnpm test:contract:cloud` green when you touched `/v1`, tasks, campaigns, webhooks, or `apps/cloud`
- No secrets, no real E.164, no CJK in shipping code
- New examples stay under `examples/` and keep mocks-only defaults

Questions about product naming: the public name is **Mishu (working name)**. "Codex" is an OpenAI product name and may appear only as the technical name of the optional local voice/text source: "Codex app-server (optional local adapter)".
