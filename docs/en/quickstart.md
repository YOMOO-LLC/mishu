# Quickstart

Developer preview. Node.js 22 or newer and [pnpm](https://pnpm.io/) are required (`node:sqlite` is used by the campaign store).

Paths below are the **public** layout. In this private repo the desktop host still lives at the repository root; `scripts/oss/snapshot-manifest.json` maps it to `apps/desktop/` on export. `apps/cloud`, `packages/*`, and `tests/contract` already use the public paths.

## Clone and verify

```bash
git clone https://github.com/YOMOO-LLC/mishu.git
cd mishu
pnpm install
pnpm check
```

`pnpm check` runs, in order: `pnpm lint:boundaries` (core/contracts/adapter import rules), typecheck, unit tests, desktop build, bundle boundary lint, and Playwright Electron e2e in mock mode.

Baseline on the extract line: 920 unit tests (plus a few skipped), 39 e2e, 14/14 contract cases on each engine.

Bring your own Twilio and model credentials when you leave mock mode. Do not commit `.env`. Example keys live in `.env.example`. Phone numbers in fixtures are `+1555…` only.

## Desktop app (mock mode)

The desktop host is `apps/desktop`. Mock telephony is the default (`LIVE_PHONE_USE_MOCKS=1`).

```bash
pnpm dev
```

That starts the Electron console without PSTN or paid APIs. Use it to answer a simulated inbound call, inspect the live transcript, and exercise AI / human takeover.

Real Twilio mode is opt-in and needs a localhost Access Token helper (`pnpm dev:twilio` on `127.0.0.1:8787`). Token issuance stays loopback-only. Do not point `/token` at the public internet.

## Headless reference host

`apps/cloud` is a single-tenant `/v1` host with the same engine stores as desktop and mock ports as the P2 default. It is not a multi-tenant production cloud.

```bash
pnpm cloud
```

Equivalent: `pnpm --filter @mishu/cloud start`, or `tsx apps/cloud/src/index.ts`.

The process prints one JSON line `{ ready, baseUrl, tokenFile, ... }` and writes the bearer token to `tokenFile` (mode `0600`). It never prints the token. Optional flags: `--data-dir <path>`, `--port <n>`. Without `--data-dir` it uses an ephemeral temp directory and deletes it on stop.

## Contract kit

The same black-box suite in `tests/contract/` must pass on every engine.

Against the reference host (starts `apps/cloud`, injects `CONTRACT_BASE_URL` / `CONTRACT_TOKEN`, then stops):

```bash
pnpm test:contract:cloud
```

Against the local desktop engine (Electron global setup when the env vars are unset):

```bash
pnpm test:contract
```

Against any engine that already speaks `/v1`:

```bash
CONTRACT_BASE_URL=http://127.0.0.1:8788/v1 \
CONTRACT_TOKEN="$(cat /path/to/tokenFile)" \
pnpm test:contract
```

`CONTRACT_BASE_URL` may be the `/v1` root, the HTTP origin, or an `/mcp` URL; the client normalizes it to `/v1`. Do not paste real tokens into shells that get logged. Do not point the kit at production user data.

Port-level helpers (`@mishu/adapters-mock/contract-tests`) run inside unit tests of each adapter package; you do not need a separate command for those.

## CLI

The `/v1` client is `mishu`. After `pnpm install`:

```bash
pnpm exec mishu --help
```

The desktop App must be running with MCP/API enabled. In this private repo the entry is `cli/mishu.mjs`; the public snapshot maps it to `apps/cli/mishu.mjs`.

## What not to do

- Do not disable opening AI disclosure. Official builds compile it in core; campaigns cannot turn it off.
- Do not use real phone numbers, Account SIDs, or access tokens in docs, issues, or examples.
- Do not expect `apps/cloud` to provision numbers or run Trust Hub. Bring your own account if you wire `@mishu/adapters-cloud`.
