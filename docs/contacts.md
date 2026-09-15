# Contact cards

Contact cards are local, agent-supplied context keyed by an E.164 phone number. External agents may push a small card before submitting a call task; the desktop never needs the external CRM's credentials to use that context.

Cards live in `calls.sqlite3`. A card may contain `displayName`, `company`, `tier`, `language`, `timeZone`, `notes`, custom JSON `facts`, `source`, and `expiresAt`. Notes are limited to 2,000 characters and serialized `facts` to 4,000 characters. Expired cards are retained in storage but are not returned by get/list or used during calls.

## HTTP

All routes use the same loopback-only bearer authentication as the rest of `/v1`:

```http
PUT /v1/contacts/%2B15551234567
Authorization: Bearer <local-token>
Content-Type: application/json

{"displayName":"Ada","company":"Analytical Engines","tier":"Gold","language":"en","notes":"Interested in a pilot.","facts":{"owner":"agent-7"},"source":"external-agent"}
```

- `GET /v1/contacts/{phone}` gets one non-expired card with the full requested phone number.
- `PUT /v1/contacts/{phone}` creates or updates one card.
- `DELETE /v1/contacts/{phone}` deletes one card.
- `GET /v1/contacts?limit=50&offset=0` lists non-expired cards with phone numbers masked.
- `POST /v1/contacts:batch` accepts an array, or `{ "contacts": [...] }`, of at most 100 cards.

`POST /v1/tasks` also accepts `contact`. Its phone may be omitted because the task's `to` is authoritative; if present, it must match `to` after E.164 normalization.

```json
{
  "to": "+15551234567",
  "goal": "Confirm attendance",
  "idempotencyKey": "attendance-42",
  "contact": { "displayName": "Ada", "tier": "Gold", "source": "external-agent" }
}
```

## MCP and CLI

MCP tools `contact_card_get` and `contact_card_list` require `read`. `contact_card_set` and `contact_card_delete` require `manage_campaigns`. Lists mask phone numbers.

```bash
mishu contacts set --file card.json
mishu contacts set --file cards.json
mishu contacts get +15551234567
mishu contacts ls --limit 25
mishu contacts rm +15551234567
mishu task submit --to +15551234567 --goal "Confirm attendance" --contact card.json
```

A single-card file may include its `phone`, or the phone may be supplied as `contacts set <e164> --file card.json`. An array or `{ "contacts": [...] }` uses the batch endpoint.

## In-call behavior

Campaigns may allow the read-risk tool `contact_lookup`. It resolves the peer from the current persisted call, checks the local card first, and falls back to registered `crm_lookup_customer` only when no non-expired local card exists. Model text is limited to name, company, tier, language, and a short notes summary; custom `facts` never enter that text.

When the copilot is enabled and a card exists at call start, the App injects one fixed-template system hint describing the caller or callee. The call stores a summary snapshot, so history shows the context actually used even if the source card is later changed or deleted.
