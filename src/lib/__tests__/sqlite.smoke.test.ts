import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

// Toolchain smoke test: the DB driver must open, migrate-style DDL,
// and prepared statements all work in this Node environment.
describe("better-sqlite3", () => {
  it("opens an in-memory database and runs prepared statements", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
    insert.run("a");
    insert.run("b");
    const row = db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number };
    expect(row.n).toBe(2);
    db.close();
  });
});
