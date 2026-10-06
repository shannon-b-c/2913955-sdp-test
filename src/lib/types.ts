// Shared API/data types, safe to import from client components.

export type RepoStatus = "pending" | "ingesting" | "ready" | "failed";

export type RepoSummary = {
  id: number;
  name: string;
  sourceType: "zip" | "remote";
  sourceUrl: string | null;
  status: RepoStatus;
  error: string | null;
  headHash: string | null;
  createdAt: string;
  ingestedAt: string | null;
  /** Non-merge commits reachable from HEAD (the analysis set H̄). */
  commits: number;
  authors: number;
};

export type Author = { id: number; name: string; email: string };

/** Filters narrowing the commit set H (all optional except the repo). */
export type MetricFilters = {
  /** Only commits authored by this author. */
  authorId?: number | null;
  /** A directory ("" = root) or an exact file path. */
  path?: string | null;
  /** Inclusive committer date (ISO). */
  from?: string | null;
  /** Exclusive committer date (ISO) — the brief's half-open [i, j). */
  to?: string | null;
  /** Manually selected commits; when non-empty it replaces the date range. */
  commitHashes?: string[] | null;
};

/** Metrics of an object (file or directory) over a commit set H. */
export type CommitSetMetrics = {
  /** |H| — commits in the filtered set (denominator for the rates). */
  setSize: number;
  added: number;
  removed: number;
  growth: number;
  churn: number;
  /** Commits in H with at least some change on the object. */
  modifications: number;
  modificationFrequency: number;
  churnRate: number;
};

export type ChildMetrics = CommitSetMetrics & {
  name: string;
  kind: "file" | "dir";
};

export type AuthorMetrics = {
  id: number;
  name: string;
  email: string;
  /** Commits in H (by this author) that touched the object. */
  commits: number;
  churn: number;
  modifications: number;
  /** Author churn ÷ total churn on the object (0 when churn is 0). */
  ownership: number;
};

export type CommitRow = {
  hash: string;
  summary: string;
  committerDate: string;
  authorName: string;
  added: number;
  removed: number;
  churn: number;
};

export type MetricsResponse = {
  object: { path: string; kind: "file" | "dir" };
  summary: CommitSetMetrics;
  /** Immediate children of the selected directory (empty for a file). */
  children: ChildMetrics[];
  authors: AuthorMetrics[];
  /** The commit set, newest first; capped with `commitsTruncated`. */
  commits: CommitRow[];
  commitsTruncated: boolean;
};
