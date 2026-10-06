import { getDb } from "@/lib/db";
import { getRepo } from "@/lib/metrics";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const repo = getRepo(getDb(), Number(id));
  if (!repo) return Response.json({ error: "repository not found" }, { status: 404 });
  return Response.json(repo);
}
