# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A worked example of managing MotherDuck resources as code: one Flight, five Dives, six Guides, and a share — all declared in `manifest.json` and reconciled by `deploy.sh`, which calls the `MD_*` SQL functions through the DuckDB CLI. There is no framework, no state file, and no committed resource IDs.

The artifacts are a vehicle; the repository's real subject is the deploy mechanics. Prose in `README.md` and the guides is part of the deliverable — keep it accurate when you change behavior.

## This repository is public

Never commit customer names, tokens, internal database references, or org-specific identifiers.

The monitoring dives read **only surfaces a customer can reach** — `MD_INFORMATION_SCHEMA.QUERY_HISTORY` and the `MD_LIST_*` functions. Never `mdw` or any MotherDuck-internal database: someone forking this must be able to run the queries unchanged. If a metric is not available from those surfaces, say so in the dive rather than reaching for an internal table — `Flight Usage Monitoring` does exactly that about per-Flight compute attribution.

## Commands

There is no build, test, or lint step. The DuckDB CLI and `jq` are the only dependencies, and `MOTHERDUCK_TOKEN` must be set.

```bash
./deploy.sh --dry-run          # print the create/update plan, mutate nothing
./deploy.sh                    # apply (CI does this; see below)
duckdb "md:" -f bootstrap.sql  # one-time: own a copy of the source data + publish the share
MANIFEST=other.json ./deploy.sh --dry-run   # manifest path is overridable
```

**Do not run `./deploy.sh` locally.** Deployment happens through CI: a pull request runs `--dry-run` into the job summary, and a merge to `main` applies. A local apply competes with CI for the same name-keyed artifacts. Use `--dry-run` freely — it only reads.

**The DuckDB CLI is pinned to 1.5.4** in `.github/workflows/deploy.yml`. MotherDuck supports a maximum DuckDB version and DuckDB releases ahead of it, so `latest` breaks on the next DuckDB release. Bump only after MotherDuck announces support.

## Architecture

### `manifest.json` is the only file that decides what deploys

It names every artifact, points at its source file, and declares the properties the repository owns (a Flight's `schedule_cron` and `config`, a Dive's `required_resources`, a Guide's `topic` and `access`). Nothing a user would reasonably want to change is hardcoded in `deploy.sh`. Adding an artifact means adding a manifest entry — not editing the script.

### Names are the lookup key; IDs are the write key

Every run asks MotherDuck what exists, then branches to create or update. Nothing persists between runs.

| Artifact | Looked up by | Then written by |
| --- | --- | --- |
| Flight | `flight_name` via `MD_LIST_FLIGHTS()` | `flight_id` |
| Dive | `title` via `MD_LIST_DIVES()` | `id` |
| Guide | `title` + `topic` via `MD_LIST_GUIDES()` | `id` |

This is what makes the script idempotent, and it is also the source of three failure modes:

1. **Renaming creates a second artifact** and orphans the first. Changing a `title` or Flight `name` in the manifest is a create, not a rename — clean up the orphan by hand.
2. **Duplicate names abort the deploy** (`require_single`) rather than guessing. A Dive built in the UI that shares a title will break CI.
3. **`MD_LIST_*` is identity-scoped.** Deploy with a service-account token. Switching tokens makes the next run find nothing and create a parallel set of everything.

### Deploy order is load-bearing

`deploy_flight` → wait for the run → `deploy_dives` → `deploy_guides`.

`Agent Commerce Overview` declares `md:agent_commerce_marts` in `required_resources`, and the Flight creates that database. Publishing the Dive first points it at a table that does not exist, so the script blocks on the Flight run reaching `RUN_STATUS_SUCCEEDED`.

## Conventions that will bite you

**Getting file contents into a table function.** `MD_CREATE_*` are table functions, so arguments must be literals — `read_text()` as an argument and a `(SELECT ...)` subquery both fail with a Binder Error. Use `SET VARIABLE` (which accepts the subquery) then `getvariable()`:

```sql
SET VARIABLE content = (SELECT content FROM read_text('dive.tsx'));
SELECT id FROM MD_CREATE_DIVE(title = 'My Dive', content = getvariable('content'), api_version = 1);
```

This applies to reads too — resolve an ID into a variable before `MD_GET_DIVE`.

**`md` retries, `md_once` does not.** The DuckDB CLI intermittently crashes (SIGSEGV/SIGABRT) mid-session against MotherDuck. A crash is not a SQL error, so retrying is reasonable for reads and for updates addressed by an existing ID. It is **not** safe for creates: if the server completed the CREATE and the client died before the reply, a retry makes a second artifact. Creates use `md_once` and fail the whole run — correct, because re-running takes the update path.

**Run statuses carry a `RUN_STATUS_` prefix** (`RUN_STATUS_SUCCEEDED` / `_FAILED` / `_CANCELLED`). Comparing against a bare `SUCCEEDED` compiles, never matches, and hangs a wait loop until timeout — then fails a run that actually succeeded.

**`MD_LIST_FLIGHTS()` returns `flight_id` / `flight_name`**, not `id` / `name` like the other list functions.

**`MD_LIST_FLIGHT_RUNS` accepts only literal arguments.** A lateral join over `MD_LIST_FLIGHTS()` is rejected, so SQL cannot fan out across Flights. Either `UNION ALL BY NAME` a branch per flight id (see `dives/flight-usage-monitoring/queries.sql`, which generates that SQL) or fan out in the client.

**Reconcile, don't just create.** The test for any property: *if someone changed this in the UI, would the next deploy notice?* Guide `access` is re-checked every run because the failure is silent and asymmetric — a drifted title breaks loudly, a drifted access level quietly exposes a guide org-wide. Dive `status` is reconciled too, and it carries a wrinkle worth knowing: a status is pinned to a **version**, and `MD_UPDATE_DIVE_CONTENT` bumps `current_version`. So comparing only the status leaves every content edit published as a stale `ready` that describes the previous version. The check covers `status` *and* `status_applies_to_version`. A Dive with no `status` in the manifest is skipped entirely rather than defaulted — defaulting to `draft` would silently demote a Dive someone endorsed.

## Working on Dives

`dives/<slug>/dive.tsx` is a React component using `useSQLQuery` and `useDiveState` from `@motherduck/react-sql-query`.

- **Databases are declared twice, on purpose.** `export const REQUIRED_DATABASES` at the top of the `.tsx` drives local preview; `required_resources` in the manifest drives the published Dive. Shipping both is a runtime error, so `deploy.sh` strips the `REQUIRED_DATABASES` line into a scratch file before upload. When you change one, change the other.
- **`queries.sql` must stay in sync with its `dive.tsx`.** Each monitoring dive ships the exact queries it runs, meant to paste straight into a notebook. If you change SQL in the `.tsx`, mirror it — and run it to prove it works.
- **Read `guides/dives/conventions.md` before styling anything.** It holds the color tokens, the sortable-table and skeleton rules, and formatting conventions. `Agent Commerce Overview` uses a dark branded canvas as a deliberate exception; everything analytical uses the light palette.
- **Gate `QUERY_HISTORY` behind one probe query.** It needs org admin on a Business plan. Without a gate, a non-admin viewer triggers one failed query per visual instead of one.

## Working on Flights

`flights/<name>/flight.py` plus a `requirements.txt`, both referenced from the manifest.

- Writes must be idempotent — `CREATE OR REPLACE TABLE`, never `INSERT`. Flights re-run on schedule, on deploy, and by hand.
- Config comes from the manifest `config` map, surfaced as same-named environment variables. Use UPPERCASE keys. Never put a secret there; use Flight secrets.
- Connect with `duckdb.connect("md:")` — the runtime injects the token.
- Flights write to `agent_commerce_marts`. `agent_commerce` is a read-only share.

See `guides/flights/conventions.md`.

## Working on Guides

**The directory tree under `guides/` mirrors the topic tree**, and a guide's identity is `title` + `topic` from the manifest — the filename carries no meaning. Keeping path and topic aligned is a convention the deployer does not enforce, so a mismatch would go unnoticed for months; don't create one.

Topics exist because agents use progressive disclosure: `list_guides(topic)` returns topic names and counts, and only promising ones get opened. So the topic name and `description` are the entire basis for whether a guide is read.

- **The root (empty topic) is expensive** — untopiced guides appear in every overview and cost tokens every session. Only `orientation.md` earns it, by being a map rather than a manual.
- **`dives` and `flights` are reserved** for the conventions guides, reached through their own entry points.
- Topics nest with slashes and filter by prefix (`agent-commerce` also returns `agent-commerce/forecasting`). Keep it shallow.

Guides are versioned in MotherDuck: each deploy stamps `external_id` with the commit SHA and `change_comment` with `deployed from <sha>`.

## Commit style

Conventional commits with an optional scope, lowercase, no trailing period: `feat(dives): daily chart, top-20 with show more`, `fix(ci): pin the DuckDB CLI to 1.5.4`, `docs: add README with setup, deploy order`.
