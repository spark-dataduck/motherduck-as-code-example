// MCP Usage Monitoring
//
// Who is querying MotherDuck through the MCP server, from which client.
//
// The MotherDuck MCP server stamps every query:
//   duckdb/... node-neo-api mcp-server-motherduck-remote/1.0.0(<client>)
// Observed <client> values: claude-user, claude-code, openai-mcp, node,
// python-httpx/<version>. It is self-reported, so treat it as a label rather
// than an identity.
//
// A Dive rendered inside an MCP app is tagged md-dives-mcp-app and matches both
// filters; it is excluded here and counted by the Dive Usage Monitoring dive,
// so the two never double-count the same query.
//
// The same SQL, ready to paste into a notebook, is in queries.sql.

import { useSQLQuery, useDiveState } from "@motherduck/react-sql-query";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";

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

// MCP-server traffic only, excluding Dives rendered inside MCP apps.
const MCP = `user_agent LIKE '%mcp-server-motherduck%' AND user_agent NOT LIKE '%md-dive%'`;
const CLIENT = `regexp_extract(user_agent, 'mcp-server-motherduck-remote/([0-9.]+)\\(([^)]*)\\)', 2)`;

function Skel({ h, w }: { h: number; w?: string }) {
  return <div className="bg-gray-200 animate-pulse rounded" style={{ height: h, width: w || "100%" }} />;
}

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

function Scorecard({ label, value, loading, delta, tone, first }: any) {
  return (
    <div style={{ flex: 1, minWidth: 150, borderLeft: first ? "none" : `1px solid ${C.border}`, paddingLeft: first ? 0 : 20 }}>
      <p style={{ color: C.muted, fontSize: 12, marginBottom: 4 }}>{label}</p>
      {loading ? <Skel h={34} w="80px" /> : (
        <>
          <p style={{ color: tone || C.text, fontSize: 30, fontWeight: 400, lineHeight: 1.1 }}>{value || "—"}</p>
          <div style={{ marginTop: 4, minHeight: 16 }}>{delta}</div>
        </>
      )}
    </div>
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
                  {c.fmt ? c.fmt(r[c.key]) : r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
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

export default function McpUsageMonitoring() {
  const [days, setDays]         = useDiveState<string>("days", "30");
  const [cliSort, setCliSort]   = useDiveState<string>("cli_sort", "queries");
  const [cliDir,  setCliDir]    = useDiveState<string>("cli_dir", "desc");
  const [usrSort, setUsrSort]   = useDiveState<string>("usr_sort", "queries");
  const [usrDir,  setUsrDir]    = useDiveState<string>("usr_dir", "desc");

  const d = Number(days) || 30;

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
      count(*) FILTER (error_message IS NOT NULL
                       AND start_time > now() - INTERVAL ${d} DAY)                          AS cur_errors,
      count(DISTINCT user_name) FILTER (start_time > now() - INTERVAL ${d} DAY)             AS cur_users
    FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
    WHERE ${MCP}
      AND start_time > now() - INTERVAL ${2 * d} DAY
  `, { enabled: ready });

  const byClient = useSQLQuery(`
    SELECT ${CLIENT}                             AS mcp_client,
           count(DISTINCT user_name)             AS users,
           count(*)                              AS queries,
           round(sum(epoch(execution_time)), 1)  AS exec_s,
           round(quantile_cont(epoch(execution_time), 0.95), 2) AS p95_s,
           count(*) FILTER (error_message IS NOT NULL) AS errors,
           strftime(max(start_time), '%Y-%m-%d %H:%M') AS last_active
    FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
    WHERE ${MCP} AND start_time > now() - INTERVAL ${d} DAY
    GROUP BY ALL
    ORDER BY queries DESC
  `, { enabled: ready });

  const byUser = useSQLQuery(`
    SELECT user_name,
           ${CLIENT}                             AS mcp_client,
           count(*)                              AS queries,
           round(sum(epoch(execution_time)), 1)  AS exec_s,
           strftime(max(start_time), '%Y-%m-%d %H:%M') AS last_active
    FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
    WHERE ${MCP} AND start_time > now() - INTERVAL ${d} DAY
    GROUP BY ALL
    ORDER BY queries DESC
    LIMIT 100
  `, { enabled: ready });

  // A date spine keeps quiet days visible as zeroes instead of vanishing.
  const daily = useSQLQuery(`
    WITH spine AS (
      SELECT unnest(generate_series(
        date_trunc('day', now() - INTERVAL ${d} DAY)::TIMESTAMP,
        date_trunc('day', now())::TIMESTAMP, INTERVAL 1 DAY))::DATE AS day
    ),
    hits AS (
      SELECT date_trunc('day', start_time)::DATE AS day,
             count(*) AS queries,
             round(sum(epoch(execution_time)), 1) AS exec_s
      FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
      WHERE ${MCP} AND start_time > now() - INTERVAL ${d} DAY
      GROUP BY 1
    )
    SELECT s.day::VARCHAR AS day,
           coalesce(h.queries, 0) AS queries,
           coalesce(h.exec_s, 0)  AS exec_s
    FROM spine s LEFT JOIN hits h USING (day)
    ORDER BY s.day
  `, { enabled: ready });

  const k = rowsOf(kpi.data)[0] ?? {};
  const loading = probe.isLoading || kpi.isLoading;
  const errPct = N(k.cur_queries) ? (100 * N(k.cur_errors)) / N(k.cur_queries) : 0;

  if (denied) {
    return (
      <div style={{ background: C.pageBg, minHeight: "100vh", padding: 24 }}>
        <h1 style={{ fontSize: 20, color: C.text, margin: 0 }}>MCP Usage Monitoring</h1>
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
          <h1 style={{ fontSize: 20, margin: 0, fontWeight: 500 }}>MCP Usage Monitoring</h1>
          <p style={{ color: C.muted, fontSize: 13, margin: "4px 0 0" }}>
            Queries reaching MotherDuck through the MCP server, by calling client.
          </p>
        </div>
        <Seg value={days} onChange={setDays} />
      </div>

      <div style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 8, padding: 20, marginTop: 20, display: "flex", gap: 20, flexWrap: "wrap" }}>
        <Scorecard first label="MCP queries" loading={loading} value={fmtNum(N(k.cur_queries))}
                   delta={<Delta cur={N(k.cur_queries)} prev={N(k.prev_queries)} />} />
        <Scorecard label="Execution time" loading={loading} value={fmtSec(N(k.cur_exec_s))}
                   delta={<Delta cur={N(k.cur_exec_s)} prev={N(k.prev_exec_s)} />} />
        <Scorecard label="Error rate" loading={loading} value={`${errPct.toFixed(1)}%`}
                   tone={errPct > 5 ? C.red : undefined} />
        <Scorecard label="Users" loading={loading} value={String(N(k.cur_users))} />
      </div>

      <Card title="By client" note="Click any column header to sort. Sorting happens in the browser — no extra query.">
        <SortTable
          cols={[
            { key: "mcp_client",  label: "Client" },
            { key: "users",       label: "Users", num: true },
            { key: "queries",     label: "Queries", num: true, fmt: (v: any) => fmtNum(N(v)) },
            { key: "exec_s",      label: "Exec time", num: true, fmt: (v: any) => fmtSec(N(v)) },
            { key: "p95_s",       label: "p95", num: true, fmt: (v: any) => `${N(v).toFixed(2)}s` },
            { key: "errors",      label: "Errors", num: true, tone: (v: any) => (N(v) > 0 ? C.red : undefined) },
            { key: "last_active", label: "Last active", ts: true },
          ]}
          rows={rowsOf(byClient.data).map((r) => ({
            mcp_client: S(r.mcp_client) || "(unknown)", users: N(r.users), queries: N(r.queries),
            exec_s: N(r.exec_s), p95_s: N(r.p95_s), errors: N(r.errors), last_active: S(r.last_active),
          }))}
          loading={probe.isLoading || byClient.isLoading}
          sortKey={cliSort} dir={cliDir}
          onSort={sortToggle(cliSort, setCliSort, cliDir, setCliDir)}
          empty="No MCP traffic in this window."
        />
      </Card>

      <Card title="By user">
        <SortTable
          cols={[
            { key: "user_name",   label: "User" },
            { key: "mcp_client",  label: "Client" },
            { key: "queries",     label: "Queries", num: true, fmt: (v: any) => fmtNum(N(v)) },
            { key: "exec_s",      label: "Exec time", num: true, fmt: (v: any) => fmtSec(N(v)) },
            { key: "last_active", label: "Last active", ts: true },
          ]}
          rows={rowsOf(byUser.data).map((r) => ({
            user_name: S(r.user_name), mcp_client: S(r.mcp_client) || "(unknown)",
            queries: N(r.queries), exec_s: N(r.exec_s), last_active: S(r.last_active),
          }))}
          loading={probe.isLoading || byUser.isLoading}
          sortKey={usrSort} dir={usrDir}
          onSort={sortToggle(usrSort, setUsrSort, usrDir, setUsrDir)}
          empty="No MCP traffic in this window."
        />
      </Card>

      <Card title="Daily volume"
            note="Queries and execution time share an x-axis but not a y-axis — they differ by orders of magnitude, so each gets its own scale. Built on a date spine, so a day with no traffic plots as 0 instead of vanishing.">
        {probe.isLoading || daily.isLoading ? <Skel h={260} /> : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={rowsOf(daily.data).map((r) => ({
                day: S(r.day).slice(5),         // MM-DD is enough on an axis
                queries: N(r.queries),
                exec_s: N(r.exec_s),
              }))}
              margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#f1f3f4" vertical={false} />
              <XAxis dataKey="day" tick={{ fill: C.muted, fontSize: 11 }}
                     axisLine={{ stroke: C.border }} tickLine={false} minTickGap={16} />
              <YAxis yAxisId="q" tick={{ fill: C.muted, fontSize: 11 }}
                     axisLine={false} tickLine={false} width={48}
                     tickFormatter={(v: number) => fmtNum(v)} />
              <YAxis yAxisId="s" orientation="right" tick={{ fill: C.muted, fontSize: 11 }}
                     axisLine={false} tickLine={false} width={48}
                     tickFormatter={(v: number) => fmtSec(v)} />
              <Tooltip
                contentStyle={{ border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12 }}
                formatter={(v: any, n: any) => (n === "Exec time" ? fmtSec(N(v)) : fmtNum(N(v)))} />
              <Legend wrapperStyle={{ fontSize: 12, color: C.muted }} />
              <Line yAxisId="q" type="monotone" dataKey="queries" name="Queries"
                    stroke={C.blue} strokeWidth={2} dot={false} isAnimationActive={false} />
              <Line yAxisId="s" type="monotone" dataKey="exec_s" name="Exec time"
                    stroke={C.green} strokeWidth={2} dot={false} isAnimationActive={false}
                    strokeDasharray="4 3" />
            </LineChart>
          </ResponsiveContainer>
        )}
      </Card>

      <p style={{ color: C.muted, fontSize: 12, marginTop: 20, lineHeight: 1.6 }}>
        <strong>Ideas from here:</strong> add <code>query_type</code> to the client breakdown to see
        read/write mix, or join <code>error_type</code> to find which client is generating the
        failures behind the error rate.
      </p>
    </div>
  );
}
