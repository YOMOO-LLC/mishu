# ADR-0004: Open-source boundary, license, and public repository

- Date: 2026-09-12
- Status: Accepted
- Decision owners: product owner, foundation maintainers
- Related: [ADR-0001](0001-call-engine-foundation.md), [ADR-0002](0002-secretary-domain-model.md), [ADR-0003](0003-channels-and-connectors.md)
- Source: internal ADR-0004 (Chinese)

## Decision

Publish the engine under **MIT** in a new public GitHub repository, `YOMOO-LLC/mishu`. Keep hosted multi-tenant operations, number reputation, compliance matrices, billing, push credentials, and the mobile app closed (or unreleased) until a later ADR.

Working product name: **Mishu**. Copyright in contributions remains with each contributor under DCO; they license the project under MIT. Trademarks are held by **YOMOO LLC**. MIT does **not** grant trademark rights. Public materials use "Mishu (working name)" until counsel review. Do not claim the mark is registered.

The public repo exists as a private empty placeholder. The first push still needs secret scanning and explicit product-owner authorization. npm scope `@mishu/*` is the intended package namespace; reservation by the owner is pending. Internal workspace packages already use `@mishu/*` with `"private": true`. Engineering does not publish to npm in this phase.

An AI that can place phone calls has extra duty: official builds default guardrails on. Forks can delete them; we cannot stop that. Official binaries, images, and `@mishu/*` packages must not ship a silent off-switch for disclosure, and public docs must not explain how to hide that the assistant is AI.

## Context

The product owner chose to open the engine so others can build on it. The desktop app (local engine host) is in the public set so people can audit that secrets never enter the renderer. The mobile app is an Owner endpoint only, with no engine, and stays closed until store policy and push certificates are settled.

A clean public snapshot is required: the private history contains internal reports and account-adjacent setup notes. The public repository starts from a new initial commit with no private git history. Desktop `productName` / `appId` in the private Electron config stay unchanged so the user's data folder does not move; the public snapshot may rewrite those fields at export time.

## Open / closed boundary

**Open (MIT, public repo)**

- Contract: OpenAPI, event schema, error envelope.
- `core`: state machines, platform policy, triage, disclosure, authority, prompt compiler.
- Adapters: Twilio, GPT-Live, SQLite/Postgres reference, Codex app-server (optional local adapter), mock.
- Local engine (desktop), CLI, MCP server (as a `/v1` client), SDK.
- Contract-test kit, connector helpers, examples.
- Default guardrail implementation, AUP, `SECURITY.md`, `TRADEMARK.md`.
- `apps/cloud` as a **single-tenant reference host** only (no billing, Trust Hub, or production secrets).

**Closed (hosted service / not public yet)**

- Mishu Cloud multi-tenant ops, SLA, metering.
- Number provisioning and voice reputation (Trust Hub, STIR/SHAKEN, CNAM).
- Compliance operations: consent ledger, jurisdiction matrix, abuse detection.
- Billing and production push (APNs/FCM).
- Official OAuth connectors that need platform review.
- Mobile app.

Anything a user can reproduce on their own machine with their own Twilio and model keys is open. Anything that needs platform identity, cross-tenant ops, or third-party OAuth review stays in Cloud.

## License, trademark, DCO

Code uses the [MIT License](https://choosealicense.com/licenses/mit/). Keep the copyright and permission notice; the software is provided as-is.

`TRADEMARK.md` (public root; counsel reviews the published text) will state:

- "Mishu", the logo, wordmark, and "Mishu Cloud" identify YOMOO LLC. MIT-licensed code does not include a right to release derivatives under those marks.
- Forks and redistributions must rename and replace the logo. Nominative fair use such as "based on the Mishu engine" is allowed.
- Do not imply a fork is official, official Cloud, or platform-reviewed.
- Official npm packages use `@mishu/*`. Unauthorized packages must not use that scope or a confusingly similar name.

Contributions use [DCO 1.1](https://developercertificate.org/) (`Signed-off-by`), not a CLA. CI rejects PRs without sign-off.

0.x may break; changelog a migration and keep the previous schema fixture green for at least one minor. `1.0.0` is when `/v1` stability is promised. Do not advertise a production SLA before 1.0.

## Default guardrails and AUP

Official releases enable, and tenants cannot configure off:

1. Disclose AI identity on the first spoken turn ([ADR-0001](0001-call-engine-foundation.md)).
2. Outbound frequency and calling-hours limits.
3. DNC / do-not-call; emergency and high-risk destination blocks.
4. Outbound consent: cloud follows "Owner-initiated, Owner's errand, disclose AI"; local treats Owner approval or budget whitelist as Owner-initiated and still discloses.
5. No productized abuse: forged caller ID, impersonating a human, hiding AI identity, bulk marketing dialers.

Users bring their own telephony account and complete that vendor's identity checks. This project does not resell "unchecked numbers".

Public root files (English; sibling Wave 6 task writes the drafts that `scripts/oss/snapshot-manifest.json` includes at the snapshot root): `AUP.md`, `SECURITY.md`, `TRADEMARK.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`. Guardrails are core platform policy, not an adapter switch. Third parties calling official Cloud cannot turn disclosure off through the API.

## Snapshot hygiene

The public tree is a new repository with a mapped layout (`packages/*`, `apps/desktop`, `apps/cloud`, `apps/cli`). It must not contain `.env`, userData, real SQLite, access tokens, Account SIDs, real E.164 numbers, internal swarm/handoff reports, campaign prompts, or an OpenAI product name used as *our* brand. Technical mention of the Codex app-server (optional local adapter) is allowed. Examples use `+1555…` only.

Extract order (P2 checklist; this ADR does not run it): generate a snapshot, secret-scan it, license-audit dependencies, ship English docs, run typecheck/unit/contract in mock, add DCO and issue templates.

## Naming

| Use | Name | Notes |
|---|---|---|
| Product | Mishu | Working name; YOMOO LLC holds the marks; pending counsel review |
| GitHub | `YOMOO-LLC/mishu` | Private empty placeholder today |
| npm | `@mishu/core`, `@mishu/sdk`, … | Scope reservation pending |
| Hosted service | Mishu Cloud | Closed ops surface; same mark holder |
| Personal UI | Mishu | ADR-0002 personal-product copy |

Public site must not assume ownership of third-party domains. Counsel review of distinctiveness (the name is pinyin for "secretary") is pending; that review is not a legal opinion in this ADR.

## Roadmap alignment

| Stage | Content | Exit |
|---|---|---|
| P0 | This ADR, ADR-0003, license, guardrail list | Accepted; no secrets in docs |
| P1 | Authorized media and connector spikes | De-identified pass notes |
| P2 | Snapshot into the public repo | Clean initial history; mock contract green on the cloud reference host |
| P3 | v0.1 developer preview | External developers run mock by swapping base URL; default guardrails testable |
| P4 | Mishu Cloud beta + mobile | 24h answer, push, handoff; mobile still private |
| P5 | Public API and connector directory | At least one external developer on public `/v1`; official OAuth connectors stay reviewed |

Developer preview is not Cloud going public. Externals run the local engine or bring their own Twilio. MCP as a `/v1` client keeps its local-first constraints (loopback, read-only sandbox, no interactive approval UI).

## Consequences

Third parties can reuse the local engine. Differentiation is open source, an open `/v1`, and explicit authority and disclosure. Costs: forks that strip guardrails, rename risk until counsel review, and the duty to keep the public snapshot clean. Cloud still charges for number reputation, compliance, and SLA, not for hiding the state machine.

Private and public trees stay dual-track for a while. Do not cherry-pick private history into the public repo. AUP, SECURITY, TRADEMARK, and naming notes are product constraints, not legal opinions; counsel sign-off is required before a public preview.

## Invariants

1. Official public source and `@mishu/*` releases default-on AI disclosure, rate/hours limits, DNC, and outbound consent. Config cannot silently disable disclosure or allow forged caller ID.
2. Public snapshot and git history contain no real numbers, Account SIDs, API keys, `.env`, or local SQLite user data. Example numbers are `+1555…` only.
3. The MIT license file must not be rewritten to ban commercial use or forks. Trademark limits live only in `TRADEMARK.md`.
4. Contributions require DCO sign-off. No CLA as a merge gate.
5. Mobile and Mishu Cloud multi-tenant ops stay out of the public repo until another ADR says otherwise.
6. Platform-reviewed OAuth connectors are not "batteries-included official plugins" in MIT core.
7. Public docs and issues do not copy private campaign prompts, contacts, or real telephony resource ids.
8. 0.x breaking changes need a changelog and contract dual-track. Do not change `/v1` meaning unannounced.
9. Official releases do not ship features or guides whose purpose is hiding disclosure, forging identity, or bulk harassment.
10. Publishing the public repo does not replay private git history.

## Alternatives rejected

- Apache-2.0: stronger patent language, heavier NOTICE duty; MIT was the chosen shortest path.
- Functional Source License: source-available, not OSI open source; conflicts with "open the engine so others create".
- AGPLv3: network copyleft blocks the target SDK audience. Abuse is handled with guardrails and AUP, not a viral license.
- Open the SDK but not core: disclosure and authority paths cannot be audited.

## Resolved questions

- GitHub host: organization `YOMOO-LLC`, repository `mishu`. Not a personal account as permanent upstream.
- Trademarks: record a preliminary search; counsel review pending; decide on applications before public preview.
- Holder: YOMOO LLC for marks; contributors retain copyright, licensed MIT to the project.
- Mobile open-source trigger: after public API beta, once a store build is stable and contains no secrets. Push certificates never enter the repo.
- `1.0.0`: at least one external production integration, and `/v1` with no unannounced breaking change for a quarter.
- `apps/cloud` in the public repo: yes, reference host only.
- npm scope `@mishu`: pending owner reservation. Do not publish from this phase.
- Opening AI disclosure: mandatory; campaigns cannot disable it.
- P2 mock contract green: same `tests/contract` kit against the cloud reference host.
