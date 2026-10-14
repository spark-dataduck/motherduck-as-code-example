-- Workflow Tower
--
-- The exact queries behind the "Workflow Tower" dive, ready to paste into a
-- MotherDuck notebook. The dive draws a swimlane lineage board over the
-- `ops` schema a collector Flight writes (see README.md for the contract).
--
-- Attach the database the dive reads under the alias the dive uses, then run
-- the file. For the deployed demo that is the org-wide share
-- demo_workflow_tower_share (anyone in the org can attach it):
--
--   ATTACH IF NOT EXISTS 'md:_share/demo_workflow_tower_share/474de109-046b-45d1-ad82-bf66ca5ee459'
--     AS demo_workflow_tower_share;
--
-- Pointing these at your own ops schema is a find-and-replace of the alias.
--
-- Every age is measured from the collector's own stamp (the AS_OF subquery,
-- max(collected_at) in ops.collect_log) rather than now(), so statuses and
-- ages always agree. Only the collect_log query uses now(), to say how old the
-- collection itself is.

-- objects: one row per pipeline node. Ages are computed here, not in JS.
SELECT node_id, node_type, name, app, detail, schedule_cron, status,
       strftime(last_run_at AT TIME ZONE 'UTC', '%b %d %H:%M') AS last_run_label,
       epoch((SELECT max(collected_at) FROM "demo_workflow_tower_share"."ops"."collect_log") - last_run_at)                           AS last_run_age_s,
       last_run_status,
       row_count,
       strftime(fresh_at AT TIME ZONE 'UTC', '%b %d %H:%M')    AS fresh_label,
       epoch((SELECT max(collected_at) FROM "demo_workflow_tower_share"."ops"."collect_log") - fresh_at)                              AS fresh_age_s,
       url
FROM "demo_workflow_tower_share"."ops"."objects"
ORDER BY node_id;

-- ord: the collector's index of each node in its NODES list, which is the
-- order a lane stacks in and the order the derived scopes list in. Read on
-- its own so a missing column cannot take the board down with it.
SELECT node_id, ord
FROM "demo_workflow_tower_share"."ops"."objects"
ORDER BY ord;

-- edges: the static graph, data + trigger kinds.
SELECT src_node, dst_node, kind
FROM "demo_workflow_tower_share"."ops"."edges"
ORDER BY src_node, dst_node;

-- runs: the most recent Flight runs across the pipeline.
SELECT flight_name, run_number, is_scheduled, status,
       strftime(started_at AT TIME ZONE 'UTC', '%b %d %H:%M') AS started_label,
       duration_s
FROM "demo_workflow_tower_share"."ops"."runs"
ORDER BY started_at DESC
LIMIT 60;

-- vitals: row counts and freshness per table, object counts per S3 prefix.
SELECT name, kind, row_count, objects, bytes,
       strftime(fresh_at AT TIME ZONE 'UTC', '%b %d %H:%M') AS fresh_label,
       epoch((SELECT max(collected_at) FROM "demo_workflow_tower_share"."ops"."collect_log") - fresh_at)                           AS fresh_age_s
FROM "demo_workflow_tower_share"."ops"."vitals"
ORDER BY kind, name;

-- collect_log: when the collector last wrote this snapshot (the one age
-- measured against the wall clock).
SELECT strftime(max(collected_at) AT TIME ZONE 'UTC', '%b %d %H:%M') AS collected_label,
       epoch(now() - max(collected_at))                              AS collected_age_s
FROM "demo_workflow_tower_share"."ops"."collect_log";

-- detail panel, Flight: that Flight's own run history. The Dive inlines the
-- selected node's name through a sanitizer; here it is the build Flight.
SELECT run_number, is_scheduled, status,
       strftime(started_at AT TIME ZONE 'UTC', '%b %d %H:%M:%S') AS started_label,
       duration_s, exit_code
FROM "demo_workflow_tower_share"."ops"."runs"
WHERE flight_name = 'demo-build-marts'
ORDER BY run_number DESC
LIMIT 200;

-- detail panel, table: that table's DuckLake load history, one row per
-- snapshot that wrote it. is_today means "on the collection day".
SELECT snapshot_id, change, rows_added, rows_removed, files_added,
       strftime(snapshot_time AT TIME ZONE 'UTC', '%b %d %H:%M:%S') AS at_label,
       CAST(snapshot_time AT TIME ZONE 'UTC' AS DATE) = CAST((SELECT max(collected_at) FROM "demo_workflow_tower_share"."ops"."collect_log") AT TIME ZONE 'UTC' AS DATE) AS is_today
FROM "demo_workflow_tower_share"."ops"."table_loads"
WHERE table_name = 'marts.fct_ticket'
ORDER BY snapshot_id DESC
LIMIT 200;

-- screenshots gallery (only while table:raw.screenshots is selected): thumbnails + captions.
SELECT s.ticket_id, s.file_name, s.size_bytes, s.width, s.height, s.image_bytes, s.thumb_b64,
       a.ui_area, a.detected_error_text, a.description
FROM "demo_workflow_tower_share"."raw"."screenshots" s
LEFT JOIN "demo_workflow_tower_share"."raw"."screenshot_annotations" a USING (ticket_id)
ORDER BY s.ticket_id;

-- one screenshot's compressed preview (only when a thumbnail is clicked).
SELECT image_b64
FROM "demo_workflow_tower_share"."raw"."screenshots"
WHERE ticket_id = 'TCK-0007';
