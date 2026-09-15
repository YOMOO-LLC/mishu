# Call tasks

Call tasks are the agent-facing unit of work. An agent submits a destination, a concrete goal, and optionally a JSON Schema; the desktop serializes outbound calls and returns a durable task with a schema-validated result.

## Lifecycle

```text
queued -> awaiting_approval -> dialing -> in_call -> analyzing -> completed
   |              |              |          |            |
   +--------------+--------------+----------+------------+-> failed
   +--------------+--------------+----------+------------+-> cancelled
```

- `queued`: persisted and waiting for its scheduling constraints and the single-call runner.
- `awaiting_approval`: autonomous budget did not cover the call; a local `call_dial` approval is pending.
- `dialing` / `in_call`: the existing renderer phone stack is dialing or carrying the call.
- `analyzing`: the call ended and its outcome, plus any requested result schema, is being evaluated.
- `completed`: contains `outcome` and, when a schema was supplied, `result` plus the related `callId` and `resultId`.
- `failed`: a non-retryable guard, denial, approval timeout, exhausted retry, or analysis error ended the task.
- `cancelled`: cancellation is terminal; an active task also requests hangup.

The runner processes one task at a time. `notBefore` and `notAfter` bound scheduling, `maxAttempts` is 1–4, and retryable no-answer or errors back off for 2, 10, then 30 minutes. Submission is idempotent by `idempotencyKey`; replaying the same key returns the existing task.

Phone numbers are masked in task responses by default. Campaign DNC, direction, and calling-hours guards still apply before dialing, regardless of budget.

A submission may provide either `campaignId` or an inline outbound `campaign`, never both. The inline object requires `direction: "outbound"`, may include `name`, `voice`, and a full `policy`, and must provide a non-empty `systemPrompt` or `policy.persona`. The App persists it as an ephemeral campaign, returns its ID on the task, keeps it for historical lookup after completion, excludes it from `GET /v1/campaigns` unless `includeEphemeral=1`, and prevents selecting it as the default. Dialing with an inline campaign does not change the campaign selected in the UI. If `voice` is omitted, the selected campaign's voice is used; if no selected campaign is available, `REALTIME_VOICES[0]` is used.

`systemPrompt` is the assistant's complete script, while `policy.persona` is only its identity description. They remain independent when both are present. If the persona is empty, the script is still valid; if only a persona is present, it is used as the legacy script fallback; if both are empty, submission fails with `INVALID_ARGUMENT`. The persisted `campaigns.system_prompt` column is the canonical full script and is what campaign reads return. Older rows had only this column (effectively using one prompt as both script and persona), so a missing or invalid `policy_json` still derives `policy.persona` from `system_prompt` for backward compatibility. Realtime instructions preserve the distinction and order the complete script first, the structured policy (including persona) second, and the per-task goal last.

An optional inline `contact` object upserts local context for the task destination before it is queued. Its `phone` may be omitted; when present it must match `to`. See [`contacts.md`](./contacts.md).

## Agent hangup

An enabled in-call copilot may use the `end_call` tool only when the campaign both lists
`end_call` in `copilot.allowedToolIds` and leaves `copilot.mayEndCall` enabled (the default).
The tool records the reason, waits for the current assistant turn to finish, with a 4
second upper bound, and then performs the same local hangup used by other control clients.
The audit row `copilot.call.end_waited` records how long it waited and whether the wait
ended on `turn_done` or `timeout`.
That wait lets the farewell finish without allowing a missing turn notification to leave
the call open indefinitely.
It does not require a local approval prompt.

A copilot or external CLI/HTTP/MCP hangup does not cancel a task. Once the call reports its
terminal state, the task moves through `analyzing` and then `completed`. The task outcome is
normally the post-call analysis outcome; copilot reasons add these deterministic rules:

- `completed` maps to `reached`.
- `callee_requested` preserves `reached` or `wrong_number`; otherwise it maps to `refused`.
- `policy` preserves the analyzed outcome, except an otherwise empty `no_answer` maps to `error`.

An external `mishu hangup`, HTTP hangup, or MCP `call_hangup` has no semantic reason
argument, so its completed task keeps the transcript-derived analysis outcome.

## Autonomous budget

The global budget is disabled by default, preserving local approval for every call. A task can dial directly only when all of these are true:

- `enabled` is true and `killSwitch` is false;
- current UTC-day call and minute usage is below `dailyMaxCalls` and `dailyMaxMinutes`;
- the destination exactly matches `allowedNumbers` or begins with an `allowedPrefixes` entry;
- the current time falls in `allowedHours` (an empty windows list means all hours).

Exceeding a normal limit routes the task to local approval; it does not silently drop the task. `killSwitch: true` fails it immediately. Changing the budget is an external-policy action and should be done only with explicit authorization.

## Shortest agent flow

CLI, for a destination already covered by the authorized budget:

```bash
mishu task submit --to +15551234567 --goal "Confirm attendance" \
  --prompt "Politely ask whether the guest will attend." \
  --result-schema ./attendance.schema.json --wait --timeout 300 \
  --include transcript,analysis
```

HTTP:

```http
POST /v1/tasks
Authorization: Bearer <local-token>
Idempotency-Key: task-42
Content-Type: application/json

{"to":"+15551234567","goal":"Confirm attendance","campaign":{"direction":"outbound","systemPrompt":"Politely ask whether the guest will attend."},"contact":{"displayName":"Ada","tier":"Gold","source":"external-agent"},"resultSchema":{"type":"object","additionalProperties":false,"required":["attending"],"properties":{"attending":{"type":"boolean"}}},"idempotencyKey":"task-42"}
```

Then call `GET /v1/tasks/{taskId}/wait?timeoutMs=300000&include=transcript,analysis`. A long-poll timeout returns the current nonterminal task; it does not cancel it. `include` accepts any comma-separated combination of `transcript`, `analysis`, and `call`; omission preserves the original compact task response.

MCP uses the same service and state machine:

```text
task_submit {"to":"+15551234567","goal":"Confirm attendance","campaign":{"direction":"outbound","systemPrompt":"Politely ask whether the guest will attend."},"contact":{"displayName":"Ada","tier":"Gold"},"idempotency_key":"task-42","result_schema":{"type":"object","additionalProperties":false,"required":["attending"],"properties":{"attending":{"type":"boolean"}}}}
task_wait {"id":"<returned taskId>","timeout_ms":300000,"include":"transcript,analysis"}
```

`task_submit` and `task_cancel` require the `control_calls` scope; reads require `read`. Budget updates also require `control_calls`.

## Events

Webhook subscriptions may include `task.queued`, `task.started`, `task.completed`, `task.failed`, `task.cancelled`, and `call.analyzed`. Task event payloads contain the task ID, status, and any available outcome, masked result, and call ID. Webhook delivery uses the existing signed outbox and retry policy.

## Copilot campaign binding and audit

The in-call copilot resolves policy from the campaign snapshot attached to the call, including an ephemeral inline task campaign. Transcript mode resolves `call.campaignId` when `call.started` is persisted. Delegation mode must register dynamic tools before that event, so its thread-start provider first uses an already-active call snapshot and otherwise uses the renderer's published `selectedCampaignId`; the renderer publishes the command-staged campaign snapshot before starting GPT Live. Only a missing campaign falls back to the durable UI selection, with `copilot.policy.fallback` recorded in `audit_log`.

Every call records the copilot decision: `copilot.session.started` includes `campaignId`, mode, and tool IDs, while `copilot.session.skipped` records why no session was created or why startup failed. These rows use `actor = copilot`, making a live-call failure distinguishable from a transcript or tool-trigger problem without relying on process logs.
