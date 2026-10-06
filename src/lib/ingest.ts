import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Db } from "./db";
import { streamRepoHistory } from "./git";

const execFileAsync = promisify(execFile);

export const REPOS_DIR = path.join(process.cwd(), ".data", "repos");

export type IngestSource =
  | { kind: "remote"; url: string }
  | { kind: "zip"; zipPath: string };

export type IngestOptions = {
  /** Display name; derived from the URL / file name when omitted. */
  name?: string;
  /** Where to place the cloned/extracted repository (tests use throwaways). */
  reposDir?: string;
  /** Timeout for `git clone` / zip extraction in milliseconds. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

function deriveName(source: IngestSource): string {
  if (source.kind === "zip") {
    return path.basename(source.zipPath).replace(/\.zip$/i, "");
  }
  const trimmed = source.url.replace(/\/+$/, "").replace(/\.git$/i, "");
  return trimmed.split("/").pop() || trimmed || source.url;
}

/**
 * Extracts the zip and returns the directory that contains `.git` (either
 * the extraction root or, for zips that wrap everything in one folder, that
 * single child directory). Info-ZIP `unzip` strips absolute paths and `..`
 * components, keeping extraction inside the destination directory.
 */
export async function extractZip(zipPath: string, destDir: string, timeoutMs: number): Promise<string> {
  await execFileAsync("unzip", ["-o", "-q", zipPath, "-d", destDir], {
    timeout: timeoutMs,
    maxBuffer: 1 << 26,
  });
  return locateGitRoot(destDir);
}

/** Finds the working-tree root containing `.git` (a directory or a file). */
export function locateGitRoot(extractedDir: string): string {
  if (existsSync(path.join(extractedDir, ".git"))) return extractedDir;
  const children = readdirSync(extractedDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(extractedDir, e.name));
  const matches = children.filter((c) => existsSync(path.join(c, ".git")));
  if (matches.length === 1) return matches[0];
  throw new Error(
    "uploaded archive does not contain a .git directory (zip the repository including its .git)",
  );
}

/**
 * Ingests a repository from a deep-cloned remote URL or a zip upload.
 * Creates the repositories row up front, moves it through
 * pending → ingesting → ready, and marks it failed (with the error) if
 * anything goes wrong. Resolves to the new repository id.
 */
export async function ingestRepository(
  db: Db,
  source: IngestSource,
  opts: IngestOptions = {},
): Promise<number> {
  const now = new Date().toISOString();
  const reposDir = opts.reposDir ?? REPOS_DIR;
  const info = db
    .prepare(
      "INSERT INTO repositories (name, source_type, source_url, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
    )
    .run(
      opts.name ?? deriveName(source),
      source.kind,
      source.kind === "remote" ? source.url : path.basename(source.zipPath),
      now,
    );
  const repoId = Number(info.lastInsertRowid);
  const repoDir = path.join(reposDir, String(repoId));
  const markFailed = db.prepare(
    "UPDATE repositories SET status = 'failed', error = ? WHERE id = ?",
  );

  try {
    mkdirSync(reposDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    db.prepare("UPDATE repositories SET status = 'ingesting' WHERE id = ?").run(repoId);

    let gitRoot: string;
    if (source.kind === "remote") {
      // Deep clone: no --depth, full history.
      await execFileAsync(
        "git",
        ["clone", source.url, repoDir],
        {
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: 1 << 26,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        },
      );
      gitRoot = repoDir;
    } else {
      gitRoot = await extractZip(source.zipPath, repoDir, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    }

    // Fails fast for empty repositories (no HEAD yet).
    const head = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: gitRoot })
    ).stdout.trim();

    await runPipeline(db, repoId, gitRoot);

    db.prepare(
      "UPDATE repositories SET status = 'ready', head_hash = ?, ingested_at = ? WHERE id = ?",
    ).run(head, new Date().toISOString(), repoId);
    return repoId;
  } catch (err) {
    markFailed.run(err instanceof Error ? err.message : String(err), repoId);
    throw err;
  }
}

/**
 * Streams `git log` once and writes authors, commits and file_stats inside a
 * single transaction — a repository becomes readable either fully ingested
 * or not at all.
 */
async function runPipeline(db: Db, repoId: number, gitRoot: string): Promise<void> {
  const now = new Date().toISOString();
  const selectAuthor = db.prepare(
    "SELECT id FROM authors WHERE repo_id = ? AND email = ?",
  );
  const insertAuthor = db.prepare(
    "INSERT INTO authors (repo_id, name, email, created_at) VALUES (?, ?, ?, ?)",
  );
  const insertCommit = db.prepare(
    "INSERT INTO commits (repo_id, hash, parent_hash, author_id, committer_date, summary, is_merge, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertStat = db.prepare(
    "INSERT INTO file_stats (repo_id, commit_id, path, added, removed) VALUES (?, ?, ?, ?, ?)",
  );
  const authorIds = new Map<string, number>();

  db.exec("BEGIN IMMEDIATE");
  try {
    for await (const record of streamRepoHistory(gitRoot)) {
      const { header, stats } = record;
      const email = header.authorEmail;
      let authorId = authorIds.get(email);
      if (authorId === undefined) {
        const existing = selectAuthor.get(repoId, email) as { id: number } | undefined;
        authorId = existing
          ? existing.id
          : Number(insertAuthor.run(repoId, header.authorName, email, now).lastInsertRowid);
        authorIds.set(email, authorId);
      }
      const commitId = Number(
        insertCommit.run(
          repoId,
          header.hash,
          header.parentHash,
          authorId,
          header.committerDate,
          header.summary,
          header.isMerge ? 1 : 0,
          now,
        ).lastInsertRowid,
      );
      for (const stat of stats) {
        // Binary files are never measured.
        if (stat.kind === "binary") continue;
        insertStat.run(repoId, commitId, stat.path, stat.added, stat.removed);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
