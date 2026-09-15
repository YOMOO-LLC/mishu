<!-- DRAFT: pending counsel review -->

# Acceptable Use Policy

This Acceptable Use Policy (AUP) applies to official Mishu (working name) distributions, the public `YOMOO-LLC/mishu` repository, and Mishu Cloud. Forks that remove guardrails are outside our control; they must not use the Mishu marks (see `TRADEMARK.md`).

This draft is a product constraint, not legal advice. You bring your own telephony account and your own compliance.

## Prohibited uses

You may not use official Mishu software or Cloud to:

- Place robocall spam, bulk marketing dials, or other unsolicited outreach.
- Impersonate a person, company, or public authority, or hide that the speaker is an AI.
- Use deceptive caller ID, spoof a number you are not authorized to present, or forge STIR/SHAKEN attestation.
- Place calls without legally required consent, including TCPA and analogous local rules.
- Record or transcribe calls without the consent the applicable recording-consent law requires.
- Harass, threaten, defraud, or target people on a do-not-call list you are required to honor.
- Probe, disable, or bypass platform guardrails in official builds, including AI identity disclosure, calling-hours limits, DNC, and outbound-consent checks.
- Submit contributions whose purpose is to add an abuse path (undisclosed AI, spoofed caller ID, or unconsented bulk dialing) to official source.

Official builds keep AI disclosure, calling hours, DNC, and consent checks **on by default**. A campaign cannot turn disclosure off. This policy does not document, and must not be read as documenting, any way to disable disclosure.

## Your account, your compliance

Mishu does not resell "pre-approved" phone numbers. You supply your own Twilio (or later Telnyx) account, complete that provider's identity and Trust Hub requirements, and remain responsible for:

- TCPA, Telemarketing Sales Rule, and state mini-TCPA rules that apply to you
- Two-party or all-party recording-consent law in every jurisdiction you call
- Emergency-calling rules and the prohibition on routing emergency numbers through this engine
- Any industry or carrier acceptable-use rules attached to your account

## Enforcement

YOMOO LLC may refuse or terminate Mishu Cloud service for AUP violations. Maintainers may refuse pull requests that introduce prohibited capabilities into official source. Trademark use that suggests an unofficial fork is an official build is also an AUP violation.

Report Cloud abuse through the channels in `SECURITY.md` when the report includes a vulnerability; otherwise open a non-security GitHub issue without real phone numbers, transcripts, or account identifiers.
