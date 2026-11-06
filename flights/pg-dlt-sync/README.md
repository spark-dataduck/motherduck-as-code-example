# pg-dlt-sync

Sync tables from **any Postgres the Flight can reach over the internet** into MotherDuck with two
Flights: a [dlt](https://dlthub.com) ingest that lands rows **append-only** in a raw schema, and a
SQL-only transform that keeps a curated schema with one current row per key. One Flight and one
config line per table, instead of one Flight per table.

![How it works](diagram.svg)

| Flight | What it does | Depends on |
| --- | --- | --- |
| [`ingest/flight.py`](ingest/flight.py) | Connects to Postgres directly, runs a dlt `sql_database` pipeline, lands tables append-only in `<TARGET_DB>.<raw>`, then triggers the transform with `MD_RUN_FLIGHT`. | dlt, SQLAlchemy, psycopg2 |
| [`transform/flight.py`](transform/flight.py) | SQL only. Discovers the tables in the raw schema, rebuilds snapshot tables, applies the incremental ones to `<TARGET_DB>.<curated>` with a transactional delete+insert (one current row per key), verifies key counts. | duckdb |

Both Flights print [Flight Explainer](https://motherduck.com/docs/key-tasks/flights/observability/explain-flight-runs/)
markers (`# @flight` chart, `@flight-run` / `@flight-log` lines), so each run shows as a live step
diagram in the MotherDuck UI.

A Postgres with **no internet path** (private subnets, no NAT) is the same pipeline plus an SSM
tunnel: [`../rds-ssm-dlt-sync`](../rds-ssm-dlt-sync). That folder reuses this transform.

## When to use this, and when to use the cookbook Flight instead

MotherDuck's docs ship a one-file
[Postgres ingest Flight](https://motherduck.com/docs/cookbook/flight-postgres-ingest) (with
[Neon](https://motherduck.com/docs/cookbook/flight-neon-postgres-ingest),
[Supabase](https://motherduck.com/docs/cookbook/flight-supabase-postgres-ingest),
[Azure](https://motherduck.com/docs/cookbook/flight-azure-postgres-ingest),
[Heroku](https://motherduck.com/docs/cookbook/flight-heroku-postgres-ingest) and
[Render](https://motherduck.com/docs/cookbook/flight-render-postgres-ingest) variants). It uses
DuckDB's `postgres` extension, does `CREATE OR REPLACE` per table and a `MERGE` for incremental
ones, and is the right start when the tables are small and you want one file with no
dependencies.

Pick this folder when any of these is true:

- **Tables grow.** A full refresh re-reads the whole table every run; cost scales with table
  size, not change volume. Here, incremental tables read only rows at or after the last cursor,
  and dlt keeps that cursor in MotherDuck so a fresh container continues where the last stopped.
- **You run it often.** A `MERGE` or `INSERT OR REPLACE` into a big table probes the whole table
  on every run, and two overlapping runs fail on a write-write conflict. Here the ingest only
  appends, and the transform applies changes with delete+insert inside one transaction.
- **You want history.** Raw keeps every version of every row. Curated shows the current one;
  point-in-time questions go to raw.
- **You want it as code.** Both Flights deploy from this repository's `manifest.json`
  ([`manifest.snippet.json`](manifest.snippet.json)), so table lists and cursors are reviewed in
  a pull request, not edited in the UI.
- **You want per-table control in one place.** Full refresh or incremental is one entry in
  `INCREMENTAL_TABLES`. Small lookup tables stay full refresh; tables without a primary key and
  an `updated_at` column have to.

## Which Postgres hosts this works with

Anything with a public endpoint, TLS, and a user that can `SELECT`. Outbound connections from a
Flight come from a fixed set of
[egress IPs per MotherDuck region](https://motherduck.com/docs/concepts/flights/#connecting-to-external-systems);
hosts with an IP allow list need those addresses. The pipeline was tested end to end against a
local Postgres 16 (two runs: full load, then an update, an insert and an added column); the
provider notes follow MotherDuck's cookbook and have not all been exercised from a Flight.

| Provider | Use this connection | Watch out for |
| --- | --- | --- |
| **Neon** | The **direct** endpoint (`ep-...<region>.aws.neon.tech`), `sslmode=require`. Paste the Connect dialog URL into the secret as `DATABASE_URL`; `channel_binding=require` passes through. | The `-pooler` endpoint (PgBouncer) is less reliable for long bulk reads; the Flight logs a warning. Scale-to-zero computes take a few seconds to wake; the probe retries for `PROBE_TIMEOUT_S`. IP Allow (paid plans) needs the Flight egress IPs. |
| **Supabase** | Connect → **Session pooler**: `postgres.<project_ref>@aws-0-<region>.pooler.supabase.com:5432`. | The direct host `db.<ref>.supabase.co` is IPv6-only and Flights connect over IPv4. Port `6543` is the transaction pooler and does not support the server-side cursors dlt uses. The pooler user needs the `.<project_ref>` suffix. Leave `auth`, `storage` and the other Supabase schemas out of `TABLES`. |
| **Amazon RDS / Aurora** (public) | The instance or cluster endpoint with `publicly_accessible = true` and the Flight egress IPs in the security group. | A private instance needs [`../rds-ssm-dlt-sync`](../rds-ssm-dlt-sync) instead. RDS Proxy is not reachable from outside the VPC. |
| **Google Cloud SQL** | Public IP with the Flight egress IPs under Authorized networks, `sslmode=require` (or `verify-ca` with the server CA in `DATABASE_URL`). | Private IP only and Cloud SQL Auth Proxy are not reachable from a Flight. |
| **Azure Database for PostgreSQL** (Flexible Server) | Public access, port 5432, firewall rules for the Flight egress IPs. | A `.private.` host (VNet integration) and the PgBouncer port `6432` fail the provider check. |
| **Heroku Postgres** | The `DATABASE_URL` config var as is (`sslmode=require`). | Credentials rotate on maintenance; the secret has to follow. Essential plans cap connections low. |
| **Render** | The **External** Database URL. | The Internal URL (`dpg-...` with no domain) only works inside Render and fails the provider check. |
| **Crunchy Bridge, Railway, DigitalOcean, Aiven, Timescale, Xata, self-hosted** | The public host, port 5432, `sslmode=require`. | Same pattern: public endpoint, egress IPs allowlisted if there is a firewall, a read-only user. |

Two things apply to every provider:

- **A cursor column on each incremental table** that the application sets on every write,
  typically `updated_at`. Postgres does not provide one; ORMs usually do. A column set only on
  insert (`created_at`) never shows updates. Hard deletes are never seen; pair incremental tables
  with soft deletes or an occasional full refresh.
- **A primary key** on each incremental table, so the transform can dedupe and apply changes.
  Tables without one are full refresh.

### Runbook: the read-only Postgres user

Run as a superuser or the database owner (replace the database, schema, and password):

```sql
CREATE ROLE motherduck_flight LOGIN PASSWORD '<strong password>';
GRANT CONNECT ON DATABASE your_database TO motherduck_flight;
GRANT USAGE ON SCHEMA public TO motherduck_flight;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO motherduck_flight;
-- tables created later get SELECT too, so a new table never breaks the sync
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO motherduck_flight;
```

Check it from your laptop before putting it in a secret:

```bash
psql "postgresql://motherduck_flight@<host>:5432/your_database?sslmode=require" \
  -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';"
```

## What you need on the MotherDuck side

One `TYPE flights` secret named `pg`, holding **credentials only**. Either the full URL from the
provider's Connect dialog:

```sql
CREATE SECRET pg IN motherduck (
  TYPE flights,
  PARAMS MAP {'DATABASE_URL': 'postgresql://<user>:<password>@<host>/<database>?sslmode=require'}
);
```

or user and password, with host, port and database in the Flight's config:

```sql
CREATE SECRET pg IN motherduck (
  TYPE flights,
  PARAMS MAP {'USER': '<postgres user>', 'PASSWORD': '<password>'}
);
```

They reach the Flight as `pg_DATABASE_URL`, or `pg_USER` and `pg_PASSWORD`. `MOTHERDUCK_TOKEN`
is injected by Flights. `DATABASE_URL` wins when both are present.

Then create the Flights. The transform goes first because the ingest needs its id. The entries in
[`manifest.snippet.json`](manifest.snippet.json) are the same thing in this repository's manifest
format; they are not in the root `manifest.json` because they need your database and your secret.

```sql
-- 1. transform (SQL only)
SELECT flight_id FROM MD_CREATE_FLIGHT(
  name := 'pg-dlt-transform',
  source_code := $$ ... transform/flight.py ... $$,
  requirements_txt := 'duckdb==1.5.6',
  instance_type := 'F16',
  config := MAP {'CURATED_SCHEMA': 'curated', 'TARGET_DB': '', 'RAW_SCHEMA': '', 'INCREMENTAL_TABLES': ''}
);

-- 2. ingest, pointing at the transform
SELECT flight_id FROM MD_CREATE_FLIGHT(
  name := 'pg-dlt-ingest',
  source_code := $$ ... ingest/flight.py ... $$,
  requirements_txt := $$ ... ingest/requirements.txt ... $$,
  flight_secret_names := ['pg'],
  config := MAP {
    'SOURCE_SCHEMA': 'public',
    'TABLES': 'customers,orders',
    'INCREMENTAL_TABLES': 'orders:updated_at:id',
    'INCREMENTAL_MODE': 'append',
    'TARGET_DB': 'pg_sync',
    'TARGET_SCHEMA': 'raw',
    'TRIGGER_FLIGHT_ID': '<flight_id from step 1>',
    'DLT_BACKEND': 'sqlalchemy'
  }
);
```

Run the ingest once with `MD_RUN_FLIGHT(flight_id := ...)`, watch both runs in the UI (the
ingest's `trigger` step logs the transform's run number), then add a `schedule_cron`.

## Config reference

**Ingest** (all config keys are plain env vars; `validate_config()` fails fast with one message
naming every bad value before any connection is made):

| Key | Default | Purpose |
| --- | --- | --- |
| `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_SSLMODE` | , `5432`, `postgres`, `require` | Where to connect, when the secret holds `USER`/`PASSWORD` rather than `DATABASE_URL`. `PG_SSLMODE=disable` only for a local test server. |
| `SOURCE_SCHEMA` | `public` | Postgres schema |
| `TABLES` | | Comma-separated tables to sync (reflected up front, not the whole schema) |
| `INCREMENTAL_TABLES` | (none) | `table:cursor:key[\|key2],...`. Listed tables are read incrementally (rows at or after the last cursor dlt saw); the rest are full `replace`. The key is what the transform dedupes and applies changes on. |
| `INCREMENTAL_MODE` | `append` | `append`: append-only raw, history kept, dedupe downstream. `merge`: dlt upserts in place (delete+insert via a staging dataset); no transform needed, no history. |
| `TARGET_DB`, `TARGET_SCHEMA` | `pg_sync`, `raw` | Landing database and dlt dataset |
| `TRIGGER_FLIGHT_ID` | (none) | Transform Flight to start after a clean ingest |
| `DLT_BACKEND` | `sqlalchemy` | `pyarrow` is faster on wide tables |
| `PROBE_TIMEOUT_S` | `90` | How long to retry the first connection (scale-to-zero wake-up) |

**Transform.** Stored config is `CURATED_SCHEMA` plus `TARGET_DB`, `RAW_SCHEMA`,
`INCREMENTAL_TABLES` as empty placeholders. The ingest Flight passes the real values per run
through `MD_RUN_FLIGHT(config := MAP {...})`, which can only override keys a Flight already
defines. The table list is **not** configured anywhere on the transform: it discovers every table
in the raw schema (minus dlt's `_dlt_*`). The ingest Flight is the single source of truth, and
MotherDuck records the effective config on each transform run (`MD_LIST_FLIGHT_RUNS ... config`).

## What a run does

Ingest (`config → probe → target → extract → normalize → load → trigger`):

1. Validate config and secrets.
2. Check the host against the provider table above and stop on a form that cannot work from a
   Flight, then retry a real Postgres handshake until it answers or `PROBE_TIMEOUT_S` passes.
3. `CREATE DATABASE IF NOT EXISTS`, then dlt `sync_destination()` to restore cursors from
   `_dlt_pipeline_state`, `extract`, `normalize`, `load`. Each dlt stage reports its own
   Explainer state; `load` reports one instance per table with the rows written.
4. Trigger the transform with the raw location and the incremental list.

Transform (`config → check → snapshot → merge → verify`):

1. Discover raw tables; fail if an incremental table is not among them.
2. Snapshot tables: `CREATE OR REPLACE TABLE curated.t AS SELECT * EXCLUDE (_dlt_id) FROM raw.t`.
3. Incremental tables: first run builds `curated.t` from a full dedupe of raw. Later runs take
   raw rows with `_dlt_load_id` newer than the max already in curated, dedupe them per key with
   `max_by(row, (cursor, _dlt_load_id))`, keep the versions newer than curated's (a NULL cursor in
   curated counts as oldest), then inside one transaction: `CREATE TEMP TABLE changes AS ...`,
   `DELETE FROM curated.t USING changes ...`, `INSERT INTO curated.t BY NAME SELECT * FROM changes`,
   `COMMIT`. Curated keeps `_dlt_load_id`, so it is its own watermark; there is no state table.
4. Verify: distinct raw keys == curated rows == curated keys, or the run fails.

## The first run

With no stored state, dlt reads **every row** of each table once and appends it to raw, then
saves the max cursor. From the second run on, only rows at or after that value are read. For a
large table, bound the first run with one of:

- `dlt.sources.incremental(cursor, initial_value=...)` in `build_source()`, if rows older than a
  date are not needed in raw. Curated then only knows rows updated since that date.
- A one-time backfill outside the Flight (Postgres → Parquet in S3 → `read_parquet` on a
  Duckling), then start dlt with `initial_value` at the backfill cut-off.

dlt uses `>=` on the cursor and dedupes rows equal to the last value by primary key, so a row
updated exactly at the watermark is not loaded twice.

## Design notes

- **Append-only raw, then delete+insert.** Appends are the cheapest write, raw keeps every version
  the source ever showed, and curated can be dropped and rebuilt from raw without touching
  Postgres. The price is storage that grows forever (decide a retention rule) and one more Flight
  to watch.
- **Delete+insert in one transaction, not `MERGE INTO`.** DuckDB runs a whole-row `UPDATE` as its
  slow path (about 3x slower than delete+insert at 5M rows in our measurements), MERGE's bare
  `INSERT` is positional, and a `WHEN MATCHED AND s.cursor >= c.cursor` guard silently matches
  nothing on a NULL. MotherDuck supports multi-statement transactions on a single database, so
  the DELETE and INSERT commit together: a concurrent reader (a Dive refreshing at 7 AM) sees
  either the old rows or the new rows, never the gap. Verified with a second connection polling
  curated between the statements (old rows until COMMIT), with an error before COMMIT (rolled
  back), and with the writer's connection closed mid-transaction (nothing changed).
- **No primary keys or indexes anywhere.** A PK in MotherDuck builds an ART index that must fit
  in memory on every build; on large tables that is a known OOM source, and an
  `INSERT OR REPLACE` against it probes the whole table on every run.
- **State survives stateless containers.** dlt stores its cursors in
  `<TARGET_DB>.<raw>._dlt_pipeline_state`; a fresh Flight container restores them on
  `sync_destination()`. Calling `extract/normalize/load` separately skips that call, which is
  why the ingest makes it explicitly.
- **Schema evolution.** New Postgres columns flow into raw as nullable (a
  `table_adapter_callback` relaxes NOT NULL, because DuckDB rejects `ADD COLUMN ... NOT NULL`),
  and the transform adds them to curated before applying changes, then inserts `BY NAME`, so
  column order never matters.
- **Switching a table's cursor column** resets dlt's state for it and re-reads the table once
  into raw. The transform's dedupe absorbs it.
- **In `merge` mode** the ingest passes an empty incremental list, so the transform snapshots
  everything; you can still run it for the curated copy, or skip the transform entirely.
- **Overlapping runs.** Flights do not skip a run when the previous one is still going. Two
  overlapping ingests both append (no conflict) and the transform's dedupe absorbs the duplicate
  rows; two overlapping transforms can conflict on the DELETE, and the loser fails and retries on
  the next trigger. Keep the schedule longer than a typical run.

## Running it locally

The ingest runs anywhere `MOTHERDUCK_TOKEN` and the `pg_*` variables are set, so you can test
against a throwaway Postgres before creating the Flight:

```bash
export MOTHERDUCK_TOKEN=...
export pg_DATABASE_URL='postgresql://user:pass@host:5432/db?sslmode=require'
export TABLES=customers,orders INCREMENTAL_TABLES=orders:updated_at:id TARGET_DB=pg_sync_test
uv run --no-project --python 3.12 --with-requirements ingest/requirements.txt python ingest/flight.py
TARGET_DB=pg_sync_test RAW_SCHEMA=raw INCREMENTAL_TABLES=orders:updated_at:id \
uv run --no-project --with duckdb==1.5.6 python transform/flight.py
```

`PG_SSLMODE=disable` (or `?sslmode=disable` in the URL) is needed for a local Postgres without
TLS; the probe logs a warning.

## Limits to know before relying on it

| Constraint | Value | Effect |
| --- | --- | --- |
| Flight max runtime | 1 h (Lite), 8 h by default (Business, Enterprise); [plan limits](https://motherduck.com/docs/concepts/flights/#availability-and-plan-limits) | The first full read of a large table has to fit, or be backfilled another way |
| Per-run setup | fresh container, dlt install (~10 s), one Postgres connection | Minutes between runs is fine; seconds is not |
| Read path | Postgres → Python (dlt) → MotherDuck | Slower than DuckDB's streaming `postgres` extension on a one-off full copy; faster over time once tables are incremental |
| Deletes | not seen by incremental tables | Soft deletes, or an occasional full refresh of the table |
