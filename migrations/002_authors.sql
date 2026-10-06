-- Distinct raw git identities per repository.
-- canonical_id points at the row representing the merged identity (via .mailmap
-- at ingest time, or manual merging in the UI); NULL means the row is itself
-- canonical. Author metrics always resolve through canonical_id.
CREATE TABLE IF NOT EXISTS authors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES repositories (id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  canonical_id INTEGER REFERENCES authors (id),
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_authors_repo_email ON authors (repo_id, email);
CREATE INDEX IF NOT EXISTS idx_authors_canonical ON authors (canonical_id);
