# Troubleshooting

Read `error.code` from stderr first; the exit code only tells you which layer failed.

## Discovery and auth

| Symptom | Cause | Do |
| --- | --- | --- |
| exit 2, `APP_UNAVAILABLE`, `ENOENT … mcp/endpoint.json` | App not running, or MCP/API disabled, or the discovery file vanished while the server kept running | Check the App window / Settings → MCP. If the App is up, retry with `--endpoint http://127.0.0.1:<port>/mcp` (port is shown in Settings); the App rewrites the file within 30 s. |
| exit 4 | Token rotated in Settings | Re-run; discovery re-reads. Never paste a token from the file. |
| `FORBIDDEN` / scope errors | MCP scopes lack `control_calls` (dial, tasks, hangup, budget) or `manage_campaigns` | Ask the user to enable the scope in Settings → MCP. |

## Dialing

| `error.code` / state | Meaning | Do |
| --- | --- | --- |
| `INVALID_NUMBER` | Not E.164 | Normalize to `+<country><number>`; confirm with the user rather than guessing a country code. |
| `GUARDRAIL_BLOCKED` | Campaign `doNotCall` or `callingHours` blocked the dial | Tell the user which rule; do not edit policy to slip past it without their say-so. |
| `CALL_IN_PROGRESS` / `A Call is already active` | The App only carries one call | Check `mishu status`; if a call is live, wait or `hangup` with the user's consent. If status shows no call but the error persists, the App is in a stale state: restart it (one instance only). |
| `RATE_LIMITED` (task `failed`) | More than 3 dials in a minute, or the same number within 10 minutes | Wait out the window (20 s between tasks, 10 min per number), then resubmit once with the user's consent. Do not loop. |
| `APPROVAL_DENIED` / `APPROVAL_TIMEOUT`, or task `failed` with `Local approval timed out` | The human said no, or nobody acted within 60 s | Stop and report. If your own script was supposed to approve and missed it (for example it read `.id` instead of `.taskId` from the submit response), say so and ask before resubmitting. |
| `CALL_IN_PROGRESS` on the next task of a batch, right after the previous call ended | The runner started the next dial while the previous call was still settling | Run batches strictly one task at a time with `--wait` and a short pause between tasks. |
| `campaign create` answers `system prompt cannot be empty` although `systemPrompt` is set | Older build read only `policy.persona` | Update the App; current builds keep `systemPrompt` and require only that it or `persona` is non-empty. |
| `CONFLICT` on submit | Idempotency key already used with different input | Use a fresh key (the CLI does by default) or fetch the existing task. |
| Task `failed` with `Ephemeral campaigns cannot be selected` | Old App build | Update the App; inline campaigns are dialed without changing the selection. |

## The call did not go well

| Observation | Meaning | Do |
| --- | --- | --- |
| `endReason: session_error`, task `no_answer`/`error`, audit shows `Timed out waiting for realtime SDP` | GPT Live did not start within 45 s; the App disconnected the Twilio leg | Check Codex CLI login (`codex login status`), machine load, and `pnpm smoke:gpt-live` for a clean handshake; then retry once with the user's consent. |
| Call stays `connecting`, phone `error`, then `A Call is already active` | Older build left a Twilio call object behind after a realtime failure | Restart the App (fixed in current builds). |
| Assistant said goodbye but the line stayed open until the callee hung up | Copilot not enabled, or `end_call` not whitelisted, or `mayEndCall: false` | `mishu call audit <id>`: look for `copilot.session.started` (with `tools`) or `copilot.session.skipped` (with `reason`). Fix the policy accordingly. |
| `copilot.session.skipped` with `campaign_not_found` / `policy_disabled` | The call's campaign has no enabled copilot | Enable `copilot.enabled` and whitelist tools on the campaign actually used by the call (inline `--policy` for task campaigns). |
| Assistant introduced itself with a made-up company | Prompt had no persona | Add `persona` in policy or an identity line in the prompt. Current builds also forbid invented identities by default. |
| Opening sounded like a sales script the user never wrote | Older default policy carried a sales-style opening | Update the App; set `opening`/`openingOutbound` explicitly if you want a fixed first sentence. |
| Farewell cut off mid-sentence | Assistant started a second sentence after `end_call`; the 4 s wait expired | Keep the farewell rule in the prompt ("one sentence, then end_call, then silence"); the `copilot.call.end_waited` row shows `waitReason`. |
| Two `call_sessions` for one dial, one stuck in `dialing` | Older build created a phantom session before the Twilio CallSid arrived | Update the App; the migration marks old ones `call.orphaned`. |
| `outcome: reached` but the callee clearly declined | Analysis judged that a real exchange happened; `refused` needs an explicit decline | Read the `summary`; report both outcome and summary rather than only the word. |

## Waiting

| Observation | Meaning | Do |
| --- | --- | --- |
| exit 7 from `--wait` | Your CLI deadline passed; the task is still alive | `mishu task wait <id> --timeout N` again, or `task get`. |
| `NETWORK_ERROR … aborted due to timeout` on an old CLI | CLI fetch timeout shorter than the server long-poll | Update the CLI; current builds size the fetch deadline to the server timeout plus margin. |
| Task sits in `queued` | Another task is running (serial runner) or `notBefore` is in the future | `mishu task ls --status in_call`; wait. |

## Environment

- Two App instances (for example a `pnpm dev` in tmux plus one from an IDE) share `userData` and the Twilio identity and produce confusing state. Keep one.
- The App refuses to start realtime in `mock` mode; if you expected a real call, check `phone.runtimeMode`.
- Real-mode prerequisites: `.env` with Twilio credentials (never printed), `pnpm dev:twilio` token helper running on `127.0.0.1:8787`, Codex CLI logged in via ChatGPT. Missing any of these shows as `phoneConnection: error` or `session_error`.
