# Meta WhatsApp Cloud API — what this code relies on

Read from Meta's official documentation on developers.facebook.com on
**23 November 2026**, before the connector was written. Every shape the code
builds or parses is listed here with the page it came from, so IT can re-check
it against the live docs (Meta moves pages often).

Where the docs did not say something, this file says **not confirmed** and the
code treats it defensively. Nothing here has been tried against Meta with real
credentials.

## Version and base URL

- Base URL `https://graph.facebook.com`.
- Latest Graph API version on the changelog: **v27.0** (introduced 4 Nov 2026).
  v25.0 is supported until 29 July 2028.
  <https://developers.facebook.com/docs/graph-api/changelog>
- The version is config: `WA_GRAPH_VERSION` (default `v27.0`).

## Sending — `POST /{version}/{phone-number-id}/messages`

<https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages>,
<https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages>,
<https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview>

- Headers `Authorization: Bearer <token>`, `Content-Type: application/json`.
- Template: `{messaging_product:"whatsapp", recipient_type:"individual", to:"+973…", type:"template", template:{name, language:{code}, components:[{type:"body", parameters:[{type:"text", text}]}]}}`.
  Positional parameters fill `{{1}}`, `{{2}}`… in order.
- Free text: `{…, type:"text", text:{body}}` — only inside the customer service window.
- Success: `{messaging_product, contacts:[{input, wa_id}], messages:[{id, message_status?}]}`.
  `message_status` appears only for paced templates (`accepted`, `held_for_quality_assessment`, `paused`).
  Success means *accepted*, not delivered: delivery comes by webhook.
- Error: `{error:{message, type, code, error_data:{messaging_product, details}, error_subcode, fbtrace_id}}`.
  `error_subcode` is documented as deprecated from v16; the code keys on `code`.

## Webhooks

<https://developers.facebook.com/docs/graph-api/webhooks/getting-started>,
<https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks>,
<https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages>

- Verify: `GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…` → reply with the challenge.
- Signature: header `X-Hub-Signature-256: sha256=<hex>`, a SHA-256 signature of the
  payload with the **app secret**. The page does not spell out "HMAC"; HMAC-SHA256 of the
  raw body is the standard reading and what this code does — **IT must confirm with a real
  delivery** (a wrong reading shows up at once as every webhook rejected with 401).
- Reply 200 to every notification. Non-200 → Meta retries with backoff **for up to 7 days**,
  so duplicates happen: processing is idempotent on message id and on (status id, status).
- Envelope: `object:"whatsapp_business_account"`, `entry[].id` (WABA id), `entry[].changes[].field`
  (`messages`), `value.metadata.{display_phone_number, phone_number_id}`, `value.contacts[].{profile.name, wa_id, user_id}`.
- Inbound `value.messages[]`: `from`, `from_user_id`, `id`, `timestamp` (string, seconds), `type`;
  `text.body`; `button.{payload,text}` (both the label text); `interactive.type` =
  `button_reply`→`{id,title}` / `list_reply`→`{id,title,description}`; `context.{from,id}` on replies.
- Statuses `value.statuses[]`: `id`, `status` (`sent`, `delivered`, `read`, `failed`, `played`),
  `timestamp`, `recipient_id`, `errors[].{code,title,message,error_data.details,href}`, `pricing`, `conversation`.
  A read can arrive without a delivered first.
- Value-level `value.errors[]` (system/account problems) — logged, not tied to a message.
- `message_template_status_update`: `value.{event, message_template_id, message_template_name,
  message_template_language ("en-US" with a hyphen), reason, message_template_category}`.
- **BSUIDs**: Meta now sends `contacts[].user_id` / `from_user_id` always and says `wa_id`/`from`
  *can be omitted*. This system keys customers by Bahrain mobile (that is what the CRM has),
  stores `user_id` when seen, and matches an inbound message by `user_id` when `from` is missing.
  A message from an unknown sender is kept in the event log and not acted on.

## Templates — `GET /{version}/{waba-id}/message_templates`

<https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/message-template-api>

- Params `fields`, `limit`, `after`. Response `{data:[…], paging:{cursors:{after}, next}}`.
- Status values: APPROVED, ARCHIVED, DELETED, DISABLED, IN_APPEAL, LIMIT_EXCEEDED, PAUSED,
  PENDING, PENDING_DELETION, REJECTED. **Only APPROVED is sendable** — everything else, and any
  template the sync has never seen, is refused.

## Limits and windows

- Throughput: up to 80 msg/s per number by default (<https://developers.facebook.com/docs/whatsapp/throughput>).
  This system defaults to 10/s (`WA_MAX_PER_SECOND`).
- Messaging limit tiers per 24h for business-initiated messages: 250 → 2,000 → 10,000 → 100,000 → unlimited
  (<https://developers.facebook.com/docs/whatsapp/messaging-limits>). The daily cap setting
  (default 200) must stay under the account's tier.
- Customer service window: 24 h from the customer's last message; free text only inside it.

## Error codes this system maps

<https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes> — see
`src/providers/errors.js` for the full table and what each does to a message and a customer.

Retried with backoff: 1, 2, 4, 80007, 130429, 131000, 131016, 131056, 133004, 2494100, HTTP 5xx,
network errors. Stop the whole queue (credentials/account): 0, 3, 10, 190, 200–299, 368, 131005,
131031, 131042, 131045, 133010. Everything else is permanent for that message.

## Not confirmed from the docs

- Test-number recipient limits in development mode (the page returned navigation only).
- `POST /{waba-id}/subscribed_apps` body (page returned navigation only) — the docs route
  webhook subscription through the App Dashboard, which is what INTEGRATION.md tells IT to use.
- HMAC wording (above).
