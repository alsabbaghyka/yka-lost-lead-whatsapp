# Runbook

## Stop everything now

Dashboard → **Stop all sending now** (admin or marketing). Nothing leaves the outbox; queued
messages wait. Only an admin can release it. Webhooks keep being received, so opt-outs still
apply while it is on.

## Pause one campaign

Campaign screen → **Pause**. No new templates for that campaign; replies are still handled and
salespeople can still reply. **Resume** continues where it stopped. **Cancel** drops its queued
automated messages for good.

## Back to test mode

Settings → **Back to test mode**. Only allow-listed numbers receive anything; everyone else
waits (they are not skipped).

## "Sending halted" banner

The sender stopped itself after an account-level Meta error (expired token, policy restriction,
payment problem, number not registered). The banner shows the Meta message.

1. Fix the cause (see token rotation below, or WhatsApp Manager for policy / payment).
2. Settings → *Test WhatsApp connection* until it is green.
3. Settings → **Resume sending**. Queued messages go out; none were lost.

## Dead letters

Settings → Dead letters lists messages that failed for temporary reasons after the attempt
limit, or were in flight when the server stopped (these may or may not have reached the
customer — check their timeline first, since Meta cannot tell us idempotently).
**Retry** re-queues it (every safety gate is checked again); **Discard** closes it.

## Rotate the access token

1. Business Settings → System users → the system user → Generate new token (same permissions:
   `whatsapp_business_messaging`, `whatsapp_business_management`, `business_management`).
2. Put it in the server environment as `WA_ACCESS_TOKEN`, restart the service.
3. Settings → *Test WhatsApp connection*. Then revoke the old token in Business Settings.

To rotate the **app secret**: reset it in the App Dashboard, set `WA_APP_SECRET`, restart. Until
both match, webhooks are rejected with 401 and Meta retries them for up to 7 days, so a short gap
loses nothing.

## Backup

```bash
node cli.js backup
```

Writes a consistent copy (`VACUUM INTO`, safe while running) to `BACKUP_DIR`. In Docker:
`docker compose exec app node cli.js backup`. Schedule it nightly (Task Scheduler / cron) and
copy the file off the server, encrypted — it holds customer mobiles and messages.

## Restore

1. Stop the service.
2. Move the current `DB_PATH` file (and any `-wal` / `-shm` next to it) aside.
3. Copy the backup file to `DB_PATH`.
4. Start the service. Migrations run automatically if the code is newer.
5. Opt-outs received after the backup was taken are lost from the database. Re-import the
   opt-out list exported before the restore if you have one, or Meta's replies since that date.

## Erase a customer (data-subject request)

Customers screen → the customer → *Erase this customer* (admin), or
`node cli.js erase-customer --mobile 3999xxxx --by admin@example.com`. Messages, campaign history,
import rows and stored webhook payloads for that number are deleted; the **opt-out and
do-not-contact entries stay**, so the number is never messaged again. The audit log keeps a
masked record that the erasure happened.

## Logs and health

- `GET /healthz` → `{ok, provider, webhookBacklog, halted}` for monitoring.
- The server log masks mobiles. A growing *webhook backlog* on the dashboard means processing
  is failing: the server log shows `webhook event failed` with the reason; after 5 failures an
  event is set aside and recorded as `webhook.poison` in the audit log.

## Upgrade

Stop, replace the code (keep `data/` and `.env`), start. Migrations in `migrations/` run on start.
Run `node --test --test-concurrency=1 "test/*.test.js"` on the new code before deploying.
