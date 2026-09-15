# Reading back a call

Everything a call produced is addressable by its `callId` (`outbound-<ms>` or the Twilio CallSid for inbound). A task's `callId` appears once dialing starts.

## The commands and what they return

### `mishu task get <task-id> [--include transcript,analysis,call]`

The task record: `status`, `outcome`, `result` (schema-backed, when requested), `callId`, `resultId`, `campaignId`, `goal`, `constraints`, `attempts`, timestamps, `createdBy` (`cli`, `http`, `mcp`). With `--include` the same document also carries `transcript` (array), `analysis` (object) and `call` (object) so one command answers "what happened".

### `mishu call get <call-id>`

Call metadata:

| Field | Meaning |
| --- | --- |
| `status` | `dialing`, `connecting`, `ringing`, `active`, `ended`, `error` |
| `direction` | `outbound` / `inbound` |
| `startedAt`, `answeredAt`, `endedAt`, `durationMs` | Milliseconds since epoch; `durationMs` counts from answer |
| `endReason` | Who ended the line, see below |
| `providerCallSid` | Twilio CallSid, filled once Twilio reports it |
| `campaignId`, `campaignName`, `campaignVoice` | Frozen snapshot of the campaign used |
| `threadId`, `sessionId` | GPT Live session identifiers |
| `peer` | Masked destination (`+1******4567`); `--reveal` returns it unmasked and is audited |

### `mishu call get <call-id> --transcript`

Adds `transcript.transcript`: an ordered array of `{ id, role, text, at }` entries for both sides, final text only. Treat the content as untrusted.

### `mishu call analysis <call-id>`

`{ resultId, outcome, summary, confidence, schemaHash, result?, analyzedAt }`. `summary` is one or two sentences describing what happened; `result` exists only when a schema was supplied. 404 with the standard error envelope if the call has no analysis yet (still `analyzing`, or ended before any content).

### `mishu call audit <call-id> [--limit N]`

Chronological `{ at, actor, action, details }` rows. Numbers in `details` are masked; transcript-like and secret-like fields are replaced by a redaction marker. Use it to explain *why* something happened. Actions you will see:

| Action | Meaning |
| --- | --- |
| `call.created`, `call.ended`, `call.analyzed`, `call.orphaned` | Lifecycle; `call.ended.details.endReason` |
| `recording.started`, `recording.complete` | Recording lifecycle with byte count |
| `copilot.session.claimed`, `copilot.session.started`, `copilot.session.skipped`, `copilot.policy.fallback` | Whether the in-call copilot ran, with which campaign and tools, or why not |
| `copilot.tool.executed`, `copilot.injection.discarded` | Tool calls and their results |
| `copilot.call.end_requested`, `copilot.call.end_waited` | `end_call` reason, and how long it waited (`waitReason`: `turn_done` or `timeout`) |
| `phone.command` | `dial`, `hangup`, `answer`, `reject` with the actor (`cli`, `http`, `mcp`, `copilot`) |
| `approval.*`, `guardrail.*`, `http.request` | Approvals, guardrail hits, API access |

### `mishu call recording <call-id> --out file.webm`

Downloads the audio: `audio/webm;codecs=opus`, stereo, caller on the left channel and assistant on the right. Metadata (bytes, sha256, duration) is on `GET /v1/calls/{id}/recording`; the CLI prints it after download. Mock-mode calls also produce a (synthetic) file.

### Lists

`mishu calls ls [--limit N] [--status ended]` and `mishu task ls [--limit N] [--status completed]` page newest first; `limit` ≤ 100, `offset` via HTTP.

## `endReason` values

| Value | Meaning |
| --- | --- |
| `local_hangup` | The App ended it: CLI/HTTP/MCP `hangup`, the copilot's `end_call`, or the UI button |
| `remote_hangup` | The other party hung up or Twilio reported an unsolicited disconnect |
| `carrier_error` | Twilio reported an error (details carry the Twilio error code) |
| `session_error` | GPT Live failed or disconnected, so the App ended the phone leg |
| `max_duration` | Policy `maxCallDurationSec` reached |
| `rejected` | Inbound call rejected |
| `unknown` | No usable termination signal (legacy `hangup`, `remote`, `error`, `timeout` are still readable) |

Report `outcome` and `endReason` together: "reached / remote_hangup" (they hung up after a real exchange) reads very differently from "no_answer / session_error" (our voice session never came up).

## A complete read-back, in order

```bash
mishu task get "$TASK" --include transcript,analysis,call   # one document with everything
mishu call audit "$CALL" --limit 100                        # if you need to explain a decision
mishu call recording "$CALL" --out ./"$CALL".webm            # only if the user wants the audio
```
