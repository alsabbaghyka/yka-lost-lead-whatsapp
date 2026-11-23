# Connecting to the WhatsApp Business Platform (Cloud API)

For IT (Isa, Akhilesh). The system runs fully on the `mock` provider today; these steps
switch it to Meta's Cloud API. Meta's screens and page addresses move often — where a step
below disagrees with Meta's current documentation, follow Meta and tell the project owner.
The API facts the code relies on, with their source pages, are in `META-API-NOTES.md`.

## What is proven and what is not

**Proven by automated tests (against the shapes in Meta's documentation, with a fake HTTP client):**

- the send request (URL with the configured Graph version, Bearer token, template body with
  positional `{{n}}` parameters, free-text body) and reading the message id from the response;
- error responses are classified by `error.code` (retry / permanent / account) with no retry on
  permanent errors, exponential backoff and a dead-letter table for transient ones, and the queue
  halting on token / account errors;
- template sync over `GET /{WABA_ID}/message_templates` with paging, and refusal of anything not `APPROVED`;
- webhook verification (`hub.mode` / `hub.verify_token` / `hub.challenge`), `X-Hub-Signature-256`
  checking over the raw body, deduplication of Meta's retries, and parsing of inbound text,
  quick-reply button, interactive button/list replies, status updates (sent / delivered / read /
  failed with error codes) and template status updates.

**Not proven — IT must confirm with real credentials:**

1. That the token, phone number ID and WABA ID work (Settings → *Test WhatsApp connection*).
2. That Meta's signature is HMAC-SHA256 of the raw body with the App Secret, as implemented. The
   page says "SHA256 signature using the payload and your App Secret". If it is wrong, every
   webhook is rejected with 401 and the webhook log on Meta's side shows failures — easy to see.
3. That a real template send is accepted and the delivered / read webhooks arrive.
4. That inbound replies arrive with `from` (a phone number). Meta now also sends business-scoped
   user ids (BSUIDs) and says `from` *can be omitted*; the system matches by `user_id` once it has
   seen one, but a reply from a customer whose number is never sent cannot be matched to a lead.
5. The behaviour of Meta's test number and its recipient limits (not found in the docs on 23 Nov 2026).
6. The Docker image (`Dockerfile`) — it was written but not built on the development machine.

## 1. Meta business setup

1. **Business portfolio** (Meta Business Suite → Settings): use Y.K. Almoayyed's verified
   portfolio. Business verification raises the messaging limit and the template cap.
2. **App**: developers.facebook.com → My Apps → Create app → type *Business*, connected to that
   portfolio. Add the **WhatsApp** product. This creates (or links) a **WhatsApp Business
   Account (WABA)** and gives you a **test phone number**.
3. **Phone number**: for testing use Meta's test number. For go-live, add and verify the
   showroom's business number with an approved **display name**. Note its **Phone number ID**
   (WhatsApp → API Setup) — this is `WA_PHONE_NUMBER_ID` — and the **WhatsApp Business Account
   ID** — `WA_WABA_ID`.
4. **System user and permanent token**: Business Settings → Users → System users → Add (admin).
   Assign assets: the app (*Manage app*, full control) and the WABA (*Manage WhatsApp Business
   accounts*, full control). Generate a token for the app with the permissions
   `whatsapp_business_messaging`, `whatsapp_business_management` and `business_management`, and
   no expiry. This is `WA_ACCESS_TOKEN`. Store it in the server's secret store, not in a file
   that is shared or committed.
5. **App secret**: App settings → Basic → App secret. This is `WA_APP_SECRET`; it signs webhooks.

## 2. Server

1. Host it on a server that can be reached over **https** from the internet (Meta calls the
   webhook) and that staff reach on the internal network. Put a reverse proxy with a valid
   certificate in front; keep the app itself on `127.0.0.1` (or the container network).
2. Set the environment (see the table below), with `WA_PROVIDER=cloud`.
3. `node cli.js check`, then `node cli.js create-admin --email … --name …`, then start it
   (`node server.js`, a Windows service wrapper, or `docker compose up -d`).
4. `GET https://<your host>/healthz` should return `{"ok":true,"provider":"cloud",…}`.
5. Sign in, Settings → **Test WhatsApp connection**. It reads one template from the WABA; a
   failure names the Meta error (for example an expired token).

## 3. Webhook

1. Choose a long random **verify token** (any string) and set it as `WA_VERIFY_TOKEN`.
2. App Dashboard → WhatsApp → Configuration → Webhook → Edit:
   - Callback URL: `https://<your host>/webhook`
   - Verify token: the same string. Meta calls `GET /webhook?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`;
     the server answers with the challenge.
3. **Subscribe to the `messages` field** (and `message_template_status_update`, so approvals and
   pauses update by themselves).
4. Meta says some webhooks are not sent while the app is in **Development** mode — switch the
   app to **Live** before testing replies.
5. The server answers 200 at once and processes from its own table, so Meta's retries (up to 7
   days) are harmless: each message and status is stored once.

## 4. Templates

1. Templates screen → **Export bodies to submit (CSV)**. It lists every template name, language,
   category (MARKETING), the body with `{{1}}`-style variables and what each variable is.
2. Submit the eight **Day 0 / permission** templates in English through WhatsApp Manager
   exactly as exported (the names must match: `lost_lead_price_v1` …). The language code must
   match `template_language` in Settings (default `en`).
3. The **Day 2 / 7 / 30** templates (`lost_lead_nudge_v1`, `lost_lead_voucher_v1`,
   `lost_lead_monthly_v1`) are **drafts**: agree the wording first. Until they are approved,
   customers who reach those steps wait (the campaign screen says so) — nothing is sent.
4. **Arabic** rows are placeholders: a translator writes them with the same variables in the
   same order; submit them as language `ar`.
5. After approval press **Sync from Meta**. Only `APPROVED` templates are ever sent.

## 5. Testing with Meta's test number first

1. Keep **test mode** on (default). Add the IT and pilot phones to the **allow-list**
   (Opt-outs & lists) *and* to Meta's list of allowed test recipients for the test number.
2. Import a small file that contains only those phones (never real customers in test).
3. Build → approve (second person) → start. At the next send time the allow-listed phones get
   the Day 0 template. Reply from the phone: `STOP`, `1`, `YES`, free text — and check the
   customer timeline, the inbox and the opt-out list.
4. Then follow `GO-LIVE-CHECKLIST.md`.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port. |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` in Docker). |
| `PUBLIC_URL` | — | The public https address (shown on Settings for the webhook URL). |
| `DB_PATH` | `./data/lost-lead.db` | SQLite database file. Back it up. |
| `BACKUP_DIR` | `./backups` | Where `node cli.js backup` writes. |
| `COOKIE_SECURE` | off | Set `1` behind https so the session cookie is `Secure`. |
| `SESSION_HOURS` | `12` | Sign-in lifetime. |
| `WA_PROVIDER` | `mock` | `cloud` (Meta), `mock` (simulated, signed webhooks), `dry-run` (records only). |
| `WA_GRAPH_VERSION` | `v27.0` | Graph API version. Latest on Meta's changelog on 23 Nov 2026; v25.0 is supported until July 2028. |
| `WA_GRAPH_BASE` | `https://graph.facebook.com` | Only for testing against a stub. |
| `WA_ACCESS_TOKEN` | — | System-user permanent token (cloud). |
| `WA_PHONE_NUMBER_ID` | — | The sending number's id (cloud). Webhooks for any other number are ignored. |
| `WA_WABA_ID` | — | WhatsApp Business Account id, for template sync (cloud). |
| `WA_APP_SECRET` | — | App secret; verifies `X-Hub-Signature-256` (cloud). |
| `WA_VERIFY_TOKEN` | — | Your chosen webhook verify token (cloud). |
| `WORKER_INTERVAL_MS` | `2000` | How often the outbox and webhook queue are worked. |
| `SCHEDULER_INTERVAL_MS` | `60000` | How often due customers are checked. |
| `MOCK_FAIL_EVERY` | `0` | Mock only: every Nth number fails as "not on WhatsApp". |
| `MOCK_APPROVE_DRAFTS` | `1` | Mock only: `0` leaves the draft templates PENDING. |

Runtime rules (daily cap, speed, quiet hours, send time, holdout, consent date…) are on the
Settings screen, not in the environment, and every change is audited.

## How sending works

- The **scheduler** (every minute) queues the next template for customers who are due, only on
  Bahrain working days (Friday skipped), after the send time and outside quiet hours, and only if
  the template is approved and — in test mode — the number is allow-listed.
- The **sender** (every 2 s) checks every gate again at the moment of sending: opt-out,
  holdout, campaign paused, test mode, do-not-contact lists, template approval, 24-hour window,
  kill switch, Friday, quiet hours, daily cap; then sends at most *N* per second.
- **Errors** (`src/providers/errors.js`): rate limit / temporary errors retry with backoff
  (2 s, 4 s, 8 s … up to 15 min) and go to **dead letters** after the attempt limit; permanent
  errors are recorded on the message and the customer (e.g. 131026 *not on WhatsApp* stops their
  sequence; 131050 *stopped marketing messages* is treated as an opt-out; 131047 *outside the
  24-hour window*; 131049 *Meta held it back*); account errors (expired token 190, policy 368,
  payment 131042 …) **halt the whole queue** until an admin resumes it.
