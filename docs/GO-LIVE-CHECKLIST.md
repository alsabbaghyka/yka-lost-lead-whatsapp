# Go-live checklist

Go-live (Settings → *Go live…*) lets running campaigns message real customers. Tick every
line first. The person turning it on records who signed off in the audit trail by doing it
under their own account.

## Legal and business

- [ ] **Consent basis signed off.** Bahrain PDPL (Law 30 of 2018): legal has confirmed in writing
      the basis for messaging lost leads on WhatsApp, and whether leads before the consent date
      may receive only the permission request. *Not confirmed as of 23 Nov 2026.*
- [ ] WhatsApp Business messaging policy and commerce policy read by marketing; the templates
      offer something the customer asked about (no unrelated promotions).
- [ ] Every template wording signed off by marketing (Day 0 bodies are the engine's; Day 2/7/30
      are drafts). Arabic versions translated and checked by a native speaker, if used.
- [ ] Note: the permission template (`lost_lead_permission_v1`) has no "Reply STOP" line, while
      the others do. STOP still works on it; decide whether to add the line before submitting.
- [ ] Holdout % and holdout key agreed for the whole pilot and **not changed mid-pilot**.
- [ ] Salespeople have user accounts whose **names match the CRM export** exactly, so handovers
      reach their inbox (otherwise they go to the shared unassigned inbox).

## Meta

- [ ] Business portfolio verified; display name approved for the sending number.
- [ ] Messaging limit tier known (WhatsApp Manager). **Daily cap in Settings is below it.**
- [ ] All Day 0 templates **Approved** (Templates screen, after *Sync from Meta*).
- [ ] App in **Live** mode; webhook verified; `messages` and `message_template_status_update` subscribed.
- [ ] Quality rating of the number is green.

## System

- [ ] `WA_PROVIDER=cloud`; Settings → *Test WhatsApp connection* is green.
- [ ] Test mode run done with allow-listed phones (INTEGRATION.md §5): Day 0 received, delivered
      and read ticks appear on the timeline, `STOP` opts out and gets the confirmation, `1` answers
      the reason question, free text appears in the salesperson's inbox, a reply from the inbox arrives.
- [ ] Do-not-contact list and **recent buyers** imported from the latest sales export.
- [ ] Opt-outs from the browser prototype imported (Opt-outs & lists → import its `opt-out-list` CSV).
- [ ] Quiet hours, send time, Friday skip, daily cap (start low, e.g. 50) reviewed.
- [ ] HTTPS with a valid certificate; `COOKIE_SECURE=1`; the app port not reachable from the internet
      except `/webhook` (and `/healthz` if monitoring needs it).
- [ ] Nightly backup scheduled (`node cli.js backup`) and **one restore tested** (RUNBOOK.md).
- [ ] At least two admins; the person who builds campaigns is not the only approver.
- [ ] Someone watches the dashboard (dead letters, webhook backlog, halted banner) daily for the first two weeks.

## First live day

- [ ] Start with one small campaign; keep the cap low.
- [ ] Check the campaign's *What went wrong* table after the first send for 131026 / 131049 / 131047.
- [ ] Know where the kill switch is (dashboard → *Stop all sending now*).
