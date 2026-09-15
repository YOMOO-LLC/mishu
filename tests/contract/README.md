# `/v1` contract tests

Black-box suite for the portable HTTP contract. Cases talk only to a base URL plus bearer token. They must not import `src/**`.

ADR-0001 invariants 9 and 10: the same public operation keeps the same schema, error envelope, idempotency, and state-machine semantics on every engine. This folder is that suite. Point it at local or cloud without changing cases.

## Runner

`pnpm test:contract` runs Vitest (`tests/contract/vitest.config.ts`).

Vitest, not Playwright:

- Cases are HTTP-only. They do not click the desktop UI.
- `CONTRACT_BASE_URL` + `CONTRACT_TOKEN` should work against any engine, including a future cloud staging URL, without launching Electron.
- Root `pnpm test:e2e` already owns Playwright's Electron driver. A second Playwright config would collide with `testDir` and workers.
- Vitest `globalSetup` can own a local Electron process and tear it down after the run.

Files are named `*.contract.ts` so root `pnpm test` (Vitest default include) does not pick them up. `pnpm check` does not run this suite yet.

## Local engine

```bash
pnpm test:contract
```

When `CONTRACT_BASE_URL` / `CONTRACT_TOKEN` are unset, global setup:

1. Builds the app if `out/main/index.js` is missing (`CONTRACT_FORCE_BUILD=1` to rebuild).
2. Starts Electron with a temp `--user-data-dir`, `LIVE_PHONE_USE_MOCKS=1`, and MCP/API enabled.
3. Reads `<userData>/mcp/endpoint.json` and the token file, same discovery path as `apps/cli/mishu.mjs`.
4. Waits until `GET /v1/health` is 200 and phone connection is `ready`.
5. Enables a mock-only `+1555` budget whitelist so task cases can reach a terminal state without a UI approval.

It does not touch the real userData directory, does not dial PSTN, and does not call paid APIs.

Set `CONTRACT_FORCE_BUILD=1` when you need a fresh `pnpm build`.

## Other engines

```bash
CONTRACT_BASE_URL=https://staging.example/v1 \
CONTRACT_TOKEN=<bearer> \
pnpm test:contract
```

`CONTRACT_BASE_URL` may be the `/v1` root, the HTTP origin, or an `/mcp` URL; the client normalizes it to `/v1`. Cloud staging should use a scoped API key, mock telephony, and `+1555…` fixtures.

## Case → invariant map

| File | Coverage | Invariants |
|---|---|---|
| `auth.contract.ts` | Missing token and wrong token → `401 UNAUTHORIZED`. Valid token reaches `/health`. | I3, I9 |
| `errors.contract.ts` | `404 NOT_FOUND`, `422 UNPROCESSABLE_ENTITY` (validation `details`), `409 CONFLICT` (stale approval). Envelope is `{ error: { code, message, details? } }`. | I9 |
| `idempotency.contract.ts` | Same `Idempotency-Key` + same body replays the first status/body. Different body does not apply the second write; portable engines return `409 CONFLICT` (local in-memory cache may replay the first response instead). | I9 |
| `campaigns.contract.ts` | Campaign create / read / update / list / delete. Numbers masked unless `reveal=true`. v1 campaign list is a workspace snapshot (no `limit`/`offset`); contacts and calls paginate. | I4, I9 |
| `contacts.contract.ts` | Contact put / get / batch / list pagination / delete. List phones are masked. | I4, I9 |
| `tasks.contract.ts` | `POST /tasks` → `202` + `taskId`. Mock mode runs to a terminal status. Observed transitions stay inside the published graph; terminal states do not move. | I9 |
| `calls.contract.ts` | List and detail field shape. Default responses mask E.164; `reveal=true` returns the raw fixture number. Pagination via `limit`/`offset`. | I4, I9 |
| `webhooks.contract.ts` | Local receiver checks HMAC (`t=,v1=` over `timestamp.body`), stable `deliveryId` / payload `id`, and retry dedupe on that id. | I13, I9 |
| `secrets.contract.ts` | Health, status, runtime, settings, lists, and OpenAPI omit bearer tokens, API keys, and unmasked numbers. | I4 |

Shared portable rules also in play: I10 (this suite is the one that must go green on local and cloud before a `/v1` release), I12 (no paid calls in tests).

## Cloud staging later

Keep the cases. Export `CONTRACT_BASE_URL` and `CONTRACT_TOKEN` in CI. Do not add engine-specific branches. If a deployment lacks a capability, it must return `CAPABILITY_UNAVAILABLE` rather than a different schema. Tenant isolation cases belong here once a second engine exists; local `tenantId` is `local` and is not taken from the caller.
