# `mishu` CLI

`mishu` is a dependency-free Node.js 22+ client for the Mishu `/v1` API. It discovers a running desktop App by default, sends bearer-authenticated requests, and prints machine-readable JSON.

## Install

From the packaged macOS App (Node.js 22+ required):

```bash
mkdir -p "$HOME/.local/bin"
ln -sfn "/Applications/Mishu.app/Contents/Resources/cli/mishu.mjs" "$HOME/.local/bin/mishu"
mishu --help
```

The App bundle must remain at that path for the symlink to work.

From a source checkout:

```bash
pnpm install
pnpm link --global
mishu --help
```

For a one-off invocation without linking:

```bash
npx --yes /absolute/path/to/mishu status
```

The desktop App must be running with MCP/API enabled. By default, the CLI reads `<userData>/mcp/endpoint.json`, then reads the bearer token from the permission-restricted `tokenPath` named by that file. Do not copy that token into scripts, logs, or source control.

## Global options

Global options may appear before or after the command.

| Option | Purpose |
| --- | --- |
| `--endpoint <url>` | Override local discovery. Accepts a server root, `/v1`, or the sibling `/mcp` URL. |
| `--token <token>` | Override the discovered bearer token. Prefer `LIVEPHONE_TOKEN` where shell history is a concern. |
| `--pretty` | Indent JSON for people. Compact JSON is the default. |
| `--help`, `-h` | Print command help. |

`--endpoint` is intended for alternate local deployments and a future hosted service. The CLI appends `/v1` to a server root, preserves a `/v1` endpoint, and converts a `/mcp` endpoint to its sibling `/v1`. Authentication is always `Authorization: Bearer`; cookies are not used.

If local discovery reports `APP_UNAVAILABLE` while the desktop App still shows the MCP
service as running, copy the endpoint shown in Settings and retry with
`mishu --endpoint http://127.0.0.1:<port>/mcp <command>`. The App checks the discovery
file during status reads and every 30 seconds, so the explicit endpoint is a temporary
fallback while `<userData>/mcp/endpoint.json` is restored.

## Commands

| Command | HTTP operation |
| --- | --- |
| `mishu status` | `GET /v1/status` |
| `mishu call --to <e164> [--campaign <id>] [--goal <text>] [--wait] [--timeout <s>]` | `POST /v1/calls`; `--wait` polls the call and fetches its transcript at a terminal state. |
| `mishu calls ls [--limit <n>] [--status <status>]` | `GET /v1/calls` |
| `mishu call get <id> [--transcript] [--reveal]` | `GET /v1/calls/{id}` and optionally its transcript. `--reveal` requests audited unmasked-number access. |
| `mishu call analysis <id>` | `GET /v1/calls/{id}/analysis` for the latest persisted analysis. |
| `mishu call audit <id> [--limit <n>]` | `GET /v1/calls/{id}/audit` for sanitized chronological audit entries. |
| `mishu call recording <id> --out <file.webm>` | Downloads `GET /v1/calls/{id}/recording/audio`. |
| `mishu task submit --to <e164> --goal <text> [--campaign <id> \| --prompt <text> \| --prompt-file <file>] [--voice <voice>] [--policy <policy.json>] [--campaign-name <name>] [--contact <card.json>] [--result-schema <schema.json>] [--constraints <constraints.json>] [--callback <url>] [--wait] [--timeout <s>] [--include transcript,analysis,call]` | `POST /v1/tasks`; prompt options create a retained one-time outbound campaign, `--contact` upserts destination context, and `--wait` uses repeated task long polls with optional expansions. |
| `mishu task get <id> [--include transcript,analysis,call]` | `GET /v1/tasks/{id}` with optional inline resources. |
| `mishu task ls [--limit <n>] [--status <status>]` | `GET /v1/tasks` |
| `mishu task wait <id> [--timeout <s>] [--include transcript,analysis,call]` | Repeats `GET /v1/tasks/{id}/wait` until the task is terminal or the CLI deadline expires, preserving optional expansions. |
| `mishu task cancel <id>` | `POST /v1/tasks/{id}/cancel` |
| `mishu budget get` | `GET /v1/settings/budget` |
| `mishu budget set --file <budget.json>` | `PUT /v1/settings/budget` |
| `mishu contacts set [<e164>] --file <card-or-cards.json>` | `PUT /v1/contacts/{phone}` for one object, or `POST /v1/contacts:batch` for an array. |
| `mishu contacts get <e164>` / `mishu contacts ls [--limit <n>]` | Get one card or list masked cards. |
| `mishu contacts rm <e164>` | `DELETE /v1/contacts/{phone}`. |
| `mishu hangup` | `POST /v1/calls/current/hangup`; if this is a task call, hangup ends the call but the task continues through analysis to completion. |
| `mishu answer` | `POST /v1/calls/current/answer` |
| `mishu reject` | `POST /v1/calls/current/reject` |
| `mishu campaigns ls [--include-ephemeral]` | `GET /v1/campaigns`; one-time task campaigns are hidden unless included. |
| `mishu campaign create --file <campaign.json>` | `POST /v1/campaigns` with the JSON file as its body. |
| `mishu campaign get <id>` | `GET /v1/campaigns/{id}` |
| `mishu campaign set <id> --file <campaign.json>` | `PUT /v1/campaigns/{id}` with the JSON file as its body. |
| `mishu campaign select <id>` | `POST /v1/campaigns/{id}/select` |
| `mishu campaign rm <id>` | `DELETE /v1/campaigns/{id}` |
| `mishu approvals ls` | `GET /v1/approvals` |
| `mishu approve <id>` / `mishu deny <id>` | `POST /v1/approvals/{id}/decide` |
| `mishu appointments ls` | `GET /v1/appointments` |
| `mishu settings get <webhook\|mcp\|appointments\|crm\|twilio>` | `GET /v1/settings/{category}`; Twilio fields are masked and the secret is never returned. |
| `mishu settings set <category> --file <settings.json>` | `PUT /v1/settings/{category}` with the JSON file as its body. |
| `mishu settings set twilio --from-env <path>` | `POST /v1/settings/twilio/import`; imports only supported Twilio fields. |
| `mishu settings set twilio [--file <settings.json>] --secret-stdin` | Reads the API Key Secret from stdin. Secret command-line arguments are rejected to avoid shell history exposure. |
| `mishu twilio test` | `POST /v1/settings/twilio/test`; signs locally and checks the TwiML App and optional number with read-only Twilio requests. |
| `mishu app relaunch` | `POST /v1/app/relaunch`; returns `CALL_IN_PROGRESS` while a call is active. |
| `mishu webhook test` | `POST /v1/settings/webhook/test` |
| `mishu simulate-incoming` | `POST /v1/debug/simulate-incoming`; available only in mock mode. |
| `mishu openapi` | Prints `GET /v1/openapi.json`. |

Every write request carries a fresh `Idempotency-Key`. Dial and task submissions include the same key as `idempotencyKey` in the JSON body.

Twilio precedence is per field: explicit process environment or `.env`, then the protected settings file, then unset/default. `LIVE_PHONE_USE_MOCKS` overrides the saved mode. Put `apiKeySecret` in a JSON file or pipe it through `--secret-stdin`; the CLI deliberately has no secret value option.

## Campaign prompt and persona

`systemPrompt` is the assistant's complete call script: objectives, facts, talk track, and operating instructions. `policy.persona` is narrower identity metadata, such as “You are the appointment coordinator.” They are independent when both are supplied, and `mishu campaign get` returns the same normalized `systemPrompt` that was created or set instead of replacing it with the persona.

For compatibility, either value can supply the missing one-way fallback needed to create a usable campaign. An explicit policy with an empty or omitted `persona` leaves the persona empty when `systemPrompt` is present. If only `policy.persona` is present, it is copied into `systemPrompt`; if both are empty, campaign create/set fails with `INVALID_ARGUMENT` (HTTP 400). When `policy` itself is omitted, the App creates the legacy policy whose persona mirrors `systemPrompt`.

SQLite's `campaigns.system_prompt` column is the canonical full script. Historically that column was also the only prompt, so rows without a valid `policy_json` still derive `policy.persona` from it on read; that legacy recovery does not overwrite the column for structured policies. Realtime instructions are assembled in the order `systemPrompt`, structured policy (including `persona`), then an optional task goal.

## Calling and approvals

An accepted call returns JSON like:

```json
{"status":"dialing","callId":"call_123"}
```

With `--wait`, the CLI polls `GET /v1/calls/{id}` until a terminal status, fetches the transcript, and prints `{ "call", "transcript", "summary" }`. The default timeout is 300 seconds.

If the service requires approval, the command returns immediately with `status: "pending_approval"`, an `approvalId`, and a JSON `hint`. Approve or deny it explicitly:

```bash
mishu approve approval_123
mishu deny approval_123
```

Approval is first-writer-wins across the CLI and desktop prompt. Do not resubmit a call to work around a pending, denied, or expired approval.

## Agent tasks and budgets

Tasks are the preferred agent-facing call workflow: the agent supplies a goal and may supply a JSON Schema for the result. The App queues tasks serially, places one call at a time, runs post-call analysis, and returns the structured result on the task object.

```bash
mishu task submit --to +15551234567 --goal "Confirm attendance" \
  --prompt "Politely ask whether the guest will attend." \
  --result-schema ./attendance.schema.json --wait --timeout 300 \
  --include transcript,analysis
```

`--prompt` or `--prompt-file` creates an outbound one-time campaign for that task. Its voice defaults to the currently selected campaign's voice, falling back to the first supported realtime voice only if no default is available; pass `--voice` to override it. The campaign remains addressable by the task's `campaignId` for history, is excluded from ordinary campaign lists, and cannot become the selected default. `--campaign` is mutually exclusive with all inline campaign options.

The server holds one task wait request for at most 300 seconds. Longer CLI timeouts transparently issue another long poll, and each CLI fetch deadline includes the server timeout plus transport margin. `--include` accepts any comma-separated combination of `transcript`, `analysis`, and `call`; omitting it preserves the compact response.

Call resources, including task responses expanded with `--include call`, report the actual voice backend and billed API duration as `voiceProvider` and optional `voiceSeconds`.

The default autonomous budget is disabled, so a queued task moves to `awaiting_approval` until a local user approves it. A task within an enabled budget may dial without an approval; a task outside any allowlist, time, call-count, or minute limit still requests approval, while `killSwitch: true` fails it immediately. Inspect with `mishu budget get`; change it only with the user's authorization.

`mishu hangup` ends the current call, including a call owned by an active task. It does
not cancel that task: the runner observes the local hangup, performs post-call analysis,
and completes the task with the transcript-derived outcome. Use `mishu task cancel`
when cancellation, rather than an early analyzed result, is intended.

## Output and exit codes

Successful commands write one JSON document to stdout. Runtime and API errors write `{ "error": { "code", "message", "details"? } }` to stderr.

| Exit | Meaning |
| ---: | --- |
| `0` | Success |
| `2` | Desktop App/API discovery failed or the discovered local App is unavailable |
| `3` | Network transport failure |
| `4` | Authentication failed; the local token may have rotated |
| `5` | API error, invalid response, or output write failure |
| `6` | Invalid command options or unreadable JSON input |
| `7` | `call --wait`, `task submit --wait`, or `task wait` timed out |

The service error's stable `error.code` provides finer-grained handling, such as `CALL_IN_PROGRESS`, `INVALID_NUMBER`, `GUARDRAIL_BLOCKED`, `RATE_LIMITED`, `APPROVAL_DENIED`, or `APPROVAL_TIMEOUT`.

## Voice source and OpenAI credentials

```sh
mishu settings get voice
mishu settings set voice --file voice.json
mishu settings get openai
mishu settings set openai --file openai.json
mishu settings set openai --secret-stdin
mishu openai test
```

`voice.json` accepts `provider` (`codex` or `gpt-live-api`), `apiVoice` (default `marin`) and `startPolicy` (`on_dial` or `on_answer`). API selection defaults to `on_answer`, so unanswered calls do not create a paid API session. `openai.json` accepts `apiKey`; use `null` to clear the stored key. Supply secrets only through a file or stdin, never an inline option. Get/test return masks or safe result codes. `OPENAI_API_KEY` takes precedence over the stored key. The read-only key test never creates a paid session.
