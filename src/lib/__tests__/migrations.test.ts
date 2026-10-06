import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrate, openDatabase } from "@/lib/db";

// Throwaway databases only — per-test in-memory DBs, or file DBs under the
// gitignored .data/tests directory. Never dev.db.
function throwawayDir(prefix: string): string {
  const root = path.join(process.cwd(), ".data", "tests");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(path.join(root, `${prefix}-`));
}

function insertRepo(db: ReturnType<typeof openDatabase>, name: string): number {
  const result = db
    .prepare(
      "INSERT INTO repositories (name, source_type, created_at) VALUES (?, ?, ?)",
    )
    .run(name, "remote", new Date().toISOString());
  return Number(result.lastInsertRowid);
}

function insertAuthor(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  name: string,
  email: string,
  canonicalId: number | null = null,
): number {
  const result = db
    .prepare(
      "INSERT INTO authors (repo_id, name, email, canonical_id, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(repoId, name, email, canonicalId, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

describe("migrations", () => {
  it("applies all migrations in order to a fresh database", () => {
    const db = new Database(":memory:");
    const applied = migrate(db);

    expect(applied).toEqual([
      "001_repositories.sql",
      "002_authors.sql",
      "003_commits.sql",
      "004_file_stats.sql",
    ]);
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "_migrations",
        "authors",
        "commits",
        "file_stats",
        "repositories",
      ]),
    );
    const recorded = db.prepare("SELECT COUNT(*) AS n FROM _migrations").get() as {
      n: number;
    };
    expect(recorded.n).toBe(4);
    db.close();
  });

  it("is idempotent — a second run applies nothing", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(migrate(db)).toEqual([]);
    const n = db.prepare("SELECT COUNT(*) AS n FROM _migrations").get() as {
      n: number;
    };
    expect(n.n).toBe(4);
    db.close();
  });

  it("enforces foreign keys and CHECK constraints", () => {
    const db = openDatabase(":memory:");
    const now = new Date().toISOString();
    const repoId = insertRepo(db, "demo");
    const authorId = insertAuthor(db, repoId, "Alice", "alice@example.com");

    // commit referencing a missing author is rejected
    expect(() =>
      db
        .prepare(
          "INSERT INTO commits (repo_id, hash, parent_hash, author_id, committer_date, created_at) VALUES (?, ?, NULL, ?, ?, ?)",
        )
        .run(repoId, "f".repeat(40), authorId + 1000, now, now),
    ).toThrow(/FOREIGN KEY/);

    // invalid source_type is rejected
    expect(() =>
      db
        .prepare(
          "INSERT INTO repositories (name, source_type, created_at) VALUES (?, ?, ?)",
        )
        .run("bad", "tarball", now),
    ).toThrow(/CHECK/);

    // file_stats must reference an existing commit
    expect(() =>
      db
        .prepare(
          "INSERT INTO file_stats (repo_id, commit_id, path, added, removed) VALUES (?, ?, ?, ?, ?)",
        )
        .run(repoId, 999_999, "src/a.ts", 1, 0),
    ).toThrow(/FOREIGN KEY/);

    db.close();
  });

  it("resolves merged authors through canonical_id", () => {
    const db = openDatabase(":memory:");
    const repoId = insertRepo(db, "merge-demo");
    const canonicalId = insertAuthor(
      db,
      repoId,
      "Alice",
      "alice@example.com",
    );
    const aliasId = insertAuthor(
      db,
      repoId,
      "A. Writer",
      "awriter@old.example",
      canonicalId,
    );

    const commitId = db
      .prepare(
        "INSERT INTO commits (repo_id, hash, parent_hash, author_id, committer_date, created_at) VALUES (?, ?, NULL, ?, ?, ?)",
      )
      .run(repoId, "a".repeat(40), aliasId, "2026-01-15T10:00:00.000Z", new Date().toISOString())
      .lastInsertRowid;

    const resolved = db
      .prepare(
        `SELECT ca.email AS canonical_email
         FROM commits c
         JOIN authors a ON a.id = c.author_id
         JOIN authors ca ON ca.id = COALESCE(a.canonical_id, a.id)
         WHERE c.id = ?`,
      )
      .get(commitId) as { canonical_email: string };
    expect(resolved.canonical_email).toBe("alice@example.com");

    // a later manual merge is a single UPDATE to canonical_id — schema untouched
    const secondId = insertAuthor(db, repoId, "Alice Two", "alice2@example.com");
    db.prepare("UPDATE authors SET canonical_id = ? WHERE id = ?").run(
      canonicalId,
      secondId,
    );
    const count = db
      .prepare(
        `SELECT COUNT(DISTINCT COALESCE(canonical_id, id)) AS n FROM authors WHERE repo_id = ?`,
      )
      .get(repoId) as { n: number };
    expect(count.n).toBe(1);
    db.close();
  });

  it("rejects migration files that would remove data or schema", () => {
    const badFiles = [
      "CREATE TABLE IF NOT EXISTS t (id INTEGER);\nDELETE FROM repositories;",
      "DROP TABLE authors;",
    ];
    for (const sql of badFiles) {
      const dir = throwawayDir("guard");
      writeFileSync(path.join(dir, "001_bad.sql"), sql, "utf8");
      const db = new Database(":memory:");
      expect(() => migrate(db, dir)).toThrow(/forbidden/);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists across reopen on a throwaway file database", () => {
    const dir = throwawayDir("file");
    const dbPath = path.join(dir, "test.db");

    const db = openDatabase(dbPath);
    insertRepo(db, "persisted");
    db.close();

    const reopened = openDatabase(dbPath);
    const row = reopened
      .prepare("SELECT name, status FROM repositories WHERE name = ?")
      .get("persisted") as { name: string; status: string };
    expect(row).toEqual({ name: "persisted", status: "pending" });
    reopened.close();

    rmSync(dir, { recursive: true, force: true });
  });
});
