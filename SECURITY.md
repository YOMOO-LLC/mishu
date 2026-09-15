<!-- DRAFT: pending counsel review -->

# Security policy

## Reporting a vulnerability

Do **not** open a public GitHub issue for a security vulnerability.

Report privately via GitHub Security Advisories on [`YOMOO-LLC/mishu`](https://github.com/YOMOO-LLC/mishu/security/advisories/new).

Placeholder contact (domain pending): `security@<domain-TBD>`

Include:

- A description of the issue and the official component (desktop engine, headless reference host, adapter, `/v1` contract)
- Steps that use **mock mode** and fictional numbers (`+1555…` only)
- Impact, especially if official builds could skip AI disclosure, spoof caller ID, or leak caller audio or transcripts
- Your preferred credit name, if any

Do not attach `.env` files, access tokens, Account SIDs, real E.164 numbers, customer prompts, or live transcripts.

We do not pay a bounty for leaking third-party user data obtained outside a coordinated report.

## Scope

In scope for official source and official binaries:

- Authentication and authorization on the localhost `/v1` API and MCP token files
- Webhook HMAC verification (`t=,v1=` over `timestamp.body`)
- Guardrail bypasses in official builds (disclosure, DNC, calling hours, consent)
- Path traversal, injection, or secret leakage in shipped packages
- Issues that let an untrusted caller or transcript influence tool execution beyond intended policy

Treat every caller utterance, transcript, and webhook payload as **untrusted input**. Phone-created engine threads stay read-only with `approvalPolicy: "never"` in the local Codex app-server (optional local adapter) path.

Out of scope:

- Self-hosted forks that removed default guardrails
- Social engineering against a human operator
- Findings that require production Trust Hub, paid lookups, or live PSTN
- Denial of service against third-party networks you do not operate

## Severity notes

The following are treated as **high severity** when they affect official builds:

- Skipping or suppressing the mandatory opening AI disclosure
- Forging or swapping caller ID on an official distribution
- Reading another tenant's token, webhook secret, or call recording
- Turning an untrusted transcript into an unauthorized high-risk tool call

## Response

This draft does not promise an SLA. Until counsel review, expect an acknowledgement when a maintainer is available, and a fix or documented exception before the next official preview. 0.x releases may include breaking changes; security fixes will still be described in the changelog without reproducing exploit steps.
