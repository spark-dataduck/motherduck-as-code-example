-- Flight usage monitoring
--
-- The exact queries behind the "Flight Usage Monitoring" dive, ready to paste
-- into a MotherDuck notebook.
--
-- Two things to know before you start:
--
--   1. Flight SQL functions are scoped to the CALLING IDENTITY. A user or
--      service account sees the Flights it owns; an org admin sees every
--      Flight in the organization (and their runs). Pass owner_only := true
--      to MD_LIST_FLIGHTS() to narrow an admin back to their own Flights.
--
--   2. There is no per-Flight compute attribution. Flight connections appear in
--      QUERY_HISTORY as `duckdb/… python/… md-flights` with NO flight id, so
--      query history can tell you how much compute Flights used in total, but
--      not which Flight used it. Use the run history below instead.


-- 1. Inventory ---------------------------------------------------------------
SELECT flight_id, flight_name, schedule_cron, schedule_status,
       status, current_version, created_at, updated_at
FROM MD_LIST_FLIGHTS()
ORDER BY flight_name;
-- created_at vs updated_at is worth a glance: a Flight whose updated_at never
-- moves is one nobody is deploying any more.


-- 2. Generate the run-health query -------------------------------------------
-- MD_LIST_FLIGHT_RUNS takes a flight_id LITERAL and rejects a lateral join:
--     FROM MD_LIST_FLIGHTS() f, LATERAL MD_LIST_FLIGHT_RUNS(flight_id := f.flight_id)
--     -> Binder Error: ... only supports literals as parameters.
-- So SQL cannot fan out across Flights on its own. Run this to BUILD the query,
-- then copy the single value it returns into a new cell and run that.
SELECT 'WITH raw_runs AS (' || chr(10) || '  ' ||
       string_agg('FROM MD_LIST_FLIGHT_RUNS(flight_id := ''' || flight_id || ''')',
                  chr(10) || '  UNION ALL BY NAME' || chr(10) || '  '
                  ORDER BY flight_name) || chr(10) ||
       '),' || chr(10) ||
       'all_runs AS (' || chr(10) ||
       '  SELECT * REPLACE (regexp_replace(status, ''^RUN_STATUS_'', '''') AS status)' || chr(10) ||
       '  FROM raw_runs' || chr(10) ||
       ')' || chr(10) ||
       'SELECT flight_name,' || chr(10) ||
       '       count(*)                                                  AS total_runs,' || chr(10) ||
       '       count(*) FILTER (status = ''FAILED''' || chr(10) ||
       '                        AND created_at >= now() - INTERVAL 7 DAY) AS failures_7d,' || chr(10) ||
       '       count(*) FILTER (status = ''SUCCEEDED'')                   AS succeeded,' || chr(10) ||
       '       max(created_at)                                           AS last_run,' || chr(10) ||
       '       max(created_at) FILTER (status = ''SUCCEEDED'')            AS last_successful_run,' || chr(10) ||
       '       max(created_at) FILTER (status = ''FAILED'')               AS last_failed_run' || chr(10) ||
       'FROM all_runs' || chr(10) ||
       'GROUP BY flight_name' || chr(10) ||
       'ORDER BY last_run DESC;' AS run_health_sql
FROM MD_LIST_FLIGHTS();


-- 3. Run health (the shape query 2 produces) ---------------------------------
-- Paste your own flight ids here, or just run query 2 and use its output.
-- Statuses came back as RUN_STATUS_SUCCEEDED / RUN_STATUS_FAILED until
-- September 2026 and come back bare (SUCCEEDED / FAILED / RUNNING) today; the
-- docs still show the prefixed form. all_runs strips an optional prefix once
-- so the comparisons below match either way.
WITH raw_runs AS (
  FROM MD_LIST_FLIGHT_RUNS(flight_id := '00000000-0000-0000-0000-000000000000')  -- flight_1
  UNION ALL BY NAME
  FROM MD_LIST_FLIGHT_RUNS(flight_id := '00000000-0000-0000-0000-000000000000')  -- flight_2
),
all_runs AS (
  SELECT * REPLACE (regexp_replace(status, '^RUN_STATUS_', '') AS status)
  FROM raw_runs
)
SELECT flight_name,
       count(*)                                                  AS total_runs,
       count(*) FILTER (status = 'FAILED'
                        AND created_at >= now() - INTERVAL 7 DAY) AS failures_7d,
       count(*) FILTER (status = 'SUCCEEDED')                     AS succeeded,
       max(created_at)                                           AS last_run,
       max(created_at) FILTER (status = 'SUCCEEDED')              AS last_successful_run,
       max(created_at) FILTER (status = 'FAILED')                 AS last_failed_run
FROM all_runs
GROUP BY flight_name
ORDER BY last_run DESC;


-- 4. Root-cause a failure ----------------------------------------------------
SELECT logs
FROM MD_GET_FLIGHT_LOGS(
  flight_id  := '00000000-0000-0000-0000-000000000000',
  run_number := 1
);


-- 5. Total Flight compute (all Flights together) -----------------------------
-- The one thing QUERY_HISTORY can tell you about Flights. There is no flight id
-- in the user agent, so this cannot be broken down per Flight.
SELECT count(*)                             AS queries,
       round(sum(epoch(execution_time)), 1) AS exec_s,
       count(DISTINCT user_name)            AS identities,
       max(start_time)                      AS last_active
FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
WHERE user_agent LIKE '%md-flights%'
  AND start_time > now() - INTERVAL 30 DAY;

-- 6. Richer run health --------------------------------------------------------
-- Same UNION shape as above, with a success rate and average successful runtime.
-- avg_secs is the early warning: a Flight getting steadily slower is a Flight
-- heading for a timeout.
--
--   round(100.0 * count(*) FILTER (status = 'SUCCEEDED') / count(*), 1) AS success_pct,
--   round(avg(epoch(ended_at - started_at))
--         FILTER (status = 'SUCCEEDED'), 1)                            AS avg_secs,
--   round(sum(epoch(ended_at - started_at))
--         FILTER (status = 'SUCCEEDED'), 1)                            AS total_secs
--
-- total_secs is the one to watch for cost: a fast Flight that runs constantly
-- can burn more compute than a slow one that runs nightly.
--
-- Add both to the SELECT in query 3 (or to the generated query from query 2).


-- Where to take this next -----------------------------------------------------
-- Pull MD_GET_FLIGHT_LOGS for the newest failed run_number to surface the error
-- inline, or chart avg_secs over time to catch a Flight slowing down.
