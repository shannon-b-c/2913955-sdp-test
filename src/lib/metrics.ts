import type { Db } from "./db";
import type {
  Author,
  AuthorMetrics,
  ChildMetrics,
  CommitRow,
  CommitSetMetrics,
  MetricFilters,
  MetricsResponse,
  RepoSummary,
} from "./types";

/**
 * Metric computations per the brief. All heavy lifting happens in SQL over
 * (commits ⋈ file_stats); JavaScript only groups immediate children and
 * derives ratios, so large repositories stay fast.
 *
 * Conventions from the brief:
 *  - Only non-merge commits reachable from the reference commit (HEAD) are
 *    ever measured — ingestion guarantees exactly those rows exist.
 *  - A commit set H is narrowed by author, half-open committer-date range
 *    [from, to), or an explicit commit list (which replaces the range).
 *  - A path filter selects one file (exact) or a directory (prefix + "/%").
 *  - modifications = # commits with churn > 0 on the object; |H| is the size
 *    of the whole filtered commit set, regardless of what it touched.
 */

const COMMIT_LIST_LIMIT = 200;

export function listRepos(db: Db): RepoSummary[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.name, r.source_type, r.source_url, r.status, r.error,
              r.head_hash, r.created_at, r.ingested_at,
              (SELECT COUNT(*) FROM commits c WHERE c.repo_id = r.id AND c.is_merge = 0) AS commits,
              (SELECT COUNT(*) FROM authors a WHERE a.repo_id = r.id) AS authors
       FROM repositories r ORDER BY r.id DESC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    sourceType: r.source_type === "remote" ? "remote" : "zip",
    sourceUrl: (r.source_url as string) ?? null,
    status: r.status as RepoSummary["status"],
    error: (r.error as string) ?? null,
    headHash: (r.head_hash as string) ?? null,
    createdAt: String(r.created_at),
    ingestedAt: (r.ingested_at as string) ?? null,
    commits: Number(r.commits),
    authors: Number(r.authors),
  }));
}

export function getRepo(db: Db, id: number): RepoSummary | null {
  return listRepos(db).find((r) => r.id === id) ?? null;
}

export function listAuthors(db: Db, repoId: number): Author[] {
  return db
    .prepare("SELECT id, name, email FROM authors WHERE repo_id = ? ORDER BY name COLLATE NOCASE")
    .all(repoId) as Author[];
}

export function repoExists(db: Db, repoId: number): boolean {
  return !!db.prepare("SELECT 1 FROM repositories WHERE id = ?").get(repoId);
}

/** Escapes LIKE wildcards so repo paths containing % or _ match literally. */
function escapeLike(path: string): string {
  return path.replace(/[\\%_]/g, (c) => `\\${c}`);
}

type Scope = { where: string; params: unknown[] };

/** Commit-set scope: repo + non-merge + author + date range or manual list. */
function commitScope(repoId: number, f: MetricFilters): Scope {
  const clauses = ["c.repo_id = ?", "c.is_merge = 0"];
  const params: unknown[] = [repoId];
  if (f.authorId != null) {
    clauses.push("c.author_id = ?");
    params.push(f.authorId);
  }
  const hashes = (f.commitHashes ?? []).filter((h) => h.length > 0);
  if (hashes.length > 0) {
    // A manual selection replaces the date range ("or" in the brief).
    clauses.push(`c.hash IN (${hashes.map(() => "?").join(",")})`);
    params.push(...hashes);
  } else {
    if (f.from) {
      clauses.push("c.committer_date >= ?");
      params.push(f.from);
    }
    if (f.to) {
      clauses.push("c.committer_date < ?");
      params.push(f.to);
    }
  }
  return { where: clauses.join(" AND "), params };
}

/** Path scope on file_stats: exact file, or a directory prefix. */
function pathScope(f: MetricFilters): { where: string; params: unknown[] } {
  const p = f.path ?? "";
  if (p === "" || p === "/") return { where: "", params: [] };
  const prefix = p.endsWith("/") ? p : `${p}/`;
  return {
    where: "(fs.path = ? OR fs.path LIKE ? ESCAPE '\\')",
    params: [p, `${escapeLike(prefix)}%`],
  };
}

/**
 * Immediate-child expression: the first path segment beyond the selected
 * directory (the whole remaining path segments when it is a deeper file).
 * `rem` must be a select expression returning the path past the prefix.
 */
function childExpr(): string {
  return "substr(rem, 1, instr(rem || '/', '/') - 1)";
}

/** The selected object's own metrics over H (l+, l−, n, η, ρ). */
function summarize(row: Record<string, unknown>, setSize: number): CommitSetMetrics {
  const added = Number(row.added ?? 0);
  const removed = Number(row.removed ?? 0);
  const churn = added + removed;
  const modifications = Number(row.modifications ?? 0);
  return {
    setSize,
    added,
    removed,
    growth: added - removed,
    churn,
    modifications,
    modificationFrequency: setSize > 0 ? modifications / setSize : 0,
    churnRate: setSize > 0 ? churn / setSize : 0,
  };
}

export function getMetrics(
  db: Db,
  repoId: number,
  filters: MetricFilters = {},
): MetricsResponse {
  const scope = commitScope(repoId, filters);
  const path = pathScope(filters);
  const pathWhere = path.where ? ` AND ${path.where}` : "";

  const setSize = Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS n FROM commits c WHERE ${scope.where}`)
        .get(...scope.params) as { n: number }
    ).n,
  );

  // The object itself (repo root, a directory, or a single file).
  const objectRow = db
    .prepare(
      `SELECT COALESCE(SUM(fs.added), 0) AS added, COALESCE(SUM(fs.removed), 0) AS removed,
              COUNT(DISTINCT CASE WHEN fs.added + fs.removed > 0 THEN fs.commit_id END) AS modifications
       FROM file_stats fs JOIN commits c ON c.id = fs.commit_id
       WHERE ${scope.where}${pathWhere}`,
    )
    .get(...scope.params, ...path.params) as Record<string, unknown>;

  // Immediate children of the selected directory, aggregated recursively:
  // sums over the whole subtree, modifications deduplicated per commit.
  const childRows = db
    .prepare(
      `SELECT ${childExpr()} AS child,
              SUM(added) AS added, SUM(removed) AS removed,
              COUNT(DISTINCT CASE WHEN added + removed > 0 THEN commit_id END) AS modifications,
              MAX(CASE WHEN instr(rem, '/') > 0 THEN 1 ELSE 0 END) AS isdir
       FROM (
         SELECT fs.added, fs.removed, fs.commit_id, substr(fs.path, ?) AS rem
         FROM file_stats fs JOIN commits c ON c.id = fs.commit_id
         WHERE ${scope.where}${pathWhere}
       )
       GROUP BY child`,
    )
    .all(pathPrefixLength(filters), ...scope.params, ...path.params) as Record<string, unknown>[];

  const totalChurn = Number(objectRow.added ?? 0) + Number(objectRow.removed ?? 0);
  const children: ChildMetrics[] = childRows
    .map((r) => ({
      name: String(r.child),
      kind: Number(r.isdir) === 1 ? ("dir" as const) : ("file" as const),
      ...summarize(r, setSize),
    }))
    .sort((a, b) => b.churn - a.churn || a.name.localeCompare(b.name));

  // Per-author metrics within the same scope (churn, modifications, commits).
  const authorRows = db
    .prepare(
      `SELECT c.author_id AS id, a.name, a.email,
              COALESCE(SUM(fs.added + fs.removed), 0) AS churn,
              COUNT(DISTINCT CASE WHEN fs.added + fs.removed > 0 THEN fs.commit_id END) AS modifications,
              COUNT(DISTINCT fs.commit_id) AS commits
       FROM file_stats fs
       JOIN commits c ON c.id = fs.commit_id
       JOIN authors a ON a.id = c.author_id
       WHERE ${scope.where}${pathWhere}
       GROUP BY c.author_id`,
    )
    .all(...scope.params, ...path.params) as Record<string, unknown>[];

  const authors: AuthorMetrics[] = authorRows
    .map((r) => {
      const churn = Number(r.churn ?? 0);
      return {
        id: Number(r.id),
        name: String(r.name),
        email: String(r.email),
        commits: Number(r.commits ?? 0),
        churn,
        modifications: Number(r.modifications ?? 0),
        ownership: totalChurn > 0 ? churn / totalChurn : 0,
      };
    })
    .sort((a, b) => b.churn - a.churn || a.name.localeCompare(b.name));

  // The commit set itself, newest first. Path filter goes in the LEFT JOIN
  // ON clause so commits that did not touch the object still appear (0/0).
  const commitRows = db
    .prepare(
      `SELECT c.hash, c.summary, c.committer_date, a.name AS author_name,
              COALESCE(SUM(fs.added), 0) AS added, COALESCE(SUM(fs.removed), 0) AS removed
       FROM commits c
       JOIN authors a ON a.id = c.author_id
       LEFT JOIN file_stats fs ON fs.commit_id = c.id${path.where ? ` AND ${path.where}` : ""}
       WHERE ${scope.where}
       GROUP BY c.id
       ORDER BY c.committer_date DESC, c.id DESC
       LIMIT ?`,
    )
    .all(...path.params, ...scope.params, COMMIT_LIST_LIMIT + 1) as Record<string, unknown>[];

  const commits: CommitRow[] = commitRows.slice(0, COMMIT_LIST_LIMIT).map((r) => {
    const added = Number(r.added ?? 0);
    const removed = Number(r.removed ?? 0);
    return {
      hash: String(r.hash),
      summary: String(r.summary),
      committerDate: String(r.committer_date),
      authorName: String(r.author_name),
      added,
      removed,
      churn: added + removed,
    };
  });

  const isFile = isFilePath(db, repoId, filters);
  return {
    object: { path: filters.path ?? "", kind: isFile ? "file" : "dir" },
    summary: summarize(objectRow, setSize),
    children: isFile ? [] : children,
    authors,
    commits,
    commitsTruncated: commitRows.length > COMMIT_LIST_LIMIT,
  };
}

/** substr start position for the "remainder past the directory prefix". */
function pathPrefixLength(f: MetricFilters): number {
  const p = f.path ?? "";
  if (p === "" || p === "/") return 1; // substr(path, 1) = whole path
  const prefix = p.endsWith("/") ? p : `${p}/`;
  return prefix.length + 1;
}

/**
 * A path is a file exactly when a file_stats row exists with that path —
 * directories never have rows of their own (only files are measured).
 * A deleted file keeps its rows (removals are recorded on the old path),
 * so filtering by it still works, as the brief's H[F] definition requires.
 */
function isFilePath(db: Db, repoId: number, f: MetricFilters): boolean {
  const p = f.path ?? "";
  if (p === "" || p.endsWith("/")) return false;
  return !!db
    .prepare("SELECT 1 FROM file_stats WHERE repo_id = ? AND path = ? LIMIT 1")
    .get(repoId, p);
}
