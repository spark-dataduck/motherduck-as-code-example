# MotherDuck as Code — a worked example

A small, complete example of managing MotherDuck resources in Git: a **Flight**, a **Dive**, and two **Guides**, deployed by CI that calls the `MD_*` SQL functions directly. The whole deployer is one bash script you can read top to bottom.

This is a teaching artifact, not a framework. If you want branch previews, RBAC, schema versioning, and a supported CLI, use [`motherduckdb/motherduck-blueprints`](https://github.com/motherduckdb/motherduck-blueprints) — this repository exposes the SQL layer that sits underneath tooling like that.

## What it deploys

![Manage MotherDuck as Code](docs/manage-motherduck-as-code.png)

| Artifact | Name | Source |
| --- | --- | --- |
| Database + share | `agent_commerce` | `bootstrap.sql` (run once, by hand) |
| Flight | `agent-commerce-monthly-rollup` | `flights/agent-commerce-monthly-rollup/` |
| Dive | `Agent Commerce Overview` | `dives/agent-commerce-overview/dive.tsx` |
| Dive | `Dive Usage Monitoring` | `dives/dive-usage-monitoring/dive.tsx` |
| Dive | `MCP Usage Monitoring` | `dives/mcp-usage-monitoring/dive.tsx` |
| Dive | `Flight Usage Monitoring` | `dives/flight-usage-monitoring/dive.tsx` |
| Guide | `MotherDuck as Code — orientation` | `guides/orientation.md` |
| Guide | `Agent commerce metrics` | `guides/agent-commerce-metrics.md` |
| Guide | `Usage monitoring with QUERY_HISTORY` | `guides/usage-monitoring.md` |
| Guide | `Dive conventions` | `guides/dive-conventions.md` |
| Guide | `Flight conventions` | `guides/flight-conventions.md` |

`manifest.json` declares the desired state for all of it. It is the only file you edit to change what deploys.

### The three monitoring dives

These exist as **SQL examples**, and they deliberately use only surfaces a customer can reach — `MD_INFORMATION_SCHEMA.QUERY_HISTORY` and the `MD_LIST_*` functions. No MotherDuck-internal databases, so you can run them in your own account unchanged.

- **Dive Usage Monitoring** — per-Dive compute, split by where the Dive was viewed. Every Dive query carries the Dive's ID in `user_agent`: `md-dives/v1(<id>)` for the MotherDuck UI, `md-dive-embed/v1(<id>)` for embedded, and `md-dives-mcp-app/v1/v1(<id>,transport=…)` for an MCP app. Compute follows the *viewer*, not the Dive's owner.
- **MCP Usage Monitoring** — traffic through the MCP server, from `mcp-server-motherduck-remote/1.0.0(<client>)`, broken down by calling client (`claude-user`, `claude-code`, `openai-mcp`, `python-httpx/…`, …) and by user. It excludes Dives-rendered-in-MCP-apps so the two dives don't double-count the same queries.
- **Flight Usage Monitoring** — inventory and run health. Two real limits shape this one: Flight connections appear in `QUERY_HISTORY` as `md-flights` with **no flight ID**, so per-Flight compute attribution is not available at all; and `MD_LIST_FLIGHT_RUNS` rejects a lateral join (*"only supports literals as parameters"*), so SQL cannot fan out across Flights. The dive therefore reads `MD_LIST_FLIGHTS()` and builds the `UNION ALL BY NAME` over `MD_LIST_FLIGHT_RUNS` **in the client** — one branch per flight ID. It's a good illustration of where the React half of a Dive earns its place.

The first two need org admin on a Business plan, because `QUERY_HISTORY` is org-scoped. The Flight one needs no special role but is scoped to the *calling identity* — Flight SQL functions only show Flights that your own user or service account owns, so an org admin does not automatically see everyone's.

### Organizing Guides with topics

Guides are deployed into a **topic tree**, because that is how an agent finds them without paying for all of them. Rather than loading every guide up front, an agent calls `list_guides(topic)`, sees the topic names and their guide counts, and drills into the ones that look relevant — progressive disclosure.

```
(root)                     MotherDuck as Code — orientation
agent-commerce/            Agent commerce metrics
platform-observability/    Usage monitoring with QUERY_HISTORY
dives/                     Dive conventions            ← reserved topic
flights/                   Flight conventions          ← reserved topic
```

Three rules shaped that layout:

- **The root is reserved for the one guide that is always worth loading.** Guides with no topic appear in *every* overview, so they cost tokens in every session. `MotherDuck as Code — orientation` earns that slot by being a map — what lives in which database, and which topic to open next — rather than a manual.
- **Topic names are the only thing an agent judges before opening.** `agent-commerce` and `platform-observability` say what domain they cover; `misc` or `team-docs` would not.
- **`dives` and `flights` are reserved topics** for Dive and Flight conventions. Agents reach them through their own entry points, and they are deliberately excluded from the root overview. Having both here is the point: one shows how Dives should look, the other how Flights should be written and operated.

Topics nest with slashes (`agent-commerce/forecasting` lives inside `agent-commerce`), and filtering is prefix-based, so asking for `agent-commerce` also returns everything beneath it. Keep it shallow — a few well-named top-level topics with at most a level or two below beats a deep tree. Topics carry no identity: any number of guides can share one, and each guide is still addressed by its own UUID.

> **A rename is not a rename.** Adding these guides involved retitling `Agent commerce Dive style` to `Dive conventions`. Because Guides are looked up by title, the deploy *created* a new guide and left the old one orphaned in the `dives` topic — exactly sharp edge #1 below. The orphan had to be deleted by hand. Retitle deliberately.

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

## How identity works: create once, then update by ID

There is no state file and no resource IDs committed to this repository. Every run asks MotherDuck what already exists, then branches:

**First run** — nothing exists yet. The lookup returns no rows, so `deploy.sh` calls the *create* function and MotherDuck assigns an ID:

```
lookup by name  ->  (no match)  ->  MD_CREATE_FLIGHT / MD_CREATE_DIVE / MD_CREATE_GUIDE
```

**Every run after that** — the lookup finds the artifact, and the deployer switches to the *update* functions, addressing it by the ID it just resolved:

```
lookup by name  ->  id  ->  MD_UPDATE_FLIGHT(flight_id => id)
                            MD_UPDATE_DIVE_CONTENT(id) + MD_UPDATE_DIVE_METADATA(id)
                            MD_UPDATE_GUIDE(id)        + MD_UPDATE_GUIDE_METADATA(id)
```

So names are the *lookup* key and IDs are the *write* key. The name is what you version in Git; the ID never leaves MotherDuck. That is what makes the script idempotent — run it ten times and you get one of each artifact, not ten.

| Artifact | Looked up by | Then written by |
| --- | --- | --- |
| Flight | `flight_name` via `MD_LIST_FLIGHTS()` | `flight_id` |
| Dive | `title` via `MD_LIST_DIVES()` | `id` |
| Guide | `title` + `topic` via `MD_LIST_GUIDES()` | `id` |

`./deploy.sh --dry-run` shows you which branch each artifact will take before anything runs:

```
ACTION   TYPE           NAME
update   flight         agent-commerce-monthly-rollup
update   dive           Agent Commerce Overview
create   dive           Dive Usage Monitoring
update   guide          Agent commerce metrics
```

### Three sharp edges

Resolving identity by name keeps the repository clean, but it has consequences worth knowing before you adopt the pattern:

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
