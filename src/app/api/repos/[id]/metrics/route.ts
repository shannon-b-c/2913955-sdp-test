import { getDb } from "@/lib/db";
import { getMetrics, repoExists } from "@/lib/metrics";
import type { MetricFilters } from "@/lib/types";

function parseFilters(url: URL): MetricFilters {
  const authorId = Number(url.searchParams.get("authorId"));
  const commits = (url.searchParams.get("commits") ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  return {
    authorId: Number.isInteger(authorId) && authorId > 0 ? authorId : null,
    path: url.searchParams.get("path") ?? "",
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
    commitHashes: commits.length > 0 ? commits : null,
  };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const repoId = Number(id);
  if (!repoExists(getDb(), repoId)) {
    return Response.json({ error: "repository not found" }, { status: 404 });
  }
  return Response.json(getMetrics(getDb(), repoId, parseFilters(new URL(req.url))));
}
