# Webhook receiver: `t=,v1=` HMAC

A minimal loopback receiver that verifies Mishu (working name) webhook signatures. It does **not** import `src/`. The HMAC scheme is:

- Header: `X-Mishu-Signature: t=<unix-ms>,v1=<hex>`
- Signed bytes: `SHA-256(secret, "{timestamp}.{rawBody}")` as hex
- Reject timestamps older than five minutes
- Compare digests with a constant-time check

Related headers (informational): `X-Mishu-Event`, `X-Mishu-Delivery-Id`.

HTTPS URLs are required except for `127.0.0.1` / `localhost` HTTP, which this example uses.

## Run

```bash
WEBHOOK_SECRET=your-hex-secret pnpm exec tsx examples/webhook-receiver/server.ts
```

The process prints `{ "ready": true, "baseUrl": "http://127.0.0.1:<port>" }` and never logs the secret.

Point the headless host at that URL:

```bash
# after pnpm cloud (or the quickstart host)
curl -sS -X PUT "$MISHU_BASE_URL/settings/webhook" \
  -H "authorization: Bearer $(cat "$MISHU_TOKEN_FILE")" \
  -H "content-type: application/json" \
  -d '{"enabled":true,"url":"http://127.0.0.1:PORT/hook","events":["webhook.test"]}'
```

Then `POST /v1/settings/webhook/test`. A valid signature returns HTTP 200; a tampered body returns HTTP 401.

## Test

```bash
pnpm exec vitest run examples/webhook-receiver/webhook-receiver.test.ts
```

The test starts `apps/cloud` on port 0, starts this receiver, registers the URL, and checks that the host's `webhook.test` delivery verifies.
