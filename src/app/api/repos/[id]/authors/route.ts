import { getDb } from "@/lib/db";
import { listAuthors, repoExists } from "@/lib/metrics";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const repoId = Number(id);
  if (!repoExists(getDb(), repoId)) {
    return Response.json({ error: "repository not found" }, { status: 404 });
  }
  return Response.json(listAuthors(getDb(), repoId));
}
