-- Per-commit, per-file line accounting (git numstat, rename detection at 50%).
-- Binary files are never recorded. Pure renames are recorded with 0/0 so the
-- new path exists in scope; rename+edit lands on the new path; a removed
-- file's row carries its full line count on the old path.
-- Directory and repository metrics aggregate over path prefixes at query time.
CREATE TABLE IF NOT EXISTS file_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES repositories (id),
  commit_id INTEGER NOT NULL REFERENCES commits (id),
  path TEXT NOT NULL,
  added INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_file_stats_commit ON file_stats (commit_id);
CREATE INDEX IF NOT EXISTS idx_file_stats_repo_path ON file_stats (repo_id, path);
CREATE INDEX IF NOT EXISTS idx_file_stats_repo_commit ON file_stats (repo_id, commit_id);
