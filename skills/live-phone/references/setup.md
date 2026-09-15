# Setup, discovery, and running modes

## Install the CLI

`mishu` is `cli/mishu.mjs` in the Mishu repository. It needs Node.js 22+ and nothing else.

```bash
pnpm install            # once, in the repo
pnpm link --global      # puts `mishu` on PATH
mishu --help
```

Without linking: `node /path/to/mishu/cli/mishu.mjs status`, or `npx --yes /path/to/mishu status`.

## How the CLI finds the App

The desktop App writes `<userData>/mcp/endpoint.json` when its MCP/API server is running. The CLI reads that file, finds the loopback URL and the path to a permission-restricted bearer token, and authenticates every request with it. `<userData>` on macOS is `~/Library/Application Support/mishu`.

Implications:

- The App must be running **with MCP/API enabled** (Settings → MCP, or the persisted `<userData>/mcp/settings.json` containing `{"enabled": true, "scopes": [...]}`). Dialing needs the `control_calls` scope; reads need `read`; campaign writes need `manage_campaigns`.
- Do not read, print, or copy the token. Discovery is the whole point.
- If discovery fails but the App is visibly running, the discovery file may be missing. The App re-creates it on status reads and every 30 seconds; as a temporary fallback pass the endpoint explicitly: `mishu --endpoint http://127.0.0.1:<port>/mcp status` (the CLI converts `/mcp` to `/v1`). Use `LIVEPHONE_TOKEN` only if the user intentionally supplies a token for an alternate deployment.

## Two runtime modes

`mishu status` → `phone.runtimeMode` tells you which one is running:

| Mode | How it starts | What a call does |
| --- | --- | --- |
| `mock` | `LIVE_PHONE_USE_MOCKS=1 pnpm dev` (the default for `pnpm dev`, tests, and E2E) | No Twilio, no GPT Live. Dials complete instantly with a scripted two-line conversation; `mishu simulate-incoming` fakes a ringing inbound call. Safe for rehearsing commands and schemas. |
| `twilio` | `LIVE_PHONE_USE_MOCKS=0 pnpm dev` (or a `.env` with that value) plus the token helper `pnpm dev:twilio` on `127.0.0.1:8787`, with Codex CLI logged in | Real PSTN calls through Twilio, real voice model. Every dial is billed and reaches a real phone. |

Rehearse in mock mode when the goal is to validate a prompt, policy, or result schema shape. Switch to `twilio` only for the actual call, and say so explicitly to the user, because the same commands now have real consequences.

Keep exactly one App instance running. Two instances share the same `userData`, the same Twilio identity, and the same discovery file; the symptoms are `A Call is already active`, calls that stay `connecting`, and a discovery file that points at the wrong port.

## Starting the App from an agent session

`pnpm dev` is long-running. Do not start it inside a tool call that has a timeout; when the tool is killed the App dies mid-call. Use a detached session:

```bash
tmux new-session -d -s mishu "cd /path/to/mishu && pnpm dev > /tmp/mishu-dev.log 2>&1"
# wait for <userData>/mcp/endpoint.json to appear, then:
mishu status
```

Confirm `phone.phoneConnection` is `ready` before dialing; in `twilio` mode the Twilio device registration takes a few seconds after launch.

## Exit codes

| Exit | Meaning | Typical next step |
| ---: | --- | --- |
| `0` | Success | Parse stdout |
| `2` | Discovery failed or the App is unavailable | Start the App / enable MCP, or use `--endpoint` |
| `3` | Network transport failure | Retry once; check the App is still up |
| `4` | Authentication failed (token rotated) | Re-run; discovery re-reads the token. Do not paste tokens. |
| `5` | API error or invalid response | Read `error.code` on stderr; see troubleshooting |
| `6` | Invalid options or unreadable JSON input | Fix the command or the file |
| `7` | `--wait` timed out | The task is still running; `mishu task wait <id>` again |

Every write carries a fresh `Idempotency-Key`; task submissions also embed it as `idempotencyKey`. Replaying a task submission with the same key returns the existing task instead of dialing twice.
