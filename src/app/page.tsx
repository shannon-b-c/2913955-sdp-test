"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  CircleAlert,
  File,
  Folder,
  GitCommitHorizontal,
  Loader2,
  Moon,
  RefreshCcw,
  Sun,
  X,
} from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { AddRepoDialog } from "@/components/add-repo-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  Author,
  MetricsResponse,
  RepoSummary,
} from "@/lib/types";

const fmtInt = new Intl.NumberFormat("en-US");

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function fmtRate(value: number): string {
  return value.toFixed(2);
}

/** Local calendar date -> ISO instant at local midnight (or next midnight). */
function localDateToIso(dateStr: string, exclusive: boolean): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = exclusive ? new Date(y, m - 1, d + 1) : new Date(y, m - 1, d);
  return date.toISOString();
}

type Filters = {
  authorId: number | null;
  path: string;
  from: string; // YYYY-MM-DD or ""
  to: string; // YYYY-MM-DD or ""
};

const EMPTY_FILTERS: Filters = { authorId: null, path: "", from: "", to: "" };

export default function Dashboard() {
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [repoId, setRepoId] = useState<number | null>(null);
  const [authors, setAuthors] = useState<Author[]>([]);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [selectedCommits, setSelectedCommits] = useState<string[]>([]);
  const [fetched, setFetched] = useState<{
    repoId: number;
    key: string;
    data: MetricsResponse;
  } | null>(null);

  // Reset per-repository state when the selection changes. Adjusting state
  // during render (not in an effect) is the React-endorsed way to do this.
  const [prevRepoId, setPrevRepoId] = useState<number | null>(null);
  if (prevRepoId !== repoId) {
    setPrevRepoId(repoId);
    setAuthors([]);
    setFilters(EMPTY_FILTERS);
    setSelectedCommits([]);
  }

  const selectedRepo = useMemo(
    () => repos?.find((r) => r.id === repoId) ?? null,
    [repos, repoId],
  );
  const anyBusy = !!repos?.some((r) => r.status === "pending" || r.status === "ingesting");

  const loadRepos = useCallback(async () => {
    try {
      const res = await fetch("/api/repos");
      if (!res.ok) throw new Error(`list failed (${res.status})`);
      setRepos((await res.json()) as RepoSummary[]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "could not load repositories");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/repos");
        if (!res.ok) throw new Error(`list failed (${res.status})`);
        if (!cancelled) setRepos((await res.json()) as RepoSummary[]);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : "could not load repositories");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll while something is being ingested so status flips over live.
  useEffect(() => {
    if (!anyBusy) return;
    const t = setInterval(() => void loadRepos(), 2500);
    return () => clearInterval(t);
  }, [anyBusy, loadRepos]);

  // Authors of the selected repository (for the author filter).
  useEffect(() => {
    if (repoId == null) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/repos/${repoId}/authors`);
        if (!res.ok) return;
        if (!cancelled) setAuthors((await res.json()) as Author[]);
      } catch {
        // The author filter simply stays empty; metrics still work.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  // Query string identifying the current filter combination.
  const requestKey = useMemo(() => {
    const params = new URLSearchParams();
    if (filters.authorId != null) params.set("authorId", String(filters.authorId));
    if (filters.path) params.set("path", filters.path);
    if (filters.from) params.set("from", localDateToIso(filters.from, false));
    if (filters.to) params.set("to", localDateToIso(filters.to, true));
    if (selectedCommits.length > 0) params.set("commits", selectedCommits.join(","));
    return params.toString();
  }, [filters, selectedCommits]);

  // Metrics for the current request, whenever the selected repo is ready.
  // Every state update happens after `await`, never synchronously.
  useEffect(() => {
    if (repoId == null || selectedRepo?.status !== "ready") return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/repos/${repoId}/metrics?${requestKey}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "metrics request failed");
        if (!cancelled) setFetched({ repoId, key: requestKey, data: body as MetricsResponse });
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : "metrics request failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, selectedRepo?.status, requestKey]);

  // Metrics are shown only when they match the current request exactly —
  // stale results for other repos/filter combinations never render.
  const metrics =
    fetched && fetched.repoId === repoId && fetched.key === requestKey ? fetched.data : null;
  const metricsLoading =
    repoId != null && selectedRepo?.status === "ready" && metrics === null;

  const childPath = (name: string) => (filters.path ? `${filters.path}/${name}` : name);

  const toggleCommit = (hash: string) =>
    setSelectedCommits((prev) =>
      prev.includes(hash) ? prev.filter((h) => h !== hash) : [...prev, hash],
    );

  const filtersActive =
    filters.authorId != null || !!filters.path || !!filters.from || !!filters.to || selectedCommits.length > 0;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">RAT — Repo Analysis Tool</h1>
          <p className="text-muted-foreground text-sm">
            Churn and ownership metrics per author, file, directory and commit set.
          </p>
        </div>
        <ThemeToggle />
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={repoId != null ? String(repoId) : ""}
          onValueChange={(v) => setRepoId(v ? Number(v) : null)}
        >
          <SelectTrigger className="w-64">
            <SelectValue placeholder={repos?.length ? "Choose a repository" : "No repositories yet"}>
              {(value: string) =>
                (repos ?? []).find((r) => String(r.id) === value)?.name ??
                (repos?.length ? "Choose a repository" : "No repositories yet")
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(repos ?? []).map((r) => (
              <SelectItem key={r.id} value={String(r.id)}>
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selectedRepo && <RepoStatusBadge repo={selectedRepo} />}
        <Button variant="outline" size="icon" onClick={() => void loadRepos()} title="Refresh">
          <RefreshCcw className="size-4" />
        </Button>
        <div className="grow" />
        <AddRepoDialog
          onAdded={(id) => {
            setRepoId(id);
            void loadRepos();
          }}
        />
      </div>

      {!repos?.length ? (
        <EmptyState />
      ) : selectedRepo && selectedRepo.status !== "ready" ? (
        <IngestStatus repo={selectedRepo} />
      ) : selectedRepo ? (
        <>
          <Card>
            <CardContent className="flex flex-wrap items-end gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="author-filter">Author</Label>
                <Select
                  value={filters.authorId != null ? String(filters.authorId) : "all"}
                  onValueChange={(v) =>
                    setFilters((f) => ({ ...f, authorId: v === "all" ? null : Number(v) }))
                  }
                >
                  <SelectTrigger id="author-filter" className="w-52">
                    <SelectValue placeholder="All authors">
                      {(value: string) =>
                        value === "all"
                          ? "All authors"
                          : (authors.find((a) => String(a.id) === value)?.name ?? "All authors")
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All authors</SelectItem>
                    {authors.map((a) => (
                      <SelectItem key={a.id} value={String(a.id)}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="from-date">From (inclusive)</Label>
                <Input
                  id="from-date"
                  type="date"
                  className="w-40"
                  value={filters.from}
                  onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="to-date">To (exclusive)</Label>
                <Input
                  id="to-date"
                  type="date"
                  className="w-40"
                  value={filters.to}
                  onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
                />
              </div>
              {selectedCommits.length > 0 && (
                <Badge variant="secondary" className="gap-1 py-1.5">
                  {selectedCommits.length} manually selected
                  <button
                    onClick={() => setSelectedCommits([])}
                    className="hover:text-destructive"
                    title="Clear manual selection"
                  >
                    <X className="size-3.5" />
                  </button>
                </Badge>
              )}
              {filtersActive && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setFilters(EMPTY_FILTERS);
                    setSelectedCommits([]);
                  }}
                >
                  <X className="size-4" /> Clear filters
                </Button>
              )}
              {metricsLoading && <Loader2 className="text-muted-foreground size-4 animate-spin" />}
            </CardContent>
          </Card>

          {metrics && <Breadcrumb path={metrics.object.path} kind={metrics.object.kind} onNavigate={(p) => setFilters((f) => ({ ...f, path: p }))} />}

          {metrics && <SummaryCards m={metrics} />}

          {metrics && (
            <Tabs defaultValue="directory">
              <TabsList>
                <TabsTrigger value="directory">Directory</TabsTrigger>
                <TabsTrigger value="authors">Authors</TabsTrigger>
                <TabsTrigger value="commits">Commits</TabsTrigger>
              </TabsList>

              <TabsContent value="directory">
                {metrics.object.kind === "file" ? (
                  <p className="text-muted-foreground py-8 text-center text-sm">
                    A file has no children — its own metrics are shown above.
                  </p>
                ) : metrics.children.length === 0 ? (
                  <p className="text-muted-foreground py-8 text-center text-sm">
                    Nothing measured under this path for the current filters.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead className="text-right">Added</TableHead>
                        <TableHead className="text-right">Removed</TableHead>
                        <TableHead className="text-right">Growth</TableHead>
                        <TableHead className="text-right">Churn</TableHead>
                        <TableHead className="text-right">Modifications</TableHead>
                        <TableHead className="text-right">Mod frequency</TableHead>
                        <TableHead className="text-right">Churn rate</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {metrics.children.map((c) => (
                        <TableRow
                          key={c.name}
                          className="cursor-pointer"
                          onClick={() => setFilters((f) => ({ ...f, path: childPath(c.name) }))}
                        >
                          <TableCell>
                            <span className="flex items-center gap-2">
                              {c.kind === "dir" ? (
                                <Folder className="text-muted-foreground size-4" />
                              ) : (
                                <File className="text-muted-foreground size-4" />
                              )}
                              {c.name}
                            </span>
                          </TableCell>
                          <MetricCells
                            added={c.added}
                            removed={c.removed}
                            growth={c.growth}
                            churn={c.churn}
                            modifications={c.modifications}
                            modificationFrequency={c.modificationFrequency}
                            churnRate={c.churnRate}
                          />
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </TabsContent>

              <TabsContent value="authors">
                {metrics.authors.length === 0 ? (
                  <p className="text-muted-foreground py-8 text-center text-sm">
                    No author touched this scope in the current commit set.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Author</TableHead>
                        <TableHead className="text-right">Commits touching scope</TableHead>
                        <TableHead className="text-right">Churn</TableHead>
                        <TableHead className="text-right">Modifications</TableHead>
                        <TableHead className="text-right">Ownership</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {metrics.authors.map((a) => (
                        <TableRow key={a.id}>
                          <TableCell>
                            <span className="flex flex-col">
                              {a.name}
                              <span className="text-muted-foreground text-xs">{a.email}</span>
                            </span>
                          </TableCell>
                          <TableCell className="text-right">{fmtInt.format(a.commits)}</TableCell>
                          <TableCell className="text-right">{fmtInt.format(a.churn)}</TableCell>
                          <TableCell className="text-right">{fmtInt.format(a.modifications)}</TableCell>
                          <TableCell className="text-right">{fmtPct(a.ownership)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </TabsContent>

              <TabsContent value="commits">
                <p className="text-muted-foreground mb-2 text-sm">
                  Tick commits to manually restrict the analysis to exactly that set.
                  {metrics.commitsTruncated && " Showing the 200 most recent."}
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10" />
                      <TableHead>Hash</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Author</TableHead>
                      <TableHead>Summary</TableHead>
                      <TableHead className="text-right">+ / −</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {metrics.commits.map((c) => (
                      <TableRow key={c.hash}>
                        <TableCell>
                          <input
                            type="checkbox"
                            className="accent-primary"
                            checked={selectedCommits.includes(c.hash)}
                            onChange={() => toggleCommit(c.hash)}
                          />
                        </TableCell>
                        <TableCell className="font-mono text-xs">{c.hash.slice(0, 7)}</TableCell>
                        <TableCell className="whitespace-nowrap text-sm">
                          {new Date(c.committerDate).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-sm">{c.authorName}</TableCell>
                        <TableCell className="max-w-72 truncate text-sm" title={c.summary}>
                          {c.summary}
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap font-mono text-xs">
                          <span className="text-emerald-600 dark:text-emerald-400">+{c.added}</span>{" "}
                          <span className="text-rose-600 dark:text-rose-400">−{c.removed}</span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TabsContent>
            </Tabs>
          )}
        </>
      ) : (
        <EmptyState />
      )}
    </div>
  );
}

function MetricCells(props: {
  added: number;
  removed: number;
  growth: number;
  churn: number;
  modifications: number;
  modificationFrequency: number;
  churnRate: number;
}) {
  return (
    <>
      <TableCell className="text-right font-mono text-xs text-emerald-600 dark:text-emerald-400">
        +{fmtInt.format(props.added)}
      </TableCell>
      <TableCell className="text-right font-mono text-xs text-rose-600 dark:text-rose-400">
        −{fmtInt.format(props.removed)}
      </TableCell>
      <TableCell className="text-right font-mono text-xs">{fmtInt.format(props.growth)}</TableCell>
      <TableCell className="text-right font-mono text-xs">{fmtInt.format(props.churn)}</TableCell>
      <TableCell className="text-right">{fmtInt.format(props.modifications)}</TableCell>
      <TableCell className="text-right">{fmtPct(props.modificationFrequency)}</TableCell>
      <TableCell className="text-right">{fmtRate(props.churnRate)}</TableCell>
    </>
  );
}

function SummaryCards({ m }: { m: MetricsResponse }) {
  const cards: { label: string; value: string }[] = [
    { label: "Commits in set", value: fmtInt.format(m.summary.setSize) },
    { label: "Added", value: `+${fmtInt.format(m.summary.added)}` },
    { label: "Removed", value: `−${fmtInt.format(m.summary.removed)}` },
    { label: "Growth", value: fmtInt.format(m.summary.growth) },
    { label: "Churn", value: fmtInt.format(m.summary.churn) },
    { label: "Modifications", value: fmtInt.format(m.summary.modifications) },
    { label: "Mod frequency", value: fmtPct(m.summary.modificationFrequency) },
    { label: "Churn rate", value: fmtRate(m.summary.churnRate) },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
      {cards.map((c) => (
        <Card key={c.label}>
          <CardContent className="flex flex-col gap-1 px-4 py-3">
            <span className="text-muted-foreground text-xs">{c.label}</span>
            <span className="font-mono text-lg font-semibold">{c.value}</span>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function Breadcrumb({
  path,
  kind,
  onNavigate,
}: {
  path: string;
  kind: "file" | "dir";
  onNavigate: (path: string) => void;
}) {
  const segments = path ? path.split("/") : [];
  const crumbs = [{ name: "repository root", value: "" }].concat(
    segments.map((s, i) => ({ name: s, value: segments.slice(0, i + 1).join("/") })),
  );
  return (
    <nav className="text-muted-foreground flex flex-wrap items-center gap-1 text-sm">
      {kind === "file" && <File className="size-3.5" />}
      {crumbs.map((c, i) => (
        <span key={c.value || "root"} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="size-3.5" />}
          <button
            className="hover:text-foreground underline-offset-2 hover:underline"
            onClick={() => onNavigate(c.value)}
          >
            {c.name}
          </button>
        </span>
      ))}
    </nav>
  );
}

function RepoStatusBadge({ repo }: { repo: RepoSummary }) {
  if (repo.status === "ready") {
    return (
      <Badge variant="outline" className="gap-1">
        <GitCommitHorizontal className="size-3.5" />
        {fmtInt.format(repo.commits)} commits · {fmtInt.format(repo.authors)} authors
      </Badge>
    );
  }
  if (repo.status === "failed") {
    return (
      <Badge variant="destructive" className="gap-1" title={repo.error ?? ""}>
        <CircleAlert className="size-3.5" /> failed
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1">
      <Loader2 className="size-3.5 animate-spin" /> {repo.status}
    </Badge>
  );
}

function IngestStatus({ repo }: { repo: RepoSummary }) {
  if (repo.status === "failed") {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-2 py-6">
          <p className="text-destructive flex items-center gap-2 font-medium">
            <CircleAlert className="size-4" /> Ingestion failed for “{repo.name}”
          </p>
          <p className="text-muted-foreground text-sm">{repo.error}</p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="text-muted-foreground flex items-center gap-3 py-10 text-sm">
        <Loader2 className="size-4 animate-spin" />
        Ingesting “{repo.name}” ({repo.status}) — the dashboard will fill in automatically.
      </CardContent>
    </Card>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardContent className="text-muted-foreground flex flex-col items-center gap-2 py-16 text-sm">
        <Folder className="size-8 opacity-50" />
        <p>No repositories yet.</p>
        <p>Use “Add repository” to clone a remote URL or upload a zip containing the repo&apos;s .git.</p>
      </CardContent>
    </Card>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      title="Toggle theme"
    >
      {/* CSS picks the icon so server and client markup always agree. */}
      <Moon className="size-4 dark:hidden" />
      <Sun className="hidden size-4 dark:block" />
    </Button>
  );
}
