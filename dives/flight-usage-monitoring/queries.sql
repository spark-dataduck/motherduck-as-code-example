-- Flight usage monitoring
--
-- The exact queries behind the "Flight Usage Monitoring" dive, ready to paste
-- into a MotherDuck notebook.
--
-- Two things to know before you start:
--
--   1. Flight SQL functions are scoped to the CALLING IDENTITY. You see the
--      Flights your own user or service account owns — an org admin does not
--      automatically see everyone's.
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


-- 2. Generate the run-health query -------------------------------------------
-- MD_LIST_FLIGHT_RUNS takes a flight_id LITERAL and rejects a lateral join:
--     FROM MD_LIST_FLIGHTS() f, LATERAL MD_LIST_FLIGHT_RUNS(flight_id := f.flight_id)
--     -> Binder Error: ... only supports literals as parameters.
-- So SQL cannot fan out across Flights on its own. Run this to BUILD the query,
-- then copy the single value it returns into a new cell and run that.
SELECT 'WITH all_runs AS (' || chr(10) || '  ' ||
       string_agg('FROM MD_LIST_FLIGHT_RUNS(flight_id := ''' || flight_id || ''')',
                  chr(10) || '  UNION ALL BY NAME' || chr(10) || '  '
                  ORDER BY flight_name) || chr(10) ||
       ')' || chr(10) ||
       'SELECT flight_name,' || chr(10) ||
       '       count(*)                                                  AS total_runs,' || chr(10) ||
       '       count(*) FILTER (status = ''RUN_STATUS_FAILED''' || chr(10) ||
       '                        AND created_at >= now() - INTERVAL 7 DAY) AS failures_7d,' || chr(10) ||
       '       count(*) FILTER (status = ''RUN_STATUS_SUCCEEDED'')        AS succeeded,' || chr(10) ||
       '       max(created_at)                                           AS last_run,' || chr(10) ||
       '       max(created_at) FILTER (status = ''RUN_STATUS_SUCCEEDED'') AS last_successful_run,' || chr(10) ||
       '       max(created_at) FILTER (status = ''RUN_STATUS_FAILED'')    AS last_failed_run' || chr(10) ||
       'FROM all_runs' || chr(10) ||
       'GROUP BY flight_name' || chr(10) ||
       'ORDER BY last_run DESC;' AS run_health_sql
FROM MD_LIST_FLIGHTS();


-- 3. Run health (the shape query 2 produces) ---------------------------------
-- Paste your own flight ids here, or just run query 2 and use its output.
-- Statuses carry a RUN_STATUS_ prefix: comparing against a bare 'SUCCEEDED'
-- is valid SQL that never matches.
WITH all_runs AS (
  FROM MD_LIST_FLIGHT_RUNS(flight_id := '00000000-0000-0000-0000-000000000000')  -- flight_1
  UNION ALL BY NAME
  FROM MD_LIST_FLIGHT_RUNS(flight_id := '00000000-0000-0000-0000-000000000000')  -- flight_2
)
SELECT flight_name,
       count(*)                                                  AS total_runs,
       count(*) FILTER (status = 'RUN_STATUS_FAILED'
                        AND created_at >= now() - INTERVAL 7 DAY) AS failures_7d,
       count(*) FILTER (status = 'RUN_STATUS_SUCCEEDED')          AS succeeded,
       max(created_at)                                           AS last_run,
       max(created_at) FILTER (status = 'RUN_STATUS_SUCCEEDED')   AS last_successful_run,
       max(created_at) FILTER (status = 'RUN_STATUS_FAILED')      AS last_failed_run
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
