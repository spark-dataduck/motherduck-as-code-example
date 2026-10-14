# Workflow Tower

A swimlane lineage board over a data pipeline's own telemetry: a data pipeline watching itself.
Every source, Flight, table, export, share and consumer is a card with a status; edges show either
what writes what (**Data flow**) or which Flight kicks off which (**Triggers**). Clicking a card
opens that node's own history in place: run history for a Flight, load history and row counts for
a table.

The board is **pipeline-agnostic**. It knows nothing about which Flights or tables exist. Lanes come
from node *types*, scopes from the `app` tags on the nodes, the collector's own name from the one
Flight tagged `app = 'all'`. Point it at any database with an `ops` schema that follows the
contract below and it draws that pipeline instead.

| File | What it is |
|---|---|
| `dive.tsx` | The Dive: one React file, default export. `REQUIRED_DATABASES` is kept on one line because `deploy.sh` strips it before upload. |
| `queries.sql` | Every query the Dive runs, verbatim, ready to paste into a notebook. |

The deployed copy reads `demo_workflow_tower`, a frozen snapshot of a six-Flight demo pipeline
(three sources, ingest → enrich → build Flights, `raw | intermediate | marts` tables, an export
handoff, an org share, two consumers), through the org-wide share `demo_workflow_tower_share`.
Nothing re-collects it, which is why every age on the board is measured from the collector's stamp
rather than the viewer's clock (see *Ages* below).

## Two halves

```
 your pipeline  ──►  collector Flight  ──►  ops.* tables  ──►  this Dive
 (Flights, dbt,       (runs as the same       (one snapshot,      (reads, draws,
  tables, S3)          identity as the         rewritten on        never computes
                       pipeline)               every run)          health itself)
```

**Flights and their runs are identity-scoped.** `MD_LIST_FLIGHTS()` returns only the caller's
own Flights and `MD_LIST_FLIGHT_RUNS()` needs a `flight_id`, so a Dive viewer reading through a
share can never see a service account's Flights directly. A collector Flight that runs *as* the
pipeline's identity snapshots what it can see into plain tables, and the Dive reads those. All of
the "is it stale / failing / miswired" computation happens upstream in the collector; the Dive only
renders what it is told. That also keeps it cheap: six small queries on load, two more when a node
is selected.

## What is on screen

- **Sidebar.** Whole-pipeline status tiles (a count per state; fixed, they do not move with the
  scope), then the scopes: *Everything*, followed by one row per distinct `app` tag in pipeline
  order, each with a rolled-up status chip and a `N flights · N tables` count. The footer says when
  the collector last ran and when this view last loaded, with ↻ Refresh and a *go live* toggle that
  re-polls every 15 seconds.
- **Board.** Four fixed swimlanes: **Sources**, **Flights**, **Tables**, **Outputs**. A node's lane
  is its kind, so there is no graph solver and no shape can fail to lay out. Inside Tables the
  schemas are side-by-side band columns under one lane header, which keeps a large pipeline inside
  the viewport. Cards stack in the collector's `ord`, so the board reads in pipeline order. Same-
  column edges (a Flight triggering a Flight, a share feeding a consumer) bow into a gutter of their
  own. An empty lane is not drawn. Zoom with + / − / Fit, drag to pan.
- **Cards.** Name, kind tag + status pill, an age (`last run 4h ago · SUCCEEDED` for a Flight,
  `written 4h ago` for a table), and a fourth line (`cron …` / `on trigger`, or `60 rows`).
- **Detail panel (click a node).** A **Flight** shows its run history (newest first, up to 200)
  with status, UTC start, duration and a bar. A **table** shows a KPI row (rows, last written,
  loads on the collection day) over its load history, one row per load with rows added and
  removed: the "did my mart actually get inserts today" view. A **source or output** shows
  *feeds into* / *fed by*. `Esc`, ✕, or clicking the card again closes it.
- **Recent runs** and **Freshness** when nothing is selected: the last 60 Flight runs in scope,
  and row counts / last-write ages per table plus object counts and bytes per S3 prefix, with
  empty ones highlighted.
- **Hover / selection** lights the focused node and everything one edge away; the rest dims.

### Ages

Every age is `epoch(AS_OF - ts)` where `AS_OF` is `max(collected_at)` from `ops.collect_log`.
Statuses in `ops.objects` were computed by the collector at that moment; an age that kept moving
while its status stood still would contradict it. The sidebar footer is the one place `now()` is
used: it says how old the collection itself is.

### Shareable state

| key | values | default |
|---|---|---|
| `scope` | `all`, or any `app` tag present in `ops.objects` | `all` |
| `view` | `data`, `trigger` | `data` |
| `node` | a `node_id` present in `ops.objects`, or `""` | `""` |

Each is clamped to a known value on read, and a selected node's name passes a sanitizer
(`[A-Za-z0-9_.:-]` only) before it is inlined into the panel's `WHERE` clause.

## The ops contract

Six tables in an `ops` schema, **rewritten whole on every collector run** (`CREATE OR REPLACE
TABLE` then bulk insert, never an append).

```sql
CREATE SCHEMA IF NOT EXISTS ops;

CREATE OR REPLACE TABLE ops.objects (          -- one row per pipeline node
  ord             INTEGER,      -- position in pipeline order; stacks cards, orders scopes
  node_id         VARCHAR,      -- '<type>:<name>', e.g. 'flight:build-marts', 'table:marts.fct_order'
  node_type       VARCHAR,      -- source | flight | table | export | share | consumer
  name            VARCHAR,      -- Flight slug, or 'schema.table'; [A-Za-z0-9_.:-] only
  app             VARCHAR,      -- scope tag; the collector Flight itself is 'all'
  detail          VARCHAR,      -- one sentence for the detail panel header
  schedule_cron   VARCHAR,      -- Flights; NULL means 'on trigger'
  status          VARCHAR,      -- ok | warn | fail | idle | unknown (unknown renders as idle)
  last_run_at     TIMESTAMPTZ,  -- Flights
  last_run_status VARCHAR,      -- Flights; RUN_STATUS_SUCCEEDED | RUN_STATUS_FAILED | RUN_STATUS_RUNNING | ...
  last_run_age_s  BIGINT,       -- Flights, at collection time (informational)
  row_count       BIGINT,       -- tables
  fresh_at        TIMESTAMPTZ,  -- tables: last write
  url             VARCHAR       -- optional deep link; shows 'open in MotherDuck ↗' when set
);

CREATE OR REPLACE TABLE ops.edges (            -- the static graph
  src_node VARCHAR, dst_node VARCHAR,
  kind     VARCHAR                             -- data | trigger
);

CREATE OR REPLACE TABLE ops.runs (             -- one row per Flight run
  flight_name VARCHAR, flight_id VARCHAR, run_number BIGINT,
  is_scheduled BOOLEAN,                        -- true = cron, false = triggered
  status      VARCHAR,                         -- RUN_STATUS_* as MD_LIST_FLIGHT_RUNS returns it
  created_at TIMESTAMPTZ, started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ,
  duration_s DOUBLE, exit_code BIGINT
);

CREATE OR REPLACE TABLE ops.vitals (           -- one row per table or S3 prefix
  name VARCHAR,                                -- 'schema.table' or an s3:// prefix
  kind VARCHAR,                                -- table | prefix
  row_count BIGINT, objects BIGINT, bytes BIGINT, fresh_at TIMESTAMPTZ
);

CREATE OR REPLACE TABLE ops.table_loads (      -- one row per load that wrote a table
  table_name VARCHAR, snapshot_id BIGINT,      -- snapshot_id: monotonic per table
  snapshot_time TIMESTAMPTZ,
  change VARCHAR,                              -- created | inserted | deleted | dropped | altered
  rows_added BIGINT, rows_removed BIGINT, files_added BIGINT
);

CREATE OR REPLACE TABLE ops.collect_log (      -- one row per collector run; max(collected_at) is AS_OF
  collected_at TIMESTAMPTZ,
  objects INTEGER, edges INTEGER, runs INTEGER, vitals INTEGER, table_loads INTEGER
);
```

Conventions the Dive relies on:

- The `node_id` type prefix decides the lane: `source` → Sources, `flight` → Flights, `table` →
  Tables, everything else → Outputs. One exception: an `export` whose data edge points into a
  Flight is drawn with the Sources (an inbound hop, such as a vendor dropping files into S3 that an
  ingest Flight picks up).
- A table's **band** inside the Tables lane is the schema prefix of its `name`. Tables in a schema
  with no configured band still draw, in an unbanded column after the configured ones.
- `ops.runs.flight_name` and `ops.table_loads.table_name` must equal the node's `name` exactly.
- Run statuses map SUCCEEDED → ok, FAILED → fail, RUNNING → warn, anything else → idle.
- `ord` is read in a separate query whose failure is swallowed, so a snapshot without that column
  still draws (lanes fall back to type order, then name).

### Status rules the reference collector applied

| Node type | Rule |
|---|---|
| flight | last run SUCCEEDED and (no cron, or age < 2 × cron period) → `ok`; SUCCEEDED but older than 2 × period → `warn`; FAILED → `fail`; no run yet → `idle`; RUNNING / CANCELLED / other → `warn` |
| table | `row_count > 0` → `ok`, else `warn` |
| source, export, share, consumer | inherit: walk the data edges to the nearest Flights/tables; `ok` only if all of them are `ok`, otherwise `warn`; nothing connected → `unknown` |

Roll-ups take the worst status present: fail > warn > idle > ok.

## Writing a collector Flight

It is **one Flight, one run, one full rewrite**. There is no Flight per source, table or database:
a single collector walks the whole pipeline in one process and ends by `CREATE OR REPLACE`-ing all
six `ops` tables, `collect_log` last. Two reasons. Every status and age on the board then comes from
one moment, the `collect_log` stamp, so a Flight checked at 01:00 is never shown beside a table
checked at 03:00. And each Flight run pays a fixed startup cost of roughly 20 seconds before any
work, so one run a day is cheaper than six.

The reference collector is a Python Flight on a daily cron, also triggered as the last link of the
pipeline's trigger chain so the board refreshes right after each build. Its shape:

1. **Static graph, hand-authored in code.** `NODES` (a list in pipeline order; the index becomes
   `ord`) and `EDGES` (`(src, dst, kind)` tuples). The graph's shape does not change at runtime,
   so it lives in the collector, not in a table maintained by hand.
2. **Flights and runs.** `MD_LIST_FLIGHTS()` and, per Flight, `MD_LIST_FLIGHT_RUNS(flight_id := …)`,
   run **as the identity that owns the pipeline Flights**. Exclude the collector's own in-progress
   run from "latest run" or it always shows as RUNNING. Derive `schedule_cron`, `last_run_*` and
   the Flight status from this.
3. **Vitals.** `row_count` per table and `fresh_at` = the last write (a load watermark column if
   the ingest tool lands one, otherwise the newest load below). S3 prefixes via `glob()` over
   `httpfs`.
4. **Table loads.** On DuckLake, read the snapshot catalog: one row per snapshot that wrote a
   table, with rows added and removed. On native MotherDuck tables with dbt, read
   `target/run_results.json`: one row per model per invocation from `adapter_response.rows_affected`,
   `change = 'inserted'` for incremental runs and `'created'` for full rebuilds, a monotonically
   increasing `snapshot_id`, accumulated across runs. This is the "a mart got zero inserts because
   upstream did not change" signal.
5. **Objects.** Apply the status rules to every node and write all six tables, `collect_log` last.

Notes from building the reference: in the Flight runtime DuckDB reports `TimeZone = 'Etc/Unknown'`,
which breaks the Python client decoding `TIMESTAMPTZ` from `MD_LIST_FLIGHT_RUNS()`, so run
`SET TimeZone = 'UTC'` first and ship `pytz`. Bulk-insert through `read_json` with an explicit
`columns=` map built from the same list used for `CREATE TABLE`, so the two cannot drift. Views
have no row count or load history worth collecting; either edge raw tables straight to the marts
they feed or include the views as nodes with inherited status and no vitals.

## Customizing the Dive

Configuration sits at the top of `dive.tsx`; everything below the layout functions is rendering.

- **Data source.** `REQUIRED_DATABASES` (one line) and the `DB` alias. Use a share, not a
  `database` requirement: a `database` resolves only for its owner, while an `ACCESS ORGANIZATION`
  share resolves for everyone who opens the Dive. The alias must differ from the database's own
  name or the owner's ATTACH collides with their real catalog. `AS_OF` and every query are built
  from `DB`.
- **Bands and lanes.** `BANDS` keys must match schema names exactly and are left-to-right order;
  adding one widens the Tables lane by a column. `LANES` holds the four labels and tints,
  `TYPE_TAG` the three-letter chips. The header string `DEMO WORKFLOW TOWER` and the component
  name are the only places the demo's name appears in rendered output.
- **Screenshot gallery.** The demo's `raw.screenshots` node shows ticket screenshots as thumbnails
  (`SCREENSHOTS_NODE`, `RAW`, the `shot` state with `shotsQ` / `shotImageQ`, and the
  `isShotsSel` branch of `DetailPanel`). Delete it for a pipeline without such a table; leaving it
  is harmless, the queries collapse to `SELECT NULL WHERE false` unless that exact node is selected.
- **Status vocabulary.** `STATUS` (colour, glyph, label per status), `runStatus()` for
  `RUN_STATUS_*`, `ageLabel()` / `fmtDur()` for formatting.
- **Theme.** One token object `C` plus two font stacks. The look is deliberately light: paper
  tones, 1.5 px ink borders, hard offset shadows, no radius, sun-yellow actives. Re-theming is a
  token swap, but every lane and band tint is a *fill*, so re-pick those with borders at or above
  3:1 against the new canvas and compute the contrast rather than eyeballing it. The Dives runtime
  CSP blocks external fonts and images: a logo must be inline SVG, a typeface must already be
  installed or fall back to the stack.
- **Polling.** `POLL_MS` is the *go live* interval; polling re-issues every query, so size it to
  how often the collector writes. `withRefresh(sql, tick)` prepends a `-- refresh:N` comment so
  `useSQLQuery` sees a new string.

Runtime constraints: one file, default export, static imports only (`react`,
`@motherduck/react-sql-query`, `recharts`, `d3`, `lucide-react`); no `fetch()` outside
`*.motherduck.com`; timestamps formatted in SQL and numerics coerced with `N()` at the point of use,
because values arrive as strings, BigInts or Decimals depending on the path; booleans read as
`true`, `1` or `"true"`.

## Deploying your own

Create the share on the database that holds `ops` (`CREATE SHARE … (ACCESS ORGANIZATION,
VISIBILITY DISCOVERABLE, UPDATE AUTOMATIC)`; `UPDATE AUTOMATIC` carries `CREATE OR REPLACE TABLE`
through, a brand-new table or schema still needs `UPDATE SHARE`), put its `md:_share/…` URL in
`REQUIRED_DATABASES` and in the manifest's `required_resources`, attach it under the alias and
`.read queries.sql` from the CLI to prove the schema, then let `deploy.sh` create or update the
Dive by title. If any share in `REQUIRED_DATABASES` is not accessible to a viewer, the runtime
replaces the whole Dive with "Share not accessible", so test with a non-owner account.
