# Call tasks

## Lifecycle

```text
queued → awaiting_approval → dialing → in_call → analyzing → completed
   └──────────┴───────────────┴──────────┴───────────┴──────→ failed | cancelled
```

| Status | Meaning | What you do |
| --- | --- | --- |
| `queued` | Persisted; waiting for `notBefore` or for the single-call runner | Nothing; the runner is serial |
| `awaiting_approval` | Budget did not cover the number; a local `call_dial` approval is pending and expires after 60 s | Surface it to the user; `mishu approvals ls` then `approve`/`deny` only with explicit authorization |
| `dialing` / `in_call` | Twilio is ringing or the call is live | Optionally watch `call get --transcript`; `hangup` if the user says so |
| `analyzing` | Call ended; outcome and schema extraction running | Wait; usually a few seconds |
| `completed` | `outcome` set; `result` present when a schema was supplied; `callId`, `resultId` filled | Read back data |
| `failed` | Guard, denial, approval timeout, exhausted retries, or analysis error; `error` says which | Report; do not auto-resubmit |
| `cancelled` | `task cancel` was called (hangs up an active call) | Terminal |

Retryable failures (`no_answer`, transient errors) back off 2, 10, then 30 minutes up to `maxAttempts`. A call ended by the copilot or by an external `hangup` is never retried automatically.

## `task submit` options

| Option | Notes |
| --- | --- |
| `--to +E164` | Required. Masked in every response. |
| `--goal TEXT` | Required, ≤ 8000 chars. The analysis grades the call against it. |
| `--campaign ID` **or** `--prompt TEXT` / `--prompt-file FILE` | Exactly one family. Prompt options create an ephemeral outbound campaign. |
| `--voice`, `--policy FILE`, `--campaign-name NAME` | Only with the prompt options. |
| `--contact FILE` | Upserts a contact card for `--to`. |
| `--result-schema FILE` | JSON Schema for the structured result (rules below). |
| `--constraints FILE` | `{ "maxDurationSec": 30–3600, "notBefore": ISO-8601, "notAfter": ISO-8601, "maxAttempts": 1–4, "allowedToolIds": [...] }` |
| `--callback URL` | Webhook for task events, in addition to any globally configured webhook. |
| `--wait --timeout S` | Block until terminal. The server long-polls at most 300 s per request; the CLI repeats until `S` elapses, then exits `7` with the task still running. |
| `--include transcript,analysis,call` | Only with `--wait` on submit; also on `task get` / `task wait`. Inlines the transcript array, the analysis object, and the call metadata. |

## Submit response

`task submit` without `--wait` prints `{"taskId": "…", "status": "queued"}`. Every other task command names the same value `id`. Read `taskId` from submit.

## Result schema

`--result-schema` turns "did it work" into data. The extractor fills the object strictly from the transcript and never invents facts, so the schema must allow absence:

- Top level `"type": "object"`; use `"additionalProperties": false` for a closed shape.
- Every property that might not come up in conversation must allow `null`: `"type": ["string", "null"]`.
- Keep it small and self-contained; only local `#/` refs; unsupported constructs are rejected before the model runs.
- The same `callId` + schema hash returns the stored result without re-running the model, so re-fetching is free.

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["attending", "preferred_time", "objection"],
  "properties": {
    "attending": { "type": ["boolean", "null"] },
    "preferred_time": { "type": ["string", "null"], "format": "date-time" },
    "objection": { "type": ["string", "null"] }
  }
}
```

An invalid model result is retried once; a second failure stores `outcome: "error"` with a diagnostic. Very short transcripts skip the model and use a rule-based classifier with `confidence: "low"` and `null` fields.

## Outcomes and confidence

| `outcome` | Meaning |
| --- | --- |
| `reached` | A real person was reached and a meaningful exchange happened |
| `no_answer` | No meaningful conversation (unanswered, dropped before content) |
| `voicemail` | Voicemail or a message system |
| `refused` | The person explicitly declined the call or request |
| `wrong_number` | Wrong number or wrong contact |
| `error` | Call or extraction failed |

`confidence` is `high`, `medium`, or `low`. When the copilot ended the call, its reason adjusts the outcome deterministically: `completed` → `reached`; `callee_requested` keeps `reached`/`wrong_number`, otherwise `refused`; `policy` keeps the analyzed outcome.

## Approvals

The App shows a modal for each pending dial: destination, campaign name, estimated cost, a countdown. The same approval is visible to the CLI:

```bash
mishu approvals ls
mishu approve <id>     # or deny
```

First writer wins between the UI and the CLI. The approval is for one dial; a retry attempt asks again. Approving on the user's behalf is only acceptable when they have explicitly authorized this specific call (or a clearly scoped batch); otherwise report the pending approval and stop.

## Budgets

`mishu budget get` returns:

```json
{"enabled":false,"dailyMaxCalls":0,"dailyMaxMinutes":0,"allowedPrefixes":[],"allowedNumbers":[],"allowedHours":{"timeZone":"UTC","windows":[]},"killSwitch":false}
```

A task dials without approval only when **all** hold: `enabled`, not `killSwitch`, today's UTC call and minute usage below the limits, the number matches `allowedNumbers` exactly or starts with an `allowedPrefixes` entry, and now is inside `allowedHours` (empty windows = always). Anything outside a normal limit falls back to approval; `killSwitch: true` fails tasks immediately. Update with `mishu budget set --file budget.json` only when the user has spelled out the limits and allowlists; log what was set.

## Batches and rate limits

Limits enforced by the App, checked when the task dials:

| Limit | Value | Symptom |
| --- | --- | --- |
| Calls per minute, all numbers | 3 | Task `failed`, `At most 3 calls are allowed per minute` |
| Same number | once per 10 minutes | Task `failed`, `The same number may only be called once every 10 minutes` |
| Concurrent calls | 1 | Later tasks stay `queued`; a dial that starts while the previous call is still settling can fail with `CALL_IN_PROGRESS` |
| Approval window | 60 s | Task `failed`, `Local approval timed out` |

A safe batch runs strictly one task at a time:

```bash
while read -r number; do
  [ -z "$number" ] && continue
  mishu task submit --to "$number" --campaign "$CAMPAIGN_ID" \
    --goal "Remind them about tomorrow's appointment and record whether they confirm." \
    --constraints ./constraints.json --result-schema ./result.schema.json \
    --wait --timeout 900 --include analysis > "result-${number#+}.json"
  sleep 20
done < numbers.txt
```

With `{"maxAttempts": 1}` in `constraints.json` each number gets exactly one dial and one approval. If the budget is disabled, each dial still waits for an approval: someone must approve it in the App within 60 seconds, or the user must explicitly authorize you to run `mishu approve` for exactly these numbers. Match approvals on `details.peer` before approving and never approve anything outside the batch.

To remove the approvals instead, the user can authorize a budget scoped to exactly the batch: `allowedNumbers` set to those numbers, no prefixes, a daily call cap equal to the batch size plus today's usage, and a short `allowedHours` window. Record the previous budget with `budget get`, apply the scoped one, and restore the previous one afterwards. Tell the user each of those steps.

When a task fails on a limit or an expired approval, find the cause first. Wait out the cooldown or fix your script, and tell the user before resubmitting. A failed task is not retried by resubmitting in a loop.

## Hangup vs cancel

- `mishu hangup`: ends the current call. A task that owned it continues into `analyzing` and completes with the transcript-based outcome. Use for "we have what we need" or "the caller asked us to stop".
- `mishu task cancel <id>`: terminal `cancelled`; hangs up if live. Use when the task should not produce a result at all.
- Copilot `end_call`: the assistant ends the call itself after its farewell; see campaigns-and-policy.md.

## Events

With a webhook configured (`mishu settings get webhook`), tasks emit `task.queued`, `task.started`, `task.completed`, `task.failed`, `task.cancelled`, and `call.analyzed`, signed with `X-Mishu-Signature: t=<unix-ms>,v1=<hex>` (HMAC-SHA256 over `{timestamp}.{rawBody}`). Payloads mask numbers. `--callback URL` adds a per-task destination.
