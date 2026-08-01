# MotherDuck as Code — a worked example

A small, complete example of managing MotherDuck resources in Git: a **Flight**, a **Dive**, and two **Guides**, deployed by CI that calls the `MD_*` SQL functions directly. The whole deployer is one bash script you can read top to bottom.

This is a teaching artifact, not a framework. If you want branch previews, RBAC, schema versioning, and a supported CLI, use [`motherduckdb/motherduck-blueprints`](https://github.com/motherduckdb/motherduck-blueprints) — this repository exposes the SQL layer that sits underneath tooling like that.

## What it deploys

| Artifact | Name | Source |
| --- | --- | --- |
| Database + share | `agent_commerce` | `bootstrap.sql` (run once, by hand) |
| Flight | `agent-commerce-monthly-rollup` | `flights/agent-commerce-monthly-rollup/` |
| Dive | `Agent Commerce Overview` | `dives/agent-commerce-overview/dive.tsx` |
| Guide | `Agent commerce metrics` | `guides/agent-commerce-metrics.md` |
| Guide | `Agent commerce Dive style` | `guides/agent-commerce-dive-style.md` |

`manifest.json` declares the desired state for all of it. It is the only file you edit to change what deploys.

## The one technique that makes this possible

`MD_CREATE_DIVE`, `MD_CREATE_GUIDE`, and `MD_CREATE_FLIGHT` are **table functions**, so their arguments must be literals. Both obvious ways to pass a file's contents fail:

```sql
-- Binder Error: read_text is a table function and must be called in a FROM clause
SELECT id FROM MD_CREATE_DIVE(content = read_text('dive.tsx'), ...);

-- Binder Error: Table function cannot contain subqueries
SELECT id FROM MD_CREATE_DIVE(content = (SELECT content FROM read_text('dive.tsx')), ...);
```

`SET VARIABLE` accepts the subquery, and `getvariable()` then hands the result to the table function as a scalar:

```sql
SET VARIABLE content = (SELECT content FROM read_text('dive.tsx'));
SELECT id FROM MD_CREATE_DIVE(title = 'My Dive', content = getvariable('content'), api_version = 1);
```

No heredocs, no dollar-quoting, no shell-escaping a 25 KB `.tsx`. This same pattern also applies when passing an ID you looked up: `MD_GET_DIVE(id = (SELECT ...))` fails, so resolve it into a variable first.

## Setup

```bash
export MOTHERDUCK_TOKEN='<your token>'   # the DuckDB CLI reads this env var

duckdb "md:" -f bootstrap.sql            # once: create the database and share
./deploy.sh --dry-run                    # see what would change
./deploy.sh                              # apply
```

For CI, add `MOTHERDUCK_TOKEN` as a GitHub Actions secret. Pull requests run `--dry-run` and post the plan to the job summary; merges to `main` apply.

## Deploy order

**Flight → run it → Dive → Guides.**

This order is not cosmetic. The Dive's `required_resources` names `md:agent_commerce_marts`, a database the Flight creates. Publish the Dive first and it references a table that does not exist yet, so `deploy.sh` waits for the Flight's run to reach `RUN_STATUS_SUCCEEDED` before touching the Dive.

## How identity works — and three sharp edges

There is no state file and no resource IDs in this repository. Every run asks MotherDuck what already exists:

| Artifact | Looked up by |
| --- | --- |
| Flight | `flight_name` via `MD_LIST_FLIGHTS()` |
| Dive | `title` via `MD_LIST_DIVES()` |
| Guide | `title` + `topic` via `MD_LIST_GUIDES()` |

That keeps the repository clean, but it has consequences worth knowing before you adopt the pattern:

1. **Renaming a Dive's `title` creates a second Dive.** The lookup on the new title finds nothing, so the deployer creates. The old Dive is orphaned, not renamed.
2. **Duplicate titles fail the deploy** with a non-zero exit rather than guessing which to update. A Dive you built by hand in the UI that happens to share a title will break CI.
3. **`MD_LIST_DIVES()` is identity-scoped.** Deploy once under your personal token and again under a service account, and the second run sees no match — so it creates a duplicate instead of updating. Using a dedicated service account for CI is therefore a **correctness requirement, not hygiene**: it is what keeps the upsert idempotent.

### Retry is not safe for creates

The DuckDB CLI intermittently crashes (SIGSEGV / SIGABRT) partway through a MotherDuck session — seen on v1.5.4 at several different `MD_*` call sites, never reproducibly. `deploy.sh` retries crashed calls, but only for reads and for updates addressed by an existing ID.

Creates deliberately do **not** retry. If the server completes a `CREATE` and the client crashes before receiving the reply, retrying produces a second artifact with a new ID. That is not hypothetical — it created a duplicate Guide while this repository was being written. Creates fail the run instead, which is safe because the script as a whole is idempotent: re-run it, and the next lookup finds the artifact the crashed run created and takes the update path.

## About the data

The dataset is a frozen snapshot covering 2024 only, so **the weekly Flight recomputes an identical table every run**. It is here to demonstrate managing a Flight as code — scheduling, config, versioning, ordering — not incremental ingestion. Do not read the schedule as evidence of freshness.

`bootstrap.sql` copies four tables out of an upstream share into a database this account owns, then republishes it. `ACCESS UNRESTRICTED` shares are **region-scoped**: if you fork this and your organization is in a different cloud region, re-run `bootstrap.sql` against your own account rather than attaching the share URL in `manifest.json`.

## Deliberately left out

Branch-scoped preview resources, cleanup-on-branch-delete, RBAC roles and grants, manifest schema versioning and migrations, and Dive status reconciliation (`MD_UPDATE_DIVE_STATUS`). Each is a real need at scale and each is handled by [`motherduck-blueprints`](https://github.com/motherduckdb/motherduck-blueprints). They are omitted here because preview-name derivation and teardown is where most of that complexity lives, and it would bury the part worth learning.
