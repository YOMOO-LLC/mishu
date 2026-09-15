# Post-call structured analysis

The analysis module turns a completed call and its final transcript entries into a small outcome summary and, when requested, a JSON value that follows an agent-provided `result_schema`. It stores results in the same `calls.sqlite3` database as the call session and runs automatically for completed calls.

## Schema contract

`result_schema` uses JSON Schema and must follow these rules:

- The top level must have `type: "object"` (or a type array containing `"object"`).
- Use `additionalProperties: false` when the caller needs a closed result shape.
- Every required fact that may be absent from the transcript must allow `null`, for example `type: ["string", "null"]`. The extractor never invents a missing fact.
- Local `$ref` values beginning with `#/` may be used when supported by Zod's JSON Schema converter. External file or URL `$ref` values are rejected.
- Keep schemas self-contained and reasonably small. Unsupported JSON Schema constructs are rejected before a model turn starts.
- A schema is identified by a canonical SHA-256 hash. Object key order does not affect the hash; the same `callId + schemaHash` returns the stored result without running another model turn.

Example:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["contact_name", "interested", "follow_up_at"],
  "properties": {
    "contact_name": { "type": ["string", "null"] },
    "interested": { "type": ["boolean", "null"] },
    "follow_up_at": { "type": ["string", "null"], "format": "date-time" }
  }
}
```

The model must return one JSON envelope containing `outcome`, `summary`, `confidence`, and (when a schema was supplied) `result`. Model output is parsed strictly and `result` is validated through Zod's JSON Schema converter. An invalid result is retried once; a second invalid result is stored as `outcome: "error"` with diagnostic text in the `error` column.

## Retrieval

The latest result for a call is available through `GET /v1/calls/{id}/analysis`, MCP `call_analysis_get`, and `mishu call analysis <id>`. The response contains `resultId`, `outcome`, `summary`, `confidence`, `schemaHash`, optional schema-backed `result`, and `analyzedAt`; a call with no stored analysis returns the standard 404 error envelope.

Per-call audit history is available through `GET /v1/calls/{id}/audit?limit=&offset=`, MCP `call_audit_list`, and `mishu call audit <id>`. Entries are chronological and contain `at`, `actor`, `action`, and optional `details`; phone numbers are masked by default, while transcript-like fields and token/secret/authorization/password fields are always replaced with an explicit redaction marker.

The shortest complete CLI path is:

```bash
mishu task submit --to +15551234567 --goal "Confirm attendance" \
  --prompt "Politely ask whether the guest will attend." \
  --result-schema ./attendance.schema.json --wait --timeout 300 \
  --include transcript,analysis
```

## Outcome values

Call termination is recorded independently from the analysis outcome. New reports use
`local_hangup` for an app-initiated hangup, `remote_hangup` for an unsolicited Twilio
disconnect, `carrier_error` for a Twilio call error, and `session_error` when GPT Live
disconnects first and the app ends the phone call; legacy `hangup`, `remote`, `error`, and
`timeout` values remain readable for compatibility, while `unknown` is reserved for calls
with no usable termination signal.

## Realtime startup failure policy

Outbound AI calls start GPT Live and Twilio in parallel to avoid adding the full realtime
handshake to time-to-ring. The dial operation now waits for both branches: if realtime
startup fails, it disconnects a dialing, connecting, ringing, or active Twilio call,
persists `session_error`, and returns the realtime error to the command gateway. This
accepts a bounded window of empty ringing in exchange for lower normal-case latency; a
prewarm-before-dial policy would eliminate empty ringing but would make every successful
call wait for the full realtime handshake before Twilio begins dialing.

The 45-second SDP deadline remains unchanged and startup is not retried automatically.
The available evidence is two complete deadline expirations, not a latency distribution
that supports a shorter safe cutoff, while one retry could double empty-ringing time and
create a second app-server session after an ambiguous first failure. Instrumented SDP
latency and cancellation confirmation should precede any timeout reduction or single
retry experiment.

| Outcome | Meaning |
| --- | --- |
| `reached` | A real person was reached and a meaningful exchange occurred. |
| `no_answer` | No meaningful conversation was established. |
| `voicemail` | The call reached voicemail or a message-taking system. |
| `refused` | The person explicitly refused the call or request. |
| `wrong_number` | The number or intended contact was wrong. |
| `error` | The call or structured extraction failed. |

Empty and very short transcripts do not start a Codex thread. A deterministic rule fallback classifies obvious voicemail, refusal, wrong-number, and call-error signals; otherwise it returns `no_answer`. Those results use `confidence: "low"` and fill required schema fields with `null`.

## Confidence

- `high`: the transcript directly and unambiguously supports the classification and extracted facts.
- `medium`: the result is supported but includes some interpretation or incomplete context.
- `low`: evidence is sparse, the rule fallback was used, or the extraction failed.

## Persistence and retry behavior

`call_results` stores the immutable result for a `call_id + schema_hash`. `analysis_jobs` stores automatic post-call work with the schema and optional goal needed for a later attempt. Backend failures use the same retry intervals as CRM post-call sync: 1 second, 5 seconds, 30 seconds, 2 minutes, and 5 minutes; the fifth failed attempt becomes `dead`.

`register(ctx)` subscribes to `call.ended`, reads `defaultResultSchema` and `defaultGoal` from the optional values or providers on its context, enqueues the job, and starts the retry scheduler. An injected `onAnalyzed(event, result)` callback receives the reserved `call.analyzed` payload; webhook publication is left to the integration layer so this module does not change the shared webhook event types.

The real backend starts an ephemeral, read-only, approval-never Codex app-server text thread and registers no dynamic tools. Transcript and goal text are explicitly labeled as untrusted data. Mock mode uses `MockAnalysisBackend`, which returns deterministic JSON and can be seeded with exact responses or errors for tests.

## T6.12b copilot incident analysis

The missing `end_call` action for inline task campaigns was a policy-selection bug rather than a tool or transcript failure. The `call.started` subscriber searched `getWorkspace()`, whose default view intentionally excludes ephemeral campaigns, and then silently used the selected durable campaign; the delegation thread provider always used that durable selection. As a result, a call whose actual ephemeral policy enabled copilot could inherit a disabled policy and create no copilot audit activity.

Policy resolution now uses the persisted call's `campaignId` in transcript mode. Delegation needs tools at realtime thread creation, before `call.started`; at that point it reads the campaign snapshot that the renderer stages and publishes while handling the dial command, then reuses the persisted call snapshot once present. Fallback is explicit and audited. Stored-policy normalization warnings are deduplicated in memory by campaign ID and field, so malformed legacy rows remain visible once per process without logging on every workspace read.

Identity instructions now cover both outcomes: a configured persona is the only allowed identity source, while an empty persona forbids inventing a name or organization and requires identifying as an automated voice assistant when asked. Unit tests cover both realtime and transcript-copilot prompts, and the mock E2E covers an approved inline campaign through copilot `end_call`, `local_hangup`, and task completion.

Outbound call history now keeps the renderer-created provisional call ID for the full Twilio lifecycle; a late provider `CallSid` is attached as metadata instead of replacing that ID and creating a second session. On startup, pre-connect sessions left in `dialing` or `connecting` for more than ten minutes are finalized as `ended` with `unknown` reason and a `call.orphaned` audit entry. A successful `end_call` now creates a speech barrier: the copilot stops accepting caller transcript, does not inject its tool result into realtime, suppresses later assistant handoff/transcript entries, and asks the realtime model to remain silent while the existing four-second bounded hangup wait completes.
