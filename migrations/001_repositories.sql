-- One row per ingested repository (zip upload with .git, or deep-cloned remote URL).
CREATE TABLE IF NOT EXISTS repositories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('zip', 'remote')),
  source_url TEXT,
  head_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ingesting', 'ready', 'failed')),
  error TEXT,
  created_at TEXT NOT NULL,
  ingested_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_repositories_status ON repositories (status);
