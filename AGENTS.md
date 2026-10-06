# AGENTS.md — rules for the agent

## Project
Your project manager has asked you to build a Repo Analysis Tool (RAT) that measures specific metrics
of a provided repository. You need to calculate these metrics for: each developer (called an author), each
file, each directory, and the entire repository. These metrics are provided below.
The RAT should be a web-app dashboard for multiple repositories. This dashboard should be filterable
by:
• A repository
• An author
• A file or directory
• Commits
‣ a specified period of time
‣ or a manually selected list of commits

The full brief and rubric is in docs/brief.pdf. Re-read them before any feature.

## Stack (do not change, do not add alternatives)
- Next.js (App Router) + TypeScript, npm only (no yarn/pnpm/bun)
- Styling: Tailwind + shadcn/ui. Icons: lucide-react. Toasts: sonner. Theme: next-themes.
- Database: SQLite via better-sqlite3 with plain .sql migrations in /migrations, applied automatically on startup.
- Tests: Vitest, each test uses a fresh throwaway database (never dev.db, never mocks of the DB).
- Ask me before installing ANY new package. Never install two libraries that do the same job.

## Hard constraints from the brief (never violate)
- Migrations only ADD; never drop/recreate tables with data.
- Analyze non-merge commits only: the analysis set is all non-merge commits reachable from the reference commit (typically HEAD).
- All time filtering uses the committer date (never the author date); ranges are half-open [i, j): i inclusive, j exclusive; "from t to present" is t inclusive.
- Binary files are never measured (use git's own binary detection).
- Rename detection at 50% similarity: a pure rename changes no metrics; a rename+edit counts only the edit, attributed to the new path; a deletion counts as lines removed on the old path.
- The file/dir scope of a commit set includes paths touched by each commit OR its parent (H[F] = union of h[F] and h[p][F]) — deleted files still appear in metrics.
- Directory metrics are the recursive sum over immediate children (files and subdirectories); repository metrics are directory metrics on the root.
- Growth = added − removed; churn = added + removed; modifications count commits with churn > 0 on the object.
- Modification frequency and churn rate are defined as 0 when the commit set is empty — never divide by zero.
- Author merging (repo .mailmap when present, plus manual merging in the UI) must be applied before computing any author metric.
- Remote ingestion must deep clone (full history); zip ingestion must include the repo's .git directory.

## Working rules
- When finished with a task, stop and tell me: files changed, how to test it by hand, anything you were unsure of.
- Run `npm test` and `npm run build` after every change; both must pass before you say "done".
- Never delete or weaken a failing test to make it pass — tell me instead.
- No placeholder/mock data, no TODO stubs left in UI code.
- Dates: store ISO strings; compare "today" in the user's local timezone, not UTC.
- Keep the README "Running it" section accurate whenever scripts/env change.
- Do not commit; I commit myself.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
