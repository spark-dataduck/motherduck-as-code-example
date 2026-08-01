-- MCP usage monitoring
--
-- The exact queries behind the "MCP Usage Monitoring" dive, ready to paste into
-- a MotherDuck notebook. Change `INTERVAL 30 DAY` to widen or narrow the window.
--
-- Requires org admin on a Business plan: MD_INFORMATION_SCHEMA.QUERY_HISTORY is
-- org-scoped and has a small ingestion delay.
--
-- The MotherDuck MCP server tags every query:
--   duckdb/v1.5.4(linux_arm64) node-neo-api mcp-server-motherduck-remote/1.0.0(<client>)
-- Observed <client> values: claude-user, claude-code, openai-mcp, node,
-- python-httpx/<version>. The client string is self-reported by whatever
-- connects, so treat it as a useful label rather than an identity.
--
-- Every query below excludes `%md-dive%`. A Dive rendered inside an MCP app is
-- tagged md-dives-mcp-app and matches BOTH filters; it is counted as a Dive in
-- the Dive-usage queries, so excluding it here avoids double-counting.


-- 1. Traffic by calling client -----------------------------------------------
SELECT
  regexp_extract(user_agent, 'mcp-server-motherduck-remote/([0-9.]+)\(([^)]*)\)', 2) AS mcp_client,
  regexp_extract(user_agent, 'mcp-server-motherduck-remote/([0-9.]+)\(([^)]*)\)', 1) AS server_version,
  count(DISTINCT user_name)                   AS users,
  count(*)                                    AS queries,
  round(sum(epoch(execution_time)), 1)        AS exec_s,
  count(*) FILTER (error_message IS NOT NULL) AS errors,
  max(start_time)                             AS last_active
FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
WHERE user_agent LIKE '%mcp-server-motherduck%'
  AND user_agent NOT LIKE '%md-dive%'
  AND start_time > now() - INTERVAL 30 DAY
GROUP BY ALL
ORDER BY queries DESC;


-- 2. Traffic by user and client ----------------------------------------------
SELECT
  user_name,
  regexp_extract(user_agent, 'mcp-server-motherduck-remote/[0-9.]+\(([^)]*)\)', 1) AS mcp_client,
  count(*)                             AS queries,
  round(sum(epoch(execution_time)), 1) AS exec_s,
  max(start_time)                      AS last_active
FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
WHERE user_agent LIKE '%mcp-server-motherduck%'
  AND user_agent NOT LIKE '%md-dive%'
  AND start_time > now() - INTERVAL 30 DAY
GROUP BY ALL
ORDER BY queries DESC
LIMIT 100;


-- 3. Daily volume ------------------------------------------------------------
SELECT
  date_trunc('day', start_time)::DATE  AS day,
  count(*)                             AS queries,
  round(sum(epoch(execution_time)), 1) AS exec_s
FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
WHERE user_agent LIKE '%mcp-server-motherduck%'
  AND user_agent NOT LIKE '%md-dive%'
  AND start_time > now() - INTERVAL 30 DAY
GROUP BY ALL
ORDER BY day DESC
LIMIT 30;


-- Bonus: what user agents exist at all? --------------------------------------
-- Useful when adapting these queries — it shows every client shape hitting your
-- account, with UUIDs masked so the output collapses to distinct patterns.
SELECT
  regexp_replace(user_agent,
    '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<uuid>', 'g') AS ua_shape,
  count(*) AS queries
FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
WHERE start_time > now() - INTERVAL 30 DAY
GROUP BY ALL
ORDER BY queries DESC
LIMIT 25;
