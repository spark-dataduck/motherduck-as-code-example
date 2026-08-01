# Usage monitoring with QUERY_HISTORY

How to attribute MotherDuck compute to the thing that caused it — a Dive, an MCP
client, or a Flight — using only surfaces a customer can reach. Every rule below
was verified against real `user_agent` values.

## Rules

- **`MD_INFORMATION_SCHEMA.QUERY_HISTORY` is the only org-wide source.** It
  requires org admin on a Business plan and has a small ingestion delay.
- **Attribute by `user_agent`, not by `query_text`.** MotherDuck stamps the
  originating surface into the user agent; matching on query text is fragile.
- **Compute follows the viewer, not the owner.** A Dive in the UI runs on the
  viewer's duckling; an embedded Dive runs on read-scaling ducklings of the user
  its embed session was created for.
- **Execution time is attribution, not a bill line item.** Dive queries are
  priced as ordinary compute. Flight-hour charges are separate and appear in the
  billing portal.
- **Do not double-count Dives-in-MCP-apps.** A Dive rendered inside an MCP app
  matches *both* `%md-dive%` and `%mcp%`. Pick one home for it: these dives
  count it as a Dive, and the MCP breakdown excludes it explicitly.

## The user_agent taxonomy

| Pattern | Surface | Carries an ID? |
| --- | --- | --- |
| `md-dives/v1(<uuid>)` | Dive in the MotherDuck UI | Dive ID |
| `md-dive-embed/v1(<uuid>)` | Externally embedded Dive | Dive ID |
| `md-dives-mcp-app/v1/v1(<uuid>,transport=…)` | Dive inside an MCP app | Dive ID |
| `mcp-server-motherduck-remote/<ver>(<client>)` | MotherDuck MCP server | Client name |
| `md-flights` | Flight | **No** — see below |
| `hatchling` | MotherDuck notebook UI | No |

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

## What is not available

**Per-Flight compute attribution does not exist.** Flight connections appear as
`duckdb/… python/… md-flights` with no flight id, so `QUERY_HISTORY` can tell
you how much compute Flights used in total, but not which Flight used it. For
per-Flight health use `MD_LIST_FLIGHT_RUNS` instead — see the `flights` topic —
and remember those functions are scoped to the calling identity.
