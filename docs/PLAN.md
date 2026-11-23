# Lost Lead WhatsApp System — Implementation Plan

> **For agentic workers:** executed inline in the session that wrote it (superpowers:executing-plans style), TDD for every rule module. Steps use checkbox syntax.

**Goal:** A server application that turns a CRM lost-sales export into approved WhatsApp campaigns, sends them through Meta's WhatsApp Cloud API (or a mock / dry-run provider), runs the Day 0 → 2 → 7 → 30 follow-up with the simulator's reply rules, and measures send vs holdout — safe by default, ready for IT to connect and test.

**Architecture:** One Node 24 process, zero third-party runtime dependencies. `node:http` serves a REST API and a vanilla-JS single page; `node:sqlite` holds everything with numbered SQL migrations. Pure rule modules (ported verbatim from `lost-lead-engine/index.html` and `simulator.html`) sit under `src/rules/` and are unit-tested in isolation; services wire them to the database; a provider interface (`cloud`, `mock`, `dry-run`) is the only thing that talks to WhatsApp. A scheduler tick (injectable clock) decides who is due; an outbox worker sends with throttle, retry and dead-letter; webhooks land in a durable table first and are processed after the 200.

**Tech Stack:** Node 24 (`node:http`, `node:sqlite` DatabaseSync, `node:crypto`, `node:test`), SheetJS 0.20.3 (vendored, hash-pinned), Docker.

## Global Constraints

- Lives in `lost-lead-whatsapp/`, its own git repo; never touches `lost-lead-engine/` or the Customer Entry Audit. Git identity `alsabbaghyka@gmail.com` / `Yusuf Mahmood`. No push.
- No third-party runtime dependencies. SheetJS `vendor/xlsx.js` SHA-256 `cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41`, checked at startup and in a test.
- Graph API version is config (`WA_GRAPH_VERSION`, default `v27.0` — latest on Meta's changelog 23 Nov 2026).
- Test mode ON by default; kill switch; four-eyes; daily cap; holdout never messaged; opt-outs instant, global, never erased.
- Timezone Asia/Bahrain; no Friday sends; configurable quiet hours.
- Mobiles masked in every log and audit line (`+973****1234`).
- Sample data must give: 160 rows → 148 customers, 31 excluded, 12 holdout, 11 Meta, 106 ready.
- No real customer data, no real credentials, no real message sent.

---

## File structure

| Path | Responsibility |
| --- | --- |
| `server.js` | Entry: load config, open DB, migrate, start HTTP + workers. |
| `cli.js` | `create-admin`, `migrate`, `backup`, `erase-customer`, `check`. |
| `src/config.js` | Env parsing with defaults and validation (`.env` file loader, no dependency). |
| `src/clock.js` | `systemClock`, `fakeClock`; Bahrain date parts, `isFriday`, `inQuietHours`, `bahrainDate`. |
| `src/mask.js` | `maskMobile`, `maskText` (masks any Bahrain mobile inside free text). |
| `src/rules/mobile.js` | `cleanMobile`, `mobileOf` (date-shaped → null), `parseDate`, `iso`, `addDays`. |
| `src/rules/keywords.js` | `kwRegex`, `hasKw`, `has`, `norm`, `cleanText`. |
| `src/rules/buckets.js` | `BUCKETS`, `MATCH_ORDER`, `TRANSFER_KW`, `JUNK_KW`, `OPEN_KW`, `OURS_KW`, `OPEN_TEXT_KW`, `SYSTEM_TEXT`, `BRAND_CODES`, `classify(lead)`. |
| `src/rules/templates.js` | Template catalogue (8 Day-0 + permission + 3 drafts, `en` + `ar` placeholders), `fill`, `tplVars`, `varValues`, `tplBody`, `firstName`, `templateForKey`. |
| `src/rules/engine.js` | `runEngine(rows, map, opts)` → `{total, unique, send, hold, meta, metaHold, excluded, exCount, bucketCount}` — the engine's `run()` without DOM. `FIELDS`, `detect`, `detectByContent`, `EX_LABEL`, `sampleRows`. |
| `src/rules/stats.js` | `erf`, `normCdf`, `compareArms`, `minDetectable`, `scoreArm`. |
| `src/rules/replies.js` | `isStop`, `isYes`, `isNo`, `isCall`, `clip`, `OPTOUT_KW`, `isOutboundRow`, `parseOptoutRows`. |
| `src/rules/sequence.js` | Pure state machine: `startState`, `afterTemplate(state, key, day)`, `onReply(state, text, day)` → `{state, actions[]}`; `SEQ_KEYS`. |
| `src/spreadsheet.js` | `readSpreadsheet(buffer, filename)` → `{rows, names, headerless}` (port of `readFile`). |
| `src/db.js` | `openDb(path)`, `migrate(db)`, tx helper. `migrations/*.sql`. |
| `src/audit.js` | `audit(db, user, action, target, detail)` — masks mobiles. |
| `src/settings.js` | Typed get/set over `settings` table with defaults. |
| `src/auth.js` | scrypt hash/verify, sessions, CSRF, roles, login throttle. |
| `src/providers/errors.js` | Meta error-code table → `{kind: retry|permanent|account, outcome, label}`. |
| `src/providers/cloud.js` | Graph API: `sendTemplate`, `sendText`, `listTemplates`, `testConnection`. |
| `src/providers/mock.js` | In-process fake: realistic ids, signed status webhooks, `simulateInbound`. |
| `src/providers/dryrun.js` | Records and returns fake ids; never sends, never produces webhooks. |
| `src/providers/index.js` | `makeProvider(config, deps)`. |
| `src/webhook.js` | `verifyChallenge`, `verifySignature`, `ingest(raw)` → durable rows, `processPending()`. |
| `src/services/*.js` | `imports`, `campaigns`, `scheduler`, `sender`, `conversation`, `optouts`, `customers`, `results`, `templates`, `exports`. |
| `src/http/*.js` | Router, body/multipart parsing, static files, API routes. |
| `public/` | `index.html`, `app.css` (engine tokens), `app.js` (hash-routed screens). |
| `test/*.test.js` | `node --test`. |
| `docs/` | PLAN, META-API-NOTES, INTEGRATION, GO-LIVE-CHECKLIST, RUNBOOK, SECURITY, openapi.yaml. |

## Data model (migration 001)

`users`, `sessions`, `settings`, `allowlist`, `customers` (mobile unique, wa_user_id, last_inbound_at), `imports`, `import_leads`, `campaigns` (draft → pending_approval → approved → running ⇄ paused → completed / cancelled; created_by ≠ approved_by), `enrollments` (state, next_key, next_day, step counts, handover), `messages` (outbox + history; `idem_key` unique; `wamid` unique; status queued/sending/sent/delivered/read/failed/blocked/cancelled; error code + outcome text; attempts, next_attempt_at), `dead_letters`, `webhook_events` (event_key unique, raw, processed_at), `optouts` (never deleted), `suppressions` (dnc / recent_buyer), `templates` (name+language, status, body), `outcome_events`, `audit`.

## Tasks

### Task 1: Pure rules, test-first
**Files:** `src/rules/*.js`, `src/spreadsheet.js`, `test/rules.*.test.js`
- [ ] Write failing tests: cleanMobile (`973`, `00973`, `+973`, `.0` suffix, landline, date-shaped `30/06/2026` → null via `mobileOf`); keyword probes — busy≠business, jac≠jacket, dp≠dpt, `availab*` stem, Arabic `سعر`/`غالي`/`تمويل` substring; classify — "not interested in the white colour" is not disq, "bought from us" not competitor, transfer/junk/open precedence, disqualified only from reason or status; `hashPct` fixed values; template body numbering `{{1}}..{{3}}`; stats against hand-computed values; replies — STOP vs "stopped by", Arabic STOP, outbound "Reply STOP to opt out" rows ignored.
- [ ] Sample test: `runEngine(sampleRows(), detect(headers), {holdPct:15, seed:2026, consentFrom:'2026-11-01'})` → 160 / 148 / 31 / 12 / 11 / 106.
- [ ] Port code verbatim; run `node --test`; commit.

### Task 2: Sequence state machine with the 9 simulator checks
**Files:** `src/rules/sequence.js`, `test/sequence.test.js`
- [ ] Tests replay the simulator's 13 demo customers day by day with a pure driver and assert all 9 checks hold (nothing after opt-out; STOP always opts out; holdout gets nothing; pause after handover; ≤3 unanswered in a row; permission first for old leads; undeliverable not retried; no Friday; nobody on opt-out list messaged), plus each fault mode makes its check fail.
- [ ] Implement; commit.

### Task 3: Database, config, clock, audit, settings
**Files:** `src/db.js`, `migrations/001_init.sql`, `src/config.js`, `src/clock.js`, `src/mask.js`, `src/audit.js`, `src/settings.js`, tests.
- [ ] Tests: migrations idempotent; Bahrain Friday/quiet hours across UTC midnight; mask; audit never stores a raw mobile.
- [ ] Implement; commit.

### Task 4: Providers and error mapping
**Files:** `src/providers/*.js`, `test/providers.test.js`
- [ ] Tests with a fake `fetch`: cloud builds the documented template/text bodies and URL with the configured version; parses success id; maps 130429 → retry, 131026 → permanent "not on WhatsApp", 131047 → "outside 24h window", 190 → account (queue stops); listTemplates follows `paging.next`. Mock produces sent/delivered/read (or failed 131026) webhooks signed with the app secret. Dry-run never calls fetch.
- [ ] Implement; commit.

### Task 5: Webhook ingest
**Files:** `src/webhook.js`, `test/webhook.test.js`
- [ ] Tests: GET challenge ok / wrong token 403; bad / missing signature 401 and nothing stored; duplicate delivery stored once; inbound text, button, interactive button_reply / list_reply, statuses incl. failed with errors; template status update; processing after 200 from the durable table, survives a "crash" (unprocessed rows processed on next start).
- [ ] Implement; commit.

### Task 6: Sender (outbox) and safety gates
**Files:** `src/services/sender.js`, `test/sender.test.js`
- [ ] Tests: kill switch holds everything; test mode blocks non-allowlisted; daily cap; holdout refused; opt-out refused (even if queued before the opt-out); unapproved / pending / unknown template refused; free text outside 24h refused; throttle (N per second with fake clock); retry with exponential backoff on 130429/5xx; dead letter after max attempts; no retry on 131026; account error stops the worker; idempotency key prevents double enqueue.
- [ ] Implement; commit.

### Task 7: Scheduler and conversation
**Files:** `src/services/scheduler.js`, `src/services/conversation.js`, `src/services/optouts.js`, tests.
- [ ] Tests with fake clock: Day 0 at the send hour; Friday moved to Saturday; quiet hours wait; 3 unanswered → quiet; 1–4 answers; YES/NO permission; free text → handover, automation paused; STOP (EN/AR, button "Unsubscribe") opts out across all campaigns and cancels queued messages; failed 131026 → no retry.
- [ ] Implement; commit.

### Task 8: Imports, campaigns (four-eyes), results, customers (erasure), exports
**Files:** `src/services/{imports,campaigns,results,customers,exports,templates}.js`, tests.
- [ ] Tests: import sample → preview counts; creator cannot approve; viewer/sales cannot build; approve → schedule → run; pause/resume; results compare arms with outcome file; erasure removes history but keeps opt-out and the number stays unmessageable; CSV exports.
- [ ] Implement; commit.

### Task 9: HTTP, auth, API, UI
**Files:** `src/http/*.js`, `src/auth.js`, `server.js`, `cli.js`, `public/*`, `test/http.test.js`, `docs/openapi.yaml`.
- [ ] Tests over a real listening server: login, httpOnly cookie, CSRF required on writes, role checks, upload, webhook route uses the raw body.
- [ ] Build screens: dashboard, import, campaigns, templates, inbox, customer, suppression, results, settings (Test connection), audit, users.
- [ ] Commit.

### Task 10: End-to-end
**Files:** `test/e2e.test.js`
- [ ] Sample import → build (marketing A) → approve (marketing B) → start → tick with mock provider → webhooks return → Day 2 → STOP opts out → free text creates a handover → salesperson replies inside 24h → outcome file → results numbers match hand computation.
- [ ] Start the server and click through every screen in the Browser pane.

### Task 11: Docs, Docker, reviews
- [ ] `Dockerfile`, `docker-compose.yml`, `.env.example`, README, INTEGRATION, GO-LIVE-CHECKLIST, RUNBOOK, SECURITY.
- [ ] security-review + code-review; fix; full `node --test`; commit.
