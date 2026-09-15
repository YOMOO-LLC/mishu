# API parity

"Yes" means the capability reaches the shared main-process service layer. Renderer-only media plumbing is exposed over HTTP for contract parity but remains intended for the trusted first-party renderer; normal agents use the higher-level call resources.

The CLI mirrors the agent-facing HTTP surface for campaign create/delete, optional ephemeral listing, inline task campaigns, and task long polling. `task submit --wait` and `task wait` repeat the server's bounded 300-second long poll until the CLI deadline.

Campaign create/update and inline task campaigns use the same prompt contract across CLI, MCP, and HTTP: `systemPrompt` is the complete call script, `policy.persona` is the identity description, and at least one must be non-empty. A persona-only input backfills the stored script; a script-only input preserves an empty persona; missing both returns `INVALID_ARGUMENT`.

| Capability | IPC | MCP | HTTP `/v1` |
|---|:---:|:---:|:---:|
| Runtime and phone status | yes | yes `phone_get_status` | yes `/status`, `/runtime` |
| Campaign list/get/create/update/delete/select | yes | yes `campaign_*` (optional ephemeral listing) | yes `/campaigns*` (`includeEphemeral=1`) |
| Full Campaign policy and copilot update | yes | yes `campaign_policy_update` | yes `PUT /campaigns/{id}` |
| Dial with approval, budget, rate limit, and idempotency | yes | yes `call_dial` | yes `POST /calls` |
| Call task submit/get/list/wait/cancel with saved or inline one-time campaign | yes | yes `task_*` | yes `/tasks*` |
| Contact card set/get/list/delete and task-inline upsert | yes (history snapshot) | yes `contact_card_*` | yes `/contacts*`, `/tasks` |
| Autonomous call budget get/update | yes | yes `budget_get`, `budget_update` | yes `/settings/budget` |
| General/background settings get/update | yes | yes `settings_general_get`, `settings_general_update` | yes `/settings/general` |
| Twilio settings/test/import and App relaunch | yes | read-only `settings_twilio_get`, `settings_twilio_test` | yes `/settings/twilio*`, `/app/relaunch` |
| Answer/reject/hang up | yes | yes `call_answer`, `call_reject`, `call_hangup` | yes `/calls/current/{answer,reject,hangup}` |
| AI/human control mode | yes | yes `call_set_control_mode` | yes `/calls/current/control-mode` |
| Simulate incoming call in mock mode | yes | yes `debug_simulate_incoming` | yes `/debug/simulate-incoming` |
| Call list/detail | yes | yes `call_list`, `call_get` | yes `/calls`, `/calls/{id}` |
| Transcript | yes | yes `transcript_get` | yes `/calls/{id}/transcript` |
| Latest post-call analysis | yes (local persistence) | yes `call_analysis_get` | yes `/calls/{id}/analysis` |
| Sanitized per-call audit log | yes (local persistence) | yes `call_audit_list` | yes `/calls/{id}/audit` |
| Recording metadata/audio | yes | yes metadata `recording_get` | yes `/calls/{id}/recording[/audio]` |
| Guardrail events | yes | yes `call_guardrails` | yes `/calls/{id}/guardrails` |
| Appointments list/by call | yes | yes `appointment_list`, `call_appointments` | yes `/appointments`, `/calls/{id}/appointments` |
| Pending approvals / first-wins decision | yes | yes `approval_list`, `approval_decide` | yes `/approvals*` |
| Webhook get/update/test/rotate/deliveries | yes | yes `settings_webhook_*` | yes `/settings/webhook*` |

Outbound deliveries use `X-Mishu-Signature` (`t=<unix-ms>,v1=<hex>`), `X-Mishu-Event`, and `X-Mishu-Delivery-Id`. HMAC input is `{unix-ms}.{rawBody}`.
| MCP status/update/token/client templates | yes | yes `settings_mcp_*` | yes `/settings/mcp*` |
| Appointment settings | yes | yes `settings_appointments_*` | yes `/settings/appointments` |
| CRM settings/test/sync log | yes | yes `settings_crm_*` | yes `/settings/crm*` |
| Realtime SDP/text lifecycle | yes | n/a (MCP client transport) | yes `/realtime/sessions*` |
| Renderer call/transcript/guardrail reports | yes | n/a (trusted producer) | yes `/events/*` |
| Recording chunk ingestion | yes | n/a (binary producer) | yes `/recordings/*` |
| OpenAPI discovery | n/a | n/a | yes `/openapi.json` |

All user-facing UI actions therefore have IPC, MCP, and HTTP reachability. The three “not applicable” MCP cells are producer-side transport plumbing rather than agent actions; their resulting resources are fully readable through MCP.

Twilio secret writes intentionally have no MCP tool: agent-visible MCP arguments and transcripts are an unnecessary credential propagation path. Use the local UI or `mishu settings set twilio --file/--from-env/--secret-stdin`; MCP get/test results contain only masks, source labels, and result codes.

## Post-call four-entry parity

| Capability | IPC/store | MCP | HTTP `/v1` | CLI |
|---|:---:|:---:|:---:|:---:|
| Latest analysis | yes | `call_analysis_get` | `GET /calls/{id}/analysis` | `call analysis <id>` |
| Sanitized chronological audit | yes | `call_audit_list` | `GET /calls/{id}/audit` | `call audit <id>` |
| Optional task transcript/analysis/call expansion | yes | `task_get`, `task_wait` `include` | `GET /tasks/{id}[/wait]?include=...` | `task get/wait` and `task submit --wait --include ...` |

Audit details mask E.164 numbers by default and replace transcript-like fields and token/secret/authorization/password fields with an explicit redaction marker. HTTP `reveal=true` and MCP `reveal_phone=true` only reveal phone-number strings; sensitive content fields remain omitted.

Audit rows and webhook event envelopes include `tenantId`. Local loopback bearer, IPC, and MCP credentials always resolve to `local`; request body and path cannot switch tenant. The field is additive and does not change existing resource identifiers or error codes.

## Voice providers and OpenAI settings

| Capability | IPC | MCP | HTTP `/v1` | CLI |
|---|---|---|---|---|
| Voice settings read | `getVoiceSettings` | `settings_voice_get` | `GET /settings/voice` | `settings get voice` |
| Voice settings write | `saveVoiceSettings` | intentionally absent | `PUT /settings/voice` | `settings set voice --file` |
| Masked OpenAI settings | `getOpenAiSettings` | `settings_openai_get` | `GET /settings/openai` | `settings get openai` |
| OpenAI key write/clear | password UI → main | intentionally absent | `PUT /settings/openai` | `settings set openai --file/--secret-stdin` |
| Read-only key test | `testOpenAiConnection` | `settings_openai_test` | `POST /settings/openai/test` | `openai test` |
| Session readiness fallback | `reportRealtimeStarted(sessionId)` | producer only | not exposed | not exposed |
| Provider and cumulative seconds | call detail | `call_get` | `GET /calls/{id}` | `call get` |

MCP exposes only the three read/test tools for this settings surface. Key writes are excluded because MCP arguments may enter agent context; provider writes remain a local UI/HTTP/CLI action. The readiness IPC accepts only the current opaque session ID and cannot forward arbitrary events. Call records expose `voiceProvider` and optional `voiceSeconds` under call detail, list, and task `include=call` responses. OpenAI settings HTTP audits omit request content, and no API error body is forwarded to clients.
