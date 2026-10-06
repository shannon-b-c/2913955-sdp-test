import { beforeAll, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "@/lib/db";
import { getMetrics } from "@/lib/metrics";

// Light checks of the metric definitions from the brief: sums, growth/churn,
// modifications, modification frequency, churn rate, author ownership, the
// half-open [i, j) date range, author filter, manual commit selection, and
// merge exclusion. Rows are inserted directly — no git involved.

let db: Db;
const repoId = 1;

const alice = { name: "Alice", email: "alice@example.com" };
const bob = { name: "Bob", email: "bob@example.com" };

let authorIds: Record<string, number> = {};
const hashes: Record<string, string> = {};

function insertAuthor(name: string, email: string): number {
  return Number(
    db
      .prepare("INSERT INTO authors (repo_id, name, email, created_at) VALUES (?, ?, ?, ?)")
      .run(repoId, name, email, "2026-01-01T00:00:00.000Z").lastInsertRowid,
  );
}

function insertCommit(
  hash: string,
  authorEmail: string,
  date: string,
  isMerge = false,
): void {
  db.prepare(
    "INSERT INTO commits (repo_id, hash, parent_hash, author_id, committer_date, summary, is_merge, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)",
  ).run(repoId, hash, authorIds[authorEmail], date, hash, isMerge ? 1 : 0, date);
}

function insertStat(commitHash: string, path: string, added: number, removed: number): void {
  const commit = db.prepare("SELECT id FROM commits WHERE hash = ?").get(commitHash) as {
    id: number;
  };
  db.prepare(
    "INSERT INTO file_stats (repo_id, commit_id, path, added, removed) VALUES (?, ?, ?, ?, ?)",
  ).run(repoId, commit.id, path, added, removed);
}

beforeAll(() => {
  db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO repositories (id, name, source_type, source_url, status, created_at) VALUES (?, ?, 'remote', 'x', 'ready', ?)",
  ).run(repoId, "fixture", "2026-01-01T00:00:00.000Z");
  authorIds = { alice: insertAuthor(alice.name, alice.email), bob: insertAuthor(bob.name, bob.email) };

  hashes.c1 = "c1".padEnd(40, "0");
  hashes.c2 = "c2".padEnd(40, "0");
  hashes.c3 = "c3".padEnd(40, "0");
  hashes.merge = "c4".padEnd(40, "0");
  hashes.c5 = "c5".padEnd(40, "0");

  insertCommit(hashes.c1, "alice", "2026-01-01T10:00:00.000Z");
  insertStat(hashes.c1, "src/a.txt", 5, 0);
  insertStat(hashes.c1, "src/lib/b.ts", 3, 0);

  insertCommit(hashes.c2, "bob", "2026-01-02T10:00:00.000Z");
  insertStat(hashes.c2, "src/a.txt", 1, 2);

  insertCommit(hashes.c3, "alice", "2026-01-03T10:00:00.000Z");
  insertStat(hashes.c3, "docs/r.md", 4, 0);

  // Merges are never measured — these rows must be invisible to every metric.
  insertCommit(hashes.merge, "bob", "2026-01-04T10:00:00.000Z", true);
  insertStat(hashes.merge, "src/a.txt", 9, 9);

  // Pure rename: the new path is in H[F] with a 0/0 row — no modifications.
  insertCommit(hashes.c5, "alice", "2026-01-05T10:00:00.000Z");
  insertStat(hashes.c5, "src/a.txt", 0, 0);
});

describe("getMetrics", () => {
  it("aggregates the repository root over immediate children", () => {
    const m = getMetrics(db, repoId);
    expect(m.object).toEqual({ path: "", kind: "dir" });
    // |H| = 4 non-merge commits; the merge commit is excluded everywhere.
    expect(m.summary.setSize).toBe(4);
    expect(m.summary.added).toBe(13);
    expect(m.summary.removed).toBe(2);
    expect(m.summary.growth).toBe(11);
    expect(m.summary.churn).toBe(15);
    // Modifications: c1, c2, c3 (c5 is a 0/0 rename). |H| = 4.
    expect(m.summary.modifications).toBe(3);
    expect(m.summary.modificationFrequency).toBeCloseTo(0.75);
    expect(m.summary.churnRate).toBeCloseTo(15 / 4);

    const byName = new Map(m.children.map((c) => [c.name, c]));
    expect([...byName.keys()].sort()).toEqual(["docs", "src"]);
    // src sums the whole subtree: a.txt (5+1 added, 2 removed) + lib/b.ts (3).
    expect(byName.get("src")).toMatchObject({ kind: "dir", added: 9, removed: 2, growth: 7, churn: 11, modifications: 2 });
    expect(byName.get("docs")).toMatchObject({ kind: "dir", added: 4, removed: 0, churn: 4, modifications: 1 });
  });

  it("computes file metrics and author ownership for a single file", () => {
    const m = getMetrics(db, repoId, { path: "src/a.txt" });
    expect(m.object).toEqual({ path: "src/a.txt", kind: "file" });
    expect(m.children).toEqual([]);
    expect(m.summary.added).toBe(6);
    expect(m.summary.removed).toBe(2);
    expect(m.summary.churn).toBe(8);
    expect(m.summary.modifications).toBe(2);

    const byEmail = new Map(m.authors.map((a) => [a.email, a]));
    // Alice: +5 (c1) and a 0/0 rename row (c5); Bob: +1 -2 (c2).
    expect(byEmail.get("alice@example.com")).toMatchObject({ churn: 5, modifications: 1, ownership: 5 / 8 });
    expect(byEmail.get("bob@example.com")).toMatchObject({ churn: 3, modifications: 1, ownership: 3 / 8 });
  });

  it("filters by author", () => {
    const m = getMetrics(db, repoId, { authorId: authorIds.bob });
    expect(m.summary.setSize).toBe(1); // the merge commit does not count
    expect(m.summary.added).toBe(1);
    expect(m.summary.removed).toBe(2);
    expect(m.children.map((c) => c.name)).toEqual(["src"]);
  });

  it("treats the committer-date range as half-open [from, to)", () => {
    const m = getMetrics(db, repoId, {
      from: "2026-01-02T10:00:00.000Z",
      to: "2026-01-04T10:00:00.000Z",
    });
    // c2 (at `from`, included), c3; c4 is at `to` (excluded) and a merge anyway.
    expect(m.summary.setSize).toBe(2);
    expect(m.summary.added).toBe(5);
    expect(m.summary.removed).toBe(2);
  });

  it("selects commits manually, ignoring unknown hashes", () => {
    const m = getMetrics(db, repoId, { commitHashes: [hashes.c1, "deadbeef".padEnd(40, "0")] });
    expect(m.summary.setSize).toBe(1);
    expect(m.summary.added).toBe(8);
    expect(m.summary.removed).toBe(0);
    expect(m.commits).toHaveLength(1);
  });

  it("lists the commit set newest-first with per-commit stats", () => {
    const m = getMetrics(db, repoId);
    expect(m.commits.map((c) => c.hash)).toEqual([hashes.c5, hashes.c3, hashes.c2, hashes.c1]);
    const c1 = m.commits.find((c) => c.hash === hashes.c1)!;
    expect(c1).toMatchObject({ added: 8, removed: 0, churn: 8, authorName: "Alice" });
    expect(m.commitsTruncated).toBe(false);
  });
});
