# 0006 · SQLite + Drizzle (Driver: better-sqlite3 First, Evaluate `node:sqlite`)

- Status: Accepted
- Date: 2026-10-01
- Related: [design/06](../design/06-data-model.md), [kb/node-runtime.md](../kb/node-runtime.md)

## Context

The panel stores users, nodes, configuration, alerts, and audit logs, plus time-series monitoring data (per-minute for 7 days, per-hour for about a year). Requirements: lightweight, no external services, easy to back up and migrate. Expected scale: ≤ 100 nodes.

Driver landscape (verified 2026-10):

- Node's built-in `node:sqlite` has been a **Release Candidate** (Stability 1.2) since v24.15.0 / v25.7.0, offering the synchronous `DatabaseSync` API and the online backup function `sqlite.backup()`.
- Drizzle supports `node:sqlite` natively via `drizzle-orm/node-sqlite`, but the official docs require `drizzle-orm@rc` / `drizzle-kit@rc`. The current stable line is `drizzle-orm` 0.45.
- `better-sqlite3` is mature and well supported by stable Drizzle; the downside is that it is a native module needing per-architecture prebuilt binaries.

## Decision

- Storage is SQLite (WAL), with Drizzle as ORM/query builder and `drizzle-kit` for migrations.
- The v1 driver is **better-sqlite3**, paired with stable Drizzle.
- **M0 includes a focused spike**: run the schema, migrations, online backup, and a metric bulk-write benchmark on `node:sqlite` + Drizzle rc. Switch to `node:sqlite` and drop the native module once all of these hold:
  1. The Drizzle release containing the `node-sqlite` driver is stable;
  2. Write throughput in the benchmark is at least 80% of better-sqlite3's;
  3. `node:sqlite` no longer prints an experimental warning on the Node LTS line we ship.
- All database access goes through a thin layer in `apps/panel/src/db/` (open, PRAGMAs, transactions, backup), so switching drivers only touches that layer.
- Time-series data also lives in SQLite at minute and hour resolution with periodic downsampling; no dedicated time-series database.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| SQLite + better-sqlite3 (chosen for v1) | Mature; supported by stable Drizzle; online backup API; simple, fast synchronous API | Native module compiled per architecture; synchronous calls block the event loop |
| SQLite + `node:sqlite` (under evaluation) | Built into Node, no native module, simplest packaging; online backup too | Still RC; Drizzle support currently in rc |
| PostgreSQL | Powerful | Far too heavy for a lightweight panel; extra deployment |
| SQLite + a dedicated TSDB (e.g. VictoriaMetrics) | Strong time-series queries | One more process; unnecessary at this data volume |

## Consequences

- Positive: the entire panel state is one file, so backup and migration are trivial.
- Negative:
  - Bulk writes (metric ingestion, downsampling) must run in short transactions, each < 50 ms;
  - Until the switch to `node:sqlite`, CI must build better-sqlite3 for x64 and arm64.
- Revisit when: node counts far exceed 100, or second-level history is needed; then consider moving time-series data to dedicated storage.
