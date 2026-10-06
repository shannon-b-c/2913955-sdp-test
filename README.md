# RAT — Repo Analysis Tool

A web dashboard that ingests git repositories — a zip of the repo including `.git`, or a
remote URL that is deep cloned — and reports churn/ownership metrics per author, per file,
per directory, per commit set, and for the whole repository. Built for COMS3011A.

## Running it

Node **>= 20.9.0** (developed on v22.23.3, e.g. via `nvm install 22`).
Also requires the `git` and `unzip` binaries on `PATH` — repository ingestion
drives them directly (deep clone, numstat analysis, archive extraction).
From a clean clone:

    npm install
    npm run dev        # http://localhost:3000
    npm test           # vitest — every test runs against its own throwaway database

Production: `npm run build && npm start`.
Or: `bash start.sh`

## Using it

Open the dashboard and **Add repository**: paste a remote URL (deep clone) or upload a zip
containing the repo's `.git` (archive root or one folder down). Ingestion runs in the
background — the status badge flips to ready with commit/author counts when done.
Then filter by **author** (dropdown), **file or directory** (click rows in the Directory
tab or the breadcrumb to drill in), and **commits** (a committer-date `from`/`to` range,
half-open `[from, to)`, or tick individual commits in the Commits tab for a manual set —
a manual selection replaces the date range). Summary cards and all tables recompute for
the selected scope: added/removed/growth/churn, modifications (commits with any change),
modification frequency (modifications ÷ |H|), churn rate (churn ÷ |H|) and per-author
ownership (author churn ÷ total churn).
Three charts visualise the current scope: **line changes per commit** (stacked added/
removed areas with the running growth), **author ownership** (churn per author, top 12)
and **directory volatility** (stacked added/removed per child, top 8 — click a bar to
drill into that child).

### API

- `GET /api/repos` — list repositories with statuses and counts.
- `POST /api/repos` — JSON `{ "url": "https://…" }` or multipart `file=<zip>`; returns
  `{ "id" }` immediately, ingestion continues in the background.
- `GET /api/repos/[id]` — one repository (status polling).
- `GET /api/repos/[id]/authors` — all authors, for the filter dropdown.
- `GET /api/repos/[id]/metrics` — metrics for a commit set. Query parameters:
  `authorId`, `path` (a directory or a file; default root), `from`/`to` (ISO committer
  dates, half-open), or `commits` (comma-separated hashes, replaces the date range).
  Returns the summary, immediate children, per-author metrics and the commit list.

## Third-party code   (package — one-line reason)

- next — App Router framework (scaffold)
- react / react-dom — UI runtime (scaffold)
- tailwindcss — utility-first styling
- shadcn + @base-ui/react — copy-in UI primitives (button, card, dialog, table, tabs, …)
- lucide-react — icons
- sonner — toasts
- next-themes — light/dark theme
- recharts — metric visualisations (via the shadcn/ui chart wrapper)
- better-sqlite3 — embedded SQLite database
- vitest — test runner
- class-variance-authority, cn, tw-animate-css — shadcn/ui component helpers

## Ingestion

Two sources: a **zip** that must contain the repo's `.git` (at the archive root or one
folder down), or a **remote URL** that is deep cloned — full history, no shallow copy.
Ingestion streams `git log --numstat -z -M50%` once and parses it byte-wise, so huge
repositories never sit in memory; author names/emails are mailmap-resolved by git itself
via `%aN`/`%aE`, so a tracked `.mailmap` in the repo merges identities at the source.
All rows for a repository are written inside a single transaction — a repo shows up
either fully ingested (`ready`) or not at all (`failed`, with the reason). The cloned or
extracted checkout is kept under `.data/repos/<repository id>`.

## Database design    (tables, columns, relationships — must match the schema)

SQLite via better-sqlite3. Migrations are plain `.sql` files in `/migrations`, applied
automatically on startup — each in its own transaction, tracked in `_migrations`; the runner
rejects any migration file containing `DELETE` or `DROP`, so migrations only ever add.

- **repositories** — one row per ingested repo. `id`, `name`, `source_type` (`zip` | `remote`),
  `source_url`, `head_hash` (reference commit for the analysis set), `status`
  (`pending` | `ingesting` | `ready` | `failed`), `error`, `created_at`, `ingested_at`.
- **authors** — raw git identities per repo. `id`, `repo_id` → repositories, `name`, `email`
  (unique per repo), `canonical_id` → authors (`NULL` = this row is the canonical identity;
  `.mailmap` and manual merges resolve through it), `created_at`.
- **commits** — full history, including merges. `id`, `repo_id`, `hash` (unique per repo),
  `parent_hash`, `author_id` → authors, `committer_date` (ISO 8601 — all time filtering uses
  the committer date, half-open `[i, j)` ranges), `summary`, `is_merge` (metric queries only
  read `is_merge = 0`), `created_at`.
- **file_stats** — the per-commit, per-file primitive (`git numstat`, 50% rename detection).
  `id`, `repo_id`, `commit_id` → commits, `path`, `added`, `removed`. Binary files are never
  recorded; a pure rename is a `0/0` row so the new path stays in scope; a rename+edit lands
  on the new path; a removal carries its full line count on the old path. Growth =
  `added − removed`, churn = `added + removed`. Directory and repository metrics aggregate
  `path` prefixes at query time — there is no directories table.

## AI usage

Code generated with the assistance of Qoder[<mode/model shown in Qoder>]. Transcripts/notes in docs/ai/.
The preceding document was generated with the assistance of: Qoder[<model>]
