// Dive Usage Monitoring
//
// Which Dives drive compute, on whose ducklings, and from where.
//
// Every Dive query is stamped with the Dive's ID and the surface it was viewed
// from:
//   md-dives/v1(<id>)                        MotherDuck UI
//   md-dive-embed/v1(<id>)                   externally embedded
//   md-dives-mcp-app/v1/v1(<id>,transport=)  MCP app (Claude, ChatGPT, ...)
// The doubled "/v1/v1" and trailing ",transport=..." in the MCP form are real;
// the regex below tolerates both.
//
// QUERY_HISTORY needs org admin on a Business plan, so one probe query runs
// first and the rest stay disabled until it succeeds — a non-admin viewer
// triggers one failed query instead of one per visual.
//
// The same SQL, ready to paste into a notebook, is in queries.sql.

import { useSQLQuery, useDiveState } from "@motherduck/react-sql-query";

export const REQUIRED_DATABASES = [];

const C = {
  blue: "#1a73e8", green: "#137333", red: "#c5221f",
  text: "#202124", muted: "#5f6368", border: "#dadce0", pageBg: "#f8f9fa",
};

type Rows = Record<string, unknown>[];
const rowsOf = (d: unknown): Rows => (Array.isArray(d) ? (d as Rows) : []);
const N = (v: unknown): number => (v != null ? Number(v) : 0);
const S = (v: unknown): string => (v != null ? String(v) : "");
const fmtNum = (n: number) =>
  n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "K" : Math.round(n).toLocaleString();
const fmtSec = (s: number) => (s >= 3600 ? (s / 3600).toFixed(1) + "h" : s >= 60 ? (s / 60).toFixed(1) + "m" : s.toFixed(1) + "s");

const WINDOWS = [{ k: "7", l: "7 days" }, { k: "30", l: "30 days" }, { k: "90", l: "90 days" }];

function Skel({ h, w }: { h: number; w?: string }) {
  return <div className="bg-gray-200 animate-pulse rounded" style={{ height: h, width: w || "100%" }} />;
}

// Direction as colour, magnitude as a percentage. "new" when there is no baseline.
function Delta({ cur, prev }: { cur: number; prev: number }) {
  if (!prev) return <span style={{ color: C.muted, fontSize: 12 }}>{cur > 0 ? "new" : "—"}</span>;
  const pct = ((cur - prev) / prev) * 100;
  const up = pct >= 0;
  return (
    <span style={{ color: up ? C.green : C.red, fontSize: 12, fontWeight: 500 }}>
      {up ? "↑" : "↓"} {Math.abs(pct).toFixed(1)}% vs prev
    </span>
  );
}

function Scorecard({ label, value, loading, delta, first }: any) {
  return (
    <div style={{ flex: 1, minWidth: 150, borderLeft: first ? "none" : `1px solid ${C.border}`, paddingLeft: first ? 0 : 20 }}>
      <p style={{ color: C.muted, fontSize: 12, marginBottom: 4 }}>{label}</p>
      {loading ? <Skel h={34} w="80px" /> : (
        <>
          <p style={{ color: C.text, fontSize: 30, fontWeight: 400, lineHeight: 1.1 }}>{value || "—"}</p>
          <div style={{ marginTop: 4, minHeight: 16 }}>{delta}</div>
        </>
      )}
    </div>
  );
}

// Sorts client-side over rows already fetched — never re-queries to re-sort.
function SortTable({ cols, rows, loading, sortKey, dir, onSort, empty, limit, expanded, onToggle }: any) {
  if (loading) return <Skel h={160} />;
  if (!rows.length) return <p style={{ color: C.muted, fontSize: 13, padding: "16px 0" }}>{empty}</p>;
  const sorted = [...rows].sort((a: any, b: any) => {
    const x = a[sortKey], y = b[sortKey];
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return dir === "asc" ? c : -c;
  });
  // Cap applies AFTER sorting, so "top 20" tracks whichever column is sorted.
  const capped = limit && !expanded ? sorted.slice(0, limit) : sorted;
  const hidden = sorted.length - capped.length;
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
                           whiteSpace: "nowrap", paddingRight: i === cols.length - 1 ? 0 : 28 }}>
                {c.label}{sortKey === c.key ? (dir === "asc" ? " ↑" : " ↓") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {capped.map((r: any, i: number) => (
            <tr key={i} style={{ borderBottom: "1px solid #f1f3f4" }} className="hover:bg-gray-50">
              {cols.map((c: any, i: number) => (
                <td key={c.key} className={"py-2.5 " + (c.num || c.ts ? "text-right tabular-nums" : "text-left")}
                    style={{ whiteSpace: "nowrap", paddingRight: i === cols.length - 1 ? 0 : 28 }}>
                  {c.fmt ? c.fmt(r[c.key]) : r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {limit && (hidden > 0 || expanded) && (
        <button onClick={onToggle}
          style={{ marginTop: 12, background: "none", border: "none", color: C.blue,
                   fontSize: 13, cursor: "pointer", padding: 0 }}>
          {expanded ? "Show less" : `Show ${hidden} more`}
        </button>
      )}
    </div>
  );
}

function Seg({ value, onChange }: any) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {WINDOWS.map((o) => {
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

function Card({ title, note, children }: any) {
  return (
    <div style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 8, padding: 20, marginTop: 20 }}>
      <p style={{ color: C.text, fontSize: 14, fontWeight: 500, marginBottom: note ? 2 : 12 }}>{title}</p>
      {note && <p style={{ color: C.muted, fontSize: 12, marginBottom: 12 }}>{note}</p>}
      {children}
    </div>
  );
}

const SURFACE = `
  CASE
    WHEN user_agent LIKE '%md-dives-mcp-app%' THEN 'MCP app'
    WHEN user_agent LIKE '%md-dive-embed%'    THEN 'Externally embedded'
    WHEN user_agent LIKE '%md-dives%'         THEN 'MotherDuck UI'
  END`;

export default function DiveUsageMonitoring() {
  const [days, setDays]       = useDiveState<string>("days", "30");
  const [surfSort, setSurfSort] = useDiveState<string>("surf_sort", "exec_s");
  const [surfDir,  setSurfDir]  = useDiveState<string>("surf_dir", "desc");
  const [diveSort, setDiveSort] = useDiveState<string>("dive_sort", "exec_s");
  const [diveDir,  setDiveDir]  = useDiveState<string>("dive_dir", "desc");
  const [showAll,  setShowAll]  = useDiveState<boolean>("dive_show_all", false);
  const [showAllOwn,  setShowAllOwn]  = useDiveState<boolean>("own_show_all", false);
  const [showAllView, setShowAllView] = useDiveState<boolean>("view_show_all", false);
  const [ownSort,  setOwnSort]  = useDiveState<string>("own_sort", "exec_s");
  const [ownDir,   setOwnDir]   = useDiveState<string>("own_dir", "desc");
  const [viewSort, setViewSort] = useDiveState<string>("view_sort", "exec_s");
  const [viewDir,  setViewDir]  = useDiveState<string>("view_dir", "desc");

  const d = Number(days) || 30;

  // Access gate: one probe. Everything else waits on it.
  const probe = useSQLQuery(`SELECT 1 AS ok FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY LIMIT 1`);
  const denied = !!probe.error;
  const ready = !probe.isLoading && !denied;

  const sortToggle = (cur: string, setK: any, dir: string, setD: any) => (k: string) => {
    if (k === cur) setD(dir === "asc" ? "desc" : "asc");
    else { setK(k); setD("desc"); }
  };

  // Headline numbers: current window and the window before it, in one pass.
  const kpi = useSQLQuery(`
    SELECT
      count(*) FILTER (start_time > now() - INTERVAL ${d} DAY)                                 AS cur_queries,
      count(*) FILTER (start_time <= now() - INTERVAL ${d} DAY)                                AS prev_queries,
      round(sum(epoch(execution_time)) FILTER (start_time > now() - INTERVAL ${d} DAY), 1)     AS cur_exec_s,
      round(sum(epoch(execution_time)) FILTER (start_time <= now() - INTERVAL ${d} DAY), 1)    AS prev_exec_s,
      round(quantile_cont(epoch(execution_time), 0.95)
            FILTER (start_time > now() - INTERVAL ${d} DAY), 2)                                AS p95_s,
      count(DISTINCT user_name) FILTER (start_time > now() - INTERVAL ${d} DAY)                AS cur_viewers
    FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
    WHERE user_agent LIKE '%md-dive%'
      AND start_time > now() - INTERVAL ${2 * d} DAY
  `, { enabled: ready });

  const bySurface = useSQLQuery(`
    SELECT ${SURFACE}                        AS surface,
           count(DISTINCT user_name)         AS viewers,
           count(*)                          AS queries,
           round(sum(epoch(execution_time)), 1) AS exec_s
    FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
    WHERE user_agent LIKE '%md-dive%'
      AND start_time > now() - INTERVAL ${d} DAY
    GROUP BY ALL
    ORDER BY exec_s DESC
  `, { enabled: ready });

  const byDive = useSQLQuery(`
    WITH dive_queries AS (
      SELECT regexp_extract(user_agent,
               'md-dive[s]?(?:-embed)?(?:-mcp-app)?/v1(?:/v1)?[(_]([0-9a-f\\-]{36})', 1) AS dive_id,
             ${SURFACE} AS surface,
             user_name, execution_time, start_time
      FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
      WHERE user_agent LIKE '%md-dive%'
        AND start_time > now() - INTERVAL ${d} DAY
    ),
    dive_names AS (
      SELECT id::VARCHAR AS dive_id, title AS dive_name, owner_name
      FROM MD_LIST_DIVES(include_org_shares := true)
    )
    SELECT coalesce(n.dive_name, '(deleted or not visible to me)') AS dive_name,
           coalesce(n.owner_name, '—')                             AS owner_name,
           q.surface,
           count(DISTINCT q.user_name)            AS viewers,
           count(*)                               AS queries,
           round(sum(epoch(q.execution_time)), 1) AS exec_s,
           strftime(max(q.start_time), '%Y-%m-%d %H:%M') AS last_active
    FROM dive_queries q
    LEFT JOIN dive_names n USING (dive_id)
    WHERE q.dive_id <> ''
    GROUP BY ALL
    ORDER BY exec_s DESC
    LIMIT 100
  `, { enabled: ready });


  // Who authors Dives, and does anyone use them? dives_created counts every
  // Dive the owner has; dives_used counts the ones with traffic in the window.
  const byOwner = useSQLQuery(`
    WITH dive_queries AS (
      SELECT regexp_extract(user_agent,
               'md-dive[s]?(?:-embed)?(?:-mcp-app)?/v1(?:/v1)?[(_]([0-9a-f\\-]{36})', 1) AS dive_id,
             user_name, execution_time, start_time
      FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
      WHERE user_agent LIKE '%md-dive%'
        AND start_time > now() - INTERVAL ${d} DAY
    ),
    dive_names AS (
      SELECT id::VARCHAR AS dive_id, owner_name
      FROM MD_LIST_DIVES(include_org_shares := true)
    ),
    authored AS (SELECT owner_name, count(*) AS dives_created FROM dive_names GROUP BY 1)
    SELECT a.owner_name,
           a.dives_created,
           count(DISTINCT q.dive_id)              AS dives_used,
           count(DISTINCT q.user_name)            AS viewers,
           count(q.dive_id)                       AS queries,
           round(sum(epoch(q.execution_time)), 1) AS exec_s
    FROM authored a
    LEFT JOIN dive_names n USING (owner_name)
    LEFT JOIN dive_queries q USING (dive_id)
    GROUP BY ALL
    ORDER BY exec_s DESC NULLS LAST
    LIMIT 50
  `, { enabled: ready });

  // Who is doing the viewing, on which surfaces, and on what duckling size.
  const byViewer = useSQLQuery(`
    SELECT user_name AS viewer,
           count(DISTINCT regexp_extract(user_agent,
             'md-dive[s]?(?:-embed)?(?:-mcp-app)?/v1(?:/v1)?[(_]([0-9a-f\\-]{36})', 1)) AS dives_viewed,
           string_agg(DISTINCT CASE
             WHEN user_agent LIKE '%md-dives-mcp-app%' THEN 'MCP app'
             WHEN user_agent LIKE '%md-dive-embed%'    THEN 'Embedded'
             WHEN user_agent LIKE '%md-dives%'         THEN 'UI' END, ', ')  AS surfaces,
           string_agg(DISTINCT instance_type, ', ')                          AS duckling_sizes,
           count(*)                                                          AS queries,
           round(sum(epoch(execution_time)), 1)                              AS exec_s,
           round(quantile_cont(epoch(execution_time), 0.95), 2)              AS p95_s
    FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
    WHERE user_agent LIKE '%md-dive%'
      AND start_time > now() - INTERVAL ${d} DAY
    GROUP BY ALL
    ORDER BY exec_s DESC
    LIMIT 50
  `, { enabled: ready });

  const k = rowsOf(kpi.data)[0] ?? {};
  const loading = probe.isLoading || kpi.isLoading;

  if (denied) {
    return (
      <div style={{ background: C.pageBg, minHeight: "100vh", padding: 24 }}>
        <h1 style={{ fontSize: 20, color: C.text, margin: 0 }}>Dive Usage Monitoring</h1>
        <div style={{ background: "#fce8e6", color: C.red, border: `1px solid ${C.red}`, borderRadius: 8, padding: 16, marginTop: 16, fontSize: 13 }}>
          <strong>QUERY_HISTORY is not readable by this account.</strong>
          <p style={{ marginTop: 6 }}>
            It requires an organization admin on a Business plan. Everything on this page is derived
            from it, so nothing below would load.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: C.pageBg, minHeight: "100vh", padding: 24, color: C.text }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, margin: 0, fontWeight: 500 }}>Dive Usage Monitoring</h1>
          <p style={{ color: C.muted, fontSize: 13, margin: "4px 0 0" }}>
            Compute attributed to Dives, from <code>MD_INFORMATION_SCHEMA.QUERY_HISTORY</code>.
          </p>
        </div>
        <Seg value={days} onChange={setDays} />
      </div>

      <div style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 8, padding: 20, marginTop: 20, display: "flex", gap: 20, flexWrap: "wrap" }}>
        <Scorecard first label="Dive queries" loading={loading} value={fmtNum(N(k.cur_queries))}
                   delta={<Delta cur={N(k.cur_queries)} prev={N(k.prev_queries)} />} />
        <Scorecard label="Execution time" loading={loading} value={fmtSec(N(k.cur_exec_s))}
                   delta={<Delta cur={N(k.cur_exec_s)} prev={N(k.prev_exec_s)} />} />
        <Scorecard label="p95 query time" loading={loading} value={`${N(k.p95_s).toFixed(2)}s`} />
        <Scorecard label="Viewers" loading={loading} value={String(N(k.cur_viewers))} />
      </div>

      <Card title="By surface" note="Where the Dive was being viewed. Compute follows the viewer, not the Dive's owner.">
        <SortTable
          cols={[
            { key: "surface", label: "Surface" },
            { key: "viewers", label: "Viewers", num: true },
            { key: "queries", label: "Queries", num: true, fmt: (v: any) => fmtNum(N(v)) },
            { key: "exec_s",  label: "Exec time", num: true, fmt: (v: any) => fmtSec(N(v)) },
          ]}
          rows={rowsOf(bySurface.data).map((r) => ({ ...r, viewers: N(r.viewers), queries: N(r.queries), exec_s: N(r.exec_s) }))}
          loading={probe.isLoading || bySurface.isLoading}
          sortKey={surfSort} dir={surfDir}
          onSort={sortToggle(surfSort, setSurfSort, surfDir, setSurfDir)}
          empty="No Dive activity in this window."
        />
      </Card>

      <Card title="By Dive" note="Click any column header to sort. Sorting happens in the browser — no extra query.">
        <SortTable
          cols={[
            { key: "dive_name",   label: "Dive" },
            { key: "owner_name",  label: "Owner" },
            { key: "surface",     label: "Surface" },
            { key: "viewers",     label: "Viewers", num: true },
            { key: "queries",     label: "Queries", num: true, fmt: (v: any) => fmtNum(N(v)) },
            { key: "exec_s",      label: "Exec time", num: true, fmt: (v: any) => fmtSec(N(v)) },
            { key: "last_active", label: "Last active", ts: true },
          ]}
          rows={rowsOf(byDive.data).map((r) => ({
            dive_name: S(r.dive_name), owner_name: S(r.owner_name), surface: S(r.surface),
            viewers: N(r.viewers), queries: N(r.queries), exec_s: N(r.exec_s),
            last_active: S(r.last_active),
          }))}
          loading={probe.isLoading || byDive.isLoading}
          sortKey={diveSort} dir={diveDir}
          onSort={sortToggle(diveSort, setDiveSort, diveDir, setDiveDir)}
          empty="No Dive activity in this window."
          limit={10} expanded={showAll} onToggle={() => setShowAll(!showAll)}
        />
      </Card>

      <Card title="By owner"
            note="Traffic each owner's Dives RECEIVED — not what the owner ran themselves. Queries received and exec received are other people using their Dives; for a person's own consumption, see By viewer below. Dives created counts everything they own; dives used counts the ones with traffic in this window.">
        <SortTable
          cols={[
            { key: "owner_name",    label: "Owner" },
            { key: "dives_created", label: "Dives created", num: true },
            { key: "dives_used",    label: "Dives used", num: true },
            { key: "viewers",       label: "Viewers", num: true },
            { key: "queries",       label: "Queries received", num: true, fmt: (v: any) => fmtNum(N(v)) },
            { key: "exec_s",        label: "Exec received", num: true, fmt: (v: any) => fmtSec(N(v)) },
          ]}
          rows={rowsOf(byOwner.data).map((r) => ({
            owner_name: S(r.owner_name), dives_created: N(r.dives_created),
            dives_used: N(r.dives_used), viewers: N(r.viewers),
            queries: N(r.queries), exec_s: N(r.exec_s),
          }))}
          loading={probe.isLoading || byOwner.isLoading}
          sortKey={ownSort} dir={ownDir}
          onSort={sortToggle(ownSort, setOwnSort, ownDir, setOwnDir)}
          empty="No Dives visible in this window."
          limit={10} expanded={showAllOwn} onToggle={() => setShowAllOwn(!showAllOwn)}
        />
      </Card>

      <Card title="By viewer"
            note="What each person CONSUMED, whoever authored the Dive. Compute follows the viewer, so this is the account whose duckling ran the query and whose usage it counts against — the mirror image of By owner above.">
        <SortTable
          cols={[
            { key: "viewer",         label: "Viewer" },
            { key: "dives_viewed",   label: "Dives viewed", num: true },
            { key: "surfaces",       label: "Surfaces" },
            { key: "duckling_sizes", label: "Duckling size" },
            { key: "queries",        label: "Queries", num: true, fmt: (v: any) => fmtNum(N(v)) },
            { key: "exec_s",         label: "Exec time", num: true, fmt: (v: any) => fmtSec(N(v)) },
            { key: "p95_s",          label: "p95", num: true, fmt: (v: any) => `${N(v).toFixed(2)}s` },
          ]}
          rows={rowsOf(byViewer.data).map((r) => ({
            viewer: S(r.viewer), dives_viewed: N(r.dives_viewed), surfaces: S(r.surfaces),
            duckling_sizes: S(r.duckling_sizes), queries: N(r.queries),
            exec_s: N(r.exec_s), p95_s: N(r.p95_s),
          }))}
          loading={probe.isLoading || byViewer.isLoading}
          sortKey={viewSort} dir={viewDir}
          onSort={sortToggle(viewSort, setViewSort, viewDir, setViewDir)}
          empty="No Dive activity in this window."
          limit={10} expanded={showAllView} onToggle={() => setShowAllView(!showAllView)}
        />
      </Card>

      <p style={{ color: C.muted, fontSize: 12, marginTop: 20, lineHeight: 1.6 }}>
        Execution time is attribution, not a bill line item — Dive queries are priced as ordinary
        compute. <strong>Ideas from here:</strong> break <code>exec_s</code> down by
        <code> instance_type</code> to see which duckling sizes Dives land on, or group
        <code> start_time</code> by day to watch a launch land.
      </p>
    </div>
  );
}
