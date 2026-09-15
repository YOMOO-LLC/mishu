# Quickstart: mock `/v1` against the headless reference host

This example talks to `apps/cloud`, the single-tenant headless host. It uses **mocks only**. It never opens a Twilio session, never places a PSTN call, and never needs an API key.

Reserved example number: `+15555550100`.

## What it does

1. Creates an outbound campaign (AI disclosure stays on; a campaign cannot turn it off).
2. Submits a call task to `+15555550100`.
3. Approves the pending outbound dial.
4. Polls the task and call until they reach a terminal state.
5. Prints the transcript JSON (often short or empty on the mock host; the shape is still `/v1`).

## Run

From the repository root, with Node 22+ and `pnpm install` already done:

```bash
LIVE_PHONE_USE_MOCKS=1 LIVE_PHONE_SKIP_ENV_FILE=1 pnpm exec tsx examples/quickstart-api/quickstart.ts
```

The script starts `apps/cloud` on loopback port 0, reads the token file (mode 0600; the token is never printed), runs the flow, then stops the host and deletes the ephemeral data directory.

To attach to a host you already started (`pnpm cloud`):

```bash
MISHU_BASE_URL=http://127.0.0.1:PORT/v1 \
MISHU_TOKEN_FILE=/path/to/token \
pnpm exec tsx examples/quickstart-api/quickstart.ts
```

Do not paste the bearer token into the shell history. Point `MISHU_TOKEN_FILE` at the file the host wrote.

## Test

The Vitest file starts the host on port 0 and cleans it up:

```bash
pnpm exec vitest run examples/quickstart-api/quickstart.test.ts
```

Root `pnpm test` / `pnpm check` collect this file when the workspace Vitest config includes `examples/**` (the default config does).
