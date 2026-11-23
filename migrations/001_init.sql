-- Lost Lead WhatsApp: initial schema. Times are ISO-8601 UTC text.

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','marketing','sales','viewer')),
  pw_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,               -- sha256 of the cookie token
  user_id INTEGER NOT NULL REFERENCES users(id),
  csrf TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT, updated_by INTEGER);

-- test mode: only these numbers can receive anything until go-live
CREATE TABLE allowlist (mobile TEXT PRIMARY KEY, note TEXT, added_at TEXT NOT NULL, added_by INTEGER);

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  mobile TEXT NOT NULL UNIQUE,
  wa_user_id TEXT,                   -- Meta BSUID when seen
  name TEXT, brand TEXT, model TEXT, sales TEXT,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  last_inbound_at TEXT,              -- opens the 24h customer service window
  last_outbound_at TEXT
);
CREATE INDEX customers_wa_user ON customers(wa_user_id);

CREATE TABLE imports (
  id INTEGER PRIMARY KEY,
  file_name TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  mapping TEXT NOT NULL,             -- JSON field -> header
  options TEXT NOT NULL,             -- JSON engine options used
  summary TEXT NOT NULL              -- JSON counts
);

CREATE TABLE import_leads (
  id INTEGER PRIMARY KEY,
  import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  row_no INTEGER NOT NULL,
  mobile TEXT, mobile_raw TEXT, name TEXT, brand TEXT, model TEXT,
  reason TEXT, comments TEXT, status TEXT, lead_date TEXT, sales TEXT,
  grp TEXT NOT NULL CHECK (grp IN ('send','holdout','meta','meta_holdout','excluded')),
  bucket TEXT, track TEXT, ex_reason TEXT, tpl_name TEXT, vars TEXT
);
CREATE INDEX import_leads_import ON import_leads(import_id, grp);
CREATE INDEX import_leads_mobile ON import_leads(mobile);

CREATE TABLE campaigns (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  import_id INTEGER NOT NULL REFERENCES imports(id),
  status TEXT NOT NULL CHECK (status IN ('draft','pending_approval','approved','running','paused','completed','cancelled')),
  start_date TEXT NOT NULL,          -- Day 0, Bahrain calendar date yyyy-mm-dd
  language TEXT NOT NULL DEFAULT 'en',
  created_by INTEGER NOT NULL REFERENCES users(id),
  submitted_at TEXT,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  started_at TEXT, paused_at TEXT, completed_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  CHECK (approved_by IS NULL OR approved_by <> created_by)   -- four eyes
);

CREATE TABLE enrollments (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  mobile TEXT NOT NULL,
  grp TEXT NOT NULL CHECK (grp IN ('send','holdout')),
  bucket TEXT NOT NULL, track TEXT NOT NULL,
  sales TEXT,
  status TEXT NOT NULL,              -- queued active asked handover optout quiet declined failed listed holdout done
  next_key TEXT, next_day INTEGER,
  tpl_count INTEGER NOT NULL DEFAULT 0,
  unanswered INTEGER NOT NULL DEFAULT 0,
  last_tpl TEXT,
  brief TEXT,
  handover_at TEXT, handover_user INTEGER REFERENCES users(id), resolved_at TEXT, resolved_by INTEGER,
  updated_at TEXT NOT NULL,
  UNIQUE (campaign_id, customer_id)
);
CREATE INDEX enrollments_due ON enrollments(campaign_id, status, next_day);
CREATE INDEX enrollments_mobile ON enrollments(mobile);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  enrollment_id INTEGER REFERENCES enrollments(id),
  customer_id INTEGER REFERENCES customers(id),
  mobile TEXT NOT NULL,
  dir TEXT NOT NULL CHECK (dir IN ('out','in')),
  kind TEXT NOT NULL,                -- template | text | button | interactive | other
  tpl_name TEXT, tpl_key TEXT, language TEXT, vars TEXT,
  body TEXT,
  wamid TEXT UNIQUE,
  status TEXT NOT NULL,              -- out: queued sending sent delivered read failed blocked cancelled; in: received
  error_code INTEGER, error_title TEXT, outcome TEXT,
  idem_key TEXT UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  sent_by INTEGER REFERENCES users(id),
  automated INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX messages_outbox ON messages(status, next_attempt_at);
CREATE INDEX messages_mobile ON messages(mobile, created_at);

CREATE TABLE dead_letters (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT, resolved_by INTEGER, resolution TEXT
);

-- webhooks land here before anything else happens: durable, deduplicated
CREATE TABLE webhook_events (
  id INTEGER PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,                -- message | status | template | error | unknown
  payload TEXT NOT NULL,             -- the one item, as JSON
  received_at TEXT NOT NULL,
  processed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX webhook_events_pending ON webhook_events(processed_at);

CREATE TABLE optouts (
  mobile TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  source TEXT NOT NULL,              -- whatsapp_reply | import | manual | meta_131050
  text TEXT
);
-- a promise to the customer: nothing in the application can remove one
CREATE TRIGGER optouts_no_delete BEFORE DELETE ON optouts BEGIN SELECT RAISE(ABORT, 'opt-outs are permanent'); END;

CREATE TABLE suppressions (
  mobile TEXT NOT NULL,
  list TEXT NOT NULL CHECK (list IN ('dnc','recent_buyer')),
  added_at TEXT NOT NULL, source TEXT, added_by INTEGER,
  PRIMARY KEY (mobile, list)
);

CREATE TABLE templates (
  name TEXT NOT NULL,
  language TEXT NOT NULL,
  status TEXT NOT NULL,              -- Meta status, or UNKNOWN if never synced
  category TEXT, meta_id TEXT, body TEXT, reason TEXT,
  synced_at TEXT,
  PRIMARY KEY (name, language)
);

CREATE TABLE outcome_events (
  id INTEGER PRIMARY KEY,
  mobile TEXT NOT NULL,
  at TEXT,                           -- first date seen, null if undated
  source_file TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  added_by INTEGER, added_at TEXT NOT NULL,
  UNIQUE (mobile, batch_id)
);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  user_id INTEGER,
  user_email TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
CREATE INDEX audit_at ON audit(at);
