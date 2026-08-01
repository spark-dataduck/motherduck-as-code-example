-- Dive usage monitoring
--
-- The exact queries behind the "Dive Usage Monitoring" dive, ready to paste
-- into a MotherDuck notebook. Change `INTERVAL 30 DAY` to widen or narrow the
-- window.
--
-- Requires org admin on a Business plan: MD_INFORMATION_SCHEMA.QUERY_HISTORY is
-- org-scoped and has a small ingestion delay.
--
-- Every Dive query is stamped with the Dive's ID and the surface it was viewed
-- from:
--   md-dives/v1(<id>)                          MotherDuck UI
--   md-dive-embed/v1(<id>)                     externally embedded
--   md-dives-mcp-app/v1/v1(<id>,transport=…)   MCP app (Claude, ChatGPT, …)
-- Note the doubled "/v1/v1" and trailing ",transport=…" in the MCP-app form —
-- a regex that assumes one "/v1" and a closing paren right after the UUID
-- silently drops those rows.


-- 1. Compute by surface ------------------------------------------------------
SELECT
  CASE
    WHEN user_agent LIKE '%md-dives-mcp-app%' THEN 'MCP app'
    WHEN user_agent LIKE '%md-dive-embed%'    THEN 'Externally embedded'
    WHEN user_agent LIKE '%md-dives%'         THEN 'MotherDuck UI'
  END                                    AS surface,
  count(*)                               AS queries,
  round(sum(epoch(execution_time)), 1)   AS exec_s,
  count(DISTINCT user_name)              AS viewers
FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
WHERE user_agent LIKE '%md-dive%'
  AND start_time > now() - INTERVAL 30 DAY
GROUP BY ALL
ORDER BY exec_s DESC;


-- 2. Compute per Dive, split by surface --------------------------------------
WITH dive_queries AS (
  SELECT
    regexp_extract(user_agent,
      'md-dive[s]?(?:-embed)?(?:-mcp-app)?/v1(?:/v1)?[(_]([0-9a-f\-]{36})', 1) AS dive_id,
    CASE
      WHEN user_agent LIKE '%md-dives-mcp-app%' THEN 'MCP app'
      WHEN user_agent LIKE '%md-dive-embed%'    THEN 'Externally embedded'
      WHEN user_agent LIKE '%md-dives%'         THEN 'MotherDuck UI'
    END AS surface,
    user_name AS viewer_name,
    instance_type,
    execution_time,
    start_time
  FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
  WHERE user_agent LIKE '%md-dive%'
    AND start_time > now() - INTERVAL 30 DAY
),
dive_names AS (
  SELECT id::VARCHAR AS dive_id, title AS dive_name
  FROM MD_LIST_DIVES(include_org_shares := true)
)
SELECT
  coalesce(n.dive_name, '(deleted or not visible to me)') AS dive_name,
  q.surface,
  count(DISTINCT q.viewer_name)          AS viewers,
  count(*)                               AS queries,
  round(sum(epoch(q.execution_time)), 1) AS exec_s,
  max(q.start_time)                      AS last_active
FROM dive_queries q
LEFT JOIN dive_names n USING (dive_id)
WHERE q.dive_id <> ''
GROUP BY ALL
ORDER BY exec_s DESC
LIMIT 100;



-- 3. Headline numbers with period-over-period comparison -----------------------
-- One pass covers both windows: FILTER splits current from previous.
SELECT
  count(*) FILTER (start_time > now() - INTERVAL 30 DAY)                               AS cur_queries,
  count(*) FILTER (start_time <= now() - INTERVAL 30 DAY)                              AS prev_queries,
  round(sum(epoch(execution_time)) FILTER (start_time > now() - INTERVAL 30 DAY), 1)   AS cur_exec_s,
  round(sum(epoch(execution_time)) FILTER (start_time <= now() - INTERVAL 30 DAY), 1)  AS prev_exec_s,
  round(quantile_cont(epoch(execution_time), 0.95)
        FILTER (start_time > now() - INTERVAL 30 DAY), 2)                              AS p95_s,
  count(DISTINCT user_name) FILTER (start_time > now() - INTERVAL 30 DAY)              AS cur_viewers
FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
WHERE user_agent LIKE '%md-dive%'
  AND start_time > now() - INTERVAL 60 DAY;   -- 2x the window, so both halves are present


-- Where to take this next -----------------------------------------------------
-- Add instance_type to see which duckling sizes Dives land on, or group
-- start_time by day to watch a launch land.


-- Reading the output ---------------------------------------------------------
-- Compute follows the VIEWER, not the Dive's owner. A Dive opened in the
-- MotherDuck UI runs on the viewer's own duckling; an embedded Dive runs on
-- read-scaling ducklings of the user its embed session was created for.
--
-- exec_s is attribution, not a bill line item: Dive queries are priced as
-- ordinary compute. There is no separate "Dive hour" charge.
