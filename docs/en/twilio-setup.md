# Twilio setup (bring your own account)

This is a generic, placeholder-only guide for connecting Mishu (working name) to **your** Twilio account. Example numbers are `+1555…` only. Do not paste Account SIDs, auth tokens, API secrets, or live numbers into issues, docs, or screenshots.

Mishu does not resell phone numbers. You stay on the hook for Twilio charges, TCPA (and analogous local rules), recording-consent law, and carrier acceptable use.

## What you need

1. A Twilio account that can buy or host a Voice-capable number.
2. An **API key** and **API secret** (recommended) plus the Account SID. Prefer an API key over putting the Account Auth Token in the desktop app.
3. A **TwiML App** whose Voice request URL will receive inbound and client-originated calls.
4. A Voice-capable **phone number** assigned to that TwiML App.
5. A way to issue short-lived **Voice SDK access tokens**. In this tree the helper is loopback-only.

Placeholder values (never real):

| Setting | Example |
|---|---|
| Account SID | `ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| API key SID | `SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| TwiML App SID | `APxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| Phone number | `+15555550100` |

## Access tokens stay on localhost

Real Twilio mode needs a short-lived Voice SDK token. The desktop host can sign tokens itself when Settings → Phone line has the API key, secret, TwiML App SID, and number, **or** you can run the localhost helper:

```bash
pnpm dev:twilio
```

That serves `/token` on `127.0.0.1:8787` only. Do not expose `/token` on the public internet. `/token` must not fail open: if the helper is not bound to loopback, it requires a strong bearer secret (`APP_TOKEN_SECRET` in `.env.example`, at least 32 random bytes).

## Incoming routing

Twilio must POST Voice webhooks to TwiML that bridges the caller into the Voice SDK client (and, for production media, into Media Streams toward the voice session). This repository ships a deploy helper for the Twilio Functions answer-on-bridge patch:

```bash
node scripts/deploy-twilio-answer-bridge.mjs
```

That script talks to the Twilio REST API. It is a **paid / external** operation. Run it only against an account you own, with credentials in the environment, after you have read the script. It does not buy or release numbers.

Point the TwiML App Voice URL at your incoming Function (commonly `/voice-incoming`) and keep outgoing client calls on `/voice-outgoing`. Exact Function hostnames are yours; this guide does not list any.

## Where to put credentials

**Preferred:** desktop **Settings → Phone line**. The app writes a protected local settings file. Those fields are Account SID, API key SID, API secret, TwiML App SID, and the E.164 number.

**Alternative:** `.env` next to the checkout (development) or in the app user-data folder (packaged app). Copy [`.env.example`](../../.env.example) and fill placeholders. Keep the file mode `0600`. Never commit it.

Environment values override the saved settings file per field. `LIVE_PHONE_USE_MOCKS=1` overrides saved mode and keeps you on mock telephony.

The packaged app signs access tokens in the main process when the four Twilio fields exist. The renderer never receives the Account Auth Token or API secret.

## Costs and compliance

- Twilio bills voice minutes, phone numbers, and (if you enable them) lookups and SMS. Mishu does not meter your Twilio account.
- GPT-Live API voice, if you choose that source, is billed per second by OpenAI. The Codex app-server (optional local adapter) uses a local Codex CLI login instead of that per-second API.
- You are responsible for TCPA, Telemarketing Sales Rule, state mini-TCPA rules, and two-party / all-party recording-consent law in every jurisdiction you call.
- Official builds disclose that the caller is speaking with AI on the first turn. A campaign cannot turn that off. Recording disclosure is a separate campaign toggle and does not replace AI identity disclosure.
- Do not route emergency numbers through this engine.

When you leave mock mode, bring your own account and your own compliance program. Mishu Cloud multi-tenant number reputation and Trust Hub operations are not part of this repository.
