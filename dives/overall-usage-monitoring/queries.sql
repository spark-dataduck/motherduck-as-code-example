-- Overall usage monitoring
--
-- The exact queries behind the "Overall Usage Monitoring" dive, ready to paste
-- into a MotherDuck notebook. Change `INTERVAL 30 DAY` to widen or narrow the
-- window.
--
-- Requires org admin on a Business plan: MD_INFORMATION_SCHEMA.QUERY_HISTORY is
-- org-scoped and has a small ingestion delay.
--
-- WHERE THIS SITS AMONG THE OTHER MONITORING DIVES
--
-- `Dive Usage Monitoring`, `MCP Usage Monitoring`, and `Flight Usage Monitoring`
-- each take one surface and go deep. This one is the roof over all of them: it
-- classifies EVERY row in QUERY_HISTORY into exactly one workload, so the shares
-- add to 100% and nothing falls through. Start here to find out which workload
-- grew, then open that surface's dive to find out why.
--
-- The question it exists to answer: *our MotherDuck spend changed — what moved?*
--
--
-- HONEST LIMITS — READ BEFORE QUOTING A NUMBER AT ANYONE
--
-- `sum(execution_time)` is ATTRIBUTION, NOT A BILL. MotherDuck bills duckling
-- uptime per second, and execution_time differs from uptime in both directions:
--   * it UNDER-counts, because a duckling stays warm between queries (plus
--     ~100 ms startup and a ~1 s cooldown) and that idle-but-alive time is real;
--   * it OVER-counts, because two queries running CONCURRENTLY on one duckling
--     each accrue their own wall-clock execution_time against one billed second.
-- Query 9 quantifies the second effect for your own account. The billing portal
-- is the only authority on money; everything here is for finding the WORKLOAD
-- that moved.
--
-- `bytes_uploaded` / `bytes_downloaded` are client <-> MotherDuck transfer. They
-- are NOT your cloud provider's cross-region egress bill. Useful as a relative
-- signal of which workload is data-heavy; not a substitute for the invoice.
--
--
-- TWO GOTCHAS THAT COST REAL TIME
--
-- 1. `ltrim(s)` with no second argument trims ONLY SPACES. Almost every query
--    logged by a pipeline starts with a NEWLINE (heredocs, triple-quoted Python
--    strings, templated SQL), so `ltrim(query_text) LIKE 'CREATE%'` silently
--    matches nothing and every load lands in an "other" bucket. Query 6
--    normalizes with regexp_replace instead: strip `/* */` blocks, then `--`
--    lines (dbt and hand-written SQL both put comments up top), collapse
--    whitespace, then `trim(..., ' ;')` for the leading semicolon that
--    multi-statement scripts leave behind.
--
-- 2. CASE arm ORDER is load-bearing in query 1. `md-dives-mcp-app` contains
--    `mcp`; `hatchling` and `md-dives` are both `motherduck-wasm`. Reorder the
--    arms and traffic quietly moves between buckets.


-- 1. Compute by workload -----------------------------------------------------
-- Every row lands in exactly one bucket, so pct_exec sums to 100. The final
-- ELSE is the interesting one: an external app or SDK with no MotherDuck marker
-- in its user agent — a CI job, an Airflow task, a load script. That bucket is
-- usually where an unexplained bill increase is hiding, and it is exactly the
-- traffic that becomes attributable once each pipeline gets its own service
-- account instead of sharing one personal token.
SELECT
  CASE
    WHEN user_agent LIKE '%md-flights%'            THEN 'Flight'
    WHEN user_agent LIKE '%md-dives-mcp-app%'      THEN 'Dive (MCP app)'
    WHEN user_agent LIKE '%md-dive-embed%'         THEN 'Dive (embedded)'
    WHEN user_agent LIKE '%md-dive%'               THEN 'Dive (MotherDuck UI)'
    WHEN user_agent LIKE '%mcp-server-motherduck%' THEN 'MCP server'
    WHEN user_agent LIKE '%hatchling%'             THEN 'Notebook UI'
    WHEN user_agent LIKE '%pgendpoint%'            THEN 'Postgres endpoint'
    WHEN user_agent LIKE '%dbt%'                   THEN 'dbt'
    WHEN user_agent LIKE '%cli%'                   THEN 'DuckDB CLI'
    WHEN user_agent LIKE '%motherduck-wasm%'       THEN 'MotherDuck UI (other)'
    ELSE 'External app / SDK'
  END                                                     AS workload,
  count(*)                                                AS queries,
  round(sum(epoch(execution_time)), 1)                    AS exec_s,
  round(100.0 * sum(epoch(execution_time))
        / sum(sum(epoch(execution_time))) OVER (), 1)     AS pct_exec,
  round(coalesce(sum(epoch(execution_time)) FILTER (query_type = 'QUERY'), 0), 1)        AS read_s,
  round(coalesce(sum(epoch(execution_time)) FILTER (query_type IN ('DDL','DML')), 0), 1) AS write_s,
  round(sum(epoch(wait_time)), 1)                         AS queue_s,
  count(DISTINCT user_name)                               AS identities,
  count(DISTINCT duckling_id)                             AS ducklings,
  string_agg(DISTINCT instance_type, ', ')                 AS instance_types,
  round(sum(bytes_uploaded + bytes_downloaded) / 1e9, 2)  AS gb_moved,
  round(sum(bytes_spilled_to_disk) / 1e9, 2)              AS gb_spilled,
  count(*) FILTER (error_message IS NOT NULL)             AS errors,
  max(start_time)                                         AS last_active
FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
WHERE start_time > now() - INTERVAL 30 DAY
GROUP BY ALL
ORDER BY exec_s DESC;

-- read_s + write_s does NOT equal exec_s: query_type TCL (transaction control)
-- is neither a read nor a write. The dive states that residue rather than
-- rounding it away.


-- 1b. Drill-down: workload x identity x duckling size -------------------------
-- What the dive expands under a clicked "By workload" row. The grain is small by
-- construction — about 125 rows over 90 days in a busy org — so the dive fetches
-- it ONCE and rolls it up in the browser instead of re-querying per click.
--
-- count(DISTINCT duckling_id) at this grain is exact per size. Summing across
-- sizes for one identity is exact too, UNLESS a duckling was resized mid-window,
-- in which case one duckling appears under two sizes.
SELECT
  CASE
    WHEN user_agent LIKE '%md-flights%'            THEN 'Flight'
    WHEN user_agent LIKE '%md-dives-mcp-app%'      THEN 'Dive (MCP app)'
    WHEN user_agent LIKE '%md-dive-embed%'         THEN 'Dive (embedded)'
    WHEN user_agent LIKE '%md-dive%'               THEN 'Dive (MotherDuck UI)'
    WHEN user_agent LIKE '%mcp-server-motherduck%' THEN 'MCP server'
    WHEN user_agent LIKE '%hatchling%'             THEN 'Notebook UI'
    WHEN user_agent LIKE '%pgendpoint%'            THEN 'Postgres endpoint'
    WHEN user_agent LIKE '%dbt%'                   THEN 'dbt'
    WHEN user_agent LIKE '%cli%'                   THEN 'DuckDB CLI'
    WHEN user_agent LIKE '%motherduck-wasm%'       THEN 'MotherDuck UI (other)'
    ELSE 'External app / SDK'
  END                                              AS workload,
  user_name,
  instance_type,
  count(DISTINCT duckling_id)                      AS ducklings,
  count(*)                                         AS queries,
  round(sum(epoch(execution_time)), 1)             AS exec_s,
  round(coalesce(sum(epoch(execution_time)) FILTER (query_type = 'QUERY'), 0), 1)        AS read_s,
  round(coalesce(sum(epoch(execution_time)) FILTER (query_type IN ('DDL','DML')), 0), 1) AS write_s,
  count(*) FILTER (query_type = 'QUERY')           AS read_queries,
  count(*) FILTER (query_type IN ('DDL','DML'))    AS write_queries,
  round(sum(epoch(wait_time)), 1)                  AS queue_s,
  max(start_time)                                  AS last_active
FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
WHERE start_time > now() - INTERVAL 30 DAY
GROUP BY ALL
ORDER BY exec_s DESC;


-- 2. Compute by identity -----------------------------------------------------
-- The cost-attribution table. One identity holding a large share of exec_s is
-- the signature of a shared token doing several unrelated jobs — you can see
-- the total but you cannot tell the pipeline from the dashboard, so you cannot
-- tune either one. The fix is one service account per workload; then this table
-- becomes the per-workload cost report for free.
--
-- write_queries / read_queries splits load from consumption. An identity that is
-- almost all writes is a pipeline; almost all reads is a person or a BI tool.
SELECT
  user_name,
  count(*)                                                AS queries,
  round(sum(epoch(execution_time)), 1)                    AS exec_s,
  round(100.0 * sum(epoch(execution_time))
        / sum(sum(epoch(execution_time))) OVER (), 1)     AS pct_exec,
  count(*) FILTER (query_type IN ('DDL', 'DML'))          AS write_queries,
  count(*) FILTER (query_type = 'QUERY')                  AS read_queries,
  round(sum(epoch(wait_time)), 1)                         AS queue_s,
  count(DISTINCT duckling_id)                             AS ducklings,
  string_agg(DISTINCT instance_type, ', ')                 AS instance_types,
  round(sum(bytes_uploaded + bytes_downloaded) / 1e9, 2)  AS gb_moved,
  count(*) FILTER (error_message IS NOT NULL)             AS errors,
  max(start_time)                                         AS last_active
FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
WHERE start_time > now() - INTERVAL 30 DAY
GROUP BY ALL
ORDER BY exec_s DESC
LIMIT 100;


-- 3. Headline numbers with period-over-period comparison ----------------------
-- One pass covers both halves: FILTER splits current from previous. Scan 2x the
-- window so both halves are present.
SELECT
  count(*) FILTER (start_time > now() - INTERVAL 30 DAY)                              AS cur_queries,
  count(*) FILTER (start_time <= now() - INTERVAL 30 DAY)                             AS prev_queries,
  round(sum(epoch(execution_time)) FILTER (start_time > now() - INTERVAL 30 DAY), 1)  AS cur_exec_s,
  round(sum(epoch(execution_time)) FILTER (start_time <= now() - INTERVAL 30 DAY), 1) AS prev_exec_s,
  round(sum(epoch(wait_time)) FILTER (start_time > now() - INTERVAL 30 DAY), 1)       AS cur_queue_s,
  round(sum(epoch(wait_time)) FILTER (start_time <= now() - INTERVAL 30 DAY), 1)      AS prev_queue_s,
  count(DISTINCT user_name) FILTER (start_time > now() - INTERVAL 30 DAY)             AS cur_identities,
  count(DISTINCT duckling_id) FILTER (start_time > now() - INTERVAL 30 DAY)           AS cur_ducklings,
  count(*) FILTER (error_message IS NOT NULL
                   AND start_time > now() - INTERVAL 30 DAY)                         AS cur_errors,
  round(sum(bytes_uploaded + bytes_downloaded)
        FILTER (start_time > now() - INTERVAL 30 DAY) / 1e9, 2)                       AS cur_gb_moved,
  round(sum(bytes_spilled_to_disk)
        FILTER (start_time > now() - INTERVAL 30 DAY) / 1e9, 2)                       AS cur_gb_spilled
FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
WHERE start_time > now() - INTERVAL 60 DAY;


-- 4. Daily compute by workload, on a date spine -------------------------------
-- The spike chart. Without the spine a silent day vanishes from the result
-- instead of plotting as zero — and a workload STOPPING is as informative as
-- one starting.
WITH spine AS (
  SELECT unnest(generate_series(
    date_trunc('day', now() - INTERVAL 30 DAY)::TIMESTAMP,
    date_trunc('day', now())::TIMESTAMP, INTERVAL 1 DAY))::DATE AS day
),
hits AS (
  SELECT
    date_trunc('day', start_time)::DATE AS day,
    CASE
      WHEN user_agent LIKE '%md-flights%'            THEN 'Flight'
      WHEN user_agent LIKE '%md-dive%'               THEN 'Dive'
      WHEN user_agent LIKE '%mcp-server-motherduck%' THEN 'MCP server'
      WHEN user_agent LIKE '%hatchling%'             THEN 'Notebook UI'
      WHEN user_agent LIKE '%pgendpoint%'            THEN 'Postgres endpoint'
      WHEN user_agent LIKE '%dbt%'                   THEN 'dbt'
      WHEN user_agent LIKE '%cli%'                   THEN 'DuckDB CLI'
      WHEN user_agent LIKE '%motherduck-wasm%'       THEN 'MotherDuck UI (other)'
      ELSE 'External app / SDK'
    END AS workload,
    count(*)                             AS queries,
    round(sum(epoch(execution_time)), 1) AS exec_s
  FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
  WHERE start_time > now() - INTERVAL 30 DAY
  GROUP BY ALL
)
SELECT s.day, h.workload, coalesce(h.queries, 0) AS queries, coalesce(h.exec_s, 0) AS exec_s
FROM spine s LEFT JOIN hits h USING (day)
ORDER BY s.day, exec_s DESC;


-- 5. Biggest movers, this period vs last --------------------------------------
-- Ranks workloads by CHANGE rather than size, which is what you actually want
-- when a bill moves. A workload that doubled off a small base ranks by pct; the
-- one that added the most seconds ranks by delta_s. Read delta_s for money.
WITH w AS (
  SELECT
    CASE
      WHEN user_agent LIKE '%md-flights%'            THEN 'Flight'
      WHEN user_agent LIKE '%md-dive%'               THEN 'Dive'
      WHEN user_agent LIKE '%mcp-server-motherduck%' THEN 'MCP server'
      WHEN user_agent LIKE '%hatchling%'             THEN 'Notebook UI'
      WHEN user_agent LIKE '%pgendpoint%'            THEN 'Postgres endpoint'
      WHEN user_agent LIKE '%dbt%'                   THEN 'dbt'
      WHEN user_agent LIKE '%cli%'                   THEN 'DuckDB CLI'
      WHEN user_agent LIKE '%motherduck-wasm%'       THEN 'MotherDuck UI (other)'
      ELSE 'External app / SDK'
    END AS workload,
    start_time, execution_time
  FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
  WHERE start_time > now() - INTERVAL 60 DAY
)
SELECT
  workload,
  round(sum(epoch(execution_time)) FILTER (start_time >  now() - INTERVAL 30 DAY), 1) AS cur_exec_s,
  round(sum(epoch(execution_time)) FILTER (start_time <= now() - INTERVAL 30 DAY), 1) AS prev_exec_s,
  round(coalesce(sum(epoch(execution_time)) FILTER (start_time >  now() - INTERVAL 30 DAY), 0)
      - coalesce(sum(epoch(execution_time)) FILTER (start_time <= now() - INTERVAL 30 DAY), 0), 1)
                                                                                     AS delta_s,
  round(100.0 * (coalesce(sum(epoch(execution_time)) FILTER (start_time >  now() - INTERVAL 30 DAY), 0)
               - coalesce(sum(epoch(execution_time)) FILTER (start_time <= now() - INTERVAL 30 DAY), 0))
        / nullif(sum(epoch(execution_time)) FILTER (start_time <= now() - INTERVAL 30 DAY), 0), 1)
                                                                                     AS pct_change
FROM w
GROUP BY ALL
ORDER BY delta_s DESC;


-- 6. Load patterns: full refresh vs incremental -------------------------------
-- The root-cause query for "our load bill grew and we didn't add data".
--
-- `CREATE OR REPLACE TABLE` and `CREATE TABLE ... AS SELECT` rebuild the whole
-- table on every run. That is fine nightly and expensive hourly: moving a full
-- refresh from daily to hourly multiplies its compute ~24x while the data volume
-- is unchanged. `INSERT ... SELECT` and `MERGE` touch only new rows, so their
-- cost tracks data volume rather than schedule frequency.
--
-- Note the nested regexp_replace: strip /* block */ comments, then -- line
-- comments, then collapse all whitespace. See gotcha 1 in the header — without
-- this, leading newlines dump ~everything into the unclassified bucket.
--
-- This is the most expensive query here (it touches query_text for every write).
-- Narrow the window before widening anything else.
WITH w AS (
  SELECT
    upper(trim(regexp_replace(
      regexp_replace(
        regexp_replace(coalesce(query_text, ''), '(?s)/\*.*?\*/', ' ', 'g'),
        '--[^\n]*', ' ', 'g'),
      '\s+', ' ', 'g'), ' ;')) AS t,
    execution_time, user_name, start_time
  FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
  WHERE start_time > now() - INTERVAL 30 DAY
    AND query_type IN ('DDL', 'DML')          -- writes only; reads are query 1's job
)
SELECT
  CASE
    WHEN t LIKE 'CREATE OR REPLACE TABLE%'                                  THEN 'Full refresh (CREATE OR REPLACE)'
    WHEN t LIKE 'TRUNCATE%'                                                 THEN 'Full refresh (TRUNCATE + reload)'
    WHEN t LIKE 'CREATE TABLE%AS SELECT%' OR t LIKE 'CREATE TABLE%AS WITH%' THEN 'Full load (CTAS)'
    WHEN t LIKE 'INSERT INTO%SELECT%'                                       THEN 'Append from query (INSERT..SELECT)'
    WHEN t LIKE 'WITH %' AND t LIKE '%INSERT INTO%'                         THEN 'Append from query (INSERT..SELECT)'
    WHEN t LIKE 'INSERT INTO%'                                              THEN 'Append literal (INSERT..VALUES)'
    WHEN t LIKE 'MERGE INTO%'                                               THEN 'Incremental merge (MERGE)'
    WHEN t LIKE 'UPDATE %'                                                  THEN 'UPDATE'
    WHEN t LIKE 'DELETE FROM%'                                              THEN 'DELETE'
    WHEN t LIKE 'COPY %'                                                    THEN 'COPY'
    WHEN t LIKE 'CREATE%VIEW%'                                              THEN 'View definition'
    WHEN t LIKE 'CREATE TABLE%' OR t LIKE 'CREATE%SCHEMA%'                  THEN 'Create empty table/schema'
    WHEN t LIKE 'DROP %' OR t LIKE 'ALTER %' OR t LIKE 'COMMENT ON%'        THEN 'DROP / ALTER / COMMENT'
    ELSE 'Unclassified'
  END                                                 AS load_pattern,
  user_name,
  count(*)                                            AS queries,
  round(sum(epoch(execution_time)), 1)                AS exec_s,
  round(100.0 * sum(epoch(execution_time))
        / sum(sum(epoch(execution_time))) OVER (), 1) AS pct_write_exec,
  max(start_time)                                     AS last_active
FROM w
GROUP BY ALL
ORDER BY exec_s DESC;

-- 6b. The same thing rolled up to pattern level -------------------------------
-- This is the table the dive SHOWS; query 6 is what it FETCHES. Because query 6
-- is the expensive one (it reads query_text for every write), the dive runs it
-- once at identity grain and does this rollup in the browser rather than paying
-- for a second scan. Sums add and the identity count is an exact distinct count,
-- so nothing is lost by deriving it.
--
-- Contrast query 1b, whose parent (query 1) IS re-queried: a p95 and a
-- count(DISTINCT duckling_id) do not roll up correctly from a finer grain, so
-- those are computed where they belong.
WITH w AS (
  SELECT
    upper(trim(regexp_replace(
      regexp_replace(
        regexp_replace(coalesce(query_text, ''), '(?s)/\*.*?\*/', ' ', 'g'),
        '--[^\n]*', ' ', 'g'),
      '\s+', ' ', 'g'), ' ;')) AS t,
    execution_time, user_name, start_time
  FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
  WHERE start_time > now() - INTERVAL 30 DAY
    AND query_type IN ('DDL', 'DML')
)
SELECT
  CASE
    WHEN t LIKE 'CREATE OR REPLACE TABLE%'                                  THEN 'Full refresh (CREATE OR REPLACE)'
    WHEN t LIKE 'TRUNCATE%'                                                 THEN 'Full refresh (TRUNCATE + reload)'
    WHEN t LIKE 'CREATE TABLE%AS SELECT%' OR t LIKE 'CREATE TABLE%AS WITH%' THEN 'Full load (CTAS)'
    WHEN t LIKE 'INSERT INTO%SELECT%'                                       THEN 'Append from query (INSERT..SELECT)'
    WHEN t LIKE 'WITH %' AND t LIKE '%INSERT INTO%'                         THEN 'Append from query (INSERT..SELECT)'
    WHEN t LIKE 'INSERT INTO%'                                              THEN 'Append literal (INSERT..VALUES)'
    WHEN t LIKE 'MERGE INTO%'                                               THEN 'Incremental merge (MERGE)'
    WHEN t LIKE 'UPDATE %'                                                  THEN 'UPDATE'
    WHEN t LIKE 'DELETE FROM%'                                              THEN 'DELETE'
    WHEN t LIKE 'COPY %'                                                    THEN 'COPY'
    WHEN t LIKE 'CREATE%VIEW%'                                              THEN 'View definition'
    WHEN t LIKE 'CREATE TABLE%' OR t LIKE 'CREATE%SCHEMA%'                  THEN 'Create empty table/schema'
    WHEN t LIKE 'DROP %' OR t LIKE 'ALTER %' OR t LIKE 'COMMENT ON%'        THEN 'DROP / ALTER / COMMENT'
    ELSE 'Unclassified'
  END                                                 AS load_pattern,
  count(*)                                            AS queries,
  round(sum(epoch(execution_time)), 1)                AS exec_s,
  round(100.0 * sum(epoch(execution_time))
        / sum(sum(epoch(execution_time))) OVER (), 1) AS pct_write_exec,
  count(DISTINCT user_name)                           AS identities,
  max(start_time)                                     AS last_active
FROM w
GROUP BY ALL
ORDER BY exec_s DESC;

-- Sanity check for query 6: if `Unclassified` is more than a rounding error,
-- your account has a load shape the CASE above does not know about. Look at it
-- before trusting the split.
--
-- Running this is what surfaced two of query 6's arms: `TRUNCATE TABLE` (dbt and
-- many load scripts do truncate-then-insert, which is a FULL REFRESH and belongs
-- with CREATE OR REPLACE, not in an "other" bucket), and a leading `;` from
-- multi-statement scripts — hence the `trim(..., ' ;')`. Expect a small residue
-- of rows whose logged text begins mid-statement (`); CREATE ...`); those are
-- multi-statement artifacts, not a classification bug.
WITH w AS (
  SELECT
    upper(trim(regexp_replace(
      regexp_replace(
        regexp_replace(coalesce(query_text, ''), '(?s)/\*.*?\*/', ' ', 'g'),
        '--[^\n]*', ' ', 'g'),
      '\s+', ' ', 'g'), ' ;')) AS t
  FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
  WHERE start_time > now() - INTERVAL 30 DAY AND query_type IN ('DDL', 'DML')
)
SELECT left(t, 80) AS unclassified_shape, count(*) AS queries
FROM w
WHERE NOT (t LIKE 'CREATE%' OR t LIKE 'INSERT%' OR t LIKE 'MERGE%' OR t LIKE 'UPDATE %'
        OR t LIKE 'DELETE FROM%' OR t LIKE 'COPY %' OR t LIKE 'DROP %'
        OR t LIKE 'ALTER %' OR t LIKE 'COMMENT ON%' OR t LIKE 'WITH %'
        OR t LIKE 'TRUNCATE%')
GROUP BY ALL
ORDER BY queries DESC
LIMIT 15;


-- 7. Read vs write, so the split in the dive header is checkable ---------------
-- Reads are query_type = 'QUERY'; writes are DDL + DML. TCL (transaction
-- control) is NEITHER, which is why read% + write% falls a hair short of 100.
-- The dive states that residue instead of rounding it away.
--
-- Per-workload read and write compute are columns on query 1 rather than a
-- section of their own — reads and writes are asymmetric (writes dominate query
-- COUNT, reads dominate COMPUTE), but they answer the same question about the
-- same rows, so splitting them into two tables just hides one of them.
SELECT
  CASE WHEN query_type = 'QUERY'            THEN 'read'
       WHEN query_type IN ('DDL', 'DML')    THEN 'write'
       ELSE 'other (' || query_type || ')' END          AS kind,
  count(*)                                             AS queries,
  round(sum(epoch(execution_time)), 1)                 AS exec_s,
  round(100.0 * sum(epoch(execution_time))
        / sum(sum(epoch(execution_time))) OVER (), 1)  AS pct_exec
FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
WHERE start_time > now() - INTERVAL 30 DAY
GROUP BY ALL
ORDER BY exec_s DESC;


-- 8. Active hours: when was the account doing anything, and what kind? ---------
-- `active_hours` is the number of distinct clock hours in the day containing ANY
-- query; `write_hours` narrows that to hours containing a write. Either reads as
-- a schedule without needing to know the cron:
--   1-2   -> a nightly batch
--   ~24   -> something running continuously
--
-- The cost signal is the SHAPE of write_s against flat data volume: write compute
-- climbing while the data does not means a full refresh got rescheduled more
-- often, which is the expensive version of the mistake.
--
-- Timezone-independent by construction: it counts distinct hours, so it does not
-- matter which zone the session renders start_time in.
--
-- The dive plots active_hours on a 0-24 left axis and write_s / read_s on a
-- right axis, because hours are bounded and compute is not.
SELECT
  date_trunc('day', start_time)::DATE                  AS day,
  count(DISTINCT date_trunc('hour', start_time))       AS active_hours,
  count(DISTINCT date_trunc('hour', start_time))
    FILTER (query_type IN ('DDL', 'DML'))              AS write_hours,
  round(coalesce(sum(epoch(execution_time))
        FILTER (query_type IN ('DDL', 'DML')), 0), 1)  AS write_s,
  round(coalesce(sum(epoch(execution_time))
        FILTER (query_type = 'QUERY'), 0), 1)          AS read_s,
  count(*)                                             AS queries,
  count(DISTINCT user_name)                            AS identities
FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
WHERE start_time > now() - INTERVAL 30 DAY
GROUP BY ALL
ORDER BY day DESC;


-- 9. Duckling busy seconds: how far is exec_s from billable uptime? -----------
-- A gaps-and-islands merge of overlapping [start_time, end_time) intervals per
-- duckling per day. Answers a question sum(execution_time) cannot: are these
-- queries running BACK TO BACK or ON TOP OF EACH OTHER?
--
--   concurrency_factor = sum(execution_time) / merged busy time
--     ~1.0  queries run sequentially. exec_s is a fair proxy; the honest gap to
--           your bill is warm-idle time, which this cannot see either.
--     >1.5  meaningful concurrency on one duckling. exec_s OVER-states billed
--           compute, because parallel queries share billed seconds. Stop quoting
--           exec_s as cost and use busy_s.
--
-- Also: busy_s includes queue time inside a burst, so busy_s much greater than
-- naive_exec_s means queries were WAITING. On a shared identity that is the
-- argument for isolation - a dedicated duckling per service account removes the
-- queueing rather than adding cost.
WITH ev AS (
  SELECT duckling_id,
         date_trunc('day', start_time)::DATE AS day,
         start_time AS s, end_time AS e,
         epoch(execution_time) AS exec_s
  FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
  WHERE start_time > now() - INTERVAL 7 DAY     -- deliberately narrower: this one is heavy
    AND end_time IS NOT NULL
),
ordered AS (
  SELECT *, max(e) OVER (PARTITION BY duckling_id, day ORDER BY s
                         ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_e
  FROM ev
),
islands AS (
  SELECT *, sum(CASE WHEN prev_e IS NULL OR s > prev_e THEN 1 ELSE 0 END)
              OVER (PARTITION BY duckling_id, day ORDER BY s ROWS UNBOUNDED PRECEDING) AS island
  FROM ordered
),
merged AS (
  SELECT duckling_id, day, island, min(s) AS s0, max(e) AS e1, sum(exec_s) AS naive_s
  FROM islands
  GROUP BY ALL
)
SELECT
  day,
  count(DISTINCT duckling_id)                             AS ducklings,
  count(*)                                                AS busy_intervals,
  round(sum(epoch(e1 - s0)), 1)                           AS busy_s,
  round(sum(naive_s), 1)                                  AS naive_exec_s,
  round(sum(naive_s) / nullif(sum(epoch(e1 - s0)), 0), 2) AS concurrency_factor
FROM merged
GROUP BY ALL
ORDER BY day DESC;


-- Bonus: what user agents exist at all? --------------------------------------
-- Run this FIRST when adapting query 1 to another account. It shows every client
-- shape hitting the org with UUIDs and versions masked, so the output collapses
-- to distinct patterns. Anything here that query 1's CASE does not name lands in
-- 'External app / SDK' — which is fine until that bucket is your biggest cost,
-- at which point it deserves its own arm.
SELECT
  regexp_replace(
    regexp_replace(user_agent,
      '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<uuid>', 'g'),
    '[0-9]+\.[0-9]+\.[0-9]+', '<v>', 'g')  AS ua_shape,
  count(*)                                 AS queries,
  round(sum(epoch(execution_time)), 1)     AS exec_s,
  count(DISTINCT user_name)                AS identities
FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
WHERE start_time > now() - INTERVAL 30 DAY
GROUP BY ALL
ORDER BY queries DESC
LIMIT 30;


-- Where to take this next -----------------------------------------------------
-- Pair query 2 with MD_LIST_SHARES() to see whether a heavy read identity is
-- reading a share rather than its own database. Or promote query 7 to an alert:
-- a Flight that runs query 7 daily and writes a row when active_hours jumps
-- turns a monthly bill surprise into a next-morning notification.
--
-- Once query 1 shows 'External app / SDK' dominating, the next move is not a SQL
-- query - it is giving each pipeline its own service account so that query 2
-- becomes a per-pipeline cost report.
