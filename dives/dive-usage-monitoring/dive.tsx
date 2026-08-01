// Dive Usage Monitoring
//
// Which Dives are driving compute, on whose ducklings, and from where.
//
// Every query a Dive runs is stamped with a user_agent containing the Dive's
// ID and the surface it was viewed from:
//   md-dives/v1(<id>)                        -> MotherDuck UI
//   md-dive-embed/v1(<id>)                   -> externally embedded
//   md-dives-mcp-app/v1/v1(<id>,transport=)  -> MCP app (Claude, ChatGPT, ...)
// The doubled "/v1/v1" and the trailing ",transport=..." in the MCP form are
// real; the regex below tolerates both.
//
// Requires org admin on a Business plan (QUERY_HISTORY is org-scoped) and has a
// small ingestion delay. Uses no MotherDuck-internal tables.

import { useSQLQuery, useDiveState } from "@motherduck/react-sql-query";

export const REQUIRED_DATABASES = [];

const CANVAS = "#0a0a0a", PAGE = "#000000", INK = "#ffffff", INK2 = "#c3c2b7";
const MUTED = "#898781", BORDER = "rgba(255,255,255,0.10)", ACCENT = "#3987e5";
const FONT = '"Poppins", "Century Gothic", system-ui, sans-serif';

type Rows = Record<string, unknown>[];
const rowsOf = (d: unknown): Rows => (Array.isArray(d) ? (d as Rows) : []);
const N = (v: unknown): number => (v != null ? Number(v) : 0);
const S = (v: unknown): string => (v != null ? String(v) : "");
const fmtNum = (v: number) => new Intl.NumberFormat("en-US", { notation: "compact" }).format(v);
const fmtSec = (v: number) => (v >= 3600 ? `${(v / 3600).toFixed(1)}h` : v >= 60 ? `${(v / 60).toFixed(1)}m` : `${v.toFixed(1)}s`);

const WINDOWS = [
  { key: "7", label: "7 days" },
  { key: "30", label: "30 days" },
  { key: "90", label: "90 days" },
] as const;

function Kpi({ label, value, loading }: { label: string; value: string; loading: boolean }) {
  return (
    <div style={{ background: CANVAS, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "14px 16px", flex: 1, minWidth: 150 }}>
      <div style={{ color: MUTED, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6 }}>{label}</div>
      <div style={{ color: INK, fontSize: 24, fontWeight: 600, marginTop: 6 }}>{loading ? "—" : value}</div>
    </div>
  );
}

function Seg({ options, value, onChange }: { options: readonly { key: string; label: string }[]; value: string; onChange: (k: string) => void }) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <button key={o.key} onClick={() => onChange(o.key)}
            style={{
              background: on ? ACCENT : "transparent", color: on ? "#fff" : INK2,
              border: `1px solid ${on ? ACCENT : BORDER}`, borderRadius: 7,
              padding: "5px 12px", fontSize: 12, fontFamily: FONT, cursor: "pointer",
            }}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Table({ head, rows, loading }: { head: string[]; rows: (string | number)[][]; loading: boolean }) {
  if (loading) return <div style={{ color: MUTED, padding: 24 }}>Loading…</div>;
  if (!rows.length) return <div style={{ color: MUTED, padding: 24 }}>No Dive activity in this window.</div>;
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

export default function DiveUsageMonitoring() {
  const [days, setDays] = useDiveState<string>("days", "30");

  // Per-Dive compute, split by the surface the Dive was viewed from.
  const perDive = useSQLQuery(`
    WITH dive_queries AS (
      SELECT
        regexp_extract(user_agent,
          'md-dive[s]?(?:-embed)?(?:-mcp-app)?/v1(?:/v1)?[(_]([0-9a-f\\-]{36})', 1) AS dive_id,
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
        AND start_time > now() - INTERVAL ${Number(days)} DAY
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
    LIMIT 100
  `);

  // Same filter, rolled up to one row per surface.
  const bySurface = useSQLQuery(`
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
      AND start_time > now() - INTERVAL ${Number(days)} DAY
    GROUP BY ALL
    ORDER BY exec_s DESC
  `);

  const loading = perDive.loading || bySurface.loading;
  const dives = rowsOf(perDive.data);
  const surfaces = rowsOf(bySurface.data);

  const totalQueries = surfaces.reduce((a, r) => a + N(r.queries), 0);
  const totalExec = surfaces.reduce((a, r) => a + N(r.exec_s), 0);
  const distinctDives = new Set(dives.map((r) => S(r.dive_name))).size;

  return (
    <div style={{ background: PAGE, minHeight: "100vh", fontFamily: FONT, padding: 24, color: INK }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, margin: 0, letterSpacing: 0.3 }}>Dive Usage Monitoring</h1>
          <p style={{ color: MUTED, fontSize: 13, margin: "6px 0 0" }}>
            Compute attributed to Dives, from <code style={{ color: INK2 }}>MD_INFORMATION_SCHEMA.QUERY_HISTORY</code>.
          </p>
        </div>
        <Seg options={WINDOWS} value={days} onChange={setDays} />
      </div>

      <div style={{ display: "flex", gap: 12, marginTop: 20, flexWrap: "wrap" }}>
        <Kpi label="Dive queries" value={fmtNum(totalQueries)} loading={loading} />
        <Kpi label="Execution time" value={fmtSec(totalExec)} loading={loading} />
        <Kpi label="Dives active" value={String(distinctDives)} loading={loading} />
        <Kpi label="Surfaces in use" value={String(surfaces.length)} loading={loading} />
      </div>

      <h2 style={{ fontSize: 14, color: INK2, marginTop: 28, marginBottom: 10, fontWeight: 500 }}>By surface</h2>
      <Table
        head={["Surface", "Viewers", "Queries", "Exec time"]}
        rows={surfaces.map((r) => [S(r.surface), N(r.viewers), fmtNum(N(r.queries)), fmtSec(N(r.exec_s))])}
        loading={bySurface.loading}
      />

      <h2 style={{ fontSize: 14, color: INK2, marginTop: 28, marginBottom: 10, fontWeight: 500 }}>By Dive</h2>
      <Table
        head={["Dive", "Surface", "Viewers", "Queries", "Exec time", "Last active"]}
        rows={dives.map((r) => [
          S(r.dive_name), S(r.surface), N(r.viewers),
          fmtNum(N(r.queries)), fmtSec(N(r.exec_s)), S(r.last_active).slice(0, 16),
        ])}
        loading={perDive.loading}
      />

      <p style={{ color: MUTED, fontSize: 12, marginTop: 24, lineHeight: 1.6 }}>
        Compute follows the <em>viewer</em>: a Dive in the UI runs on the viewer's duckling, and an
        embedded Dive runs on read-scaling ducklings of the user its embed session was created for.
        Execution time is attribution, not a bill line item — Dive queries are priced as ordinary
        compute.
      </p>
    </div>
  );
}
