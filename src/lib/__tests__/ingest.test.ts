import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "@/lib/db";
import { ingestRepository } from "@/lib/ingest";

// Hermetic git: ignore any user/system config so fixture commits are
// reproducible no matter whose machine runs the tests.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

let root: string;
let fixture: string;
let hashes: Record<string, string>;

type Stat = { path: string; added: number; removed: number };

function git(dir: string, args: string[], env: Record<string, string> = {}) {
  execFileSync("git", args, { cwd: dir, env: { ...GIT_ENV, ...env } });
}

function commit(
  dir: string,
  message: string,
  identity: { name: string; email: string },
  date: string,
): string {
  git(dir, ["commit", "-m", message], {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir })
    .toString()
    .trim();
}

const alice = { name: "Alice", email: "alice@example.com" };
const bob = { name: "Bob", email: "bob@example.com" };
// Mailmapped to Bob — must never appear as its own author row.
const robert = { name: "Robert", email: "rob@old.example" };

function buildFixture(dir: string): Record<string, string> {
  const h: Record<string, string> = {};
  git(dir, ["init", "-q", "-b", "main"]);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  mkdirSync(path.join(dir, "assets"), { recursive: true });

  writeFileSync(path.join(dir, "src/app.txt"), "l1\nl2\nl3\nl4\nl5\n");
  writeFileSync(path.join(dir, "assets/logo.bin"), Buffer.from([0x00, 0x01, 0xff, 0x02]));
  git(dir, ["add", "-A"]);
  h.c1 = commit(dir, "initial", alice, "2026-01-01T12:00:00+02:00"); // → 10:00Z

  writeFileSync(path.join(dir, "src/app.txt"), "l1\nL2\nl3\nl4\nl5\nl6\n");
  git(dir, ["add", "-A"]);
  h.c2 = commit(dir, "edit app", bob, "2026-01-02T12:00:00+02:00");

  git(dir, ["mv", "src/app.txt", "src/renamed.txt"]);
  h.c3 = commit(dir, "pure rename", alice, "2026-01-03T12:00:00+02:00");

  mkdirSync(path.join(dir, "digits"), { recursive: true });
  git(dir, ["mv", "src/renamed.txt", "digits/9lives.txt"]);
  writeFileSync(
    path.join(dir, "digits/9lives.txt"),
    "L1\nL2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n",
  );
  git(dir, ["add", "-A"]);
  h.c4 = commit(dir, "rename and edit", robert, "2026-01-04T12:00:00+02:00");

  writeFileSync(path.join(dir, "gone.txt"), "g1\ng2\ng3\ng4\n");
  git(dir, ["add", "-A"]);
  h.c5 = commit(dir, "add gone", alice, "2026-01-05T12:00:00+02:00");

  git(dir, ["rm", "-q", "gone.txt"]);
  h.c6 = commit(dir, "remove gone", alice, "2026-01-06T12:00:00+02:00");

  git(dir, ["commit", "--allow-empty", "-q", "-m", "empty"], {
    GIT_AUTHOR_NAME: alice.name,
    GIT_AUTHOR_EMAIL: alice.email,
    GIT_COMMITTER_NAME: alice.name,
    GIT_COMMITTER_EMAIL: alice.email,
    GIT_AUTHOR_DATE: "2026-01-07T12:00:00+02:00",
    GIT_COMMITTER_DATE: "2026-01-07T12:00:00+02:00",
  });
  h.c7 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();

  git(dir, ["checkout", "-q", "-b", "feature"]);
  writeFileSync(path.join(dir, "feat.txt"), "f1\nf2\n");
  git(dir, ["add", "-A"]);
  h.c8 = commit(dir, "feat", bob, "2026-01-08T12:00:00+02:00");

  git(dir, ["checkout", "-q", "main"]);
  mkdirSync(path.join(dir, "docs"), { recursive: true });
  writeFileSync(path.join(dir, "docs/readme.txt"), "r1\n");
  git(dir, ["add", "-A"]);
  h.c9 = commit(dir, "docs", alice, "2026-01-09T12:00:00+02:00");

  git(dir, ["merge", "--no-ff", "-q", "feature", "-m", "merge feature"], {
    GIT_AUTHOR_NAME: alice.name,
    GIT_AUTHOR_EMAIL: alice.email,
    GIT_COMMITTER_NAME: alice.name,
    GIT_COMMITTER_EMAIL: alice.email,
    GIT_AUTHOR_DATE: "2026-01-10T12:00:00+02:00",
    GIT_COMMITTER_DATE: "2026-01-10T12:00:00+02:00",
  });
  h.c10 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();

  // Mailmap must be tracked so clones see it too (git resolves %aN/%aE from
  // the worktree's .mailmap; an untracked file would not survive `git clone`).
  writeFileSync(path.join(dir, ".mailmap"), "Bob <bob@example.com> Robert <rob@old.example>\n");
  git(dir, ["add", "-A"]);
  h.c11 = commit(dir, "add mailmap", alice, "2026-01-11T12:00:00+02:00");
  return h;
}

function statsFor(db: Db, repoId: number, hash: string): Stat[] {
  const commit = db
    .prepare("SELECT id FROM commits WHERE repo_id = ? AND hash = ?")
    .get(repoId, hash) as { id: number } | undefined;
  if (!commit) throw new Error(`commit ${hash} not ingested`);
  return db
    .prepare(
      "SELECT path, added, removed FROM file_stats WHERE commit_id = ? ORDER BY path",
    )
    .all(commit.id) as Stat[];
}

beforeAll(() => {
  root = mkdtempSync(path.join(process.cwd(), ".data", "tests", "ingest-"));
  fixture = path.join(root, "fixture");
  mkdirSync(fixture, { recursive: true });
  hashes = buildFixture(fixture);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ingestRepository (remote clone)", () => {
  let db: Db;
  let repoId: number;
  let reposDir: string;

  beforeAll(async () => {
    db = openDatabase(":memory:");
    reposDir = mkdtempSync(path.join(root, "repos-"));
    repoId = await ingestRepository(db, { kind: "remote", url: fixture }, { reposDir });
  });

  it("marks the repository ready with head hash and timestamps", () => {
    const repo = db.prepare("SELECT * FROM repositories WHERE id = ?").get(repoId) as {
      status: string;
      source_type: string;
      head_hash: string;
      ingested_at: string | null;
      name: string;
    };
    expect(repo.status).toBe("ready");
    expect(repo.source_type).toBe("remote");
    expect(repo.head_hash).toBe(hashes.c11);
    expect(repo.ingested_at).not.toBeNull();
    expect(repo.name).toBe(path.basename(fixture));
    // The cloned checkout lives beside its repository id.
    expect(existsSync(path.join(reposDir, String(repoId), ".git"))).toBe(true);
  });

  it("mailmap-merges authors at ingest time", () => {
    const authors = db
      .prepare("SELECT name, email, canonical_id FROM authors WHERE repo_id = ?")
      .all(repoId) as { name: string; email: string; canonical_id: number | null }[];
    expect(authors.map((a) => a.email).sort()).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);
    expect(authors.every((a) => a.canonical_id === null)).toBe(true);
    // The renamed+edited commit was authored as Robert — attributed to Bob.
    const c4 = db.prepare("SELECT author_id FROM commits WHERE hash = ?").get(hashes.c4) as {
      author_id: number;
    };
    const author = db.prepare("SELECT name, email FROM authors WHERE id = ?").get(c4.author_id) as {
      name: string;
      email: string;
    };
    expect(author).toEqual({ name: "Bob", email: "bob@example.com" });
  });

  it("stores the full history with merge flags and normalized UTC dates", () => {
    const commits = db
      .prepare("SELECT hash, parent_hash, is_merge, committer_date FROM commits WHERE repo_id = ?")
      .all(repoId) as {
      hash: string;
      parent_hash: string | null;
      is_merge: number;
      committer_date: string;
    }[];
    expect(commits).toHaveLength(11);
    const byHash = new Map(commits.map((c) => [c.hash, c]));
    expect(byHash.get(hashes.c10)!.is_merge).toBe(1);
    expect(byHash.get(hashes.c9)!.is_merge).toBe(0);
    expect(byHash.get(hashes.c2)!.parent_hash).toBe(hashes.c1);
    expect(byHash.get(hashes.c1)!.parent_hash).toBeNull();
    expect(byHash.get(hashes.c1)!.committer_date).toBe("2026-01-01T10:00:00.000Z");
  });

  it("records file metrics exactly per the brief", () => {
    expect(statsFor(db, repoId, hashes.c1)).toEqual([
      { path: "src/app.txt", added: 5, removed: 0 },
    ]);
    expect(statsFor(db, repoId, hashes.c2)).toEqual([
      { path: "src/app.txt", added: 2, removed: 1 },
    ]);
    // Pure rename: a 0/0 row on the new path, nothing on the old path.
    expect(statsFor(db, repoId, hashes.c3)).toEqual([
      { path: "src/renamed.txt", added: 0, removed: 0 },
    ]);
    // Rename + edit: only the edit counts, attributed to the new path.
    expect(statsFor(db, repoId, hashes.c4)).toEqual([
      { path: "digits/9lives.txt", added: 4, removed: 1 },
    ]);
    expect(statsFor(db, repoId, hashes.c5)).toEqual([{ path: "gone.txt", added: 4, removed: 0 }]);
    // Deletion: removed lines recorded on the old path.
    expect(statsFor(db, repoId, hashes.c6)).toEqual([{ path: "gone.txt", added: 0, removed: 4 }]);
    // Empty commit: no stats.
    expect(statsFor(db, repoId, hashes.c7)).toEqual([]);
    expect(statsFor(db, repoId, hashes.c8)).toEqual([{ path: "feat.txt", added: 2, removed: 0 }]);
    expect(statsFor(db, repoId, hashes.c9)).toEqual([
      { path: "docs/readme.txt", added: 1, removed: 0 },
    ]);
    // Merge commit: flagged, but never measured.
    expect(statsFor(db, repoId, hashes.c10)).toEqual([]);
    expect(statsFor(db, repoId, hashes.c11)).toEqual([
      { path: ".mailmap", added: 1, removed: 0 },
    ]);
    // Binary files are never measured.
    const binary = db
      .prepare("SELECT COUNT(*) AS n FROM file_stats WHERE path LIKE '%logo.bin%'")
      .get() as { n: number };
    expect(binary.n).toBe(0);
  });
});

describe("ingestRepository (zip upload)", () => {
  it("ingests a zip whose entries sit at the archive root", async () => {
    const zipPath = path.join(root, "flat.zip");
    execFileSync("zip", ["-rq", zipPath, "."], { cwd: fixture });
    const db = openDatabase(":memory:");
    const repoId = await ingestRepository(db, { kind: "zip", zipPath }, { reposDir: mkdtempSync(path.join(root, "zip-")) });
    const repo = db.prepare("SELECT status, source_type, name FROM repositories WHERE id = ?").get(repoId) as {
      status: string;
      source_type: string;
      name: string;
    };
    expect(repo.status).toBe("ready");
    expect(repo.source_type).toBe("zip");
    expect(repo.name).toBe("flat");
    expect(statsFor(db, repoId, hashes.c3)).toEqual([
      { path: "src/renamed.txt", added: 0, removed: 0 },
    ]);
    const authors = db.prepare("SELECT email FROM authors WHERE repo_id = ?").all(repoId) as {
      email: string;
    }[];
    expect(authors).toHaveLength(2);
  });

  it("ingests a zip that wraps the repository in one folder", async () => {
    const zipPath = path.join(root, "wrapped.zip");
    execFileSync("zip", ["-rq", zipPath, path.basename(fixture)], { cwd: path.dirname(fixture) });
    const db = openDatabase(":memory:");
    const repoId = await ingestRepository(db, { kind: "zip", zipPath }, { reposDir: mkdtempSync(path.join(root, "zip-")) });
    expect(statsFor(db, repoId, hashes.c4)).toEqual([
      { path: "digits/9lives.txt", added: 4, removed: 1 },
    ]);
  });

  it("fails cleanly when the zip has no .git", async () => {
    const plain = path.join(root, "plain");
    mkdirSync(plain, { recursive: true });
    writeFileSync(path.join(plain, "note.txt"), "no git here");
    const zipPath = path.join(root, "plain.zip");
    execFileSync("zip", ["-rqj", zipPath, "."], { cwd: plain });
    const db = openDatabase(":memory:");
    const reposDir = mkdtempSync(path.join(root, "zip-"));
    await expect(
      ingestRepository(db, { kind: "zip", zipPath }, { reposDir }),
    ).rejects.toThrow(/\.git/);
    const repo = db.prepare("SELECT status, error FROM repositories").get() as {
      status: string;
      error: string | null;
    };
    expect(repo.status).toBe("failed");
    expect(repo.error).toMatch(/\.git/);
  });
});

describe("ingestRepository (failures)", () => {
  it("marks an empty repository as failed", async () => {
    const empty = path.join(root, "empty");
    mkdirSync(empty, { recursive: true });
    git(empty, ["init", "-q", "-b", "main"]);
    const db = openDatabase(":memory:");
    const reposDir = mkdtempSync(path.join(root, "repos-"));
    await expect(
      ingestRepository(db, { kind: "remote", url: empty }, { reposDir }),
    ).rejects.toThrow(/HEAD/);
    const repo = db.prepare("SELECT status, error FROM repositories").get() as {
      status: string;
      error: string | null;
    };
    expect(repo.status).toBe("failed");
    expect(repo.error).toMatch(/HEAD/);
  });
});
