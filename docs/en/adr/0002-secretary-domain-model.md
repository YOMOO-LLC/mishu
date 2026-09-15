# ADR-0002: Personal phone-secretary domain model

- Date: 2026-09-12
- Status: Accepted
- Decision owners: product owner, foundation maintainers
- Related: [ADR-0001](0001-call-engine-foundation.md)
- Source: internal ADR-0002 (Chinese)

## Decision

The product is a private secretary that handles the phone for the Owner: it answers and acts inside its authority, blocks marketing and abuse, and escalates only when a human is actually required. It is not a "who is calling?" screener. Missing an important call is the worst failure. Social engineering and slow knowledge lookup are the next two.

The domain splits "can talk" from "may decide":

| Layer | May | Must not |
|---|---|---|
| Deterministic hard rules | DNC / blacklist, VIP shortcut, policy composition, knowledge visibility, authority, budget, approval, final execute, fallback | Widen authority from natural language; let model output override platform rules |
| Copilot | Propose intent, urgency, triage, tool args, and whether a human is needed, with reason and confidence | Disclose knowledge, execute side effects, change trust or authority, silently block an unknown caller |
| Voice model | Listen, speak, barge-in, clarify, restated approved facts, take a message | Be the action authority, identity verifier, final triage record, or secret store |

Voice-model text is never evidence that a transfer or booking already happened. Only a verified adapter or tool result produces a completion event the model may speak.

## Context

Existing campaigns, policies, contact cards, call store, copilot, approvals, and post-call analysis treated a call as a single peer. That mixed hangup outcome with business triage, and it had no knowledge visibility, Owner availability, or handoff state machine.

v1 keeps `Tenant` (isolation and billing) separate from `Owner` (the human principal), even when a deployment is one-to-one, so family or team sharing does not rewrite every key. `Assistant` is the consumer-facing name; `campaigns` remains a compatibility alias on `/v1`. `Line` routing rules are metadata about who answers first, ring time, VIP direct (only when the Owner is available and that Line opted in), DND, and fallback. Campaign number mappings do not reconfigure vendor routing or caller ID.

## Trust and disclosure

Caller ID, CNAM, STIR/SHAKEN, and Contact `tier` never prove who is on the line.

Trust levels: `unverified`, `number_match`, `verified_contact`, `verified_vip`. `tier` is a relationship label; it does not raise `trustLevel` by itself.

Knowledge visibility: `public`, `known_contact` (needs `verified_contact`, not mere number match), `vip_only`, `never_disclose` (default; missing visibility is treated as strictest). Sensitive categories (account, health, finance, one-time codes, precise location) can still demand step-up or owner transfer even when the matrix would allow speech. v1 step-up prefers a push confirm on the Owner's phone rather than collecting high-risk secrets.

The model only sees content the disclosure evaluator already clipped. Minimum necessary fields only.

## Authority, triage, handoff

Authority rules are versioned, auditable, deterministic policy, not prompt sentences. Results: `allow`, `require_approval`, `deny`, `indeterminate` (treat as deny, then transfer or take a message). The caller on the phone can never approve as the Owner.

Triage dispositions: `handled`, `blocked`, `message_taken`, `escalated`, `transferred`. Uncertain triage may only become `message_taken` or `escalated` — never a silent block. Even a confirmed block writes a minimal inbox row (time, masked peer, reason), retained at least 30 days.

Handoff as designed:

```text
requested
  -> owner_notified
  -> owner_ringing
  -> accepted -> connecting -> connected -> completed
                    |             |
                    +-> failed ---+
  -> declined ------+
  -> timed_out -----+--> fallback_message -> completed
```

`accepted` is Owner intent. `connected` requires an adapter observation that the owner leg joined. Decline, timeout, and failure fall back to a message; the caller must not be dropped. Counterparty hangup cancels and stops ringing the Owner. Transitions compare-and-set on `(tenantId, handoffId, version)`.

The live machine in `@mishu/core` records three accepted differences from that diagram (implementation notes on the internal original, 2026-09-14): `owner_notified` aliases `requested`; `fallback_message` is terminal and does not auto-advance to `completed`; a desktop `client` "answered" counts as owner-joined. Pointers: `packages/core/src/handoff/**`.

Desktop maps takeover to local audio control (`local_takeover`). Cloud maps it to Twilio Conference legs and stops GPT-Live once the Owner is connected.

## Knowledge placement

Stable, low-sensitivity facts compile into startup instructions with a product budget of 1,500 tokens (at least 500 reserved for platform and authority). `never_disclose` content must not enter those instructions. Long-tail facts go through retrieve → disclose → quiet injection. v1 does not ship a vector index; personal knowledge is small enough for structured fields, FTS, tags, and visibility filters.

A session keeps injected knowledge until it ends. If caller trust drops or the speaker changes, open a new session. Do not inject a higher visibility level into the same session.

Owner feedback (`should_have_transferred`, `wrong_block`, and similar) proposes a knowledge or rule change. The Owner must confirm each item. Feedback must never auto-widen authority, visibility, or trust, never delete DNC evidence, and never write caller transcript into knowledge as fact.

## Consequences

API customers reuse the same entities (Line, Assistant, Contact, Call, Knowledge, Authority, Triage, Handoff, Message, Feedback). Personal-product UI (inbox sort, summary-card layout, "my secretary" copy) stays out of the public contract. Vendor SIDs, raw prompts, raw audio, secrets, and internal model traces stay private.

The cost is new version, trust, knowledge, handoff, and inbox state, and the UI must explain "number recognized" versus "identity verified".

## Invariants (abridged)

1. Every entity is inside one `tenantId`. Cross-tenant ids look like "not found".
2. Number, CNAM, STIR/SHAKEN, or `tier` alone never prove speaker identity.
3. Knowledge defaults to `never_disclose`.
4. Disclosure must pass visibility, trust, sensitive-category, and minimum-fields checks together.
5. `never_disclose` content does not enter speech-model context that can be repeated.
6. Authority runs in deterministic code. The model only proposes.
7. `deny` / `indeterminate` execute no side effects. The caller is not the Owner.
8. Uncertain triage is `message_taken` or `escalated`, never a silent `blocked`.
9. Blocked calls still produce a queryable inbox/audit row.
10. VIP hard rules beat the model but do not skip sensitive disclosure checks.
11. `transferred` only after the owner leg is confirmed connected.
12. Handoff failure falls back to a message; the caller is not dropped.
13. After the counterparty hangs up, do not keep ringing the Owner or start new side effects.
14. Corrections need Owner confirmation and must not auto-widen authority, visibility, or trust.
15. Each call records immutable assistant / policy / knowledge / authority versions.
16. Raw caller, transcript, and tool output stay untrusted.
17. The assistant must not claim success without a verified adapter/tool result.
18. The voice layer expresses; it does not own business truth or execute rights.
19. Injected knowledge cannot be pulled back inside the same session.

## Alternatives rejected

- Screening-only product: not enough differentiation; still allowed as a narrow Line preset.
- Putting every rule in the system prompt: not auditable; prompt injection can bypass it.
- Number match as identity: caller ID is forgeable.
- Every knowledge item in the resident prompt: larger leak surface and slower sessions.
- A vector index in v1: unjustified at current scale.

## Resolved questions

- Step-up: Owner phone push confirm first.
- VIP direct: only when the Owner is available and that Line enabled it.
- Resident instruction budget: 1,500 tokens, revisit with latency and leak evals.
- Feedback publishing: per-item confirm by default; batch preview still shows each diff.
- Blocked inbox retention: platform minimum 30 days; tenants may extend after compliance review.
