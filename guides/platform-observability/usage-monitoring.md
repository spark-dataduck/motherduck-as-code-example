# Usage monitoring with QUERY_HISTORY

How to attribute MotherDuck compute to the thing that caused it — a Dive, an MCP
client, or a Flight — using only surfaces a customer can reach. Every rule below
was verified against real `user_agent` values.

Two altitudes. **Account-wide** ("our spend moved — what changed?") classifies
every row into exactly one workload so the shares add to 100%; that is
`Overall Usage Monitoring`. **Per-surface** ("which Dive, which MCP client")
goes deep on one bucket. Start account-wide, then descend.

## Rules

- **`MD_INFORMATION_SCHEMA.QUERY_HISTORY` is the only org-wide source.** It
  requires org admin on a Business plan and has a small ingestion delay.
- **Attribute by `user_agent`, not by `query_text`.** MotherDuck stamps the
  originating surface into the user agent; matching on query text is fragile.
  The one legitimate use of `query_text` is classifying *load shape* — full
  refresh vs incremental — because no column carries that.
- **Compute follows the viewer, not the owner.** A Dive in the UI runs on the
  viewer's duckling; an embedded Dive runs on read-scaling ducklings of the user
  its embed session was created for.
- **Execution time is attribution, not a bill line item.** Dive queries are
  priced as ordinary compute. Flight-hour charges are separate and appear in the
  billing portal. See "How far is exec_s from the bill" below before quoting a
  number at anyone.
- **Do not double-count Dives-in-MCP-apps.** A Dive rendered inside an MCP app
  matches *both* `%md-dive%` and `%mcp%`. Pick one home for it: these dives
  count it as a Dive, and the MCP breakdown excludes it explicitly.
- **When classifying every row, CASE arm order is load-bearing.**
  `md-dives-mcp-app` contains `mcp`; `hatchling` and `md-dives` are both
  `motherduck-wasm`. Reorder the arms and traffic moves buckets silently.

## The user_agent taxonomy

| Pattern | Surface | Carries an ID? |
| --- | --- | --- |
| `md-dives/v1(<uuid>)` | Dive in the MotherDuck UI | Dive ID |
| `md-dive-embed/v1(<uuid>)` | Externally embedded Dive | Dive ID |
| `md-dives-mcp-app/v1/v1(<uuid>,transport=…)` | Dive inside an MCP app | Dive ID |
| `mcp-server-motherduck-remote/<ver>(<client>)` | MotherDuck MCP server | Client name |
| `md-flights` | Flight | **No** — see below |
| `hatchling` | MotherDuck notebook UI | No |
| `pgendpoint` | Postgres endpoint | No |
| `dbt/<ver> dbt-duckdb/<ver>` | dbt | No |
| `cli` | DuckDB CLI | No |
| `python/<ver>` or `node-neo-api` with no marker | External app, SDK, or CI job | No |

That last row is the one that matters for cost. A load pipeline running from CI
carries no MotherDuck marker at all, so it is only identifiable as "everything
else" — and it is routinely the largest consumer in an account. Run the
user-agent census (the bonus query in
`dives/overall-usage-monitoring/queries.sql`) before trusting any bucketing you
copied from here.

Note the doubled `/v1/v1` and the trailing `,transport=…` in the MCP-app form.
A regex that assumes a single `/v1` and a closing paren right after the UUID
silently drops those rows.

## Query patterns

Per-Dive compute, split by surface:

```sql
WITH dive_queries AS (
  SELECT
    regexp_extract(user_agent,
      'md-dive[s]?(?:-embed)?(?:-mcp-app)?/v1(?:/v1)?[(_]([0-9a-f\-]{36})', 1) AS dive_id,
    CASE
      WHEN user_agent LIKE '%md-dives-mcp-app%' THEN 'MCP app'
      WHEN user_agent LIKE '%md-dive-embed%'    THEN 'Externally embedded'
      WHEN user_agent LIKE '%md-dives%'         THEN 'MotherDuck UI'
    END AS surface,
    user_name AS viewer_name, execution_time, start_time
  FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
  WHERE user_agent LIKE '%md-dive%'
    AND start_time > now() - INTERVAL 30 DAY
),
dive_names AS (
  SELECT id::VARCHAR AS dive_id, title AS dive_name
  FROM MD_LIST_DIVES(include_org_shares := true)
)
SELECT coalesce(n.dive_name, '(deleted or not visible to me)') AS dive_name,
       q.surface,
       count(*)                               AS queries,
       round(sum(epoch(q.execution_time)), 1) AS exec_s,
       max(q.start_time)                      AS last_active
FROM dive_queries q
LEFT JOIN dive_names n USING (dive_id)
WHERE q.dive_id <> ''
GROUP BY ALL
ORDER BY exec_s DESC;
```

MCP traffic by calling client:

```sql
SELECT regexp_extract(user_agent, 'mcp-server-motherduck-remote/([0-9.]+)\(([^)]*)\)', 2) AS mcp_client,
       count(DISTINCT user_name)            AS users,
       count(*)                             AS queries,
       round(sum(epoch(execution_time)), 1) AS exec_s
FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
WHERE user_agent LIKE '%mcp-server-motherduck%'
  AND user_agent NOT LIKE '%md-dive%'          -- do not double-count Dives in MCP apps
  AND start_time > now() - INTERVAL 30 DAY
GROUP BY ALL
ORDER BY queries DESC;
```

## Cost attribution: identity, load shape, cadence

When an account's spend moves, three questions answer it, in order.

**1. Which identity?** `user_name` is the billing-relevant grouping. One identity
holding most of `exec_s` is the signature of a shared token running several
unrelated jobs — the total is visible but the pipeline cannot be told apart from
the dashboard, so neither can be tuned. The fix is one service account per
workload, after which a `GROUP BY user_name` *is* the per-workload cost report.

**2. Full refresh or incremental?** No column carries this, so it comes from
`query_text`. `CREATE OR REPLACE TABLE`, `TRUNCATE`+reload, and
`CREATE TABLE … AS SELECT` rebuild the whole table every run; `INSERT … SELECT`
and `MERGE` touch only new rows. The distinction is what makes cadence
expensive: rescheduling a full refresh from daily to hourly multiplies its
compute ~24× on unchanged data, while an incremental load barely moves.

**3. How often does it run?** `count(DISTINCT date_trunc('hour', start_time))`
per day reads as a schedule without knowing the cron — 1–2 means nightly, ~24
means hourly. It counts distinct hours, so it is timezone-independent.

### The gotcha that eats an afternoon

`ltrim(s)` with no second argument trims **only spaces**. Pipeline SQL almost
always starts with a newline (heredocs, triple-quoted Python, templated SQL), so
`ltrim(query_text) LIKE 'CREATE%'` matches nothing and every load silently lands
in an "other" bucket. Normalize properly: strip `/* */` blocks, then `--` lines,
collapse whitespace, then `trim(…, ' ;')` for the leading semicolon that
multi-statement scripts leave behind.

Always ship a companion query listing whatever stayed unclassified. Running that
check is what revealed `TRUNCATE TABLE` — a full refresh that would otherwise
have been miscounted as "other" — in this very account.

## How far is exec_s from the bill

MotherDuck bills **duckling uptime per second**. `sum(execution_time)` differs
from uptime in both directions:

- it **under-counts**, because a duckling stays warm between queries (plus
  ~100 ms startup and a ~1 s cooldown), and that idle-but-alive time is real;
- it **over-counts**, because two queries running *concurrently* on one duckling
  each accrue their own wall-clock `execution_time` against one billed second.

Merging overlapping `[start_time, end_time)` intervals per `duckling_id`
(gaps-and-islands; query 9 in `dives/overall-usage-monitoring/queries.sql`)
measures the second effect for a given account. A `concurrency_factor` near 1.0
means queries run sequentially and `exec_s` is a fair proxy; well above 1.0 means
`exec_s` overstates billed compute and the merged figure should be used instead.

Two more columns worth knowing:

- **`wait_time` is queueing.** Rising queue time on a shared identity is the
  argument *for* isolation, not against it — a dedicated duckling per service
  account removes the waiting rather than adding cost.
- **`bytes_uploaded` / `bytes_downloaded` are client ⇄ MotherDuck transfer.**
  They are **not** a cloud provider's cross-region egress bill. Use them to spot
  which workload is data-heavy; never to reconcile an invoice.

## What is not available

**Per-Flight compute attribution does not exist.** Flight connections appear as
`duckdb/… python/… md-flights` with no flight id, so `QUERY_HISTORY` can tell
you how much compute Flights used in total, but not which Flight used it. For
per-Flight health use `MD_LIST_FLIGHT_RUNS` instead — see the `flights` topic —
and remember those functions are scoped to the calling identity.

**Per-database and per-table attribution does not exist either.**
`QUERY_HISTORY` has no `database_name` column. Parsing table names out of
`query_text` is the only route, and it is fragile enough that it belongs in an
ad-hoc investigation rather than a dashboard.
