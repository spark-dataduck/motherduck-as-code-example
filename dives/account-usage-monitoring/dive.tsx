// Account Usage Monitoring
//
// Where the account's MotherDuck compute actually goes, across every surface.
//
// The other three monitoring dives each take one surface and go deep. This one is
// the roof over them: every row in QUERY_HISTORY is classified into exactly one
// workload, so the shares add to 100% and nothing falls through. Start here to
// find out WHICH workload moved, then open that surface's dive to find out why.
//
// The question it exists to answer: our spend changed — what moved?
//
// exec_s is ATTRIBUTION, NOT A BILL. MotherDuck bills duckling uptime per second.
// execution_time under-counts it (a duckling stays warm between queries) and can
// over-count it (concurrent queries on one duckling each accrue wall-clock time
// against one billed second). Query 8 in queries.sql quantifies the second effect
// for a given account. The billing portal is the authority on money; this dive
// finds the workload that moved.
//
// PALETTE NOTE: the stacked chart honours the one-accent rule from
// guides/dives/conventions.md by giving the SELECTED workload the blue and
// rendering every other band in a neutral ramp. Click a row in "By workload" to
// move the accent. No second hue is introduced.
//
// The same SQL, ready to paste into a notebook, is in queries.sql.

import { useSQLQuery, useDiveState } from "@motherduck/react-sql-query";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";

export const REQUIRED_DATABASES = [];

const C = {
  blue: "#1a73e8", blueLight: "#669df6", green: "#137333", red: "#c5221f",
  text: "#202124", muted: "#5f6368", border: "#dadce0", pageBg: "#f8f9fa",
};

// Neutral ramp for the non-highlighted bands. Darkest first, so the largest
// remaining workload still reads as the strongest neutral.
const RAMP = ["#80868b", "#9aa0a6", "#bdc1c6", "#dadce0", "#e8eaed", "#f1f3f4"];

type Rows = Record<string, unknown>[];
const rowsOf = (d: unknown): Rows => (Array.isArray(d) ? (d as Rows) : []);
const N = (v: unknown): number => (v != null ? Number(v) : 0);
const S = (v: unknown): string => (v != null ? String(v) : "");
const fmtNum = (n: number) =>
  n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "K" : Math.round(n).toLocaleString();
const fmtSec = (s: number) => (s >= 3600 ? (s / 3600).toFixed(1) + "h" : s >= 60 ? (s / 60).toFixed(1) + "m" : s.toFixed(1) + "s");
const fmtGb = (g: number) => (g >= 1000 ? (g / 1000).toFixed(2) + " TB" : g >= 1 ? g.toFixed(2) + " GB" : (g * 1000).toFixed(0) + " MB");

const WINDOWS = [{ k: "7", l: "7 days" }, { k: "30", l: "30 days" }, { k: "90", l: "90 days" }];

// Full workload taxonomy. ARM ORDER IS LOAD-BEARING: md-dives-mcp-app contains
// "mcp"; hatchling and md-dives are both motherduck-wasm. Reordering silently
// moves traffic between buckets.
const WORKLOAD = `CASE
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
  END`;

// Coarser grouping for the stacked chart — 11 bands is unreadable, 6 is not.
const WORKLOAD_COARSE = `CASE
    WHEN user_agent LIKE '%md-flights%'            THEN 'Flight'
    WHEN user_agent LIKE '%md-dive%'               THEN 'Dive'
    WHEN user_agent LIKE '%mcp-server-motherduck%' THEN 'MCP server'
    WHEN user_agent LIKE '%hatchling%'             THEN 'Notebook UI'
    WHEN user_agent LIKE '%pgendpoint%'            THEN 'Postgres endpoint'
    WHEN user_agent LIKE '%dbt%'                   THEN 'dbt'
    WHEN user_agent LIKE '%cli%'                   THEN 'DuckDB CLI'
    WHEN user_agent LIKE '%motherduck-wasm%'       THEN 'MotherDuck UI (other)'
    ELSE 'External app / SDK'
  END`;

// ltrim() trims ONLY SPACES, and pipeline SQL almost always starts with a
// newline. Strip block comments, line comments, collapse whitespace, then trim
// the leading semicolon multi-statement scripts leave behind.
const NORM = `upper(trim(regexp_replace(
      regexp_replace(
        regexp_replace(coalesce(query_text, ''), '(?s)/\\*.*?\\*/', ' ', 'g'),
        '--[^\\n]*', ' ', 'g'),
      '\\s+', ' ', 'g'), ' ;'))`;

function Skel({ h, w }: { h: number; w?: string }) {
  return <div className="bg-gray-200 animate-pulse rounded" style={{ height: h, width: w || "100%" }} />;
}

function Delta({ cur, prev, invert }: { cur: number; prev: number; invert?: boolean }) {
  if (!prev) return <span style={{ color: C.muted, fontSize: 12 }}>{cur > 0 ? "new" : "—"}</span>;
  const pct = ((cur - prev) / prev) * 100;
  const up = pct >= 0;
  // "Up" is not automatically good or bad — for compute and queue time a rise is
  // the thing you were looking for, so invert the semantic colour.
  const bad = invert ? up : !up;
  return (
    <span style={{ color: bad ? C.red : C.green, fontSize: 12, fontWeight: 500 }}>
      {up ? "↑" : "↓"} {Math.abs(pct).toFixed(1)}% vs prev
    </span>
  );
}

function Scorecard({ label, value, loading, delta, tone, first }: any) {
  return (
    <div style={{ flex: 1, minWidth: 140, borderLeft: first ? "none" : `1px solid ${C.border}`, paddingLeft: first ? 0 : 20 }}>
      <p style={{ color: C.muted, fontSize: 12, marginBottom: 4 }}>{label}</p>
      {loading ? <Skel h={34} w="80px" /> : (
        <>
          <p style={{ color: tone || C.text, fontSize: 30, fontWeight: 400, lineHeight: 1.1 }}>{value ?? "—"}</p>
          <div style={{ marginTop: 4, minHeight: 16 }}>{delta}</div>
        </>
      )}
    </div>
  );
}

function SortTable({ cols, rows, loading, sortKey, dir, onSort, empty, onRowClick, activeRow }: any) {
  if (loading) return <Skel h={160} />;
  if (!rows.length) return <p style={{ color: C.muted, fontSize: 13, padding: "16px 0" }}>{empty}</p>;
  const sorted = [...rows].sort((a: any, b: any) => {
    const x = a[sortKey], y = b[sortKey];
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return dir === "asc" ? c : -c;
  });
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="w-full" style={{ color: C.text, fontSize: 13, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${C.border}` }}>
            {cols.map((c: any, i: number) => (
              <th key={c.key} onClick={() => onSort(c.key)} title="Sort by this column"
                  className={"py-2.5 select-none " + (c.num || c.ts ? "text-right" : "text-left")}
                  style={{ color: sortKey === c.key ? C.blue : C.muted, fontSize: 11, fontWeight: 500,
                           textTransform: "uppercase", letterSpacing: "0.3px", cursor: "pointer",
                           whiteSpace: "nowrap", paddingRight: i === cols.length - 1 ? 0 : 24 }}>
                {c.label}{sortKey === c.key ? (dir === "asc" ? " ↑" : " ↓") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r: any, ri: number) => {
            const active = activeRow != null && activeRow === r[cols[0].key];
            return (
              <tr key={ri} onClick={onRowClick ? () => onRowClick(r[cols[0].key]) : undefined}
                  style={{ borderBottom: "1px solid #f1f3f4", cursor: onRowClick ? "pointer" : undefined,
                           background: active ? "#e8f0fe" : undefined }}
                  className={active ? "" : "hover:bg-gray-50"}>
                {cols.map((c: any, i: number) => (
                  <td key={c.key} className={"py-2.5 " + (c.num || c.ts ? "text-right tabular-nums" : "text-left")}
                      style={{ whiteSpace: "nowrap",
                               color: c.tone ? c.tone(r[c.key]) : (active && i === 0 ? C.blue : undefined),
                               fontWeight: active && i === 0 ? 500 : undefined,
                               paddingRight: i === cols.length - 1 ? 0 : 24 }}>
                    {c.fmt ? c.fmt(r[c.key]) : r[c.key]}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Seg({ value, onChange, options }: any) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {options.map((o: any) => {
        const on = o.k === value;
        return (
          <button key={o.k} onClick={() => onChange(o.k)}
            style={{ background: on ? C.blue : "#fff", color: on ? "#fff" : C.muted,
                     border: `1px solid ${on ? C.blue : C.border}`, borderRadius: 6,
                     padding: "5px 12px", fontSize: 12, cursor: "pointer" }}>{o.l}</button>
        );
      })}
    </div>
  );
}

function Card({ title, note, right, children }: any) {
  return (
    <div style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 8, padding: 20, marginTop: 20 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <p style={{ color: C.text, fontSize: 14, fontWeight: 500, marginBottom: note ? 2 : 12 }}>{title}</p>
        {right}
      </div>
      {note && <p style={{ color: C.muted, fontSize: 12, marginBottom: 12 }}>{note}</p>}
      {children}
    </div>
  );
}

export default function AccountUsageMonitoring() {
  const [days, setDays]       = useDiveState<string>("days", "30");
  const [metric, setMetric]   = useDiveState<string>("metric", "exec_s");
  const [focus, setFocus]     = useDiveState<string>("focus", "");
  const [wSort, setWSort]     = useDiveState<string>("w_sort", "exec_s");
  const [wDir, setWDir]       = useDiveState<string>("w_dir", "desc");
  const [iSort, setISort]     = useDiveState<string>("i_sort", "exec_s");
  const [iDir, setIDir]       = useDiveState<string>("i_dir", "desc");
  const [lSort, setLSort]     = useDiveState<string>("l_sort", "exec_s");
  const [lDir, setLDir]       = useDiveState<string>("l_dir", "desc");

  const d = Number(days) || 30;

  // One probe gates every other query. QUERY_HISTORY needs org admin on a
  // Business plan; without the gate a non-admin viewer fires one failed query
  // per visual instead of one.
  const probe = useSQLQuery(`SELECT 1 AS ok FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY LIMIT 1`);
  const denied = !!probe.error;
  const ready = !probe.isLoading && !denied;

  const sortToggle = (cur: string, setK: any, dir: string, setD: any) => (k: string) => {
    if (k === cur) setD(dir === "asc" ? "desc" : "asc");
    else { setK(k); setD("desc"); }
  };

  const kpi = useSQLQuery(`
    SELECT
      count(*) FILTER (start_time > now() - INTERVAL ${d} DAY)                              AS cur_queries,
      count(*) FILTER (start_time <= now() - INTERVAL ${d} DAY)                             AS prev_queries,
      round(sum(epoch(execution_time)) FILTER (start_time > now() - INTERVAL ${d} DAY), 1)  AS cur_exec_s,
      round(sum(epoch(execution_time)) FILTER (start_time <= now() - INTERVAL ${d} DAY), 1) AS prev_exec_s,
      round(sum(epoch(wait_time)) FILTER (start_time > now() - INTERVAL ${d} DAY), 1)       AS cur_queue_s,
      round(sum(epoch(wait_time)) FILTER (start_time <= now() - INTERVAL ${d} DAY), 1)      AS prev_queue_s,
      count(DISTINCT user_name) FILTER (start_time > now() - INTERVAL ${d} DAY)             AS cur_identities,
      count(DISTINCT duckling_id) FILTER (start_time > now() - INTERVAL ${d} DAY)           AS cur_ducklings,
      count(*) FILTER (error_message IS NOT NULL
                       AND start_time > now() - INTERVAL ${d} DAY)                          AS cur_errors,
      round(sum(bytes_uploaded + bytes_downloaded)
            FILTER (start_time > now() - INTERVAL ${d} DAY) / 1e9, 2)                        AS cur_gb_moved
    FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
    WHERE start_time > now() - INTERVAL ${2 * d} DAY
  `, { enabled: ready });

  const byWorkload = useSQLQuery(`
    SELECT ${WORKLOAD}                                        AS workload,
           count(*)                                           AS queries,
           round(sum(epoch(execution_time)), 1)               AS exec_s,
           round(100.0 * sum(epoch(execution_time))
                 / sum(sum(epoch(execution_time))) OVER (), 1) AS pct_exec,
           round(sum(epoch(wait_time)), 1)                    AS queue_s,
           count(DISTINCT user_name)                          AS identities,
           count(DISTINCT duckling_id)                        AS ducklings,
           round(sum(bytes_uploaded + bytes_downloaded) / 1e9, 2) AS gb_moved,
           count(*) FILTER (error_message IS NOT NULL)        AS errors,
           strftime(max(start_time), '%Y-%m-%d %H:%M')        AS last_active
    FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
    WHERE start_time > now() - INTERVAL ${d} DAY
    GROUP BY ALL
    ORDER BY exec_s DESC
  `, { enabled: ready });

  const byIdentity = useSQLQuery(`
    SELECT user_name,
           count(*)                                           AS queries,
           round(sum(epoch(execution_time)), 1)               AS exec_s,
           round(100.0 * sum(epoch(execution_time))
                 / sum(sum(epoch(execution_time))) OVER (), 1) AS pct_exec,
           count(*) FILTER (query_type IN ('DDL', 'DML'))     AS write_queries,
           count(*) FILTER (query_type = 'QUERY')             AS read_queries,
           round(sum(epoch(wait_time)), 1)                    AS queue_s,
           count(DISTINCT duckling_id)                        AS ducklings,
           round(sum(bytes_uploaded + bytes_downloaded) / 1e9, 2) AS gb_moved,
           strftime(max(start_time), '%Y-%m-%d %H:%M')        AS last_active
    FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
    WHERE start_time > now() - INTERVAL ${d} DAY
    GROUP BY ALL
    ORDER BY exec_s DESC
    LIMIT 100
  `, { enabled: ready });

  // A date spine keeps quiet days visible as zeroes. A workload STOPPING is as
  // informative as one starting, and without the spine that day just vanishes.
  const daily = useSQLQuery(`
    WITH spine AS (
      SELECT unnest(generate_series(
        date_trunc('day', now() - INTERVAL ${d} DAY)::TIMESTAMP,
        date_trunc('day', now())::TIMESTAMP, INTERVAL 1 DAY))::DATE AS day
    ),
    hits AS (
      SELECT date_trunc('day', start_time)::DATE AS day,
             ${WORKLOAD_COARSE} AS workload,
             count(*) AS queries,
             round(sum(epoch(execution_time)), 1) AS exec_s
      FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
      WHERE start_time > now() - INTERVAL ${d} DAY
      GROUP BY ALL
    )
    SELECT s.day::VARCHAR AS day, h.workload,
           coalesce(h.queries, 0) AS queries, coalesce(h.exec_s, 0) AS exec_s
    FROM spine s LEFT JOIN hits h USING (day)
    ORDER BY s.day
  `, { enabled: ready });

  const movers = useSQLQuery(`
    WITH w AS (
      SELECT ${WORKLOAD_COARSE} AS workload, start_time, execution_time
      FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
      WHERE start_time > now() - INTERVAL ${2 * d} DAY
    )
    SELECT workload,
           round(coalesce(sum(epoch(execution_time)) FILTER (start_time >  now() - INTERVAL ${d} DAY), 0), 1) AS cur_exec_s,
           round(coalesce(sum(epoch(execution_time)) FILTER (start_time <= now() - INTERVAL ${d} DAY), 0), 1) AS prev_exec_s,
           round(coalesce(sum(epoch(execution_time)) FILTER (start_time >  now() - INTERVAL ${d} DAY), 0)
               - coalesce(sum(epoch(execution_time)) FILTER (start_time <= now() - INTERVAL ${d} DAY), 0), 1) AS delta_s
    FROM w
    GROUP BY ALL
    ORDER BY delta_s DESC
  `, { enabled: ready });

  // Writes only. This is the most expensive query in the dive — it reads
  // query_text for every DDL/DML row in the window.
  const loads = useSQLQuery(`
    WITH w AS (
      SELECT ${NORM} AS t, execution_time, user_name
      FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
      WHERE start_time > now() - INTERVAL ${d} DAY
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
      count(DISTINCT user_name)                           AS identities
    FROM w
    GROUP BY ALL
    ORDER BY exec_s DESC
  `, { enabled: ready });

  // active_hours reads as a schedule without knowing the cron: 1-2 is nightly,
  // ~24 is hourly. Counting DISTINCT hours makes it timezone-independent.
  const cadence = useSQLQuery(`
    WITH spine AS (
      SELECT unnest(generate_series(
        date_trunc('day', now() - INTERVAL ${d} DAY)::TIMESTAMP,
        date_trunc('day', now())::TIMESTAMP, INTERVAL 1 DAY))::DATE AS day
    ),
    hits AS (
      SELECT date_trunc('day', start_time)::DATE            AS day,
             count(DISTINCT date_trunc('hour', start_time)) AS active_hours,
             count(*)                                       AS write_queries,
             round(sum(epoch(execution_time)), 1)           AS exec_s
      FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
      WHERE start_time > now() - INTERVAL ${d} DAY
        AND query_type IN ('DDL', 'DML')
      GROUP BY 1
    )
    SELECT s.day::VARCHAR AS day,
           coalesce(h.active_hours, 0)  AS active_hours,
           coalesce(h.write_queries, 0) AS write_queries,
           coalesce(h.exec_s, 0)        AS exec_s
    FROM spine s LEFT JOIN hits h USING (day)
    ORDER BY s.day
  `, { enabled: ready });

  const k = rowsOf(kpi.data)[0] ?? {};
  const loading = probe.isLoading || kpi.isLoading;
  const errPct = N(k.cur_queries) ? (100 * N(k.cur_errors)) / N(k.cur_queries) : 0;

  const wRows = rowsOf(byWorkload.data).map((r) => ({
    workload: S(r.workload), queries: N(r.queries), exec_s: N(r.exec_s), pct_exec: N(r.pct_exec),
    queue_s: N(r.queue_s), identities: N(r.identities), ducklings: N(r.ducklings),
    gb_moved: N(r.gb_moved), errors: N(r.errors), last_active: S(r.last_active),
  }));

  // Stack order: largest workload at the bottom. The focused workload takes the
  // accent; everything else walks the neutral ramp.
  const stackOrder = (() => {
    const tot = new Map<string, number>();
    for (const r of rowsOf(daily.data)) {
      const w = S(r.workload);
      if (!w) continue;
      tot.set(w, (tot.get(w) ?? 0) + N(metric === "queries" ? r.queries : r.exec_s));
    }
    return [...tot.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w);
  })();

  // Zero-fill every workload on every day. A missing key is `undefined` to
  // recharts, which breaks a stacked bar; an explicit 0 stacks correctly.
  const chartData = (() => {
    const byDay = new Map<string, any>();
    for (const r of rowsOf(daily.data)) {
      const day = S(r.day);
      if (!byDay.has(day)) {
        const seed: any = { day: day.slice(5) };
        for (const w of stackOrder) seed[w] = 0;
        byDay.set(day, seed);
      }
      const w = S(r.workload);
      if (w) byDay.get(day)[w] = N(metric === "queries" ? r.queries : r.exec_s);
    }
    return [...byDay.values()];
  })();

  // The table is fine-grained (three Dive surfaces); the chart is coarse (one
  // Dive band), because 11 stacked bands cannot be read. Collapse a clicked
  // table row to its chart band so the accent lands somewhere.
  const coarseOf = (w: string) => (w.startsWith("Dive") ? "Dive" : w);
  const focusBand = focus ? coarseOf(focus) : "";

  const bandColor = (w: string, i: number) => {
    if (focusBand) return w === focusBand ? C.blue : RAMP[Math.min(i, RAMP.length - 1)];
    // No explicit focus: the largest workload carries the accent, since that is
    // the one the reader is almost always looking for.
    return i === 0 ? C.blue : RAMP[Math.min(i - 1, RAMP.length - 1)];
  };

  const moverRows = rowsOf(movers.data).map((r) => ({
    workload: S(r.workload), delta_s: N(r.delta_s), cur: N(r.cur_exec_s), prev: N(r.prev_exec_s),
  }));
  const topMover = moverRows.length
    ? moverRows.reduce((a, b) => (Math.abs(b.delta_s) > Math.abs(a.delta_s) ? b : a))
    : null;

  const cadRows = rowsOf(cadence.data).map((r) => ({
    day: S(r.day).slice(5), active_hours: N(r.active_hours),
    write_queries: N(r.write_queries), exec_s: N(r.exec_s),
  }));
  const maxHours = cadRows.reduce((m, r) => Math.max(m, r.active_hours), 0);

  if (denied) {
    return (
      <div style={{ background: C.pageBg, minHeight: "100vh", padding: 24 }}>
        <h1 style={{ fontSize: 20, color: C.text, margin: 0 }}>Account Usage Monitoring</h1>
        <div style={{ background: "#fce8e6", color: C.red, border: `1px solid ${C.red}`, borderRadius: 8, padding: 16, marginTop: 16, fontSize: 13 }}>
          <strong>QUERY_HISTORY is not readable by this account.</strong>
          <p style={{ marginTop: 6 }}>It requires an organization admin on a Business plan.</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: C.pageBg, minHeight: "100vh", padding: 24, color: C.text }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, margin: 0, fontWeight: 500 }}>Account Usage Monitoring</h1>
          <p style={{ color: C.muted, fontSize: 13, margin: "4px 0 0" }}>
            Every query in the org, classified into exactly one workload — so the shares add to 100%.
          </p>
        </div>
        <Seg value={days} onChange={setDays} options={WINDOWS} />
      </div>

      <div style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 8, padding: 20, marginTop: 20, display: "flex", gap: 20, flexWrap: "wrap" }}>
        <Scorecard first label="Compute (attributed)" loading={loading} value={fmtSec(N(k.cur_exec_s))}
                   delta={<Delta cur={N(k.cur_exec_s)} prev={N(k.prev_exec_s)} invert />} />
        <Scorecard label="Queries" loading={loading} value={fmtNum(N(k.cur_queries))}
                   delta={<Delta cur={N(k.cur_queries)} prev={N(k.prev_queries)} invert />} />
        <Scorecard label="Queue time" loading={loading} value={fmtSec(N(k.cur_queue_s))}
                   delta={<Delta cur={N(k.cur_queue_s)} prev={N(k.prev_queue_s)} invert />} />
        <Scorecard label="Identities" loading={loading} value={String(N(k.cur_identities))} />
        <Scorecard label="Ducklings" loading={loading} value={String(N(k.cur_ducklings))} />
        <Scorecard label="Data moved" loading={loading} value={fmtGb(N(k.cur_gb_moved))} />
        <Scorecard label="Error rate" loading={loading} value={`${errPct.toFixed(1)}%`}
                   tone={errPct > 5 ? C.red : undefined} />
      </div>

      {topMover && Math.abs(topMover.delta_s) > 1 && (
        <div style={{ background: "#fff", border: `1px solid ${C.border}`, borderLeft: `3px solid ${topMover.delta_s > 0 ? C.red : C.green}`,
                      borderRadius: 8, padding: "14px 20px", marginTop: 20, fontSize: 13, lineHeight: 1.6 }}>
          <strong>Biggest mover:</strong>{" "}
          <span style={{ color: C.blue }}>{topMover.workload}</span>{" "}
          {topMover.delta_s > 0 ? "added" : "gave back"}{" "}
          <strong style={{ color: topMover.delta_s > 0 ? C.red : C.green }}>{fmtSec(Math.abs(topMover.delta_s))}</strong>{" "}
          of attributed compute versus the previous {d} days ({fmtSec(topMover.prev)} → {fmtSec(topMover.cur)}).
        </div>
      )}

      <Card title="Daily compute by workload"
            note={`Stacked on a date spine, so a day a workload stops is visible instead of missing. ${focusBand ? `“${focusBand}” holds the accent` : "The largest workload holds the accent"} — click a row in “By workload” below to move it.`}
            right={<Seg value={metric} onChange={setMetric}
                        options={[{ k: "exec_s", l: "Compute" }, { k: "queries", l: "Queries" }]} />}>
        {probe.isLoading || daily.isLoading ? <Skel h={280} /> : (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#f1f3f4" vertical={false} />
              <XAxis dataKey="day" tick={{ fill: C.muted, fontSize: 11 }}
                     axisLine={{ stroke: C.border }} tickLine={false} minTickGap={16} />
              <YAxis tick={{ fill: C.muted, fontSize: 11 }} axisLine={false} tickLine={false} width={52}
                     tickFormatter={(v: number) => (metric === "queries" ? fmtNum(v) : fmtSec(v))} />
              <Tooltip contentStyle={{ border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12 }}
                       formatter={(v: any, n: any) => [metric === "queries" ? fmtNum(N(v)) : fmtSec(N(v)), n]} />
              <Legend wrapperStyle={{ fontSize: 12, color: C.muted }} />
              {stackOrder.map((w, i) => (
                <Bar key={w} dataKey={w} name={w} stackId="a"
                     fill={bandColor(w, i)} isAnimationActive={false} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </Card>

      <Card title="By workload"
            note="Click a row to move the chart accent onto that workload. Sorting happens in the browser — no extra query.">
        <SortTable
          cols={[
            { key: "workload",    label: "Workload" },
            { key: "exec_s",      label: "Compute", num: true, fmt: (v: any) => fmtSec(N(v)) },
            { key: "pct_exec",    label: "Share", num: true, fmt: (v: any) => `${N(v).toFixed(1)}%` },
            { key: "queries",     label: "Queries", num: true, fmt: (v: any) => fmtNum(N(v)) },
            { key: "queue_s",     label: "Queue", num: true, fmt: (v: any) => fmtSec(N(v)) },
            { key: "identities",  label: "Identities", num: true },
            { key: "ducklings",   label: "Ducklings", num: true },
            { key: "gb_moved",    label: "Data moved", num: true, fmt: (v: any) => fmtGb(N(v)) },
            { key: "errors",      label: "Errors", num: true, tone: (v: any) => (N(v) > 0 ? C.red : undefined) },
            { key: "last_active", label: "Last active", ts: true },
          ]}
          rows={wRows}
          loading={probe.isLoading || byWorkload.isLoading}
          sortKey={wSort} dir={wDir}
          onSort={sortToggle(wSort, setWSort, wDir, setWDir)}
          onRowClick={(w: string) => setFocus(focus === w ? "" : w)}
          activeRow={focus || null}
          empty="No traffic in this window."
        />
      </Card>

      <Card title="By identity"
            note="The cost-attribution table. One identity holding most of the compute is the signature of a shared token running several unrelated jobs — you can see the total but cannot separate the pipeline from the dashboard, so you cannot tune either. Give each workload its own service account and this becomes a per-workload cost report.">
        <SortTable
          cols={[
            { key: "user_name",     label: "Identity" },
            { key: "exec_s",        label: "Compute", num: true, fmt: (v: any) => fmtSec(N(v)) },
            { key: "pct_exec",      label: "Share", num: true, fmt: (v: any) => `${N(v).toFixed(1)}%` },
            { key: "write_queries", label: "Writes", num: true, fmt: (v: any) => fmtNum(N(v)) },
            { key: "read_queries",  label: "Reads", num: true, fmt: (v: any) => fmtNum(N(v)) },
            { key: "queue_s",       label: "Queue", num: true, fmt: (v: any) => fmtSec(N(v)) },
            { key: "ducklings",     label: "Ducklings", num: true },
            { key: "gb_moved",      label: "Data moved", num: true, fmt: (v: any) => fmtGb(N(v)) },
            { key: "last_active",   label: "Last active", ts: true },
          ]}
          rows={rowsOf(byIdentity.data).map((r) => ({
            user_name: S(r.user_name), exec_s: N(r.exec_s), pct_exec: N(r.pct_exec),
            write_queries: N(r.write_queries), read_queries: N(r.read_queries),
            queue_s: N(r.queue_s), ducklings: N(r.ducklings), gb_moved: N(r.gb_moved),
            last_active: S(r.last_active),
          }))}
          loading={probe.isLoading || byIdentity.isLoading}
          sortKey={iSort} dir={iDir}
          onSort={sortToggle(iSort, setISort, iDir, setIDir)}
          empty="No traffic in this window."
        />
      </Card>

      <Card title="Load patterns — full refresh vs incremental"
            note="Writes only, classified from the SQL text. CREATE OR REPLACE, TRUNCATE+reload, and CTAS rebuild the whole table every run: fine nightly, expensive hourly — rescheduling a full refresh from daily to hourly multiplies its compute ~24× on unchanged data. INSERT..SELECT and MERGE touch only new rows, so their cost tracks data volume rather than schedule frequency.">
        <SortTable
          cols={[
            { key: "load_pattern",   label: "Pattern" },
            { key: "exec_s",         label: "Compute", num: true, fmt: (v: any) => fmtSec(N(v)) },
            { key: "pct_write_exec", label: "Share of writes", num: true, fmt: (v: any) => `${N(v).toFixed(1)}%` },
            { key: "queries",        label: "Queries", num: true, fmt: (v: any) => fmtNum(N(v)) },
            { key: "identities",     label: "Identities", num: true },
          ]}
          rows={rowsOf(loads.data).map((r) => ({
            load_pattern: S(r.load_pattern), exec_s: N(r.exec_s),
            pct_write_exec: N(r.pct_write_exec), queries: N(r.queries), identities: N(r.identities),
          }))}
          loading={probe.isLoading || loads.isLoading}
          sortKey={lSort} dir={lDir}
          onSort={sortToggle(lSort, setLSort, lDir, setLDir)}
          empty="No writes in this window."
        />
      </Card>

      <Card title="Load cadence"
            note="Distinct clock hours per day that contained a write — a schedule you can read without knowing the cron. 1–2 is a nightly batch; ~24 is an hourly job. If this jumps to 24 while data volume is flat, a full refresh got rescheduled more often, and that is the expensive version of the mistake.">
        {probe.isLoading || cadence.isLoading ? <Skel h={220} /> : (
          <>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={cadRows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#f1f3f4" vertical={false} />
                <XAxis dataKey="day" tick={{ fill: C.muted, fontSize: 11 }}
                       axisLine={{ stroke: C.border }} tickLine={false} minTickGap={16} />
                <YAxis yAxisId="h" domain={[0, 24]} ticks={[0, 6, 12, 18, 24]} width={40}
                       tick={{ fill: C.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis yAxisId="s" orientation="right" width={52}
                       tick={{ fill: C.muted, fontSize: 11 }} axisLine={false} tickLine={false}
                       tickFormatter={(v: number) => fmtSec(v)} />
                <Tooltip contentStyle={{ border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12 }}
                         formatter={(v: any, n: any) => (n === "Write compute" ? fmtSec(N(v)) : String(N(v)))} />
                <Legend wrapperStyle={{ fontSize: 12, color: C.muted }} />
                <Line yAxisId="h" type="stepAfter" dataKey="active_hours" name="Active hours"
                      stroke={C.blue} strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line yAxisId="s" type="monotone" dataKey="exec_s" name="Write compute"
                      stroke={C.blueLight} strokeWidth={2} dot={false} isAnimationActive={false}
                      strokeDasharray="4 3" />
              </LineChart>
            </ResponsiveContainer>
            <p style={{ color: C.muted, fontSize: 12, marginTop: 8 }}>
              Peak in this window: <strong style={{ color: C.text }}>{maxHours}</strong> of 24 hours had writes
              {maxHours >= 20 ? " — an hourly-or-finer schedule." : maxHours <= 3 ? " — a batch schedule." : "."}
            </p>
          </>
        )}
      </Card>

      <p style={{ color: C.muted, fontSize: 12, marginTop: 20, lineHeight: 1.6 }}>
        <strong>Compute here is attribution, not a bill.</strong> MotherDuck bills duckling uptime
        per second. <code>execution_time</code> under-counts it, because a duckling stays warm
        between queries, and can over-count it, because concurrent queries on one duckling each
        accrue wall-clock time against one billed second. Query 8 in <code>queries.sql</code> merges
        overlapping intervals to measure that gap for this account. Treat the billing portal as the
        authority on money and this dive as the way to find the workload that moved.
        <br /><br />
        <strong>Data moved</strong> is client ⇄ MotherDuck transfer, not your cloud provider’s
        cross-region egress bill — useful for spotting which workload is data-heavy, not for
        reconciling an invoice.
        <br /><br />
        <strong>Ideas from here:</strong> once <em>External app / SDK</em> dominates, the next move is
        not a query — it is giving each pipeline its own service account, which turns “By identity”
        into a per-pipeline cost report. Or promote <em>Load cadence</em> to a Flight that writes a
        row when <code>active_hours</code> jumps, turning a monthly bill surprise into a next-morning
        notification.
      </p>
    </div>
  );
}
