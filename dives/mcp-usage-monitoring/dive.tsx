// MCP Usage Monitoring
//
// Who is querying MotherDuck through the MCP server, from which client.
//
// The MotherDuck MCP server stamps every query with a user_agent of the form:
//   duckdb/v1.5.4(linux_arm64) node-neo-api mcp-server-motherduck-remote/1.0.0(<client>)
// where <client> is the calling agent — observed values include claude-user,
// claude-code, openai-mcp, node, and python-httpx/<version>.
//
// Not to be confused with a Dive rendered inside an MCP app, which is tagged
// md-dives-mcp-app/... instead. That belongs to the Dive Usage Monitoring dive;
// this one deliberately excludes it so the two do not double-count.
//
// Requires org admin on a Business plan (QUERY_HISTORY is org-scoped).
// Uses no MotherDuck-internal tables.

import { useSQLQuery, useDiveState } from "@motherduck/react-sql-query";

const CANVAS = "#0a0a0a", PAGE = "#000000", INK = "#ffffff", INK2 = "#c3c2b7";
const MUTED = "#898781", BORDER = "rgba(255,255,255,0.10)", ACCENT = "#3987e5";
const FONT = '"Poppins", "Century Gothic", system-ui, sans-serif';

export const REQUIRED_DATABASES = [];

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

function Table({ head, rows, loading, empty }: { head: string[]; rows: (string | number)[][]; loading: boolean; empty: string }) {
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

// Shared WHERE clause: MCP-server traffic only, excluding Dives-in-MCP-apps.
const MCP_FILTER = `user_agent LIKE '%mcp-server-motherduck%' AND user_agent NOT LIKE '%md-dive%'`;

export default function McpUsageMonitoring() {
  const [days, setDays] = useDiveState<string>("days", "30");

  const byClient = useSQLQuery(`
    SELECT
      regexp_extract(user_agent, 'mcp-server-motherduck-remote/([0-9.]+)\\(([^)]*)\\)', 2) AS mcp_client,
      regexp_extract(user_agent, 'mcp-server-motherduck-remote/([0-9.]+)\\(([^)]*)\\)', 1) AS server_version,
      count(DISTINCT user_name)              AS users,
      count(*)                               AS queries,
      round(sum(epoch(execution_time)), 1)   AS exec_s,
      count(*) FILTER (error_message IS NOT NULL) AS errors,
      max(start_time)                        AS last_active
    FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
    WHERE ${MCP_FILTER}
      AND start_time > now() - INTERVAL ${Number(days)} DAY
    GROUP BY ALL
    ORDER BY queries DESC
  `);

  const byUser = useSQLQuery(`
    SELECT
      user_name,
      regexp_extract(user_agent, 'mcp-server-motherduck-remote/[0-9.]+\\(([^)]*)\\)', 1) AS mcp_client,
      count(*)                               AS queries,
      round(sum(epoch(execution_time)), 1)   AS exec_s,
      max(start_time)                        AS last_active
    FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
    WHERE ${MCP_FILTER}
      AND start_time > now() - INTERVAL ${Number(days)} DAY
    GROUP BY ALL
    ORDER BY queries DESC
    LIMIT 100
  `);

  const daily = useSQLQuery(`
    SELECT
      date_trunc('day', start_time)::DATE    AS day,
      count(*)                               AS queries,
      round(sum(epoch(execution_time)), 1)   AS exec_s
    FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
    WHERE ${MCP_FILTER}
      AND start_time > now() - INTERVAL ${Number(days)} DAY
    GROUP BY ALL
    ORDER BY day DESC
    LIMIT 30
  `);

  const clients = rowsOf(byClient.data);
  const users = rowsOf(byUser.data);
  const days_ = rowsOf(daily.data);
  const loading = byClient.loading;

  const totalQueries = clients.reduce((a, r) => a + N(r.queries), 0);
  const totalExec = clients.reduce((a, r) => a + N(r.exec_s), 0);
  const totalErrors = clients.reduce((a, r) => a + N(r.errors), 0);
  const errPct = totalQueries ? (100 * totalErrors) / totalQueries : 0;

  return (
    <div style={{ background: PAGE, minHeight: "100vh", fontFamily: FONT, padding: 24, color: INK }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, margin: 0, letterSpacing: 0.3 }}>MCP Usage Monitoring</h1>
          <p style={{ color: MUTED, fontSize: 13, margin: "6px 0 0" }}>
            Queries reaching MotherDuck through the MCP server, by calling client.
          </p>
        </div>
        <Seg options={WINDOWS} value={days} onChange={setDays} />
      </div>

      <div style={{ display: "flex", gap: 12, marginTop: 20, flexWrap: "wrap" }}>
        <Kpi label="MCP queries" value={fmtNum(totalQueries)} loading={loading} />
        <Kpi label="Execution time" value={fmtSec(totalExec)} loading={loading} />
        <Kpi label="Distinct clients" value={String(clients.length)} loading={loading} />
        <Kpi label="Error rate" value={`${errPct.toFixed(1)}%`} loading={loading} />
      </div>

      <h2 style={{ fontSize: 14, color: INK2, marginTop: 28, marginBottom: 10, fontWeight: 500 }}>By client</h2>
      <Table
        head={["Client", "Server", "Users", "Queries", "Exec time", "Errors", "Last active"]}
        rows={clients.map((r) => [
          S(r.mcp_client) || "(unknown)", S(r.server_version), N(r.users),
          fmtNum(N(r.queries)), fmtSec(N(r.exec_s)), N(r.errors), S(r.last_active).slice(0, 16),
        ])}
        loading={byClient.loading}
        empty="No MCP traffic in this window."
      />

      <h2 style={{ fontSize: 14, color: INK2, marginTop: 28, marginBottom: 10, fontWeight: 500 }}>By user</h2>
      <Table
        head={["User", "Client", "Queries", "Exec time", "Last active"]}
        rows={users.map((r) => [
          S(r.user_name), S(r.mcp_client) || "(unknown)",
          fmtNum(N(r.queries)), fmtSec(N(r.exec_s)), S(r.last_active).slice(0, 16),
        ])}
        loading={byUser.loading}
        empty="No MCP traffic in this window."
      />

      <h2 style={{ fontSize: 14, color: INK2, marginTop: 28, marginBottom: 10, fontWeight: 500 }}>Daily volume</h2>
      <Table
        head={["Day", "Queries", "Exec time"]}
        rows={days_.map((r) => [S(r.day), fmtNum(N(r.queries)), fmtSec(N(r.exec_s))])}
        loading={daily.loading}
        empty="No MCP traffic in this window."
      />

      <p style={{ color: MUTED, fontSize: 12, marginTop: 24, lineHeight: 1.6 }}>
        The client string is self-reported by whatever connects to the MCP server, so treat it as a
        useful label rather than an identity. A Dive opened inside an MCP app is tagged
        <code style={{ color: INK2 }}> md-dives-mcp-app</code> instead and is excluded here — it is
        counted by the Dive Usage Monitoring dive.
      </p>
    </div>
  );
}
