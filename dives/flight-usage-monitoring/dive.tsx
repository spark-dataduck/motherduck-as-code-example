// Flight Usage Monitoring
//
// Flight inventory and run health, built only from Flight SQL functions.
//
// Two constraints shape this dive:
//
//   1. QUERY_HISTORY cannot attribute compute to a specific Flight. Flight
//      connections are tagged `md-flights` with NO flight id, so unlike Dives
//      there is no per-Flight compute breakdown.
//
//   2. MD_LIST_FLIGHT_RUNS takes a flight_id literal and rejects a lateral
//      join ("only supports literals as parameters"), so SQL alone cannot fan
//      out across every Flight. The workaround below is the point of the file:
//      read MD_LIST_FLIGHTS(), then build a UNION ALL BY NAME over
//      MD_LIST_FLIGHT_RUNS in JavaScript, one branch per flight id.
//
// Scope: Flight SQL functions are scoped to the calling identity. You see the
// Flights YOUR user or service account owns — an org admin does not
// automatically see everyone's.
//
// The same SQL, ready to paste into a notebook, is in queries.sql.

import { useSQLQuery, useDiveState } from "@motherduck/react-sql-query";

export const REQUIRED_DATABASES = [];

const C = {
  blue: "#1a73e8", green: "#137333", red: "#c5221f", amber: "#b06000",
  text: "#202124", muted: "#5f6368", border: "#dadce0", pageBg: "#f8f9fa",
};

type Rows = Record<string, unknown>[];
const rowsOf = (d: unknown): Rows => (Array.isArray(d) ? (d as Rows) : []);
const N = (v: unknown): number => (v != null ? Number(v) : 0);
const S = (v: unknown): string => (v != null ? String(v) : "");

// Anything interpolated into SQL must be a UUID and nothing else.
// Durations get long here — document-parse totals over two hours.
const fmtDur = (s: number) =>
  !s ? "—" : s >= 3600 ? (s / 3600).toFixed(1) + "h" : s >= 60 ? (s / 60).toFixed(1) + "m" : s.toFixed(0) + "s";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Skel({ h, w }: { h: number; w?: string }) {
  return <div className="bg-gray-200 animate-pulse rounded" style={{ height: h, width: w || "100%" }} />;
}

function Scorecard({ label, value, loading, tone, first }: any) {
  return (
    <div style={{ flex: 1, minWidth: 150, borderLeft: first ? "none" : `1px solid ${C.border}`, paddingLeft: first ? 0 : 20 }}>
      <p style={{ color: C.muted, fontSize: 12, marginBottom: 4 }}>{label}</p>
      {loading ? <Skel h={34} w="80px" />
               : <p style={{ color: tone || C.text, fontSize: 30, fontWeight: 400, lineHeight: 1.1 }}>{value || "—"}</p>}
    </div>
  );
}

function Pill({ text, tone }: { text: string; tone: "ok" | "warn" | "bad" | "off" }) {
  const styles = {
    ok:   { bg: "#e6f4ea", fg: C.green },
    warn: { bg: "#fef7e0", fg: C.amber },
    bad:  { bg: "#fce8e6", fg: C.red },
    off:  { bg: "#f1f3f4", fg: C.muted },
  }[tone];
  return (
    <span style={{ background: styles.bg, color: styles.fg, borderRadius: 10, padding: "1px 8px", fontSize: 11, whiteSpace: "nowrap" }}>
      {text}
    </span>
  );
}

function SortTable({ cols, rows, loading, sortKey, dir, onSort, empty }: any) {
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
                           whiteSpace: "nowrap", paddingRight: i === cols.length - 1 ? 0 : 28 }}>
                {c.label}{sortKey === c.key ? (dir === "asc" ? " ↑" : " ↓") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r: any, i: number) => (
            <tr key={i} style={{ borderBottom: "1px solid #f1f3f4" }} className="hover:bg-gray-50">
              {cols.map((c: any, i: number) => (
                <td key={c.key} className={"py-2.5 " + (c.num || c.ts ? "text-right tabular-nums" : "text-left")}
                    style={{ whiteSpace: "nowrap", color: c.tone ? c.tone(r[c.key]) : undefined,
                             paddingRight: i === cols.length - 1 ? 0 : 28 }}>
                  {c.render ? c.render(r) : r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
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

export default function FlightUsageMonitoring() {
  const [win, setWin]           = useDiveState<string>("fail_window", "7");
  const [runSort, setRunSort]   = useDiveState<string>("run_sort", "last_run");
  const [runDir,  setRunDir]    = useDiveState<string>("run_dir", "desc");
  const [invSort, setInvSort]   = useDiveState<string>("inv_sort", "flight_name");
  const [invDir,  setInvDir]    = useDiveState<string>("inv_dir", "asc");

  const w = Number(win) || 7;
  const sortToggle = (cur: string, setK: any, dir: string, setD: any) => (k: string) => {
    if (k === cur) setD(dir === "asc" ? "desc" : "asc");
    else { setK(k); setD("desc"); }
  };

  // 1. Inventory. Plain SQL.
  const inventory = useSQLQuery(`
    SELECT flight_id, flight_name, schedule_cron, schedule_status,
           status, current_version,
           strftime(created_at, '%Y-%m-%d %H:%M') AS created_at,
           strftime(updated_at, '%Y-%m-%d %H:%M') AS updated_at
    FROM MD_LIST_FLIGHTS()
    ORDER BY flight_name
  `);

  const flights = rowsOf(inventory.data);
  const ids = flights.map((f) => S(f.flight_id)).filter((id) => UUID_RE.test(id));

  // 2. Run health. SQL cannot loop over the ids, so assemble the UNION here.
  const runsSQL = ids.length
    ? `
    WITH all_runs AS (
      ${ids.map((id) => `FROM MD_LIST_FLIGHT_RUNS(flight_id := '${id}')`).join("\n      UNION ALL BY NAME\n      ")}
    )
    SELECT flight_name,
           count(*)                                                     AS total_runs,
           count(*) FILTER (status = 'RUN_STATUS_SUCCEEDED')             AS succeeded,
           count(*) FILTER (status = 'RUN_STATUS_FAILED'
                            AND created_at >= now() - INTERVAL ${w} DAY) AS recent_failures,
           round(100.0 * count(*) FILTER (status = 'RUN_STATUS_SUCCEEDED') / count(*), 1) AS success_pct,
           round(avg(epoch(ended_at - started_at)) FILTER (status = 'RUN_STATUS_SUCCEEDED'), 1) AS avg_secs,
           round(sum(epoch(ended_at - started_at)) FILTER (status = 'RUN_STATUS_SUCCEEDED'), 1) AS total_secs,
           strftime(max(created_at), '%Y-%m-%d %H:%M')                   AS last_run,
           strftime(max(created_at) FILTER (status = 'RUN_STATUS_SUCCEEDED'), '%Y-%m-%d %H:%M') AS last_success,
           strftime(max(created_at) FILTER (status = 'RUN_STATUS_FAILED'), '%Y-%m-%d %H:%M')    AS last_failure
    FROM all_runs
    GROUP BY flight_name
    ORDER BY last_run DESC`
    : `SELECT NULL AS flight_name WHERE false`;

  const runs = useSQLQuery(runsSQL, { enabled: ids.length > 0 });
  const runRows = rowsOf(runs.data);

  const totalFailures = runRows.reduce((a, r) => a + N(r.recent_failures), 0);
  const scheduled = flights.filter((f) => S(f.schedule_cron).trim() !== "").length;
  const totalRuns = runRows.reduce((a, r) => a + N(r.total_runs), 0);
  const totalOk = runRows.reduce((a, r) => a + N(r.succeeded), 0);
  const okPct = totalRuns ? (100 * totalOk) / totalRuns : 0;

  const runsLoading = inventory.isLoading || (ids.length > 0 && runs.isLoading);

  return (
    <div style={{ background: C.pageBg, minHeight: "100vh", padding: 24, color: C.text }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, margin: 0, fontWeight: 500 }}>Flight Usage Monitoring</h1>
          <p style={{ color: C.muted, fontSize: 13, margin: "4px 0 0" }}>
            Inventory and run health from <code>MD_LIST_FLIGHTS</code> and <code>MD_LIST_FLIGHT_RUNS</code>.
          </p>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {[{ k: "7", l: "7 days" }, { k: "30", l: "30 days" }].map((o) => {
            const on = o.k === win;
            return (
              <button key={o.k} onClick={() => setWin(o.k)}
                style={{ background: on ? C.blue : "#fff", color: on ? "#fff" : C.muted,
                         border: `1px solid ${on ? C.blue : C.border}`, borderRadius: 6,
                         padding: "5px 12px", fontSize: 12, cursor: "pointer" }}>
                failures / {o.l}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 8, padding: 20, marginTop: 20, display: "flex", gap: 20, flexWrap: "wrap" }}>
        <Scorecard first label="Flights" loading={inventory.isLoading} value={String(flights.length)} />
        <Scorecard label="Scheduled" loading={inventory.isLoading} value={String(scheduled)} />
        <Scorecard label={`Failures / ${win}d`} loading={runsLoading} value={String(totalFailures)}
                   tone={totalFailures > 0 ? C.red : C.green} />
        <Scorecard label="Success rate" loading={runsLoading} value={`${okPct.toFixed(1)}%`}
                   tone={okPct < 90 ? C.red : undefined} />
      </div>

      <Card title="Run health"
            note="SQL cannot fan out across Flights, so this dive builds a UNION ALL BY NAME over MD_LIST_FLIGHT_RUNS — one branch per flight id. Click a header to sort.">
        <SortTable
          cols={[
            { key: "flight_name",     label: "Flight" },
            { key: "total_runs",      label: "Runs", num: true },
            { key: "success_pct",     label: "Success", num: true, render: (r: any) => `${r.success_pct.toFixed(1)}%`,
              tone: (v: any) => (N(v) < 90 ? C.red : undefined) },
            { key: "recent_failures", label: `Fail ${win}d`, num: true,
              tone: (v: any) => (N(v) > 0 ? C.red : undefined) },
            { key: "avg_secs",        label: "Avg run", num: true, render: (r: any) => fmtDur(r.avg_secs) },
            { key: "total_secs",      label: "Total run", num: true, render: (r: any) => fmtDur(r.total_secs) },
            { key: "last_run",        label: "Last run", ts: true },
            { key: "last_success",    label: "Last success", ts: true, render: (r: any) => r.last_success || "—" },
            { key: "last_failure",    label: "Last failure", ts: true, render: (r: any) => r.last_failure || "—" },
          ]}
          rows={runRows.map((r) => ({
            flight_name: S(r.flight_name), total_runs: N(r.total_runs), success_pct: N(r.success_pct),
            recent_failures: N(r.recent_failures), avg_secs: N(r.avg_secs), total_secs: N(r.total_secs),
            last_run: S(r.last_run), last_success: S(r.last_success), last_failure: S(r.last_failure),
          }))}
          loading={runsLoading}
          sortKey={runSort} dir={runDir}
          onSort={sortToggle(runSort, setRunSort, runDir, setRunDir)}
          empty="No Flights visible to this identity."
        />
      </Card>

      <Card title="Inventory">
        <SortTable
          cols={[
            { key: "flight_name",     label: "Flight" },
            { key: "schedule_cron",   label: "Schedule", render: (r: any) => r.schedule_cron || "(on demand)" },
            { key: "schedule_status", label: "Schedule status",
              render: (r: any) => r.schedule_cron
                ? <Pill text={r.schedule_status.replace("SCHEDULE_STATUS_", "").toLowerCase() || "—"}
                        tone={r.schedule_status.includes("ACTIVE") ? "ok" : "warn"} />
                : <Pill text="on demand" tone="off" /> },
            { key: "status",          label: "Status",
              render: (r: any) => <Pill text={r.status.replace("JOB_STATUS_", "").toLowerCase()}
                                        tone={r.status.includes("ACTIVE") ? "ok" : "off"} /> },
            { key: "current_version", label: "Version", num: true },
            { key: "created_at",      label: "Created", ts: true },
            { key: "updated_at",      label: "Updated", ts: true },
          ]}
          rows={flights.map((f) => ({
            flight_name: S(f.flight_name), schedule_cron: S(f.schedule_cron),
            schedule_status: S(f.schedule_status), status: S(f.status),
            current_version: N(f.current_version),
            created_at: S(f.created_at), updated_at: S(f.updated_at),
          }))}
          loading={inventory.isLoading}
          sortKey={invSort} dir={invDir}
          onSort={sortToggle(invSort, setInvSort, invDir, setInvDir)}
          empty="No Flights visible to this identity."
        />
      </Card>

      <p style={{ color: C.muted, fontSize: 12, marginTop: 20, lineHeight: 1.6 }}>
        Per-Flight <em>compute</em> attribution is not available: Flight connections appear in{" "}
        <code>QUERY_HISTORY</code> tagged <code>md-flights</code> with no flight id. Flight-hour
        charges appear in the billing portal. <strong>Ideas from here:</strong> pull{" "}
        <code>MD_GET_FLIGHT_LOGS</code> for the newest failed <code>run_number</code> to surface the
        error inline, or chart <code>avg_secs</code> over time to catch a Flight getting slower
        before it starts timing out.
      </p>
    </div>
  );
}
