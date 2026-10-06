-- One row per commit in the full history, including merges (is_merge = 1).
-- The analysis set is only non-merge rows reachable from the reference commit.
-- committer_date is an ISO 8601 string; time ranges are half-open [i, j).
CREATE TABLE IF NOT EXISTS commits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES repositories (id),
  hash TEXT NOT NULL,
  parent_hash TEXT,
  author_id INTEGER NOT NULL REFERENCES authors (id),
  committer_date TEXT NOT NULL,
  summary TEXT,
  is_merge INTEGER NOT NULL DEFAULT 0 CHECK (is_merge IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_commits_repo_hash ON commits (repo_id, hash);
CREATE INDEX IF NOT EXISTS idx_commits_repo_date ON commits (repo_id, committer_date);
CREATE INDEX IF NOT EXISTS idx_commits_repo_author_date ON commits (repo_id, author_id, committer_date);
