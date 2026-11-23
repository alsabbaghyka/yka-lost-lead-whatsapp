# Security and data protection

## Data held

| Data | Where | Why | Kept |
| --- | --- | --- | --- |
| Lead rows from CRM exports: mobile, name, brand, model, loss reason, comments, status, lead date, salesperson | `import_leads` | Campaign building, audit of why someone was or was not messaged | Until erased (see retention) |
| Customer record: mobile, name, brand, model, salesperson, last in/out time, WhatsApp user id | `customers` | Sequence and 24-hour window | Until erased |
| Messages in and out: text, template, status, Meta error | `messages` | Timeline, inbox, measurement | Until erased |
| Raw webhook payloads (contain number, name, message text) | `webhook_events` | Durable intake, deduplication | Until erased; prune processed ones periodically (see below) |
| Opt-outs: mobile, date, source, the reply text | `optouts` | Legal duty not to message again | **Permanently** — erasure keeps them |
| Do-not-contact / recent-buyer lists | `suppressions` | Not messaging people who must not be | Until removed by marketing; erasure keeps them |
| Outcome files: mobile, first date | `outcome_events` | Measuring the campaign | Until removed or erased |
| Staff users, scrypt password hashes, sessions, audit log (mobiles masked) | `users`, `sessions`, `audit` | Access and accountability | Audit: keep per company policy |

Nothing is sent anywhere except Meta's Graph API (`graph.facebook.com`) when `WA_PROVIDER=cloud`.
The screens load the Archivo font from Google Fonts; block it and they fall back to Arial.

## Legal basis — open

**Bahrain PDPL (Law No. 30 of 2018): the consent / legitimate-interest basis for messaging lost
leads has NOT been confirmed by legal.** The system supports a cautious reading — old leads
(before the configurable consent date) only receive a permission request, and nothing more unless
they answer YES — but the decision, the consent date and the retention periods need written
legal sign-off before go-live. WhatsApp's own Business Messaging Policy also requires opt-in.

## Retention (proposal for legal to confirm)

- Messages, customers, import rows, webhook payloads: delete 24 months after the last contact.
- Outcome files: delete after the measurement is reported.
- Opt-outs and do-not-contact: keep indefinitely (they exist to stop contact).
Retention jobs are **not automated yet**; erasure per customer is (`cli.js erase-customer`).

## Threat model

| Threat | Control |
| --- | --- |
| Forged webhooks (fake replies, fake opt-outs, fake "delivered") | `X-Hub-Signature-256` HMAC over the raw body with the app secret, constant-time compare; no secret → nothing verifies; events for another phone number id are ignored. |
| Replayed / duplicated webhooks | Stored once per message id and (status id, status). |
| Messaging someone who opted out | Opt-out checked at queue time **and** at send time; queued messages cancelled at once; DB trigger forbids deleting an opt-out; erasure keeps it. |
| A single person sending a campaign | Four-eyes approval in code and as a database CHECK constraint; roles. |
| Mass accidental send | Test mode by default, allow-list, daily cap, kill switch, per-second throttle, Friday / quiet hours. |
| Stolen session / CSRF | httpOnly, SameSite=Strict cookie (Secure behind https); server-side sessions (only a hash of the token is stored); CSRF token header on every write; Origin check; 12-hour expiry; deactivating a user kills their sessions. |
| Password guessing | scrypt (N=16384, r=8, p=1, 16-byte salt); 12-character minimum; 5 failures lock that email for 5 minutes (in memory; put rate limiting on the reverse proxy too). |
| XSS | All output escaped; strict Content-Security-Policy (`script-src 'self'`, no inline script, no inline handlers); `frame-ancestors 'none'`. |
| Malicious spreadsheets | SheetJS 0.20.3 (after the prototype-pollution fix), hash-pinned and checked at start; 25 MB limit; formulas not evaluated. |
| CSV formula injection in exports | Cells starting `= + - @` are prefixed with `'` (phone numbers excepted). |
| Leaking mobiles in logs | Mobiles masked in the server log and the audit log. |
| Token leakage | Token only in the environment; never shown on screen or logged; Settings shows ids only. |
| Path traversal on static files | Normalised path must stay inside `public/`. |
| Double sending after a crash | Messages left "sending" at start-up go to dead letters for a person to check instead of being re-sent. |

## Known gaps

- No automated retention job (above).
- Login throttling is per process and in memory.
- No 2FA; put the app behind the corporate VPN / SSO proxy if available.
- The audit log is in the same database as the data; ship backups off-host.
- Webhook payload table grows; prune processed rows older than 30 days
  (`DELETE FROM webhook_events WHERE processed_at < date('now','-30 day')`) until a job exists.
