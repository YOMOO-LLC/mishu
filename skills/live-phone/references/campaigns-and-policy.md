# Campaigns and policy

A campaign is the assistant's configuration for a call: the system prompt it speaks from, the voice, the direction it may serve, and a policy of guardrails. Every call carries a frozen snapshot of the campaign it used, so later edits never change the history of a finished call.

## Ephemeral vs saved campaigns

| | Inline (ephemeral) campaign | Saved campaign |
| --- | --- | --- |
| Created by | `task submit --prompt/--prompt-file [--policy] [--voice] [--campaign-name]` | `mishu campaign create --file campaign.json` |
| Visible in `campaigns ls` | Only with `--include-ephemeral` | Always |
| Can be the UI default (`campaign select`) | No | Yes |
| Best for | One task with its own instructions; agents that build the prompt per call | Repeated calls with a stable script; inbound handling; anything a human edits in the App |

Submitting a task with an inline campaign never changes the campaign the user has selected in the App. The task's `campaignId` still points at the ephemeral record, so `campaign get <id>` works for history.

`--campaign <id>` and the inline options are mutually exclusive; the CLI refuses both.

## Campaign JSON (`campaign create` / `campaign set`)

```json
{
  "name": "Demo confirmation",
  "direction": "outbound",
  "systemPrompt": "You are Ada from Northwind's events team ...",
  "voice": "sol",
  "policy": { "...": "see below" },
  "inboundNumber": "+15550001111",
  "outboundCallerId": "+15550001111"
}
```

- `direction`: `outbound`, `inbound`, or `both`. An inline task campaign is always `outbound`.
- `systemPrompt`: up to 8000 characters. This is the whole script; see "Writing the prompt". `policy.persona` is only the identity. At least one of the two must be non-empty; with only a persona, the persona also becomes the script. When a task supplies a `--goal`, the assistant's instructions are built in the order script, then policy rules, then goal, so a saved campaign's script is never replaced by the goal.
- `voice`: one of `arbor`, `breeze`, `cove`, `ember`, `juniper`, `maple`, `sol`, `spruce`, `vale`. An inline campaign without `--voice` inherits the selected campaign's voice.
- `inboundNumber` / `outboundCallerId` are metadata for matching and display; they do not reconfigure Twilio routing.

## Writing the prompt

The realtime assistant follows the prompt literally and fills gaps with invention, so state the things you would otherwise assume:

- **Identity.** Who is speaking and on whose behalf. If you leave the persona empty, the App injects a rule forbidding the assistant from inventing an organization or name, and it will describe itself as an automated voice assistant when asked.
- **Language.** Say which language to use and whether to switch if the callee answers in another.
- **Flow.** Opening, the one thing the call must accomplish, how to handle "not now", how to close. Numbered steps work well.
- **Boundaries.** What not to promise, not to ask for, not to discuss. Put hard rules in `policy` too, because policy is enforced deterministically while the prompt is only advice.
- **Ending.** If the copilot's `end_call` is enabled, say: "say exactly one short farewell, then call `end_call`, then stay silent". Without that the assistant tends to keep talking after a goodbye.

The App always prepends a recording disclosure when `recordingDisclosure` is true and appends safety rules; do not duplicate them.

## Policy JSON

Pass it as `--policy policy.json` on `task submit` or as the `policy` field of a campaign. Every field is optional; invalid single fields fall back to their default with a warning instead of rejecting the whole policy.

| Field | Default | Effect |
| --- | --- | --- |
| `persona` | `""` | Identity text merged into the prompt; empty means "do not invent an identity". |
| `allowedTopics` | `[]` | Topics the assistant may discuss (advisory, sent to the model). |
| `forbiddenTopics` | `[]` | Topics to refuse (advisory). |
| `forbiddenClaims` | `[]` | Phrases the assistant must never assert. Monitored deterministically on the transcript; a hit records a guardrail event and, per `onForbiddenClaim`, reports or hands the call to a human. |
| `negativePrompt` | `""` | Free-text "never do this" block appended to instructions. |
| `opening`, `openingOutbound`, `openingInbound` | unset | Exact first sentence to speak, per direction. Leave unset to let the prompt decide. |
| `recordingDisclosure` | `true` | Prepends a "this call may be recorded" line to the opening. Keep it on unless the user confirms their jurisdiction does not require it. |
| `maxCallDurationSec` | `600` (30–3600) | Hard auto-hangup with `endReason: max_duration`. |
| `callingHours` | `{ "timeZone": "UTC", "windows": [] }` | Dial guard. Empty windows means any time. Each window is `{ "days": [1,2,3,4,5], "start": "09:00", "end": "18:00" }` with `days` 0=Sunday. Violations fail the dial with `GUARDRAIL_BLOCKED`. |
| `doNotCall` | `[]` | E.164 numbers the campaign refuses to dial. |
| `blockedCallers` | `[]` | E.164 numbers whose inbound calls are rejected. |
| `onForbiddenClaim` | `"report"` | `report` logs the event; `handoff` also switches control to a human. |
| `copilot` | see below | In-call tool-using side agent. |

## Copilot and `end_call`

The copilot is a second, text-only model that watches the transcript (mode `transcript`, default) or receives delegated requests from the voice model (mode `delegation`) and can call tools registered in the App: `contact_lookup`, `calendar_check_slot`, `appointments_make`, `end_call`, and any others the App exposes.

```json
"copilot": {
  "enabled": true,
  "mode": "transcript",
  "prompt": "When the callee asks to stop, or the goal is complete and the assistant has said goodbye, call end_call with farewell_said=true. Otherwise do nothing.",
  "allowedToolIds": ["end_call"],
  "autoExecuteRisks": ["read"],
  "maxToolCallsPerTurn": 1,
  "mayEndCall": true
}
```

- `enabled` defaults to `false`; nothing below matters until it is `true`.
- `allowedToolIds` is a whitelist. A tool not listed is invisible to the copilot.
- `autoExecuteRisks`: tools carry a risk level (`read`, `draft-write`, `external-write`, `automatic`). Listed levels run without a local approval prompt; `external-write` always requires one; `automatic` (used by `end_call`) never does.
- `mayEndCall` (default `true`) is a second switch for `end_call`; both it and the whitelist entry are required. When both hold, the prompts gain the rule "one brief farewell, then `end_call`, then silence".
- `end_call` waits for the assistant's current turn to finish (up to 4 seconds) before hanging up, records the reason (`completed`, `callee_requested`, `policy`) in the audit trail, and lets the task complete normally.

Rehearse copilot behaviour in mock mode first; the mock phone can exercise `end_call` without a real call.

## Contacts (optional context)

`--contact contact.json` on `task submit` upserts a local contact card for the destination before the task queues. Fields: `displayName`, `company`, `tier`, `language`, `timeZone`, `notes`, `facts` (free object), `source`, `expiresAt`. The copilot's `contact_lookup` tool reads it, and the card is frozen into the call snapshot. Cards are also managed with `mishu contacts set|get|ls|rm`.
