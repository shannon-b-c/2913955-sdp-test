import { describe, expect, it } from "vitest";
import { GitLogParser, normalizeIso } from "@/lib/git";

function header(
  hash: string,
  parents: string,
  name: string,
  email: string,
  date: string,
  subject: string,
): Buffer {
  // utf8, not latin1: non-ASCII names/paths must be valid UTF-8 on the wire.
  return Buffer.from(
    `\x00${hash}\x1f${parents}\x1f${name}\x1f${email}\x1f${date}\x1f${subject}\x01\x00\n`,
    "utf8",
  );
}

function textEntry(added: number | string, removed: number | string, path: string): Buffer {
  return Buffer.from(`${added}\t${removed}\t${path}\0`, "utf8");
}

function renameEntry(
  added: number | string,
  removed: number | string,
  from: string,
  to: string,
): Buffer {
  return Buffer.from(`${added}\t${removed}\t\0${from}\0${to}\0`, "utf8");
}

function parseAll(chunks: Buffer[]): ReturnType<GitLogParser["finish"]> {
  const parser = new GitLogParser();
  const out: ReturnType<GitLogParser["finish"]> = [];
  for (const chunk of chunks) out.push(...parser.push(chunk));
  out.push(...parser.finish());
  return out;
}

const H1 = "a".repeat(40);
const H2 = "b".repeat(40);

describe("GitLogParser", () => {
  it("parses rename, binary and text entries in one record", () => {
    const stream = Buffer.concat([
      header(H1, H2, "Alice", "alice@example.com", "2026-01-01T12:00:00+02:00", "mixed commit"),
      renameEntry(0, 0, "old.txt", "new.txt"),
      textEntry("-", "-", "logo.bin"),
      textEntry(3, 1, "src/app.txt"),
    ]);
    const [record] = parseAll([stream]);
    expect(record.header).toMatchObject({
      hash: H1,
      parentHash: H2,
      isMerge: false,
      authorName: "Alice",
      authorEmail: "alice@example.com",
      committerDate: "2026-01-01T10:00:00.000Z",
      summary: "mixed commit",
    });
    expect(record.stats).toEqual([
      { kind: "text", path: "new.txt", from: "old.txt", added: 0, removed: 0 },
      { kind: "binary", path: "logo.bin" },
      { kind: "text", path: "src/app.txt", added: 3, removed: 1 },
    ]);
  });

  it("handles empty commits and merges (headers without entries)", () => {
    const stream = Buffer.concat([
      header(H1, "", "A", "a@e.com", "2026-01-01T00:00:00Z", "empty"),
      header(H2, `${H1} cdef0000000000000000000000000000000000ab`, "A", "a@e.com", "2026-01-02T00:00:00Z", "merge"),
    ]);
    const records = parseAll([stream]);
    expect(records).toHaveLength(2);
    expect(records[0].stats).toEqual([]);
    expect(records[1].header.isMerge).toBe(true);
    expect(records[1].header.parentHash).toBe(H1);
    expect(records[1].stats).toEqual([]);
  });

  it("is chunk-boundary safe (byte-by-byte delivery)", () => {
    const stream = Buffer.concat([
      header(H1, H2, "Ünicode Name", "u@e.com", "2026-01-01T00:00:00Z", "sübject — em dash"),
      renameEntry(4, 2, "docs/old dir/fröm.txt", "2new/9lives.txt"),
      textEntry(1, 0, "naïve.txt"),
    ]);
    const expected = parseAll([stream]);
    const actual = parseAll([...stream].map((b) => Buffer.from([b])));
    expect(actual).toEqual(expected);
    expect(actual[0].stats[0]).toEqual({
      kind: "text",
      path: "2new/9lives.txt",
      from: "docs/old dir/fröm.txt",
      added: 4,
      removed: 2,
    });
  });

  it("is not fooled by paths made of hex characters", () => {
    const hexPath = "abcdef0123456789abcdef0123456789abcdef01";
    const stream = Buffer.concat([
      header(H1, H2, "A", "a@e.com", "2026-01-01T00:00:00Z", "hexy"),
      renameEntry(0, 0, "old.txt", hexPath), // rename target looks like a header hash
      header(H2, H1, "A", "a@e.com", "2026-01-02T00:00:00Z", "next"),
      textEntry(2, 2, hexPath), // normal path looks like a header hash
    ]);
    const records = parseAll([stream]);
    expect(records).toHaveLength(2);
    expect(records[0].stats[0]).toMatchObject({ kind: "text", path: hexPath, from: "old.txt" });
    expect(records[1].stats[0]).toMatchObject({ kind: "text", path: hexPath, added: 2, removed: 2 });
  });

  it("normalizes committer dates to UTC ISO", () => {
    expect(normalizeIso("2026-01-01T12:00:00+02:00")).toBe("2026-01-01T10:00:00.000Z");
    expect(normalizeIso("2005-04-07T22:13:13-07:00")).toBe("2005-04-08T05:13:13.000Z");
    expect(() => normalizeIso("not-a-date")).toThrow(/invalid committer date/);
  });

  it("throws on corrupt streams at end of input", () => {
    const parser = new GitLogParser();
    parser.push(Buffer.from("garbage without headers"));
    expect(() => parser.finish()).toThrow(/expected commit header/);
  });
});
