import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export type Db = Database.Database;

export const DEFAULT_DB_PATH =
  process.env.RAT_DB_PATH ?? path.join(process.cwd(), "dev.db");

const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");

// Migrations only ever add schema. Any file containing a statement that
// removes or rewrites schema/data is rejected before it can run.
const FORBIDDEN_MIGRATION_PATTERN = /\b(delete|drop)\b/i;

export type MigrationFile = { name: string; sql: string };

export function readMigrationFiles(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(path.join(dir, name), "utf8") }));
}

/**
 * Applies every pending migration in filename order, each in its own
 * transaction, recorded in the `_migrations` table. Returns the names
 * of migrations applied by this call.
 */
export function migrate(db: Db, migrationsDir: string = MIGRATIONS_DIR): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    );
  `);
  const appliedRows = db.prepare("SELECT name FROM _migrations").all() as {
    name: string;
  }[];
  const applied = new Set(appliedRows.map((r) => r.name));
  const record = db.prepare(
    "INSERT INTO _migrations (name, applied_at) VALUES (?, ?)",
  );

  const appliedNow: string[] = [];
  for (const { name, sql } of readMigrationFiles(migrationsDir)) {
    if (applied.has(name)) continue;
    if (FORBIDDEN_MIGRATION_PATTERN.test(sql)) {
      throw new Error(
        `Migration "${name}" contains a forbidden statement (migrations only add schema).`,
      );
    }
    db.transaction(() => {
      db.exec(sql);
      record.run(name, new Date().toISOString());
    })();
    appliedNow.push(name);
  }
  return appliedNow;
}

/**
 * Opens the database (WAL, foreign keys on) with all pending migrations
 * applied automatically on startup. Tests pass their own throwaway path or
 * ":memory:" — never the dev database.
 */
export function openDatabase(dbPath: string = DEFAULT_DB_PATH): Db {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

// One database connection per server process, shared across route handlers
// (survives dev-mode module reloads via globalThis).
const globalStore = globalThis as unknown as { __ratDb?: Db };

/** Server-side singleton for API route handlers. Never import from client code. */
export function getDb(): Db {
  if (!globalStore.__ratDb) globalStore.__ratDb = openDatabase();
  return globalStore.__ratDb;
}
