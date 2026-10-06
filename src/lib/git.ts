import { spawn } from "node:child_process";

export type CommitHeader = {
  hash: string;
  parentHash: string | null;
  isMerge: boolean;
  authorName: string;
  authorEmail: string;
  /** Committer date, normalized to ISO 8601 UTC (all time filtering uses it). */
  committerDate: string;
  summary: string;
};

/**
 * One changed file from `git log --numstat`. Pure renames keep added/removed
 * at 0 and carry `from`; binary files are reported so the caller can skip
 * them (the brief forbids measuring binary files).
 */
export type NumStat =
  | { kind: "text"; path: string; added: number; removed: number; from?: string }
  | { kind: "binary"; path: string };

export type CommitRecord = { header: CommitHeader; stats: NumStat[] };

/** Normalize a git ISO date (%cI, with offset) to ISO 8601 UTC. */
export function normalizeIso(date: string): string {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid committer date: ${JSON.stringify(date)}`);
  }
  return d.toISOString();
}

/**
 * Incremental parser for:
 *   git log --numstat -z -M50% --format=%x00%H%x1f%P%x1f%aN%x1f%aE%x1f%cI%x1f%s%x01
 *
 * Wire format (verified empirically against git 2.43):
 *   record := '\0' hash40 '\x1f' parents '\x1f' name '\x1f' email '\x1f' date '\x1f' subject '\x01' '\0'? '\n'? entry*
 *   entry  := count TAB count TAB ( path NUL                -- normal or binary ("- -")
 *                                  | NUL from NUL to NUL )  -- rename; the empty
 *                                                            first token is the marker
 * Headers start with NUL + exactly 40 lowercase hex + 0x1f, which can never
 * occur inside an entry, so the framing is unambiguous even for paths made of
 * hex characters. All multi-byte safety comes from parsing raw bytes and only
 * decoding complete fields as UTF-8.
 */
export class GitLogParser {
  private buf: Buffer = Buffer.alloc(0);
  private pos = 0;
  private state: "header" | "entries" = "header";
  private pending: CommitRecord | null = null;

  /** Feed a chunk; returns every record completed by it. */
  push(chunk: Buffer): CommitRecord[] {
    this.buf =
      this.pos === 0
        ? Buffer.concat([this.buf, chunk])
        : Buffer.concat([this.buf.subarray(this.pos), chunk]);
    this.pos = 0;
    return this.drain(false);
  }

  /** Call at end of stream; returns the final record. */
  finish(): CommitRecord[] {
    return this.drain(true);
  }

  private available(): number {
    return this.buf.length - this.pos;
  }

  private isHeaderAt(p: number): boolean {
    if (this.buf.length - p < 42) return false;
    if (this.buf[p] !== 0x00 || this.buf[p + 41] !== 0x1f) return false;
    for (let i = 1; i <= 40; i++) {
      const c = this.buf[p + i];
      const isHex = (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66);
      if (!isHex) return false;
    }
    return true;
  }

  private findByte(from: number, byte: number): number {
    for (let i = from; i < this.buf.length; i++) {
      if (this.buf[i] === byte) return i;
    }
    return -1;
  }

  private drain(atEof: boolean): CommitRecord[] {
    const out: CommitRecord[] = [];
    for (;;) {
      if (this.state === "header") {
        if (!this.isHeaderAt(this.pos)) {
          if (!atEof && this.available() < 42) return out; // wait for more bytes
          throw new Error("corrupt git log stream: expected commit header");
        }
        // Fields start right after the leading NUL: hash at +1 .. +40, first
        // 0x1f separator at +41 (hex can never contain 0x01 or 0x1f).
        const headerEnd = this.findByte(this.pos + 1, 0x01);
        if (headerEnd === -1) {
          if (!atEof) return out; // header fields split across chunks
          throw new Error("corrupt git log stream: unterminated commit header");
        }
        const parts = this.buf.toString("utf8", this.pos + 1, headerEnd).split("\x1f");
        if (parts.length < 6) {
          throw new Error("corrupt git log stream: malformed commit header");
        }
        const parents = parts[1];
        const header: CommitHeader = {
          hash: parts[0],
          parentHash: parents.length > 0 ? (parents.split(" ")[0] || null) : null,
          isMerge: parents.includes(" "),
          authorName: parts[2],
          authorEmail: parts[3],
          committerDate: normalizeIso(parts[4]),
          summary: parts.slice(5).join("\x1f"),
        };
        if (this.pending) out.push(this.pending);
        this.pending = { header, stats: [] };
        this.pos = headerEnd + 1;
        this.state = "entries";
      } else {
        // Skip the -z record separators — a NUL, plus a newline when the
        // record has entries — before the first entry, but never swallow the
        // NUL that starts the next record's header. A separator NUL is
        // followed by \n or by the next header's NUL; a header NUL is
        // followed by hex. This must run on every drain because a chunk can
        // split the separator from the bytes that identify it.
        while (this.pos < this.buf.length) {
          const b = this.buf[this.pos];
          if (b === 0x0a) { this.pos++; continue; }
          if (b !== 0x00) break;
          if (this.isHeaderAt(this.pos)) break;
          if (this.available() < 2) {
            // Not enough bytes to tell a separator from a header NUL.
            if (!atEof) return out;
            throw new Error("corrupt git log stream: truncated record separator");
          }
          const next = this.buf[this.pos + 1];
          if (next === 0x0a || next === 0x00) { this.pos++; continue; } // separator
          if (this.available() < 42) {
            // Hex follows the NUL: a header split across chunks.
            if (!atEof) return out;
            throw new Error("corrupt git log stream: expected commit header");
          }
          throw new Error("corrupt git log stream: unexpected NUL in stat block");
        }
        if (this.available() === 0) {
          if (atEof && this.pending) {
            out.push(this.pending);
            this.pending = null;
          }
          return out;
        }
        if (this.isHeaderAt(this.pos)) {
          this.state = "header";
          continue;
        }
        if (!atEof && this.available() < 42 && !this.isHeaderAt(this.pos)) {
          // Not enough bytes to rule out a header split across chunks.
          return out;
        }
        const addedEnd = this.findByte(this.pos, 0x09);
        if (addedEnd === -1) {
          if (!atEof) return out;
          throw new Error("corrupt git log stream: unterminated numstat entry");
        }
        const addedStr = this.buf.toString("latin1", this.pos, addedEnd);
        const removedEnd = this.findByte(addedEnd + 1, 0x09);
        if (removedEnd === -1) {
          if (!atEof) return out;
          throw new Error("corrupt git log stream: unterminated numstat entry");
        }
        const removedStr = this.buf.toString("latin1", addedEnd + 1, removedEnd);
        let p = removedEnd + 1;
        const firstEnd = this.findByte(p, 0x00);
        if (firstEnd === -1) {
          if (!atEof) return out;
          throw new Error("corrupt git log stream: unterminated numstat path");
        }
        const first = this.buf.toString("utf8", p, firstEnd);
        p = firstEnd + 1;

        let stat: NumStat;
        if (first === "") {
          // Rename: NUL from NUL to NUL. Edits are attributed to the new path.
          const fromEnd = this.findByte(p, 0x00);
          if (fromEnd === -1) {
            if (!atEof) return out;
            throw new Error("corrupt git log stream: unterminated rename source");
          }
          const from = this.buf.toString("utf8", p, fromEnd);
          p = fromEnd + 1;
          const toEnd = this.findByte(p, 0x00);
          if (toEnd === -1) {
            if (!atEof) return out;
            throw new Error("corrupt git log stream: unterminated rename target");
          }
          const to = this.buf.toString("utf8", p, toEnd);
          p = toEnd + 1;
          stat = { kind: "text", path: to, from, added: count(addedStr), removed: count(removedStr) };
        } else if (addedStr === "-" && removedStr === "-") {
          stat = { kind: "binary", path: first };
        } else {
          stat = { kind: "text", path: first, added: count(addedStr), removed: count(removedStr) };
        }
        this.pending?.stats.push(stat);
        this.pos = p;
      }
    }
  }
}

function count(s: string): number {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`corrupt git log stream: bad line count ${JSON.stringify(s)}`);
  }
  return n;
}

const LOG_ARGS = [
  "log",
  "--numstat",
  "-z",
  "-M50%",
  "--format=%x00%H%x1f%P%x1f%aN%x1f%aE%x1f%cI%x1f%s%x01",
  "HEAD",
];

/**
 * Streams every commit reachable from HEAD (merges included; they simply
 * carry no stats). Author name/email are mailmap-resolved via %aN/%aE.
 */
export async function* streamRepoHistory(
  repoDir: string,
): AsyncGenerator<CommitRecord> {
  const child = spawn("git", LOG_ARGS, {
    cwd: repoDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    if (stderr.length < 8192) stderr += d.toString("utf8");
  });
  const parser = new GitLogParser();
  try {
    for await (const chunk of child.stdout) {
      for (const record of parser.push(chunk as Buffer)) yield record;
    }
    const code = await new Promise<number | null>((resolve) =>
      child.once("close", (c) => resolve(c)),
    );
    if (code !== 0) {
      throw new Error(`git log failed with code ${code}: ${stderr.trim()}`);
    }
    for (const record of parser.finish()) yield record;
  } finally {
    // If the consumer stops early, make sure git does not linger.
    child.kill();
  }
}
