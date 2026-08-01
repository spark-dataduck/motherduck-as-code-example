import { useState } from "react";
import { useSQLQuery } from "@motherduck/react-sql-query";
import { useDiveState } from "@motherduck/react-sql-query";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell,
} from "recharts";

// Local preview only. deploy.sh strips this line and passes the same list to
// MD_CREATE_DIVE / MD_UPDATE_DIVE_CONTENT as required_resources instead —
// declaring the databases twice is a runtime error in the Dives runtime.
export const REQUIRED_DATABASES = [{ type: "share", path: "md:_share/agent_commerce/a6ee8703-ade7-4e18-8ec5-e3c09065064f", alias: "agent_commerce" }, { type: "database", path: "md:agent_commerce_marts", alias: "agent_commerce_marts" }];

const N = (v: unknown): number => (v != null ? Number(v) : 0);

const CANVAS = "#0a0a0a";
const PAGE = "#000000";
const INK = "#ffffff";
const INK2 = "#c3c2b7";
const MUTED = "#898781";
const GRID = "#383835";
const BASELINE = "#4d4d49";
const BORDER = "rgba(255,255,255,0.10)";
const ACCENT = "#3987e5";
const FONT = '"Poppins", "Century Gothic", system-ui, sans-serif';

const fmtUSD = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
  return `$${v.toFixed(2)}`;
};
const fmtNum = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return `${Math.round(v)}`;
};

type Rows = Record<string, unknown>[];
const rowsOf = (d: unknown): Rows => (Array.isArray(d) ? (d as Rows) : []);

function Skeleton({ h = 220 }: { h?: number }) {
  return (
    <div
      style={{
        height: h,
        borderRadius: 6,
        background: "rgba(255,255,255,0.04)",
        border: `1px solid ${BORDER}`,
      }}
      className="animate-pulse"
    />
  );
}

function DarkTooltip({ active, payload, label, valueFmt }: any) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div
      style={{
        background: CANVAS,
        border: `1px solid ${BORDER}`,
        borderRadius: 6,
        padding: "8px 10px",
        fontFamily: FONT,
      }}
    >
      <div style={{ color: INK2, fontSize: 11, marginBottom: 4 }}>{label}</div>
      {payload.map((p: any, i: number) => (
        <div key={i} style={{ color: INK, fontSize: 12 }}>
          {p.name}: {valueFmt ? valueFmt(N(p.value)) : N(p.value)}
        </div>
      ))}
    </div>
  );
}

function SegButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        fontFamily: FONT,
        fontSize: 12,
        padding: "6px 12px",
        borderRadius: 999,
        border: `1px solid ${active ? ACCENT : BORDER}`,
        background: active ? "rgba(57,135,229,0.12)" : hover ? "rgba(255,255,255,0.04)" : "transparent",
        color: active ? ACCENT : hover ? INK : MUTED,
        cursor: "pointer",
        transition: "all 120ms ease",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

const TABS = [
  { key: "plan", label: "Revenue by plan" },
  { key: "monthly", label: "Monthly spend" },
  { key: "category", label: "Service performance" },
  { key: "buyers", label: "Top buyers" },
  { key: "storefront", label: "Storefront impact" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

function Logo() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <svg width="26" height="26" viewBox="0 0 28 28" fill="none">
        <rect x="1" y="1" width="26" height="26" rx="6" stroke={INK} strokeWidth="1.5" />
        <path
          d="M8 9H20L9 19H20"
          stroke={INK}
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
      <span
        style={{
          fontFamily: FONT,
          letterSpacing: "0.08em",
          fontWeight: 500,
          fontSize: 15,
          color: INK,
        }}
      >
        AGENT COMMERCE
      </span>
    </div>
  );
}

function TabBar({ active, onChange }: { active: TabKey; onChange: (k: TabKey) => void }) {
  const [hovered, setHovered] = useState<TabKey | null>(null);
  return (
    <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${BORDER}`, marginBottom: 16 }}>
      {TABS.map((t) => {
        const isActive = active === t.key;
        const isHover = hovered === t.key;
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            onMouseEnter={() => setHovered(t.key)}
            onMouseLeave={() => setHovered(null)}
            style={{
              fontFamily: FONT,
              fontSize: 13,
              padding: "10px 14px",
              background: "transparent",
              border: "none",
              borderBottom: `2px solid ${isActive ? ACCENT : "transparent"}`,
              color: isActive ? INK : isHover ? INK2 : MUTED,
              cursor: "pointer",
              transition: "color 120ms ease, border-color 120ms ease",
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function Kpi({ label, value, loading }: { label: string; value: string; loading: boolean }) {
  return (
    <div>
      {loading ? (
        <div className="animate-pulse" style={{ height: 32, width: 90, background: "rgba(255,255,255,0.06)", borderRadius: 4 }} />
      ) : (
        <p style={{ fontFamily: FONT, fontSize: 28, fontWeight: 500, color: INK, margin: 0 }}>{value}</p>
      )}
      <p style={{ fontFamily: FONT, fontSize: 11, color: MUTED, marginTop: 4 }}>{label}</p>
    </div>
  );
}

// ---------- Tab 1: Revenue by plan (click a bar to drill into its top categories) ----------
function PlanTab() {
  const [selectedPlan, setSelectedPlan] = useDiveState<string | null>("plan_selected", null);

  const planQ = useSQLQuery(`
    SELECT
      t.tenant_plan AS plan,
      count(DISTINCT t.tenant_id) AS tenant_count,
      sum(CASE WHEN x.transaction_status = 'authorized' THEN x.gross_amount_usd END) AS authorized_revenue,
      avg(CASE WHEN x.transaction_status = 'authorized' THEN x.gross_amount_usd END) AS avg_txn
    FROM "agent_commerce"."main"."tenants" t
    JOIN "agent_commerce"."main"."agent_transactions" x USING (tenant_id)
    GROUP BY ALL
    ORDER BY authorized_revenue DESC
  `);

  const drillQ = useSQLQuery(
    `
    SELECT s.service_category AS category,
      sum(CASE WHEN x.transaction_status = 'authorized' THEN x.gross_amount_usd END) AS revenue
    FROM "agent_commerce"."main"."tenants" t
    JOIN "agent_commerce"."main"."agent_transactions" x USING (tenant_id)
    JOIN "agent_commerce"."main"."agent_services" s USING (service_id)
    WHERE t.tenant_plan = '${selectedPlan}'
    GROUP BY ALL
    ORDER BY revenue DESC
    LIMIT 5
    `,
    { enabled: !!selectedPlan }
  );

  const rows = rowsOf(planQ.data).map((r) => ({
    plan: String(r.plan),
    revenue: N(r.authorized_revenue),
    tenants: N(r.tenant_count),
    avg: N(r.avg_txn),
  }));
  const drillRows = rowsOf(drillQ.data).map((r) => ({
    category: String(r.category),
    revenue: N(r.revenue),
  }));
  const total = rows.reduce((a, r) => a + r.revenue, 0);

  return (
    <div>
      <div style={{ display: "flex", gap: 32, marginBottom: 20 }}>
        <Kpi label="Authorized revenue" value={fmtUSD(total)} loading={planQ.isLoading} />
        <Kpi label="Plans" value={String(rows.length || "—")} loading={planQ.isLoading} />
      </div>
      <p style={{ fontFamily: FONT, fontSize: 11, color: MUTED, marginBottom: 8 }}>
        Click a bar to see its top service categories
      </p>
      {planQ.isLoading ? (
        <Skeleton />
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={rows} onClick={(s) => s?.activeLabel && setSelectedPlan(s.activeLabel)}>
            <CartesianGrid strokeDasharray="2 3" stroke={GRID} vertical={false} />
            <XAxis dataKey="plan" stroke={BASELINE} tick={{ fill: MUTED, fontSize: 11, fontFamily: FONT }} />
            <YAxis
              stroke={BASELINE}
              tick={{ fill: MUTED, fontSize: 11, fontFamily: FONT }}
              tickFormatter={(v) => fmtUSD(N(v))}
              width={54}
            />
            <Tooltip content={<DarkTooltip valueFmt={fmtUSD} />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
            <Bar dataKey="revenue" name="Authorized revenue" radius={[4, 4, 0, 0]} cursor="pointer">
              {rows.map((r, i) => (
                <Cell key={i} fill={r.plan === selectedPlan ? INK : ACCENT} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}

      {selectedPlan && (
        <div style={{ marginTop: 20, borderTop: `1px solid ${BORDER}`, paddingTop: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <p style={{ fontFamily: FONT, fontSize: 12, color: INK2 }}>
              Top categories — <span style={{ color: INK }}>{selectedPlan}</span> plan
            </p>
            <button
              onClick={() => setSelectedPlan(undefined)}
              style={{ background: "transparent", border: "none", color: MUTED, fontFamily: FONT, fontSize: 11, cursor: "pointer" }}
            >
              clear
            </button>
          </div>
          {drillQ.isLoading ? (
            <Skeleton h={160} />
          ) : (
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={drillRows} layout="vertical" margin={{ left: 12 }}>
                <CartesianGrid strokeDasharray="2 3" stroke={GRID} horizontal={false} />
                <XAxis type="number" stroke={BASELINE} tick={{ fill: MUTED, fontSize: 10, fontFamily: FONT }} tickFormatter={(v) => fmtUSD(N(v))} />
                <YAxis type="category" dataKey="category" stroke={BASELINE} tick={{ fill: INK2, fontSize: 11, fontFamily: FONT }} width={90} />
                <Tooltip content={<DarkTooltip valueFmt={fmtUSD} />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                <Bar dataKey="revenue" name="Revenue" fill={ACCENT} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Tab 2: Monthly authorized spend (toggle spend vs txn count) ----------
function MonthlyTab() {
  const [metric, setMetric] = useDiveState<"spend" | "txns">("monthly_metric", "spend");

  // Reads the gold table maintained by the agent-commerce-monthly-rollup Flight,
  // rather than re-aggregating 110K transactions on every render.
  const q = useSQLQuery(`
    SELECT month, authorized_txns, authorized_spend
    FROM "agent_commerce_marts"."main"."monthly_spend"
    ORDER BY month
  `);

  const rows = rowsOf(q.data).map((r) => ({
    month: String(r.month),
    spend: N(r.authorized_spend),
    txns: N(r.authorized_txns),
  }));
  const totalSpend = rows.reduce((a, r) => a + r.spend, 0);
  const totalTxns = rows.reduce((a, r) => a + r.txns, 0);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 32 }}>
          <Kpi label="Total authorized spend" value={fmtUSD(totalSpend)} loading={q.isLoading} />
          <Kpi label="Total authorized txns" value={fmtNum(totalTxns)} loading={q.isLoading} />
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <SegButton active={metric === "spend"} onClick={() => setMetric("spend")}>Spend ($)</SegButton>
          <SegButton active={metric === "txns"} onClick={() => setMetric("txns")}>Transactions</SegButton>
        </div>
      </div>
      {q.isLoading ? (
        <Skeleton />
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={rows}>
            <CartesianGrid strokeDasharray="2 3" stroke={GRID} vertical={false} />
            <XAxis dataKey="month" stroke={BASELINE} tick={{ fill: MUTED, fontSize: 11, fontFamily: FONT }} />
            <YAxis
              stroke={BASELINE}
              tick={{ fill: MUTED, fontSize: 11, fontFamily: FONT }}
              tickFormatter={(v) => (metric === "spend" ? fmtUSD(N(v)) : fmtNum(N(v)))}
              width={54}
            />
            <Tooltip content={<DarkTooltip valueFmt={metric === "spend" ? fmtUSD : fmtNum} />} cursor={{ stroke: BASELINE }} />
            <Line
              type="linear"
              dataKey={metric}
              name={metric === "spend" ? "Authorized spend" : "Authorized transactions"}
              stroke={ACCENT}
              strokeWidth={2}
              dot={{ r: 3, fill: ACCENT, strokeWidth: 0 }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ---------- Tab 3: Service performance across categories ----------
const CATEGORY_METRICS = [
  { key: "authorized_revenue", label: "Revenue", fmt: fmtUSD },
  { key: "avg_latency_ms", label: "Avg latency", fmt: (v: number) => `${Math.round(v)}ms` },
  { key: "avg_risk_score", label: "Avg risk", fmt: (v: number) => v.toFixed(1) },
  { key: "authorized_pct", label: "Authorized %", fmt: (v: number) => `${v.toFixed(1)}%` },
] as const;

function CategoryTab() {
  const [metric, setMetric] = useDiveState<string>("cat_metric", "authorized_revenue");
  const [selectedCat, setSelectedCat] = useDiveState<string | null>("cat_selected", null);
  const activeMetric = CATEGORY_METRICS.find((m) => m.key === metric) ?? CATEGORY_METRICS[0];

  const q = useSQLQuery(`
    SELECT
      s.service_category AS category,
      count(*) AS txn_count,
      avg(x.latency_ms) AS avg_latency_ms,
      avg(x.risk_score) AS avg_risk_score,
      100.0 * count(*) FILTER (WHERE x.transaction_status = 'authorized') / count(*) AS authorized_pct,
      sum(CASE WHEN x.transaction_status = 'authorized' THEN x.gross_amount_usd END) AS authorized_revenue
    FROM "agent_commerce"."main"."agent_transactions" x
    JOIN "agent_commerce"."main"."agent_services" s USING (service_id)
    GROUP BY ALL
  `);

  const agentsQ = useSQLQuery(
    `
    SELECT x.agent_name AS agent,
      sum(CASE WHEN x.transaction_status = 'authorized' THEN x.gross_amount_usd END) AS revenue
    FROM "agent_commerce"."main"."agent_transactions" x
    JOIN "agent_commerce"."main"."agent_services" s USING (service_id)
    WHERE s.service_category = '${selectedCat}'
    GROUP BY ALL
    ORDER BY revenue DESC
    LIMIT 5
    `,
    { enabled: !!selectedCat }
  );

  const rows = rowsOf(q.data)
    .map((r) => ({
      category: String(r.category),
      authorized_revenue: N(r.authorized_revenue),
      avg_latency_ms: N(r.avg_latency_ms),
      avg_risk_score: N(r.avg_risk_score),
      authorized_pct: N(r.authorized_pct),
    }))
    .sort((a, b) => (b as any)[metric] - (a as any)[metric])
    .slice(0, 10);

  const agentRows = rowsOf(agentsQ.data).map((r) => ({ agent: String(r.agent), revenue: N(r.revenue) }));

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {CATEGORY_METRICS.map((m) => (
          <SegButton key={m.key} active={metric === m.key} onClick={() => setMetric(m.key)}>
            {m.label}
          </SegButton>
        ))}
      </div>
      <p style={{ fontFamily: FONT, fontSize: 11, color: MUTED, marginBottom: 8 }}>
        Top 10 categories by {activeMetric.label.toLowerCase()} — click a bar for its top agents
      </p>
      {q.isLoading ? (
        <Skeleton />
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={rows} layout="vertical" margin={{ left: 12 }}>
            <CartesianGrid strokeDasharray="2 3" stroke={GRID} horizontal={false} />
            <XAxis type="number" stroke={BASELINE} tick={{ fill: MUTED, fontSize: 10, fontFamily: FONT }} tickFormatter={(v) => activeMetric.fmt(N(v))} />
            <YAxis type="category" dataKey="category" stroke={BASELINE} tick={{ fill: INK2, fontSize: 11, fontFamily: FONT }} width={90} />
            <Tooltip content={<DarkTooltip valueFmt={activeMetric.fmt} />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
            <Bar
              dataKey={metric}
              name={activeMetric.label}
              radius={[0, 4, 4, 0]}
              cursor="pointer"
              onClick={(d: any) => setSelectedCat(d.category)}
            >
              {rows.map((r, i) => (
                <Cell key={i} fill={r.category === selectedCat ? INK : ACCENT} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}

      {selectedCat && (
        <div style={{ marginTop: 20, borderTop: `1px solid ${BORDER}`, paddingTop: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <p style={{ fontFamily: FONT, fontSize: 12, color: INK2 }}>
              Top agents — <span style={{ color: INK }}>{selectedCat}</span>
            </p>
            <button
              onClick={() => setSelectedCat(undefined)}
              style={{ background: "transparent", border: "none", color: MUTED, fontFamily: FONT, fontSize: 11, cursor: "pointer" }}
            >
              clear
            </button>
          </div>
          {agentsQ.isLoading ? (
            <Skeleton h={160} />
          ) : (
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={agentRows} layout="vertical" margin={{ left: 12 }}>
                <CartesianGrid strokeDasharray="2 3" stroke={GRID} horizontal={false} />
                <XAxis type="number" stroke={BASELINE} tick={{ fill: MUTED, fontSize: 10, fontFamily: FONT }} tickFormatter={(v) => fmtUSD(N(v))} />
                <YAxis type="category" dataKey="agent" stroke={BASELINE} tick={{ fill: INK2, fontSize: 11, fontFamily: FONT }} width={110} />
                <Tooltip content={<DarkTooltip valueFmt={fmtUSD} />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                <Bar dataKey="revenue" name="Revenue" fill={ACCENT} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Tab 4: Top agent buyers by GMV ----------
function BuyersTab() {
  const [metric, setMetric] = useDiveState<"gmv_all" | "gmv_authorized">("buyers_metric", "gmv_all");

  const q = useSQLQuery(`
    SELECT
      agent_name AS agent,
      agent_platform AS platform,
      count(*) AS txn_count,
      sum(gross_amount_usd) AS gmv_all,
      sum(CASE WHEN transaction_status = 'authorized' THEN gross_amount_usd END) AS gmv_authorized
    FROM "agent_commerce"."main"."agent_transactions"
    GROUP BY ALL
    ORDER BY gmv_all DESC
    LIMIT 10
  `);

  const rows = rowsOf(q.data).map((r) => ({
    agent: String(r.agent),
    platform: String(r.platform),
    gmv_all: N(r.gmv_all),
    gmv_authorized: N(r.gmv_authorized),
  }));

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16 }}>
        <Kpi label="Top 10 combined GMV" value={fmtUSD(rows.reduce((a, r) => a + r.gmv_all, 0))} loading={q.isLoading} />
        <div style={{ display: "flex", gap: 6 }}>
          <SegButton active={metric === "gmv_all"} onClick={() => setMetric("gmv_all")}>All statuses</SegButton>
          <SegButton active={metric === "gmv_authorized"} onClick={() => setMetric("gmv_authorized")}>Authorized only</SegButton>
        </div>
      </div>
      {q.isLoading ? (
        <Skeleton h={280} />
      ) : (
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={rows} layout="vertical" margin={{ left: 12 }}>
            <CartesianGrid strokeDasharray="2 3" stroke={GRID} horizontal={false} />
            <XAxis type="number" stroke={BASELINE} tick={{ fill: MUTED, fontSize: 10, fontFamily: FONT }} tickFormatter={(v) => fmtUSD(N(v))} />
            <YAxis type="category" dataKey="agent" stroke={BASELINE} tick={{ fill: INK2, fontSize: 11, fontFamily: FONT }} width={140} />
            <Tooltip content={<DarkTooltip valueFmt={fmtUSD} />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
            <Bar dataKey={metric} name={metric === "gmv_all" ? "GMV (all)" : "GMV (authorized)"} fill={ACCENT} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ---------- Tab 5: Storefront readiness impact ----------
const STOREFRONT_METRICS = [
  { key: "authorized_revenue", label: "Authorized revenue", fmt: fmtUSD },
  { key: "revenue_per_service", label: "Revenue / service", fmt: fmtUSD },
  { key: "avg_txn", label: "Avg transaction", fmt: fmtUSD },
  { key: "authorized_pct", label: "Authorized %", fmt: (v: number) => `${v.toFixed(1)}%` },
] as const;

function StorefrontTab() {
  const [metric, setMetric] = useDiveState<string>("storefront_metric", "revenue_per_service");
  const activeMetric = STOREFRONT_METRICS.find((m) => m.key === metric) ?? STOREFRONT_METRICS[0];

  const q = useSQLQuery(`
    SELECT
      s.machine_readable_storefront AS storefront_ready,
      count(DISTINCT s.service_id) AS service_count,
      count(*) AS txn_count,
      100.0 * count(*) FILTER (WHERE x.transaction_status = 'authorized') / count(*) AS authorized_pct,
      avg(x.gross_amount_usd) AS avg_txn,
      sum(CASE WHEN x.transaction_status = 'authorized' THEN x.gross_amount_usd END) AS authorized_revenue,
      sum(CASE WHEN x.transaction_status = 'authorized' THEN x.gross_amount_usd END) / count(DISTINCT s.service_id) AS revenue_per_service
    FROM "agent_commerce"."main"."agent_transactions" x
    JOIN "agent_commerce"."main"."agent_services" s USING (service_id)
    GROUP BY ALL
    ORDER BY storefront_ready DESC
  `);

  const rows = rowsOf(q.data).map((r) => ({
    label: (r.storefront_ready ? "Storefront-ready" : "Not storefront-ready") as string,
    service_count: N(r.service_count),
    authorized_pct: N(r.authorized_pct),
    avg_txn: N(r.avg_txn),
    authorized_revenue: N(r.authorized_revenue),
    revenue_per_service: N(r.revenue_per_service),
  }));

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {STOREFRONT_METRICS.map((m) => (
          <SegButton key={m.key} active={metric === m.key} onClick={() => setMetric(m.key)}>
            {m.label}
          </SegButton>
        ))}
      </div>
      {q.isLoading ? (
        <Skeleton />
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={rows}>
            <CartesianGrid strokeDasharray="2 3" stroke={GRID} vertical={false} />
            <XAxis dataKey="label" stroke={BASELINE} tick={{ fill: MUTED, fontSize: 11, fontFamily: FONT }} />
            <YAxis stroke={BASELINE} tick={{ fill: MUTED, fontSize: 11, fontFamily: FONT }} tickFormatter={(v) => activeMetric.fmt(N(v))} width={64} />
            <Tooltip content={<DarkTooltip valueFmt={activeMetric.fmt} />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
            <Bar dataKey={metric} name={activeMetric.label} radius={[4, 4, 0, 0]}>
              {rows.map((r, i) => (
                <Cell key={i} fill={i === 0 ? ACCENT : "#5f5e5a"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
      {!q.isLoading && (
        <div style={{ display: "flex", gap: 24, marginTop: 12 }}>
          {rows.map((r, i) => (
            <p key={i} style={{ fontFamily: FONT, fontSize: 11, color: MUTED }}>
              {r.label}: <span style={{ color: INK2 }}>{r.service_count} services</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AgentCommerceOverviewDive() {
  const [activeTab, setActiveTab] = useDiveState<TabKey>("active_tab", "plan");

  return (
    <div style={{ background: PAGE, minHeight: "100%", padding: 24 }}>
      <div
        style={{
          background: CANVAS,
          border: `1px solid ${BORDER}`,
          borderRadius: 12,
          padding: 20,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
          <Logo />
        </div>
        <p style={{ fontFamily: FONT, fontSize: 11, color: MUTED, marginTop: 6, marginBottom: 16 }}>
          Agent commerce performance — tenants, services, transactions
        </p>

        <TabBar active={activeTab} onChange={setActiveTab} />

        {activeTab === "plan" && <PlanTab />}
        {activeTab === "monthly" && <MonthlyTab />}
        {activeTab === "category" && <CategoryTab />}
        {activeTab === "buyers" && <BuyersTab />}
        {activeTab === "storefront" && <StorefrontTab />}
      </div>
    </div>
  );
}
