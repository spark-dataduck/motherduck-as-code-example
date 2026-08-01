// Flight Usage Monitoring
//
// Flight inventory and run health, built only from Flight SQL functions.
//
// Two constraints shape this dive, and both are worth understanding before you
// copy it:
//
//   1. QUERY_HISTORY cannot attribute compute to a specific Flight. Flight
//      connections are tagged `md-flights` with NO flight id, so unlike Dives
//      there is no per-Flight breakdown available from query history.
//
//   2. MD_LIST_FLIGHT_RUNS takes a flight_id literal and rejects a lateral
//      join ("only supports literals as parameters"), so SQL alone cannot fan
//      out across every Flight.
//
// The workaround below is the point of this file: query MD_LIST_FLIGHTS() for
// the inventory, then build a UNION ALL BY NAME over MD_LIST_FLIGHT_RUNS in
// JavaScript, one branch per flight id. The generated SQL is exactly the shape
// you would hand-write, minus the hand-editing.
//
// Scope caveat: Flight SQL functions are user/service-account scoped. You see
// the Flights that YOUR identity owns — an org admin does not automatically see
// everyone's. Run this as the identity whose Flights you want to monitor.
//
// Uses no MotherDuck-internal tables.

import { useSQLQuery, useDiveState } from "@motherduck/react-sql-query";

export const REQUIRED_DATABASES = [];

const CANVAS = "#0a0a0a", PAGE = "#000000", INK = "#ffffff", INK2 = "#c3c2b7";
const MUTED = "#898781", BORDER = "rgba(255,255,255,0.10)", ACCENT = "#3987e5";
const OK = "#3dc789", BAD = "#e0574f";
const FONT = '"Poppins", "Century Gothic", system-ui, sans-serif';

type Rows = Record<string, unknown>[];
const rowsOf = (d: unknown): Rows => (Array.isArray(d) ? (d as Rows) : []);
const N = (v: unknown): number => (v != null ? Number(v) : 0);
const S = (v: unknown): string => (v != null ? String(v) : "");

// A flight id from MD_LIST_FLIGHTS is a UUID. Accept nothing else before
// interpolating it into SQL.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Kpi({ label, value, tone, loading }: { label: string; value: string; tone?: string; loading: boolean }) {
  return (
    <div style={{ background: CANVAS, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "14px 16px", flex: 1, minWidth: 150 }}>
      <div style={{ color: MUTED, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6 }}>{label}</div>
      <div style={{ color: tone ?? INK, fontSize: 24, fontWeight: 600, marginTop: 6 }}>{loading ? "—" : value}</div>
    </div>
  );
}

// Cells may be plain values or rendered nodes (the failure count is colored).
function Table({ head, rows, loading, empty }: { head: string[]; rows: any[][]; loading: boolean; empty: string }) {
  if (loading) return <div style={{ color: MUTED, padding: 24 }}>Loading…</div>;
  if (!rows.length) return <div style={{ color: MUTED, padding: 24 }}>{empty}</div>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={h} style={{ textAlign: i === 0 ? "left" : "right", color: MUTED, fontWeight: 500, padding: "8px 10px", borderBottom: `1px solid ${BORDER}`, whiteSpace: "nowrap" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {r.map((c, ci) => (
                <td key={ci} style={{ textAlign: ci === 0 ? "left" : "right", color: ci === 0 ? INK : INK2, padding: "8px 10px", borderBottom: `1px solid ${BORDER}`, whiteSpace: "nowrap" }}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function FlightUsageMonitoring() {
  const [failWindow, setFailWindow] = useDiveState<string>("fail_window", "7");

  // 1. Inventory. This part is plain SQL.
  const inventory = useSQLQuery(`
    SELECT flight_id, flight_name, schedule_cron, schedule_status,
           status, current_version, created_at, updated_at
    FROM MD_LIST_FLIGHTS()
    ORDER BY flight_name
  `);

  const flights = rowsOf(inventory.data);
  const ids = flights.map((f) => S(f.flight_id)).filter((id) => UUID_RE.test(id));

  // 2. Run health. SQL cannot loop over the ids, so build the UNION here.
  //    Produces exactly:
  //      WITH all_runs AS (
  //        FROM MD_LIST_FLIGHT_RUNS(flight_id := '<id1>')
  //        UNION ALL BY NAME
  //        FROM MD_LIST_FLIGHT_RUNS(flight_id := '<id2>')
  //      ) SELECT ...
  const runsSQL = ids.length
    ? `
    WITH all_runs AS (
      ${ids.map((id) => `FROM MD_LIST_FLIGHT_RUNS(flight_id := '${id}')`).join("\n      UNION ALL BY NAME\n      ")}
    )
    SELECT flight_name,
           count(*)                                                    AS total_runs,
           count(*) FILTER (status = 'RUN_STATUS_FAILED'
                            AND created_at >= now() - INTERVAL ${Number(failWindow)} DAY) AS recent_failures,
           count(*) FILTER (status = 'RUN_STATUS_SUCCEEDED')            AS succeeded,
           max(created_at)                                             AS last_run,
           max(created_at) FILTER (status = 'RUN_STATUS_SUCCEEDED')     AS last_successful_run,
           max(created_at) FILTER (status = 'RUN_STATUS_FAILED')        AS last_failed_run
    FROM all_runs
    GROUP BY flight_name
    ORDER BY last_run DESC`
    : `SELECT NULL AS flight_name WHERE false`;

  const runs = useSQLQuery(runsSQL);
  const runRows = rowsOf(runs.data);

  const totalFailures = runRows.reduce((a, r) => a + N(r.recent_failures), 0);
  const scheduled = flights.filter((f) => S(f.schedule_cron).trim() !== "").length;

  return (
    <div style={{ background: PAGE, minHeight: "100vh", fontFamily: FONT, padding: 24, color: INK }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, margin: 0, letterSpacing: 0.3 }}>Flight Usage Monitoring</h1>
          <p style={{ color: MUTED, fontSize: 13, margin: "6px 0 0" }}>
            Inventory and run health from <code style={{ color: INK2 }}>MD_LIST_FLIGHTS</code> and{" "}
            <code style={{ color: INK2 }}>MD_LIST_FLIGHT_RUNS</code>.
          </p>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {[
            { key: "7", label: "7 days" },
            { key: "30", label: "30 days" },
          ].map((o) => {
            const on = o.key === failWindow;
            return (
              <button key={o.key} onClick={() => setFailWindow(o.key)}
                style={{
                  background: on ? ACCENT : "transparent", color: on ? "#fff" : INK2,
                  border: `1px solid ${on ? ACCENT : BORDER}`, borderRadius: 7,
                  padding: "5px 12px", fontSize: 12, fontFamily: FONT, cursor: "pointer",
                }}>
                failures / {o.label}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginTop: 20, flexWrap: "wrap" }}>
        <Kpi label="Flights" value={String(flights.length)} loading={inventory.loading} />
        <Kpi label="Scheduled" value={String(scheduled)} loading={inventory.loading} />
        <Kpi label={`Failures / ${failWindow}d`} value={String(totalFailures)}
             tone={totalFailures > 0 ? BAD : OK} loading={runs.loading} />
        <Kpi label="Runs recorded" value={String(runRows.reduce((a, r) => a + N(r.total_runs), 0))} loading={runs.loading} />
      </div>

      <h2 style={{ fontSize: 14, color: INK2, marginTop: 28, marginBottom: 10, fontWeight: 500 }}>Run health</h2>
      <Table
        head={["Flight", "Runs", `Failures ${failWindow}d`, "Last run", "Last success", "Last failure"]}
        rows={runRows.map((r) => [
          S(r.flight_name),
          N(r.total_runs),
          <span style={{ color: N(r.recent_failures) > 0 ? BAD : INK2 }}>{N(r.recent_failures)}</span>,
          S(r.last_run).slice(0, 16),
          S(r.last_successful_run).slice(0, 16) || "—",
          S(r.last_failed_run).slice(0, 16) || "—",
        ])}
        loading={inventory.loading || runs.loading}
        empty="No Flights visible to this identity."
      />

      <h2 style={{ fontSize: 14, color: INK2, marginTop: 28, marginBottom: 10, fontWeight: 500 }}>Inventory</h2>
      <Table
        head={["Flight", "Schedule", "Schedule status", "Status", "Version", "Updated"]}
        rows={flights.map((f) => [
          S(f.flight_name),
          S(f.schedule_cron) || "(on demand)",
          S(f.schedule_status),
          S(f.status),
          N(f.current_version),
          S(f.updated_at).slice(0, 16),
        ])}
        loading={inventory.loading}
        empty="No Flights visible to this identity."
      />

      <p style={{ color: MUTED, fontSize: 12, marginTop: 24, lineHeight: 1.6 }}>
        Flight SQL functions are scoped to the calling identity, so this shows the Flights owned by
        whoever is viewing — not the whole organization. Per-Flight <em>compute</em> attribution is
        not available at all: Flight connections appear in{" "}
        <code style={{ color: INK2 }}>QUERY_HISTORY</code> tagged{" "}
        <code style={{ color: INK2 }}>md-flights</code> with no flight id. Flight-hour charges do
        appear in the billing portal.
      </p>
    </div>
  );
}
