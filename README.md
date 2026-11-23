# Lost Lead WhatsApp

Win back lost new-vehicle sales over WhatsApp, safely. A server application for
Y.K. Almoayyed's lost-lead pilot that:

1. reads a CRM lost-sales export (.xlsx / .csv) with the **Lost Lead Engine's rules**
   (Bahrain mobile cleaning, dedupe, exclusions, 9 loss-reason buckets, hash-based
   holdout, permission-first track for old leads, locked templates);
2. turns it into a **campaign** that one person builds and a **second person approves**;
3. sends the Day 0 → Day 2 → Day 7 → Day 30 follow-up through the **official WhatsApp
   Business Platform (Cloud API)** — or a mock / dry-run provider until IT connects it;
4. reads replies: **STOP opts out** everywhere at once, 1–4 answers the reason question,
   YES/NO answers the permission request, anything else goes to the **named salesperson's
   inbox** and pauses the automation;
5. measures **send vs holdout** honestly (two-proportion z test, 95% interval, smallest
   provable difference) from later invoice / test-drive / service files.

It is separate from the browser prototype in `../lost-lead-engine/` (which it ports) and
has nothing to do with the Customer Entry Audit project in the parent folder.

## Quick start (Windows, no Docker)

Needs Node 24 or later. No `npm install`: there are no third-party dependencies.

```bash
node cli.js create-admin --email you@example.com --name "Your Name"
```

```bash
node server.js
```

Open http://127.0.0.1:8080, sign in, and press **Import → Use the sample data**. With the
default `WA_PROVIDER=mock` nothing reaches WhatsApp: deliveries, reads and replies are
simulated and come back as correctly signed webhooks, so the whole loop can be tried.

Run the tests:

```bash
node --test --test-concurrency=1 "test/*.test.js"
```

## Docker

```bash
cp .env.example .env
docker compose up -d --build
docker compose exec app node cli.js create-admin --email it@example.com --name "IT Admin"
```

## Safety, on by default

- **Test mode**: until an admin turns go-live on, only numbers on the allow-list receive anything.
- **Kill switch** on the dashboard stops every send at once.
- **Four eyes**: a campaign is approved by someone other than its builder (enforced in the database too).
- **Daily cap**, per-second throttle, **no Friday sends**, **quiet hours** (Asia/Bahrain).
- **Holdout** customers are never messaged. **Opt-outs** are permanent and survive erasure.
- Only **Meta-approved templates** are sent; free text only inside the 24-hour window.
- Every action is in the **audit log**; mobiles are masked in logs.

## Docs

| | |
| --- | --- |
| `docs/INTEGRATION.md` | Connecting to Meta's WhatsApp Cloud API, step by step, and every environment variable. |
| `docs/GO-LIVE-CHECKLIST.md` | What must be true before go-live is switched on. |
| `docs/RUNBOOK.md` | Pause, kill switch, dead letters, token rotation, backup and restore. |
| `docs/SECURITY.md` | Threat model, data held, retention, open legal points. |
| `docs/META-API-NOTES.md` | The Meta API facts the connector relies on, with sources. |
| `docs/openapi.yaml` | The REST API. |
| `docs/PLAN.md` | The implementation plan this was built from. |

## Layout

```
server.js, cli.js         entry points
src/rules/                the engine and simulator rules, pure and unit-tested
src/providers/            cloud (Meta Graph API), mock, dry-run; Meta error-code map
src/services/             imports & campaigns, scheduler, sender (outbox + safety gates),
                          conversation (webhook effects), inbox, opt-outs, results, exports
src/webhook.js            verification, signature check, durable deduplicated intake
src/http/app.js           REST API, sessions, CSRF, static screens
public/                   the screens (plain JS, strict CSP)
migrations/               SQLite schema
vendor/xlsx.js            SheetJS 0.20.3, SHA-256 pinned and checked at start-up
```

## Status

Built and tested against Meta's **documented** payloads only. Nothing has been sent to, or
received from, the real WhatsApp platform. See "What is proven and what is not" in
`docs/INTEGRATION.md`.
