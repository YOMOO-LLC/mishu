# Local API v1

Mishu exposes a resource-oriented JSON API on the same ephemeral loopback listener as MCP. If the MCP endpoint is `http://127.0.0.1:43123/mcp`, the API base is `http://127.0.0.1:43123/v1`. The machine-readable contract is available at `GET /v1/openapi.json` and committed as [`openapi.json`](./openapi.json).

Local contact context is available through `/v1/contacts`, `/v1/contacts/{phone}`, and `/v1/contacts:batch`; see [`../contacts.md`](../contacts.md) for privacy, expiration, and in-call behavior.

## Authentication and deployment

Every `/v1` request uses `Authorization: Bearer <token>`; cookies are not accepted. The token is the same token used by MCP and is stored with mode `0600` below the application user-data directory. Rotating it through `POST /v1/settings/mcp/token/rotate` immediately invalidates the old token.

The desktop binds only to `127.0.0.1` and rejects non-loopback `Host` and `Origin` values. This loopback restriction is a deployment policy for the single-tenant desktop, not part of the portable API contract: a future hosted deployment may replace it with tenant-aware networking and identity while preserving `/v1` resources and payloads.

## Writes and asynchronous operations

All `POST`, `PUT`, and `DELETE` routes accept `Idempotency-Key`. The same method, path, and key replay the first status and response without repeating the operation. `POST /v1/calls` also accepts `idempotencyKey` in its JSON body for MCP/CLI parity.

Dialing and other asynchronous phone operations return `202 Accepted`. A dial response contains `approvalId`; clients decide it through `POST /v1/approvals/{id}/decide`, then poll `/v1/status` or `/v1/calls`. Desktop and API approval channels race safely: only the first decision takes effect.

Agent workflows should prefer `POST /v1/tasks`. A task carries the destination, goal, optional JSON Schema result contract, constraints, callback URL, and idempotency key. Poll `GET /v1/tasks/{id}` or long-poll `GET /v1/tasks/{id}/wait?timeoutMs=30000`; budget settings live at `GET|PUT /v1/settings/budget`. A disabled budget preserves the safe default: every queued task requests local approval before dialing.

Background behavior is configured through `GET|PUT /v1/settings/general`. The response contains `minimizeToTray`, `launchAtLogin`, and `startHidden`; login launch is supported on macOS and Windows, while Linux currently stores the preference without registering a login item.

Phone numbers are masked unless `?reveal=true` is supplied. Revealed access and every other HTTP request are written to `audit_log` with actor `http`, route, status, and redacted parameters. Secrets, tokens, prompts, and credentials are never written into HTTP audit parameters.

## Webhook deliveries

Outbound webhooks are JSON POSTs signed with HMAC-SHA256. Every delivery carries:

| Header | Value |
|---|---|
| `X-Mishu-Signature` | `t=<unix-ms>,v1=<hex>` over `{unix-ms}.{rawBody}` |
| `X-Mishu-Event` | Event type, for example `webhook.test` |
| `X-Mishu-Delivery-Id` | Stable delivery id; retries reuse the same value |

Verify the signature with a constant-time compare and reject timestamps older than five minutes. The same header names are documented on `GET /v1/openapi.json` under `x-webhook-delivery` and `components.headers`.

## Errors

Errors always use:

```json
{ "error": { "code": "NOT_FOUND", "message": "Call not found", "details": {} } }
```

| HTTP | Typical codes |
|---:|---|
| 400 | `INVALID_ARGUMENT` |
| 401 | `UNAUTHORIZED` |
| 403 | `SCOPE_DENIED`, `MOCK_ONLY` |
| 404 | `NOT_FOUND` |
| 405 | `METHOD_NOT_ALLOWED` |
| 409 | `CONFLICT`, `CALL_IN_PROGRESS`, `NO_ACTIVE_CALL`, `APPROVAL_DENIED`, `APPROVAL_TIMEOUT` |
| 422 | `UNPROCESSABLE_ENTITY`, `INVALID_NUMBER` |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL_ERROR` |
| 503 | `APP_NOT_READY` |

## Generate the contract

Run `pnpm api:openapi`. Route definitions and Zod request, query, and response schemas in `src/main/http/routes/definitions.ts` are the source; the command regenerates this directory's `openapi.json` as OpenAPI 3.1.
