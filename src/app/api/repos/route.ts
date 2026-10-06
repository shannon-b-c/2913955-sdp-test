import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getDb } from "@/lib/db";
import {
  createRepository,
  deriveName,
  ingestInto,
  UPLOADS_DIR,
} from "@/lib/ingest";
import { listRepos } from "@/lib/metrics";

export async function GET() {
  return Response.json(listRepos(getDb()));
}

const REMOTE_URL_PATTERN = /^(https?:\/\/|git@|ssh:\/\/)\S+$/;

/**
 * Starts ingesting a repository. Responds with the id as soon as the pending
 * row exists; the actual clone/extraction/parse continues in the background
 * and its outcome is visible through GET /api/repos/[id] status polling.
 */
export async function POST(req: Request) {
  const db = getDb();
  try {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0) {
        return Response.json({ error: "a zip file is required" }, { status: 400 });
      }
      const name =
        (form.get("name") as string | null)?.trim() ||
        file.name.replace(/\.zip$/i, "");
      const repoId = createRepository(db, { kind: "zip", zipPath: "-" }, {
        name,
        sourceUrl: file.name,
      });
      mkdirSync(UPLOADS_DIR, { recursive: true });
      const zipPath = path.join(UPLOADS_DIR, `${repoId}.zip`);
      writeFileSync(zipPath, Buffer.from(await file.arrayBuffer()));
      void ingestInto(db, repoId, { kind: "zip", zipPath }).catch(() => {});
      return Response.json({ id: repoId }, { status: 201 });
    }

    const body = (await req.json()) as { url?: unknown; name?: unknown };
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!REMOTE_URL_PATTERN.test(url)) {
      return Response.json(
        { error: "a remote URL starting with https://, http://, ssh:// or git@ is required" },
        { status: 400 },
      );
    }
    const name =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : deriveName({ kind: "remote", url });
    const repoId = createRepository(db, { kind: "remote", url }, { name });
    void ingestInto(db, repoId, { kind: "remote", url }).catch(() => {});
    return Response.json({ id: repoId }, { status: 201 });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "invalid request" },
      { status: 400 },
    );
  }
}
