"use client";

import { useMemo } from "react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { AuthorMetrics, ChildMetrics, CommitRow } from "@/lib/types";

/** The theme's five chart colours, cycled when there are more entries. */
const PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const fullDate = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Oldest-first rows annotated with running growth (δ) and a short date label. */
function withCumulativeGrowth(rows: CommitRow[]) {
  const out: (CommitRow & { day: string; growth: number })[] = [];
  let running = 0;
  for (const c of rows) {
    running += c.added - c.removed;
    out.push({ ...c, day: shortDate.format(new Date(c.committerDate)), growth: running });
  }
  return out;
}

/**
 * Line changes per commit across the commit set, oldest to newest: stacked
 * added/removed areas with the running growth (δ) on top. Mirrors the classic
 * repository-evolution view.
 */
const activityConfig = {
  added: { label: "Added", color: "var(--chart-4)" },
  removed: { label: "Removed", color: "var(--chart-2)" },
  growth: { label: "Cumulative growth", color: "var(--chart-1)" },
} satisfies ChartConfig;

export function ActivityChart({ commits }: { commits: CommitRow[] }) {
  const data = useMemo(() => withCumulativeGrowth([...commits].reverse()), [commits]);

  return (
    <ChartContainer config={activityConfig} className="aspect-auto h-64 w-full">
      <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="day"
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
          minTickGap={48}
        />
        <YAxis tickLine={false} axisLine={false} width={56} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => {
                const commit = (payload?.[0] as { payload?: CommitRow } | undefined)?.payload;
                if (!commit) return "";
                return `${fullDate.format(new Date(commit.committerDate))} — ${commit.summary}`;
              }}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Area
          dataKey="added"
          stackId="changes"
          stroke="var(--color-added)"
          fill="var(--color-added)"
          fillOpacity={0.3}
          isAnimationActive={false}
        />
        <Area
          dataKey="removed"
          stackId="changes"
          stroke="var(--color-removed)"
          fill="var(--color-removed)"
          fillOpacity={0.3}
          isAnimationActive={false}
        />
        <Line
          dataKey="growth"
          stroke="var(--color-growth)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ChartContainer>
  );
}

/**
 * Author ownership: churn per author as coloured horizontal bars, heaviest
 * contributor first. The tooltip repeats the churn and the ownership share ω.
 */
const ownershipConfig = {
  churn: { label: "Churn", color: "var(--chart-1)" },
} satisfies ChartConfig;

export function OwnershipChart({ authors }: { authors: AuthorMetrics[] }) {
  const data = useMemo(
    () => [...authors].sort((a, b) => b.churn - a.churn).slice(0, 12),
    [authors],
  );

  return (
    <div className="flex flex-col gap-1">
      <ChartContainer config={ownershipConfig} className="aspect-auto h-72 w-full">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, bottom: 0, left: 8 }}>
          <CartesianGrid horizontal={false} />
          <XAxis type="number" tickLine={false} axisLine={false} />
          <YAxis
            type="category"
            dataKey="name"
            tickLine={false}
            axisLine={false}
            width={140}
            interval={0}
            tickFormatter={(v: string) => truncate(v, 18)}
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                formatter={(_value, _name, item) => {
                  const author = (item?.payload ?? {}) as AuthorMetrics;
                  return (
                    <div className="flex w-full flex-wrap gap-x-3">
                      <span className="font-mono font-medium">
                        {author.churn.toLocaleString()} churn
                      </span>
                      <span className="text-muted-foreground">
                        {(author.ownership * 100).toFixed(1)}% ownership ·{" "}
                        {author.commits.toLocaleString()} commits
                      </span>
                    </div>
                  );
                }}
              />
            }
          />
          <Bar dataKey="churn" radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {data.map((author, i) => (
              <Cell key={author.id} fill={PALETTE[i % PALETTE.length]} />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>
      {authors.length > data.length && (
        <p className="text-muted-foreground text-xs">
          Top {data.length} of {authors.length} authors by churn — the full list is in the table
          below.
        </p>
      )}
    </div>
  );
}

/**
 * Volatility of the selected directory: stacked added/removed per immediate
 * child (top 8 by churn). Clicking a bar drills into that child.
 */
const childrenConfig = {
  added: { label: "Added", color: "var(--chart-4)" },
  removed: { label: "Removed", color: "var(--chart-2)" },
} satisfies ChartConfig;

export function ChildrenChart({
  items,
  onSelect,
}: {
  items: ChildMetrics[];
  onSelect?: (name: string) => void;
}) {
  const data = useMemo(
    () => [...items].sort((a, b) => b.churn - a.churn).slice(0, 8),
    [items],
  );

  function drill(entry: unknown) {
    const name = (entry as { payload?: { name?: string } } | null)?.payload?.name;
    if (name && onSelect) onSelect(name);
  }

  return (
    <ChartContainer config={childrenConfig} className="aspect-auto h-64 w-full">
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, bottom: 0, left: 8 }}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" tickLine={false} axisLine={false} />
        <YAxis
          type="category"
          dataKey="name"
          tickLine={false}
          axisLine={false}
          width={160}
          tickFormatter={(v: string) => truncate(v, 22)}
        />
        <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="added" stackId="changes" fill="var(--color-added)" isAnimationActive={false} onClick={drill} />
        <Bar
          dataKey="removed"
          stackId="changes"
          fill="var(--color-removed)"
          radius={[0, 4, 4, 0]}
          isAnimationActive={false}
          onClick={drill}
        />
      </BarChart>
    </ChartContainer>
  );
}
