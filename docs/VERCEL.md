# Running on Vercel (test deployment)

Vercel project: `yka-lost-lead-whatsapp` (team *Alsabbagh's projects*), connected to
`alsabbaghyka/yka-lost-lead-whatsapp`. A push to `main` deploys.

## How it differs from the server install

| | Server (`node server.js`, Docker) | Vercel |
| --- | --- | --- |
| Database | SQLite file (`DB_PATH`) | **Turso** (hosted SQLite): `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, set by connecting a Turso store in Vercel → Storage. Without them the app refuses to start rather than keep data on a disk that disappears. |
| Background work | Workers every 2 s | After requests (at most every 15 s per instance, via `waitUntil`) and a daily cron at 07:00 UTC = 10:00 Bahrain (`CRON_SECRET`). Admins/marketing can also run it now: `POST /api/system/run-due`. On the Hobby plan nothing runs while nobody uses the site, so sends happen when someone visits. |
| First admin | `node cli.js create-admin` | `BOOTSTRAP_ADMIN_EMAIL` / `_NAME` / `_PASSWORD`, used once while there are no users. To repair a lost admin sign-in, set `BOOTSTRAP_ADMIN_RESET=1`, redeploy (it makes that email an active admin with that password, on every cold start), then **remove the flag and redeploy**. |
| Uploads | 25 MB | 4.5 MB (Vercel request limit) |
| Backups | `node cli.js backup` | Turso's own point-in-time restore |
| Access | Your network | `*.vercel.app` is behind Vercel Authentication (sign in to Vercel first), then the app's own sign-in |

Two instances can run at once on Vercel, so every outgoing message is claimed
(`queued → sending`) before it is sent, every webhook event is applied inside its own
transaction after a re-check, and the scheduler's once-a-minute run is claimed in the database.

## Safety

The Vercel deployment is set to `WA_PROVIDER=mock`: nothing reaches WhatsApp, deliveries and
replies are simulated (Inbox → "Simulate customer reply"). Use only fictional data
(Import → "Use the sample data"). Switching it to `cloud` is a go-live decision: follow
`GO-LIVE-CHECKLIST.md` first.

## Environment variables set on the project

`WA_PROVIDER=mock`, `COOKIE_SECURE=1`, `DEMO_BANNER=1`, `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_NAME`,
`BOOTSTRAP_ADMIN_PASSWORD` (encrypted), `CRON_SECRET` (encrypted); Turso adds `TURSO_DATABASE_URL` and
`TURSO_AUTH_TOKEN` when its store is connected.

## Tests

`npm test` runs everything on SQLite. `npm run test:turso-adapter` runs the same suite through
the Turso adapter (with a local stand-in for Turso's network client), which checks this
system's adapter code, not Turso itself.
