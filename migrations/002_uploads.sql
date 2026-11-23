-- Parsed spreadsheets waiting for a decision (column mapping, which list). Kept in the
-- database, not in memory, because on Vercel the next request may reach another instance.
-- Used once, deleted after use or after 30 minutes.
CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  file_name TEXT NOT NULL,
  data TEXT NOT NULL,                -- JSON {rows, names, headerless}
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
