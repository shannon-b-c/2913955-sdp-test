# RAT — Repo Analysis Tool

A web dashboard that ingests git repositories — a zip of the repo including `.git`, or a
remote URL that is deep cloned — and reports churn/ownership metrics per author, per file,
per directory, per commit set, and for the whole repository. Built for COMS3011A.

## Running it

Node **>= 20.9.0** (developed on v22.23.3, e.g. via `nvm install 22`).
From a clean clone:

    npm install
    npm run dev        # http://localhost:3000
    npm test           # vitest — every test runs against its own throwaway database

Production: `npm run build && npm start`.
Or: `bash start.sh`

## Third-party code   (package — one-line reason)

- next — App Router framework (scaffold)
- react / react-dom — UI runtime (scaffold)
- tailwindcss — utility-first styling
- shadcn + @base-ui/react — copy-in UI primitives (button, card, dialog, table, tabs, …)
- lucide-react — icons
- sonner — toasts
- next-themes — light/dark theme
- better-sqlite3 — embedded SQLite database
- vitest — test runner
- class-variance-authority, cn, tw-animate-css — shadcn/ui component helpers

## Database design    (tables, columns, relationships — must match the schema)

To be documented alongside the schema. Migrations are plain `.sql` files in `/migrations`,
applied automatically on startup; migrations only ever add.

## AI usage

Code generated with the assistance of Qoder[<mode/model shown in Qoder>]. Transcripts/notes in docs/ai/.
The preceding document was generated with the assistance of: Qoder[<model>]
