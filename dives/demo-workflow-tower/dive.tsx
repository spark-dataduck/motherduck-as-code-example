/* Demo Workflow Tower — a data pipeline watching itself.
 *
 * Reads the telemetry snapshot a collector Flight writes into an `ops`
 * schema — one row per pipeline object (`objects`), the static graph
 * (`edges`), Flight runs (`runs`), DuckLake load history (`table_loads`),
 * per-table and per-prefix freshness (`vitals`) and the collector's own log
 * (`collect_log`). Flights and their runs are identity-scoped, so a Dive
 * viewer can never see a service account's Flights directly — the collector
 * is what makes a pipeline legible from the outside, and this board is
 * agnostic about which pipeline that is: lanes come from node types, scopes
 * from the `app` tags, the collector's name from the `app = 'all'` node.
 *
 * This deployment reads `demo_workflow_tower`, a database owned by the same
 * identity the Dive is saved under, through its org-wide share
 * `demo_workflow_tower_share`. It holds a frozen, scrubbed snapshot of a
 * six-Flight demo pipeline (calls, tickets and screenshots landing through
 * ingest → enrich → build Flights into raw / intermediate / marts tables, an
 * export handoff, an org share and two consumers). Nothing re-collects it, so
 * every age on the board is measured from the collector's own stamp rather
 * than the viewer's clock — see AS_OF below.
 *
 * Structure (two-pane shell, a swimlane lineage board grouped by kind,
 * pan/zoom, and a detail panel that opens a node's own run or load history
 * in place) follows the Control Tower reference; the
 * look — sand/snow/ink, 1.5px ink borders, hard offset shadows, no radius,
 * Aeonik Mono chrome, sun-yellow actives — is the GDrive Sync Overview house
 * style. Deliberately light-only.
 *
 * Data contract: README.md beside this file ("The ops contract"). The
 * collector that writes the `ops` schema is yours to build for your pipeline;
 * the README describes what it must produce and the status rules the
 * reference one applied. The same SQL, ready to paste into a notebook, is in
 * queries.sql.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useSQLQuery, useDiveState } from "@motherduck/react-sql-query";

export const REQUIRED_DATABASES = [{ type: "share", path: "md:_share/demo_workflow_tower_share/474de109-046b-45d1-ad82-bf66ca5ee459", alias: "demo_workflow_tower_share" }];

// The Dive attaches the org share, not the database: a `database` requirement
// only resolves for the identity that owns it, while an ACCESS ORGANIZATION
// share resolves for everyone in the org. The alias must differ from the
// database's own name or the owner's ATTACH collides with the real catalog.
const DB = "demo_workflow_tower_share";
const OPS = `"${DB}"."ops"`;
const RAW = `"${DB}"."raw"`;
// Every age on the board is measured from the collector's own stamp, not the
// viewer's clock. The statuses in ops.objects were computed by the collector
// at that moment; an age that kept moving with wall-clock time while its
// status stood still would contradict it, and a snapshot nobody re-collects
// (this deployment) would otherwise read as weeks stale on every card. The
// sidebar footer still says how old the collection itself is.
const AS_OF = `(SELECT max(collected_at) FROM ${OPS}."collect_log")`;
const SCREENSHOTS_NODE = "table:raw.screenshots";
const POLL_MS = 15_000;

const N = (v: unknown): number => (v != null ? Number(v) : 0);
// Booleans arrive as a real boolean from the Dives runtime and as 1/0 or
// "true" from some drivers; read all three rather than trust one.
const isTrue = (v: unknown): boolean => v === true || v === 1 || v === "true";

// A selected node's name is inlined into the panel's WHERE clause. Node names
// are `schema.table` or a Flight slug, so allow exactly those characters and
// treat anything else as no selection at all — a shared link can carry any
// string in its state bag.
const safeId = (s: string): string | null => (/^[A-Za-z0-9_.:-]+$/.test(s) ? s : null);

// Force every poll of useSQLQuery to be a unique SQL string by prepending a
// monotonically-increasing comment marker (the Shinsegae / GDrive pattern):
// works in the Dives runtime and the local Vite shim alike.
function withRefresh(sql: string, tick: number): string {
  return `-- refresh:${tick}\n${sql}`;
}

// ─── Theme: sand/snow paper tones, hard ink borders, sun-yellow actives ──
const C = {
  sand: "#F8F4E9", snow: "#FAF7EE", ink: "#1A1A1A", muted: "#5E5E5E", pencil: "#9C9C9C",
  darksand: "#E8DFC8", panel: "#F5EFE0", divider: "#E0D8C2", duck: "#FF8530",
  lightduck: "#FFD4B3", sun: "#FFD300", watermelon: "#EF5446", garden: "#1EAA8A", pond: "#1E80AA",
};
const FONT_MONO = "'Aeonik Mono', 'JetBrains Mono', ui-monospace, monospace";
const FONT_BODY = "'Inter', system-ui, sans-serif";
const mono = (size: number, weight = 700): CSSProperties => ({ fontFamily: FONT_MONO, fontWeight: weight, fontSize: size });

type Status = "ok" | "warn" | "fail" | "idle";
const STATUS: Record<Status, { color: string; glyph: string; label: string }> = {
  ok: { color: C.garden, glyph: "✓", label: "Healthy" },
  warn: { color: C.sun, glyph: "~", label: "Stale" },
  fail: { color: C.watermelon, glyph: "✕", label: "Failing" },
  idle: { color: C.pencil, glyph: "–", label: "Idle" },
};
// The collector also emits "unknown" (a node with nothing adjacent yet); it
// reads as idle here rather than inventing a fifth colour.
const asStatus = (s: string): Status => (s === "ok" || s === "warn" || s === "fail" ? s : "idle");
const WORST: Status[] = ["fail", "warn", "idle", "ok"];
const rollupOf = (list: Status[]): Status => WORST.find((s) => list.indexOf(s) >= 0) ?? "idle";

// Run statuses arrive as MotherDuck's RUN_STATUS_* enum strings.
const runStatus = (s: string): Status =>
  s === "RUN_STATUS_SUCCEEDED" ? "ok" : s === "RUN_STATUS_FAILED" ? "fail" : s === "RUN_STATUS_RUNNING" ? "warn" : "idle";
const runLabel = (s: string): string => s.replace(/^RUN_STATUS_/, "").toLowerCase();

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "–";
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}
function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log2(n) / 10));
  return `${(n / 2 ** (10 * i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}
function fmtDur(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "–";
  return sec < 90 ? `${sec.toFixed(1)}s` : `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
}
function ageLabel(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "–";
  if (sec < 90) return "just now";
  if (sec < 5400) return `${Math.round(sec / 60)}m ago`;
  if (sec < 172800) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}
const clockHM = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// ─── Board geometry: four fixed swimlanes, one per kind of node ─────────
const NODE_W = 208, NODE_H = 92, ROW = 108, LANE_PAD = 24, LANE_TOP = 44, LANE_GAP = 24;
// Sources, Flights and Outputs are one card wide. Tables is as wide as its
// band columns: the three schemas sit side by side under one lane header, so
// seventeen tables read as three stacks of seven rather than one of
// seventeen — which is what lets the whole board fit the viewport.
//
// Flights and Outputs are the two lanes that carry same-column edges (a
// Flight triggering a Flight, the share feeding a consumer). They are wider,
// with the card pushed to the right of its column, so those loops have a
// ~60px gutter of their own to bow into instead of overhanging the lane
// beside them. Sources has no loops and stays narrow and centred.
const SINGLE_LANE_W = NODE_W + 40, LOOP_LANE_W = NODE_W + 80, CARD_RIGHT_PAD = 20;
const BAND_COL_W = NODE_W + 20, TABLES_PAD = 20;

type LaneKey = "sources" | "flights" | "tables" | "outputs";
const LOOP_LANES: LaneKey[] = ["flights", "outputs"];
const LANES: { key: LaneKey; label: string; bg: string; border: string; fg: string }[] = [
  { key: "sources", label: "Sources", bg: "#E8DFC8", border: "#C9BC9A", fg: "#5E5E5E" },
  { key: "flights", label: "Flights", bg: "#FFD4B3", border: "#FF8530", fg: "#9A4A10" },
  { key: "tables",  label: "Tables",  bg: "#EAF6F2", border: "#8CCBBD", fg: "#136B57" },
  { key: "outputs", label: "Outputs", bg: "#DCE6EC", border: "#8FA9B8", fg: "#1E80AA" },
];
// The Tables lane is banded by schema, so raw → intermediate → marts reads
// top-to-bottom inside the one lane.
const BANDS: { key: string; label: string; bg: string; border: string }[] = [
  { key: "raw",          label: "raw",          bg: "#DDF1EC", border: "#8CCBBD" },
  { key: "intermediate", label: "intermediate", bg: "#C4E8DF", border: "#4FB79F" },
  { key: "marts",        label: "marts",        bg: "#A6DCCF", border: "#1EAA8A" },
];

// Type ordering is the deterministic tie-break when two nodes in a lane carry
// the same `ord` (or none yet), and reads the way the pipeline flows.
const TYPE_ORDER: Record<string, number> = { source: 0, export: 1, flight: 2, table: 3, share: 4, consumer: 5 };
const TYPE_TAG: Record<string, string> = { source: "SRC", export: "EXP", flight: "FLT", table: "TBL", share: "SHR", consumer: "USE" };
const typeRank = (id: string): number => TYPE_ORDER[id.split(":")[0]] ?? 8;
const cmpId = (a: string, b: string): number => typeRank(a) - typeRank(b) || a.localeCompare(b);

type GEdge = { src: string; dst: string };
// `gut` is the gap between a card's left edge and its column's left edge —
// the only space a same-column loop may bow into.
type Pos = { cx: number; cy: number; left: number; top: number; w: number; h: number; col: number; gut: number };
// A drawn edge keeps src/dst identity (highlighting keys off them) and carries
// its finished path — lanes are fixed, so there is nothing to route around.
type RoutedEdge = { src: string; dst: string; d: string };
type LaneRect = { key: string; label: string; x: number; y: number; w: number; h: number; bg: string; border: string; fg: string };
type BandRect = { key: string; label: string; x: number; y: number; w: number; h: number; bg: string; border: string };
type LaneLayout = { pos: Map<string, Pos>; lanes: LaneRect[]; bands: BandRect[]; edges: RoutedEdge[]; boardW: number; boardH: number };

// Which lane a node lives in. An export that feeds a Flight is an inbound hop
// (the Snowflake COPY INTO handoff), so it belongs with the sources rather
// than with the outputs it otherwise resembles.
function laneOf(o: ObjRow, dataEdges: GEdge[]): number {
  const t = o.node_type;
  if (t === "source") return 0;
  if (t === "flight") return 1;
  if (t === "table") return 2;
  if (t === "export" && dataEdges.some((e) => e.src === o.node_id && e.dst.startsWith("flight:"))) return 0;
  return 3;
}
const bandOf = (o: ObjRow): string | null => (o.node_type === "table" ? o.name.split(".")[0] : null);

function edgePathStr(ax: number, ay: number, bx: number, by: number): string {
  const c = Math.max(34, Math.abs(bx - ax) * 0.5), dir = bx >= ax ? 1 : -1;
  return `M ${ax} ${ay} C ${ax + c * dir} ${ay}, ${bx - c * dir} ${by}, ${bx} ${by}`;
}
// Two nodes in the same column (a Flight triggering a Flight, a share feeding
// a consumer): bow out to the left instead of drawing straight through the
// cards stacked between them.
function loopPathStr(ax: number, ay: number, by: number, bulge: number): string {
  return `M ${ax} ${ay} C ${ax - bulge} ${ay}, ${ax - bulge} ${by}, ${ax} ${by}`;
}
// How far that loop may bow: it grows with the vertical span so arcs of
// different length separate, and the card's own gutter is the hard cap — a
// loop never leaves its lane. Long spans all hit that cap, though, and three
// of the six trigger edges end on the same card, so successive loops are
// nested a step shallower to keep them apart.
const loopBulge = (a: Pos, b: Pos, i: number): number =>
  Math.max(4, Math.min(a.gut, b.gut, 42 + Math.min(58, Math.abs(b.cy - a.cy) * 0.22)) * (1 - 0.12 * (i % 5)));

// Fixed swimlanes: no solver, no dummy chains, no cycle to trip over. A node's
// lane is its kind; its place inside the lane is the collector's `ord` (the
// node's index in the collector's NODES list), so the board reads in pipeline
// order rather than alphabetically.
function computeLanes(objects: ObjRow[], edges: GEdge[], dataEdges: GEdge[]): LaneLayout | null {
  if (!objects.length) return null;
  const byLane: ObjRow[][] = [[], [], [], []];
  for (const o of objects) byLane[laneOf(o, dataEdges)].push(o);
  for (const list of byLane) list.sort((a, b) => (a.ord ?? 999) - (b.ord ?? 999) || cmpId(a.node_id, b.node_id));

  // Every lane is a list of card columns: one column for most lanes, one per
  // band for Tables. A table whose schema is none of the three still gets
  // drawn, in an unbanded column after them.
  type Col = { band: typeof BANDS[number] | null; list: ObjRow[] };
  const laneCols: Col[][] = LANES.map((lane, li) => {
    const members = byLane[li];
    if (lane.key !== "tables") return members.length ? [{ band: null, list: members }] : [];
    const cols: Col[] = BANDS.map((b) => ({ band: b, list: members.filter((o) => bandOf(o) === b.key) }));
    const rest = members.filter((o) => !BANDS.some((b) => b.key === bandOf(o)));
    if (rest.length) cols.push({ band: null, list: rest });
    return cols.filter((c) => c.list.length > 0);
  });
  // A lane with nothing drawn in it is not drawn at all, and the lanes that
  // remain close up. The trigger view draws Flights only; three empty tinted
  // rectangles beside it would eat the board's width and hold the fit scale
  // down for nothing.
  const active = LANES.map((_, li) => li).filter((li) => laneCols[li].length > 0);
  const laneW = LANES.map((lane, li) =>
    lane.key === "tables" ? laneCols[li].length * BAND_COL_W + TABLES_PAD
    : LOOP_LANES.indexOf(lane.key) >= 0 ? LOOP_LANE_W
    : SINGLE_LANE_W,
  );
  const laneX: number[] = [];
  let cursor = LANE_PAD;
  for (const li of active) { laneX[li] = cursor; cursor += laneW[li] + LANE_GAP; }
  const boardW = cursor - LANE_GAP + LANE_PAD;

  const pos = new Map<string, Pos>();
  const bands: BandRect[] = [];
  let maxBottom = LANE_TOP + NODE_H;

  active.forEach((li) => {
    const lane = LANES[li];
    const isTables = lane.key === "tables";
    // Right-align in the loop lanes so the slack ends up on the left, where
    // the loops are; centre everywhere else.
    const rightAligned = LOOP_LANES.indexOf(lane.key) >= 0;
    laneCols[li].forEach((c, ci) => {
      const colW = isTables ? BAND_COL_W : laneW[li];
      const colX = laneX[li] + (isTables ? TABLES_PAD / 2 + ci * BAND_COL_W : 0);
      const left = rightAligned ? colX + colW - NODE_W - CARD_RIGHT_PAD : colX + (colW - NODE_W) / 2;
      const gut = left - colX;
      let y = LANE_TOP;
      for (const o of c.list) {
        pos.set(o.node_id, { cx: left + NODE_W / 2, cy: y + NODE_H / 2, left, top: y, w: NODE_W, h: NODE_H, col: li, gut });
        y += ROW;
      }
      const bottom = y - (ROW - NODE_H);
      if (c.band && c.list.length) {
        bands.push({
          key: c.band.key, label: c.band.label, x: colX + 3, y: LANE_TOP - 20,
          w: colW - 6, h: bottom - LANE_TOP + 28, bg: c.band.bg, border: c.band.border,
        });
      }
      if (bottom > maxBottom) maxBottom = bottom;
    });
  });

  const boardH = Math.max(320, maxBottom + LANE_PAD);
  const lanes: LaneRect[] = active.map((li) => ({
    key: LANES[li].key, label: LANES[li].label, x: laneX[li], y: 0,
    w: laneW[li], h: boardH, bg: LANES[li].bg, border: LANES[li].border, fg: LANES[li].fg,
  }));

  // A forward edge leaves a card's right face and enters the next card's left
  // face; a read back up the board (table → Flight) leaves the left face and
  // enters the target's right one. Two cards in one column — a Flight
  // triggering a Flight — bow out to the left instead.
  const routed: RoutedEdge[] = [];
  let loopIdx = 0;
  for (const e of edges) {
    const a = pos.get(e.src), b = pos.get(e.dst);
    if (!a || !b || e.src === e.dst) continue;
    const d =
      b.left === a.left ? loopPathStr(a.left, a.cy, b.cy, loopBulge(a, b, loopIdx++))
      : b.left > a.left ? edgePathStr(a.left + a.w, a.cy, b.left, b.cy)
      : edgePathStr(a.left, a.cy, b.left + b.w, b.cy);
    routed.push({ src: e.src, dst: e.dst, d });
  }
  return { pos, lanes, bands, edges: routed, boardW, boardH };
}

// ─── Building blocks (GDrive house style, tokens verbatim) ──────────────

function Card(props: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ background: C.snow, border: `1.5px solid ${C.ink}`, boxShadow: `3px 3px 0 ${C.ink}`, padding: "14px 16px", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 8, flexWrap: "wrap" }}>
        <div style={{ ...mono(11, 700), color: C.duck, letterSpacing: "0.1em", textTransform: "uppercase" }}>{props.title}</div>
        {props.right}
      </div>
      {props.children}
    </div>
  );
}

function Kpi(props: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ background: props.highlight ? C.lightduck : "#FFF", border: `1.5px solid ${C.ink}`, boxShadow: `2px 2px 0 ${C.ink}`, padding: "10px 14px", flex: "1 1 92px", minWidth: 0 }}>
      <div style={{ ...mono(9, 700), color: props.highlight ? C.ink : C.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>{props.label}</div>
      <div style={{ ...mono(22, 700), color: C.ink, marginTop: 4 }}>{props.value}</div>
    </div>
  );
}

function Chip(props: { status: Status; size?: number }) {
  const s = props.size ?? 15, m = STATUS[props.status];
  return (
    <span title={m.label} style={{ width: s, height: s, background: m.color, border: `1.5px solid ${C.ink}`, color: C.ink, ...mono(Math.round(s * 0.6), 700), display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, lineHeight: 1 }}>
      {m.glyph}
    </span>
  );
}

function Pill(props: { status: Status; label?: string; small?: boolean }) {
  const m = STATUS[props.status], s = props.small === true;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: s ? 4 : 6, background: m.color, border: `1.5px solid ${C.ink}`, boxShadow: s ? "none" : `2px 2px 0 ${C.ink}`, color: C.ink, ...mono(s ? 8 : 10, 700), letterSpacing: "0.08em", textTransform: "uppercase", padding: s ? "1px 5px" : "4px 10px", flexShrink: 0 }}>
      <span>{m.glyph}</span>
      {props.label ?? m.label}
    </span>
  );
}

const th: CSSProperties = {
  ...mono(9, 700), textAlign: "left", color: "#5E5E5E", letterSpacing: "0.1em", textTransform: "uppercase",
  padding: "7px 8px", borderBottom: "1.5px solid #1A1A1A", whiteSpace: "nowrap", userSelect: "none",
};
const td: CSSProperties = {
  fontFamily: FONT_BODY, fontSize: 13, padding: "6px 8px", borderBottom: "1px solid #E8DFC8", color: "#1A1A1A", verticalAlign: "top",
};
const tdMono: CSSProperties = { ...td, fontFamily: FONT_MONO, fontSize: 11 };
const btn = (active: boolean): CSSProperties => ({
  ...mono(10, 700), border: `1.5px solid ${C.ink}`, background: active ? C.sun : "#FFF", color: C.ink,
  boxShadow: `2px 2px 0 ${C.ink}`, letterSpacing: "0.08em", textTransform: "uppercase", padding: "6px 14px", cursor: "pointer",
});
const note: CSSProperties = { ...mono(8, 700), color: C.pencil, letterSpacing: "0.08em" };
const empty: CSSProperties = { fontSize: 13, color: C.muted, padding: "8px 2px" };

const STYLE_CSS = [
  "*{box-sizing:border-box;}",
  ".wt-shell{display:flex;min-height:100vh;align-items:stretch;}",
  ".wt-side{width:264px;flex:none;position:sticky;top:0;height:100vh;overflow-y:auto;}",
  ".wt-nav{transition:background .12s ease;}",
  ".wt-nav:hover{background:" + C.panel + " !important;}",
  ".wt-node{transition:opacity .2s ease, box-shadow .12s ease;cursor:pointer;}",
  ".wt-node:hover{box-shadow:0 0 0 3px " + C.duck + "55 !important;}",
  // The card's first line is its name: two lines at most, and never an
  // ellipsis on line one.
  ".wt-name{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;}",
  "button:focus-visible,a:focus-visible{outline:2px solid " + C.duck + ";outline-offset:2px;}",
  "@media (max-width:900px){.wt-shell{flex-direction:column;}.wt-side{position:static;height:auto;width:auto;border-right:none !important;border-bottom:1.5px solid " + C.ink + ";}}",
].join("\n");

// ─── Pan/zoom viewport: button zoom (+ / − / Fit), drag-pan ────
function BoardViewport(props: { boardW: number; boardH: number; hint: string; children: ReactNode }) {
  const { boardW, boardH } = props;
  const [vt, setVt] = useState({ s: 1, x: 24, y: 16 });
  const [grab, setGrab] = useState(false);
  const dragRef = useRef<{ x0: number; y0: number; vx: number; vy: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const VH = Math.min(Math.max(boardH + 48, 360), 680);

  // Zoom is buttons-only (+ / − / Fit). The mouse wheel is deliberately left
  // alone so scrolling the page over the board never changes the scale.

  // Fit both axes and centre. Width binds on the full data board; height binds
  // once empty lanes are dropped and the board is a single narrow column, and
  // fitting width alone there would pin the scale at 1 and push the last card
  // below the fold.
  const fit = () => {
    const el = wrapRef.current;
    if (!el) return;
    const w = el.clientWidth, s = Math.max(0.3, Math.min(1, (w - 48) / boardW, (VH - 32) / boardH));
    setVt({ s, x: (w - boardW * s) / 2, y: Math.max(16, (VH - boardH * s) / 2) });
  };
  // Refit whenever the board changes shape (scope or view switch), on the next
  // frame: measured in the same tick the wrapper can still be mid-layout and
  // the board fits itself to a width it never had.
  useEffect(() => {
    const id = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(id);
  }, [boardW, boardH]);

  const zoom = (f: number) => setVt((v) => ({ ...v, s: Math.max(0.3, Math.min(2.6, v.s * f)) }));
  const onDown = (e: { clientX: number; clientY: number }) => {
    // Clear any suppression left over from a drag whose click never landed,
    // or the next genuine click on a node card is swallowed.
    suppressClick.current = false;
    dragRef.current = { x0: e.clientX, y0: e.clientY, vx: vt.x, vy: vt.y, moved: false };
    setGrab(true);
  };
  const onMove = (e: { clientX: number; clientY: number }) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    setVt((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
  };
  // Node cards are buttons; a drag that started on one must not select it.
  const onUp = () => {
    if (dragRef.current?.moved) suppressClick.current = true;
    dragRef.current = null;
    setGrab(false);
  };
  const onClickCapture = (e: { preventDefault: () => void; stopPropagation: () => void }) => {
    if (!suppressClick.current) return;
    e.preventDefault();
    e.stopPropagation();
    suppressClick.current = false;
  };

  return (
    <div
      ref={wrapRef}
      onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} onClickCapture={onClickCapture}
      // Focusing a card scrolls it into view, and this box is only
      // overflow:hidden — the board would slide out from under its own
      // pan/zoom transform. Take the browser's scroll back to zero, but move
      // the same distance in the transform, so a Tab to an off-screen card
      // pans the board to it instead of being thrown away.
      onScroll={(e) => {
        const el = e.currentTarget, dx = el.scrollLeft, dy = el.scrollTop;
        if (!dx && !dy) return;
        el.scrollLeft = 0;
        el.scrollTop = 0;
        setVt((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
      }}
      style={{
        position: "relative", height: VH, overflow: "hidden", border: `1.5px solid ${C.ink}`, boxShadow: `3px 3px 0 ${C.ink}`,
        background: C.snow, backgroundImage: `radial-gradient(${C.darksand} 1.2px, transparent 1.2px)`, backgroundSize: "22px 22px",
        cursor: grab ? "grabbing" : "grab", userSelect: "none",
      }}
    >
      <div style={{ position: "absolute", left: 0, top: 0, width: boardW, height: boardH, transform: `translate(${vt.x}px, ${vt.y}px) scale(${vt.s})`, transformOrigin: "0 0" }}>
        {props.children}
      </div>
      <div style={{ position: "absolute", left: 12, bottom: 12, display: "flex", gap: 6 }}>
        <button type="button" onClick={() => zoom(1.2)} style={{ ...btn(false), padding: "4px 10px" }}>+</button>
        <button type="button" onClick={() => zoom(1 / 1.2)} style={{ ...btn(false), padding: "4px 10px" }}>−</button>
        <button type="button" onClick={fit} style={{ ...btn(false), padding: "4px 10px" }}>Fit</button>
      </div>
      <div style={{ position: "absolute", right: 12, bottom: 14, ...note, textTransform: "uppercase", pointerEvents: "none" }}>{props.hint}</div>
    </div>
  );
}

// ─── Node card: a 208×92 sticker, four lines, tinted by its lane or band ──
function NodeCard(props: {
  o: ObjRow; pos: Pos; selected: boolean; dimmed: boolean;
  onSelect: () => void; onHover: (id: string | null) => void;
}) {
  const { o, pos } = props;
  const band = BANDS.find((b) => b.key === bandOf(o)) ?? null;
  const lane = LANES[pos.col] ?? LANES[LANES.length - 1];
  const bg = band?.bg ?? lane.bg, border = band?.border ?? lane.border;

  // Lines 3 and 4 are ages, not stamps: "4h ago" is the thing a reader is
  // actually checking. The exact UTC timestamp is in the panel header.
  // last_run_at is the run's *end*, so a Flight still in flight carries a
  // status with no timestamp — that reads "running", never "never run".
  const line3 =
    o.node_type === "flight"
      ? o.last_run_age_s != null
        ? `last run ${ageLabel(o.last_run_age_s)} · ${runLabel(o.last_run_status ?? "").toUpperCase()}`
        : o.last_run_status ? runLabel(o.last_run_status).toUpperCase() : "never run"
      : o.node_type === "table"
        ? o.fresh_age_s != null ? `written ${ageLabel(o.fresh_age_s)}` : "never written"
        : o.detail.slice(0, 40);
  const line4 =
    o.node_type === "table" ? (o.row_count == null ? "no count" : `${fmtNum(o.row_count)} rows`)
    : o.node_type === "flight" ? (o.schedule_cron ? `cron ${o.schedule_cron}` : "on trigger")
    : "";
  const sub: CSSProperties = {
    display: "block", ...mono(9, 500), color: C.muted, minHeight: 12,
    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
  };

  return (
    <button
      type="button" className="wt-node" aria-pressed={props.selected} title={o.detail}
      onClick={props.onSelect}
      onMouseEnter={() => props.onHover(o.node_id)} onMouseLeave={() => props.onHover(null)}
      style={{
        position: "absolute", left: pos.left, top: pos.top, width: NODE_W, height: NODE_H,
        background: bg, border: `1.5px solid ${border}`, borderRadius: 8,
        boxShadow: props.selected ? `0 0 0 3px ${C.duck}55` : "none",
        opacity: props.dimmed ? 0.35 : 1, overflow: "hidden",
        padding: "7px 9px", textAlign: "left", font: "inherit", color: C.ink,
      }}
    >
      <span className="wt-name" style={{ ...mono(12, 700), color: C.ink, lineHeight: 1.2 }}>{o.name}</span>
      <span style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
        <span style={{ ...mono(8, 700), letterSpacing: "0.08em", border: `1px solid ${C.ink}`, background: "#FFFFFFCC", color: C.ink, padding: "1px 4px", flexShrink: 0 }}>
          {TYPE_TAG[o.node_type] ?? "OBJ"}
        </span>
        <Pill status={o.status} label={o.status} small />
      </span>
      <span style={{ ...sub, marginTop: 3 }}>{line3}</span>
      <span style={{ ...sub, marginTop: 1 }}>{line4}</span>
    </button>
  );
}

// ─── Data shapes ────────────────────────────────────────────────────────
type ObjRow = {
  node_id: string; node_type: string; name: string; app: string; detail: string;
  schedule_cron: string | null; status: Status; last_run_label: string | null;
  last_run_status: string | null; row_count: number | null; fresh_label: string | null;
  url: string | null;
  // Ages are computed in SQL (`epoch(AS_OF - ts)`) so the card and the panel
  // never do date math on a string. They are as-of the collector's stamp,
  // not a live clock.
  last_run_age_s: number | null; fresh_age_s: number | null;
  // `ord` is the collector's index of this node in its NODES list; the lanes
  // stack by it. It only arrives once the collector that writes it has run, so
  // until then every row is null and the lanes fall back to `cmpId`.
  ord: number | null;
};
type QueryLike = { data: Record<string, unknown>[] | undefined; isLoading: boolean; isError: boolean };
const rows = (q: QueryLike): Record<string, unknown>[] => (Array.isArray(q.data) ? q.data : []);
// The Dives runtime's query object carries an `error`; the local preview shim
// does not declare one, so read it defensively rather than assume it is there.
const errMsg = (q: QueryLike): string => String((q as unknown as { error?: { message?: string } }).error?.message || "query failed");

// ─── Detail panel: the selected node's own history, in-Dive ──────────────
// Takes the place of the Recent runs / Freshness pair while a node is
// selected. A Flight shows its run history, a table its DuckLake load
// history, a source or output the edges it sits between. Nothing here
// navigates away — the one anchor is the optional MotherDuck deep link.
function DetailPanel(props: {
  o: ObjRow; accent: string; runsQ: QueryLike; loadsQ: QueryLike;
  shotsQ: QueryLike; shotImageQ: QueryLike; shot: string; onShot: (ticketId: string) => void;
  edges: GEdge[]; byId: Map<string, ObjRow>; onClose: () => void;
}) {
  const { o } = props;
  const isShots = o.node_id === SCREENSHOTS_NODE;
  const shotRows = isShots && !props.shotsQ.isError ? rows(props.shotsQ) : [];
  const shownShot = shotRows.find((r) => String(r.ticket_id) === props.shot) ?? null;
  const shotB64 = !props.shotImageQ.isError ? rows(props.shotImageQ)[0]?.image_b64 : null;
  const isFlight = o.node_type === "flight", isTable = o.node_type === "table";
  const runRows = isFlight ? rows(props.runsQ) : [];
  // Guard on isError, not just on kind: a failed query can still be holding
  // the previously selected table's rows in `data`, and those must never be
  // drawn under this table's name.
  const loadRows = isTable && !props.loadsQ.isError ? rows(props.loadsQ) : [];
  const maxDur = runRows.reduce((m, r) => Math.max(m, N(r.duration_s)), 0);
  const maxAdded = loadRows.reduce((m, r) => Math.max(m, N(r.rows_added)), 0);
  const loadsToday = loadRows.filter((r) => isTrue(r.is_today)).length;

  // A bar is a share of the largest value in the list, floored at 2% so a
  // non-zero row is never invisible.
  const bar = (frac: number): ReactNode => (
    <div style={{ height: 6, width: 68, background: C.divider, flexShrink: 0 }}>
      <div style={{ height: "100%", width: `${Math.max(2, Math.min(100, frac * 100))}%`, background: props.accent }} />
    </div>
  );

  const linked = (dir: "out" | "in"): ObjRow[] =>
    props.edges
      .filter((e) => (dir === "out" ? e.src : e.dst) === o.node_id)
      .map((e) => props.byId.get(dir === "out" ? e.dst : e.src))
      .filter((x): x is ObjRow => !!x);

  const neighbourList = (label: string, items: ObjRow[]): ReactNode => (
    <div style={{ minWidth: 0 }}>
      <div style={{ ...mono(9, 700), color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
      {items.length === 0 ? (
        <div style={empty}>Nothing in this view.</div>
      ) : items.map((n) => (
        <div key={n.node_id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: `1px solid ${C.divider}`, minWidth: 0 }}>
          <Chip status={n.status} size={13} />
          <span style={{ ...mono(11, 500), overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.name}</span>
        </div>
      ))}
    </div>
  );

  // The card shows an age; the panel header shows the stamp behind it.
  const stamp =
    isFlight ? (o.last_run_label ? `LAST RUN ${o.last_run_label} UTC` : null)
    : isTable ? (o.fresh_label ? `WRITTEN ${o.fresh_label} UTC` : null)
    : null;

  return (
    <Card
      title={o.name}
      right={
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {o.url ? (
            <a
              href={o.url} target="_blank" rel="noreferrer"
              style={{ ...mono(9, 700), color: C.pond, letterSpacing: "0.08em", textTransform: "uppercase" }}
            >
              open in MotherDuck ↗
            </a>
          ) : null}
          <button type="button" onClick={props.onClose} style={{ ...btn(false), padding: "4px 10px" }}>✕ esc</button>
        </span>
      }
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        <span style={{ ...mono(8, 700), letterSpacing: "0.08em", border: `1px solid ${C.ink}`, background: "#FFF", color: C.ink, padding: "2px 5px", flexShrink: 0 }}>
          {TYPE_TAG[o.node_type] ?? "OBJ"}
        </span>
        <Pill status={o.status} />
        <span style={{ fontFamily: FONT_BODY, fontSize: 13, color: C.muted, minWidth: 0, overflowWrap: "anywhere" }}>{o.detail}</span>
        {stamp ? <span style={{ ...note, whiteSpace: "nowrap" }}>{stamp}</span> : null}
      </div>

      {isFlight ? (
        props.runsQ.isLoading ? (
          <div style={empty}>Paddling… 🦆</div>
        ) : props.runsQ.isError ? (
          <div style={empty}>Could not read ops.runs — {errMsg(props.runsQ)}</div>
        ) : runRows.length === 0 ? (
          <div style={empty}>No runs recorded yet.</div>
        ) : (
          <div style={{ overflowX: "auto", maxHeight: 360, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: "right" }}>Run</th>
                  <th style={th}>Trigger</th>
                  <th style={th}>Status</th>
                  <th style={th}>Started</th>
                  <th style={{ ...th, textAlign: "right" }}>Duration</th>
                  <th style={th} aria-label="Duration bar" />
                  <th style={{ ...th, textAlign: "right" }}>Exit</th>
                </tr>
              </thead>
              <tbody>
                {runRows.map((r, i) => {
                  const d = N(r.duration_s);
                  return (
                    <tr key={`${String(r.run_number)}:${i}`}>
                      <td style={{ ...tdMono, textAlign: "right", fontSize: 12 }}>#{String(r.run_number)}</td>
                      <td style={{ ...tdMono, fontSize: 9, color: C.muted, letterSpacing: "0.06em" }}>{isTrue(r.is_scheduled) ? "CRON" : "TRIGGER"}</td>
                      <td style={td}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <Chip status={runStatus(String(r.status ?? ""))} size={14} />
                          <span style={{ ...mono(9, 700), color: C.muted, letterSpacing: "0.06em" }}>{runLabel(String(r.status ?? "")).toUpperCase()}</span>
                        </span>
                      </td>
                      <td style={tdMono}>{r.started_label == null ? "—" : String(r.started_label)}</td>
                      <td style={{ ...tdMono, textAlign: "right", fontSize: 12 }}>{fmtDur(d)}</td>
                      <td style={td}>{maxDur > 0 ? bar(d / maxDur) : null}</td>
                      <td style={{ ...tdMono, textAlign: "right", fontSize: 12 }}>{r.exit_code == null ? "—" : String(r.exit_code)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : null}

      {isTable ? (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
            <Kpi label="Rows" value={o.row_count == null ? "—" : fmtNum(o.row_count)} />
            <Kpi label="Written" value={o.fresh_age_s == null ? "never" : ageLabel(o.fresh_age_s)} />
            <Kpi label="Loads, collect day" value={String(loadsToday)} highlight={loadsToday > 0} />
          </div>
          {props.loadsQ.isLoading ? (
            <div style={empty}>Paddling… 🦆</div>
          ) : loadRows.length === 0 ? (
            <div>
              <div style={empty}>No retained DuckLake snapshots for this table. Its last write predates the oldest kept snapshot (DuckLake maintenance expires old snapshots), so the written age on its card comes from the data files in S3 instead.</div>
              {/* Before the collector that writes ops.table_loads is deployed the
                  table is simply absent; say so quietly rather than alarm. */}
              {props.loadsQ.isError ? (
                <div style={{ ...mono(9, 500), color: C.pencil, overflowWrap: "anywhere", lineHeight: 1.6 }}>{errMsg(props.loadsQ)}</div>
              ) : null}
            </div>
          ) : (
            <div style={{ overflowX: "auto", maxHeight: 360, overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ ...th, textAlign: "right" }}>Snapshot</th>
                    <th style={th}>At</th>
                    <th style={th}>Change</th>
                    <th style={{ ...th, textAlign: "right" }}>Rows +</th>
                    <th style={th} aria-label="Rows added bar" />
                    <th style={{ ...th, textAlign: "right" }}>Rows −</th>
                    <th style={{ ...th, textAlign: "right" }}>Files</th>
                  </tr>
                </thead>
                <tbody>
                  {loadRows.map((r, i) => {
                    const added = N(r.rows_added);
                    return (
                      <tr key={`${String(r.snapshot_id)}:${i}`} style={isTrue(r.is_today) ? { background: C.panel } : undefined}>
                        <td style={{ ...tdMono, textAlign: "right", fontSize: 12 }}>{String(r.snapshot_id)}</td>
                        <td style={tdMono}>{r.at_label == null ? "—" : String(r.at_label)}</td>
                        <td style={{ ...tdMono, fontSize: 10, color: C.muted, letterSpacing: "0.06em" }}>{String(r.change ?? "—").toUpperCase()}</td>
                        <td style={{ ...tdMono, textAlign: "right", fontSize: 12 }}>{fmtNum(added)}</td>
                        <td style={td}>{maxAdded > 0 ? bar(added / maxAdded) : null}</td>
                        <td style={{ ...tdMono, textAlign: "right", fontSize: 12 }}>{fmtNum(N(r.rows_removed))}</td>
                        <td style={{ ...tdMono, textAlign: "right", fontSize: 12 }}>{fmtNum(N(r.files_added))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}

      {isShots ? (
        <div style={{ marginTop: 18 }}>
          <div style={{ ...mono(9, 700), color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 8 }}>
            Screenshots · {shotRows.length} · thumbnails ~40 KB each, click one for the compressed preview
          </div>
          {props.shotsQ.isLoading ? (
            <div style={empty}>Paddling… 🦆</div>
          ) : shotRows.length === 0 ? (
            <div style={empty}>{props.shotsQ.isError ? "The image columns are not in raw.screenshots yet." : "No screenshots in the bucket yet."}</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10 }}>
              {shotRows.map((r) => {
                const id = String(r.ticket_id);
                const active = props.shot === id;
                return (
                  <button key={id} type="button" onClick={() => props.onShot(active ? "" : id)} aria-pressed={active}
                    style={{ textAlign: "left", padding: 6, background: active ? C.panel : C.snow, border: `1.5px solid ${active ? props.accent : C.divider}`,
                      borderRadius: 6, cursor: "pointer", boxShadow: active ? `0 0 0 3px ${props.accent}55` : "none", font: "inherit", color: C.ink }}>
                    {r.thumb_b64 ? (
                      <img src={`data:image/jpeg;base64,${String(r.thumb_b64)}`} alt={`${id} screenshot`} loading="lazy"
                        style={{ display: "block", width: "100%", aspectRatio: "16 / 10", objectFit: "cover", objectPosition: "top", background: C.divider, borderRadius: 3 }} />
                    ) : (
                      <div style={{ aspectRatio: "16 / 10", background: C.divider, borderRadius: 3 }} />
                    )}
                    <div style={{ ...mono(11, 700), marginTop: 6 }}>{id}</div>
                    <div style={{ ...mono(9, 500), color: C.muted, letterSpacing: "0.06em", textTransform: "uppercase" }}>{r.ui_area ? String(r.ui_area) : "—"}</div>
                    <div style={{ fontSize: 11, color: C.muted, marginTop: 2, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                      {r.detected_error_text ? String(r.detected_error_text) : "no error text detected"}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          {shownShot ? (
            <div style={{ marginTop: 14, borderTop: `1px solid ${C.divider}`, paddingTop: 12 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", marginBottom: 8 }}>
                <span style={mono(12, 700)}>{String(shownShot.ticket_id)} · {String(shownShot.file_name ?? "")}</span>
                <span style={note}>
                  {shownShot.width != null ? `${fmtNum(N(shownShot.width))}×${fmtNum(N(shownShot.height))} · ` : ""}
                  original {fmtBytes(N(shownShot.size_bytes))} → preview {fmtBytes(N(shownShot.image_bytes))}
                </span>
              </div>
              {props.shotImageQ.isLoading ? (
                <div style={empty}>Paddling… 🦆</div>
              ) : shotB64 ? (
                <img src={`data:image/jpeg;base64,${String(shotB64)}`} alt={`${String(shownShot.ticket_id)} full screenshot`}
                  style={{ display: "block", maxWidth: "100%", maxHeight: 640, border: `1px solid ${C.divider}`, borderRadius: 4, background: C.snow }} />
              ) : (
                <div style={empty}>Preview not available for this screenshot.</div>
              )}
              {shownShot.description ? (
                <p style={{ fontSize: 13, color: C.muted, marginTop: 8, maxWidth: "80ch" }}>{String(shownShot.description)}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {!isFlight && !isTable ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 18 }}>
          {neighbourList("Feeds into", linked("out"))}
          {neighbourList("Fed by", linked("in"))}
        </div>
      ) : null}
    </Card>
  );
}

// Scopes are the distinct `app` tags the collector put on its nodes, in the
// order the pipeline lists them (lowest `ord` first), under a fixed
// "Everything". Nothing here knows which apps exist — a collector describing
// a different pipeline produces a different sidebar — and the scope key is
// the raw tag, so a shared link's `scope=calls` survives the derivation.
type Scope = { key: string; label: string };
const ALL_SCOPE: Scope = { key: "all", label: "Everything" };
const labelForApp = (app: string): string => app.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
function scopesOf(objects: ObjRow[]): Scope[] {
  const firstOrd = new Map<string, number>();
  for (const o of objects) {
    if (!o.app || o.app === "all") continue;
    const ord = o.ord ?? 999;
    if (!firstOrd.has(o.app) || ord < firstOrd.get(o.app)!) firstOrd.set(o.app, ord);
  }
  const apps = [...firstOrd.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([app]) => app);
  return [ALL_SCOPE, ...apps.map((app) => ({ key: app, label: labelForApp(app) }))];
}
// `app = "all"` is the collector itself — it watches every chain, so it
// belongs to every scope rather than to none.
const inScope = (o: ObjRow, key: string): boolean => key === "all" || o.app === key || o.app === "all";
const VIEWS = ["data", "trigger"];

/** `seed` plus everything reachable forward from it along `edges`. */
function downstream(seed: string[], edges: GEdge[]): Set<string> {
  const keep = new Set(seed);
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (!out.has(e.src)) out.set(e.src, []);
    out.get(e.src)!.push(e.dst);
  }
  const stack = [...seed];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const nxt of out.get(cur) || []) if (!keep.has(nxt)) { keep.add(nxt); stack.push(nxt); }
  }
  return keep;
}

export default function DemoWorkflowTower() {
  const [scopeState, setScope] = useDiveState<string>("scope", "all");
  const [viewState, setView] = useDiveState<string>("view", "data");
  // A shared link can carry anything. Clamp both to the known sets, or an
  // unrecognized value draws an empty board with neither toggle lit. The
  // scope set is derived from the data, so its clamp waits for `objects`.
  const view = VIEWS.indexOf(viewState) >= 0 ? viewState : "data";
  const [hover, setHover] = useState<string | null>(null);
  // The selected node lives in Dive state, so a shared link opens on the same
  // node. Clicking it again, or Escape, clears it.
  const [nodeState, setNode] = useDiveState<string>("node", "");
  const [live, setLive] = useState(false);
  const [tick, setTick] = useState(0);
  const [sinceRefresh, setSinceRefresh] = useState(0);
  const [checkedAt, setCheckedAt] = useState<number>(() => Date.now());

  const refresh = () => { setTick((t) => t + 1); setSinceRefresh(0); setCheckedAt(Date.now()); };
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => { setTick((t) => t + 1); setSinceRefresh(0); setCheckedAt(Date.now()); }, POLL_MS);
    return () => clearInterval(id);
  }, [live]);
  useEffect(() => {
    const id = setInterval(() => setSinceRefresh((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setNode(""); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setNode]);

  // ── Queries. Every timestamp is formatted in SQL (strftime, UTC); every
  // age is measured from AS_OF, the collector's stamp; every numeric is
  // coerced with N() at the point of use. ──
  const objectsQ = useSQLQuery(withRefresh(`
SELECT node_id, node_type, name, app, detail, schedule_cron, status,
       strftime(last_run_at AT TIME ZONE 'UTC', '%b %d %H:%M') AS last_run_label,
       epoch(${AS_OF} - last_run_at)                           AS last_run_age_s,
       last_run_status,
       row_count,
       strftime(fresh_at AT TIME ZONE 'UTC', '%b %d %H:%M')    AS fresh_label,
       epoch(${AS_OF} - fresh_at)                              AS fresh_age_s,
       url
FROM ${OPS}."objects"
ORDER BY node_id
`, tick));

  // `ord` is read on its own, and its failure is swallowed. The column only
  // exists once the collector that writes it has been deployed; asking for it
  // in the main objects query would take the whole board down with it until
  // then. Without it the lanes fall back to their type/name tie-break.
  const ordQ = useSQLQuery(withRefresh(`
SELECT node_id, ord
FROM ${OPS}."objects"
ORDER BY ord
`, tick));

  const edgesQ = useSQLQuery(withRefresh(`
SELECT src_node, dst_node, kind
FROM ${OPS}."edges"
ORDER BY src_node, dst_node
`, tick));

  const runsQ = useSQLQuery(withRefresh(`
SELECT flight_name, run_number, is_scheduled, status,
       strftime(started_at AT TIME ZONE 'UTC', '%b %d %H:%M') AS started_label,
       duration_s
FROM ${OPS}."runs"
ORDER BY started_at DESC
LIMIT 60
`, tick));

  const vitalsQ = useSQLQuery(withRefresh(`
SELECT name, kind, row_count, objects, bytes,
       strftime(fresh_at AT TIME ZONE 'UTC', '%b %d %H:%M') AS fresh_label,
       epoch(${AS_OF} - fresh_at)                           AS fresh_age_s
FROM ${OPS}."vitals"
ORDER BY kind, name
`, tick));

  const collectQ = useSQLQuery(withRefresh(`
SELECT strftime(max(collected_at) AT TIME ZONE 'UTC', '%b %d %H:%M') AS collected_label,
       epoch(now() - max(collected_at))                              AS collected_age_s
FROM ${OPS}."collect_log"
`, tick));

  // ── Projection ──
  const ordById = useMemo(() => {
    const m = new Map<string, number>();
    if (ordQ.isError) return m;
    for (const r of rows(ordQ)) if (r.ord != null) m.set(String(r.node_id), N(r.ord));
    return m;
  }, [ordQ.data, ordQ.isError]);

  const objects: ObjRow[] = useMemo(
    () => rows(objectsQ).map((r) => ({
      node_id: String(r.node_id), node_type: String(r.node_type), name: String(r.name),
      app: String(r.app ?? ""), detail: String(r.detail ?? ""),
      schedule_cron: r.schedule_cron == null ? null : String(r.schedule_cron),
      status: asStatus(String(r.status ?? "")),
      last_run_label: r.last_run_label == null ? null : String(r.last_run_label),
      last_run_status: r.last_run_status == null ? null : String(r.last_run_status),
      row_count: r.row_count == null ? null : N(r.row_count),
      fresh_label: r.fresh_label == null ? null : String(r.fresh_label),
      url: r.url == null ? null : String(r.url),
      last_run_age_s: r.last_run_age_s == null ? null : N(r.last_run_age_s),
      fresh_age_s: r.fresh_age_s == null ? null : N(r.fresh_age_s),
      ord: ordById.has(String(r.node_id)) ? ordById.get(String(r.node_id))! : null,
    })),
    [objectsQ.data, ordById],
  );
  const byId = useMemo(() => new Map(objects.map((o) => [o.node_id, o])), [objects]);
  const scopes = useMemo(() => scopesOf(objects), [objects]);
  const scope = scopes.some((s) => s.key === scopeState) ? scopeState : "all";
  // The collector is the one Flight tagged `app = "all"`. Its name is read
  // from the data like everything else, so the chrome never hardcodes it.
  const collectorName = objects.find((o) => o.node_type === "flight" && o.app === "all")?.name ?? "the collector Flight";

  // Clamp the shared state to a node that actually exists, or a stale link
  // would pin the board on nothing and never let go.
  const selected = byId.has(nodeState) ? nodeState : "";
  const toggle = (id: string) => setNode(selected === id ? "" : id);
  const sel = byId.get(selected);
  const selKey = sel ? safeId(sel.name) : null;

  // The panel's history queries. Nothing is selected on first paint and most
  // of the time after, so both stay a constant-folded empty result until a
  // node of the matching kind is picked — the filter value is inlined, hence
  // safeId above.
  const flightRunsQ = useSQLQuery(withRefresh(sel?.node_type === "flight" && selKey ? `
SELECT run_number, is_scheduled, status,
       strftime(started_at AT TIME ZONE 'UTC', '%b %d %H:%M:%S') AS started_label,
       duration_s, exit_code
FROM ${OPS}."runs"
WHERE flight_name = '${selKey}'
ORDER BY run_number DESC
LIMIT 200
` : `SELECT NULL AS run_number WHERE false`, tick));

  // Screenshot gallery: thumbnails for all seven while raw.screenshots is
  // selected; the compressed preview of ONE screenshot only when clicked.
  const [shot, setShot] = useState("");
  const shotKey = safeId(shot);
  const isShotsSel = selected === SCREENSHOTS_NODE;
  const shotsQ = useSQLQuery(withRefresh(isShotsSel ? `
SELECT s.ticket_id, s.file_name, s.size_bytes, s.width, s.height, s.image_bytes, s.thumb_b64,
       a.ui_area, a.detected_error_text, a.description
FROM ${RAW}."screenshots" s
LEFT JOIN ${RAW}."screenshot_annotations" a USING (ticket_id)
ORDER BY s.ticket_id
` : `SELECT NULL AS ticket_id WHERE false`, tick));
  const shotImageQ = useSQLQuery(withRefresh(isShotsSel && shotKey ? `
SELECT image_b64
FROM ${RAW}."screenshots"
WHERE ticket_id = '${shotKey}'
` : `SELECT NULL AS image_b64 WHERE false`, tick));

  const tableLoadsQ = useSQLQuery(withRefresh(sel?.node_type === "table" && selKey ? `
SELECT snapshot_id, change, rows_added, rows_removed, files_added,
       strftime(snapshot_time AT TIME ZONE 'UTC', '%b %d %H:%M:%S') AS at_label,
       CAST(snapshot_time AT TIME ZONE 'UTC' AS DATE) = CAST(${AS_OF} AT TIME ZONE 'UTC' AS DATE) AS is_today
FROM ${OPS}."table_loads"
WHERE table_name = '${selKey}'
ORDER BY snapshot_id DESC
LIMIT 200
` : `SELECT NULL AS snapshot_id WHERE false`, tick));
  const allEdges = useMemo(
    () => rows(edgesQ).map((r) => ({ src: String(r.src_node), dst: String(r.dst_node), kind: String(r.kind) })),
    [edgesQ.data],
  );

  // Whole-pipeline status tiles — fixed, they do not move with the scope.
  const tiles = useMemo(() => {
    const t: Record<Status, number> = { ok: 0, warn: 0, fail: 0, idle: 0 };
    for (const o of objects) t[o.status]++;
    return t;
  }, [objects]);

  // The drawn graph. Seed by scope, then take the full DOWNSTREAM closure, so
  // a chain is never cut off mid-edge (picking Calls still shows the marts,
  // share and consumers its data ends up in). Finally drop anything with no
  // edge of the active kind — the trigger view is a Flight story, and the data
  // view has no place for a Flight that writes no modeled table.
  const seedIds = useMemo(() => objects.filter((o) => inScope(o, scope)).map((o) => o.node_id), [objects, scope]);

  const graph = useMemo(() => {
    const kindEdges = allEdges.filter((e) => e.kind === view && byId.has(e.src) && byId.has(e.dst));
    const keep = downstream(seedIds, kindEdges);
    const edges = kindEdges.filter((e) => keep.has(e.src) && keep.has(e.dst));
    const incident = new Set<string>();
    for (const e of edges) { incident.add(e.src); incident.add(e.dst); }
    const ids = [...keep].filter((id) => incident.has(id)).sort(cmpId);
    return { ids, edges, dropped: seedIds.filter((id) => !incident.has(id)).length };
  }, [seedIds, allEdges, byId, view]);

  // Lane membership for an export depends on where its *data* goes, which the
  // trigger view does not draw — so lanes always read the data edges.
  const dataEdgesAll = useMemo(() => allEdges.filter((e) => e.kind === "data"), [allEdges]);
  const layout = useMemo(
    () => computeLanes(graph.ids.map((id) => byId.get(id)).filter((o): o is ObjRow => !!o), graph.edges, dataEdgesAll),
    [graph, byId, dataEdgesAll],
  );
  // The panel's bars take the selected node's own colour — its band's border
  // inside Tables, its lane's border everywhere else — so the panel reads as
  // an extension of the card that opened it.
  const selAccent = sel
    ? (BANDS.find((b) => b.key === bandOf(sel))?.border ?? LANES[laneOf(sel, dataEdgesAll)].border)
    : C.duck;
  // Feeds-into / fed-by follow the active view's edge kind, so a source read
  // in the trigger view lists trigger neighbours, not data ones.
  const viewEdges = useMemo(() => allEdges.filter((e) => e.kind === view), [allEdges, view]);

  const scopeObjects = useMemo(() => objects.filter((o) => inScope(o, scope)), [objects, scope]);
  const scopeRollup = rollupOf(scopeObjects.map((o) => o.status));
  const scopeLabel = scopes.find((s) => s.key === scope)?.label ?? "Everything";

  // Runs and Freshness follow the board, not a bare `app` match. Scoping them
  // on `app` alone hid the build Flight and the marts tables at scope Calls
  // while the board drew them. The panel set is everything the data flow
  // reaches from this scope, plus whatever the active view actually draws —
  // a superset of the board, so nothing on screen is ever missing its rows.
  const panelNames = useMemo(() => {
    const dataEdges = allEdges.filter((e) => e.kind === "data" && byId.has(e.src) && byId.has(e.dst));
    const ids = downstream(seedIds, dataEdges);
    for (const id of graph.ids) ids.add(id);
    const flights = new Set<string>();
    const tables = new Set<string>();
    for (const id of ids) {
      const o = byId.get(id);
      if (!o) continue;
      if (o.node_type === "flight") flights.add(o.name);
      else if (o.node_type === "table") tables.add(o.name);
    }
    return { flights, tables };
  }, [seedIds, allEdges, byId, graph]);

  // Scope Everything filters nothing, so a Flight the collector sees but the
  // static graph does not list still shows its runs rather than vanishing.
  const runRows = useMemo(() => {
    const all = rows(runsQ);
    return scope === "all" ? all : all.filter((r) => panelNames.flights.has(String(r.flight_name)));
  }, [runsQ.data, panelNames, scope]);

  // The three S3 prefixes are pipeline-wide and always shown.
  const vitalRows = useMemo(() => {
    const all = rows(vitalsQ);
    return scope === "all" ? all : all.filter((r) => String(r.kind) === "prefix" || panelNames.tables.has(String(r.name)));
  }, [vitalsQ.data, panelNames, scope]);

  const collectRow = rows(collectQ)[0];
  const collectedLabel = collectRow && collectRow.collected_label != null ? String(collectRow.collected_label) : null;
  const collectedAge = collectRow && collectRow.collected_age_s != null ? N(collectRow.collected_age_s) + sinceRefresh : null;

  const failedQueries = ([
    ["objects", objectsQ], ["edges", edgesQ], ["runs", runsQ], ["vitals", vitalsQ], ["collect_log", collectQ],
  ] as [string, QueryLike][]).filter(([, q]) => q.isError);

  // The selected node keeps its neighbours lit when the mouse is elsewhere;
  // hovering takes over while it lasts. Lit = the focused node plus whatever
  // is one edge away in the active view — one hop, not the whole chain, or a
  // node in the middle of the pipeline lights the entire board and the
  // dimming says nothing.
  const focus: string | null = hover ?? (selected || null);
  const conn = useMemo(() => {
    if (!focus || !layout) return null;
    const s = new Set([focus]);
    for (const e of layout.edges) {
      if (e.src === focus) s.add(e.dst);
      if (e.dst === focus) s.add(e.src);
    }
    return s;
  }, [focus, layout]);

  function board(lay: LaneLayout): ReactNode {
    const isTrigger = view === "trigger", stroke = isTrigger ? C.duck : C.ink;
    return (
      <BoardViewport boardW={lay.boardW} boardH={lay.boardH} hint="+ − fit to zoom · drag to pan · click a node">
        <svg width={lay.boardW} height={lay.boardH} viewBox={`0 0 ${lay.boardW} ${lay.boardH}`} style={{ position: "absolute", inset: 0 }}>
          <defs>
            <marker id="wtArrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M 0 1 L 7.5 4 L 0 7 z" fill={stroke} />
            </marker>
          </defs>
          {lay.lanes.map((l) => (
            <g key={l.key}>
              <rect x={l.x} y={l.y} width={l.w} height={l.h} fill={l.bg} stroke={l.border} strokeWidth={1.5} rx={10} />
              <text x={l.x + 14} y={l.y + 24} fill={l.fg} style={{ ...mono(9, 700), letterSpacing: "0.12em" }}>
                {l.label.toUpperCase()}
              </text>
            </g>
          ))}
          {lay.bands.map((b) => (
            <g key={b.key}>
              <rect x={b.x} y={b.y} width={b.w} height={b.h} fill={b.bg} stroke={b.border} strokeWidth={1} rx={8} />
              <text x={b.x + 10} y={b.y + 14} fill={C.muted} style={{ ...mono(9, 700), letterSpacing: "0.1em" }}>{b.label}</text>
            </g>
          ))}
          {lay.edges.map((e, i) => {
            const hot = focus ? e.src === focus || e.dst === focus : false;
            return (
              <path
                key={i} d={e.d} fill="none" stroke={stroke} strokeWidth={hot ? 2.4 : 1.5}
                strokeDasharray={isTrigger ? "7 5" : "0"} strokeLinecap="round"
                opacity={focus ? (hot ? 1 : 0.12) : 0.65} markerEnd="url(#wtArrow)"
              />
            );
          })}
        </svg>
        {[...lay.pos.entries()].map(([id, p]) => {
          const o = byId.get(id);
          if (!o) return null;
          return (
            <NodeCard
              key={id} o={o} pos={p}
              selected={selected === id}
              dimmed={!!conn && !conn.has(id)}
              onSelect={() => toggle(id)}
              onHover={setHover}
            />
          );
        })}
      </BoardViewport>
    );
  }

  const navRow = (active: boolean): CSSProperties => ({
    display: "flex", gap: 9, alignItems: "flex-start", width: "100%", textAlign: "left", cursor: "pointer",
    border: `1.5px solid ${active ? C.ink : "transparent"}`, background: active ? C.sun : "transparent",
    boxShadow: active ? `2px 2px 0 ${C.ink}` : "none", padding: "7px 9px", marginBottom: 5, font: "inherit", color: "inherit",
  });

  return (
    <div style={{ background: C.sand, color: C.ink, minHeight: "100vh", fontFamily: FONT_BODY, fontSize: 14 }}>
      <style>{STYLE_CSS}</style>
      <div className="wt-shell">
        {/* ── SIDEBAR ── */}
        <aside className="wt-side" style={{ background: C.snow, borderRight: `1.5px solid ${C.ink}`, padding: "18px 16px 16px", display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <h1 style={{ margin: 0, ...mono(15, 700), letterSpacing: "0.02em", lineHeight: 1.25 }}>
              <span style={{ marginRight: 8 }}>🦆</span>DEMO WORKFLOW TOWER
            </h1>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 5, lineHeight: 1.45 }}>A data pipeline, watching itself.</div>
          </div>

          <div>
            <div style={{ ...mono(9, 700), color: C.pencil, letterSpacing: "0.14em", marginBottom: 8 }}>PIPELINE STATUS</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {(["ok", "warn", "fail", "idle"] as Status[]).map((s) => (
                <Kpi key={s} label={STATUS[s].label} value={String(tiles[s])} highlight={s === "fail" && tiles.fail > 0} />
              ))}
            </div>
            <div style={{ ...note, marginTop: 8 }}>{objects.length} OBJECTS · {allEdges.length} EDGES</div>
          </div>

          <div>
            <div style={{ ...mono(9, 700), color: C.pencil, letterSpacing: "0.14em", marginBottom: 8 }}>SCOPE</div>
            {scopes.map((s) => {
              const members = objects.filter((o) => inScope(o, s.key));
              const st = rollupOf(members.map((o) => o.status));
              const flights = members.filter((o) => o.node_type === "flight").length;
              const tables = members.filter((o) => o.node_type === "table").length;
              const active = s.key === scope;
              return (
                <button
                  key={s.key} type="button" className="wt-nav" aria-current={active ? "page" : undefined}
                  onClick={() => { setScope(s.key); setHover(null); }} style={navRow(active)}
                >
                  <span style={{ width: 5, alignSelf: "stretch", background: STATUS[st].color, border: `1px solid ${C.ink}`, flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ ...mono(11, 700), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                        {s.label}
                      </span>
                      <Chip status={st} size={14} />
                    </span>
                    <span style={{ display: "block", ...mono(9, 500), color: C.muted, marginTop: 3 }}>
                      {flights} flights · {tables} tables
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <div style={{ marginTop: "auto", borderTop: `1.5px solid ${C.ink}`, paddingTop: 12 }}>
            <div style={{ ...mono(9, 700), color: C.muted, letterSpacing: "0.06em", lineHeight: 1.7 }}>
              COLLECTED {collectedLabel ? `${collectedLabel} UTC` : "NEVER"}
              {collectedAge != null ? ` · ${ageLabel(collectedAge).toUpperCase()}` : ""}
              <br />
              CHECKED {clockHM(checkedAt)} · {sinceRefresh}S AGO{live ? " · LIVE 15S" : ""}
              <br />
              CARD AGES ARE AS OF THE COLLECTION
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              <button type="button" onClick={refresh} style={btn(true)}>↻ Refresh</button>
              <button type="button" onClick={() => setLive((l) => !l)} style={btn(live)}>{live ? "● live" : "○ go live"}</button>
            </div>
          </div>
        </aside>

        {/* ── MAIN ── */}
        <main style={{ flex: 1, minWidth: 0, height: "100vh", overflowY: "auto", padding: "20px 22px 28px" }}>
          <div style={{ maxWidth: 1180, margin: "0 auto", display: "grid", gap: 16 }}>
            {failedQueries.length ? (
              <div style={{ background: C.lightduck, border: `1.5px solid ${C.ink}`, borderLeft: `6px solid ${C.watermelon}`, boxShadow: `3px 3px 0 ${C.ink}`, padding: "12px 14px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Chip status="fail" size={16} />
                  <span style={{ ...mono(11, 700), letterSpacing: "0.06em", textTransform: "uppercase" }}>
                    Some telemetry could not be read — what is below may be incomplete
                  </span>
                </div>
                <div style={{ ...mono(10, 500), color: C.ink, marginTop: 6, lineHeight: 1.6, overflowWrap: "anywhere" }}>
                  {failedQueries.map(([k, q]) => `${k}: ${errMsg(q)}`).join("  ·  ")}
                </div>
                <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: C.ink, marginTop: 8 }}>
                  If the <code>ops</code> schema does not exist yet, the collector Flight has not run.
                  Run it once, then hit Refresh. 🐣
                </div>
              </div>
            ) : null}

            <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, flexWrap: "wrap", borderBottom: `1.5px solid ${C.ink}`, paddingBottom: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ ...mono(19, 700), letterSpacing: "0.02em", textTransform: "uppercase" }}>{scopeLabel}</span>
                  <Pill status={scopeRollup} />
                </div>
                <div style={{ ...mono(10, 500), color: C.muted, marginTop: 6, letterSpacing: "0.04em" }}>
                  {scopeObjects.length} objects in scope · {graph.ids.length} drawn incl. downstream
                  {graph.dropped ? ` · ${graph.dropped} with no ${view === "trigger" ? "trigger" : "data"} edge not drawn` : ""}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button type="button" onClick={() => setView("data")} style={btn(view === "data")}>Data flow</button>
                <button type="button" onClick={() => setView("trigger")} style={btn(view === "trigger")}>Triggers</button>
              </div>
            </div>

            {objectsQ.isLoading || edgesQ.isLoading ? (
              <Card title="Lineage board"><div style={{ fontSize: 13, color: C.muted }}>Paddling… 🦆</div></Card>
            ) : !layout ? (
              <Card title="Lineage board">
                <div style={{ fontSize: 13, color: C.muted }}>
                  {objects.length === 0
                    ? "Nothing collected yet — run the collector Flight, then hit Refresh."
                    : `No ${view === "trigger" ? "trigger" : "data"} edges in this scope.`}
                </div>
              </Card>
            ) : (
              board(layout)
            )}

            {sel ? (
              <DetailPanel
                o={sel} accent={selAccent} runsQ={flightRunsQ} loadsQ={tableLoadsQ}
                shotsQ={shotsQ} shotImageQ={shotImageQ} shot={shot} onShot={setShot}
                edges={viewEdges} byId={byId} onClose={() => setNode("")}
              />
            ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 16 }}>
              <Card title="Recent runs" right={<span style={note}>{runRows.length} SHOWN · UTC</span>}>
                {runsQ.isError ? (
                  <div style={{ fontSize: 13, color: C.muted }}>Could not read ops.runs — {errMsg(runsQ)}</div>
                ) : (
                  <div style={{ overflowX: "auto", maxHeight: 320, overflowY: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr>
                          <th style={th}>Flight</th>
                          <th style={{ ...th, textAlign: "right" }}>Run</th>
                          <th style={th}>Status</th>
                          <th style={th}>Started</th>
                          <th style={{ ...th, textAlign: "right" }}>Duration</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runRows.map((r, i) => (
                          <tr key={`${String(r.flight_name)}:${String(r.run_number)}:${i}`}>
                            <td style={tdMono}>
                              {String(r.flight_name)}
                              <span style={{ ...mono(8, 500), color: C.pencil, marginLeft: 6 }}>{r.is_scheduled ? "CRON" : "TRIGGER"}</span>
                            </td>
                            <td style={{ ...tdMono, textAlign: "right", fontSize: 12 }}>#{String(r.run_number)}</td>
                            <td style={td}>
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                <Chip status={runStatus(String(r.status ?? ""))} size={14} />
                                <span style={{ ...mono(9, 700), color: C.muted, letterSpacing: "0.06em" }}>
                                  {runLabel(String(r.status ?? "")).toUpperCase()}
                                </span>
                              </span>
                            </td>
                            <td style={tdMono}>{r.started_label == null ? "—" : String(r.started_label)}</td>
                            <td style={{ ...tdMono, textAlign: "right", fontSize: 12 }}>{fmtDur(N(r.duration_s))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {runsQ.isLoading ? <div style={empty}>Paddling… 🦆</div> : null}
                    {!runsQ.isLoading && runRows.length === 0 ? <div style={empty}>No runs recorded for this scope yet.</div> : null}
                  </div>
                )}
              </Card>

              <Card title="Freshness" right={<span style={note}>TABLES + S3 PREFIXES · UTC</span>}>
                {vitalsQ.isError ? (
                  <div style={{ fontSize: 13, color: C.muted }}>Could not read ops.vitals — {errMsg(vitalsQ)}</div>
                ) : (
                  <div style={{ overflowX: "auto", maxHeight: 320, overflowY: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr>
                          <th style={th}>Name</th>
                          <th style={{ ...th, textAlign: "right" }}>Rows / objects</th>
                          <th style={th}>Fresh at</th>
                          <th style={{ ...th, textAlign: "right" }}>Age</th>
                        </tr>
                      </thead>
                      <tbody>
                        {vitalRows.map((r, i) => {
                          const isPrefix = String(r.kind) === "prefix";
                          const count = isPrefix ? r.objects : r.row_count;
                          const blank = count == null || N(count) === 0;
                          return (
                            <tr key={`${String(r.name)}:${i}`} style={blank ? { background: C.lightduck } : undefined}>
                              <td style={tdMono}>
                                {String(r.name)}
                                {isPrefix ? <span style={{ ...mono(8, 500), color: C.pencil, marginLeft: 6 }}>{fmtBytes(N(r.bytes))}</span> : null}
                              </td>
                              <td style={{ ...tdMono, textAlign: "right", fontSize: 12 }}>{count == null ? "—" : fmtNum(N(count))}</td>
                              <td style={tdMono}>{r.fresh_label == null ? "—" : String(r.fresh_label)}</td>
                              <td style={{ ...tdMono, textAlign: "right" }}>
                                {r.fresh_age_s == null ? "—" : ageLabel(N(r.fresh_age_s))}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {vitalsQ.isLoading ? <div style={empty}>Paddling… 🦆</div> : null}
                    {!vitalsQ.isLoading && vitalRows.length === 0 ? <div style={empty}>No vitals collected yet.</div> : null}
                  </div>
                )}
              </Card>
            </div>
            )}

            <div style={{ ...mono(9, 700), color: C.pencil, letterSpacing: "0.1em", textAlign: "center", paddingTop: 4 }}>
              EVERY CHAIN ENDS AT {collectorName} · IT WRITES ops.* AND THIS BOARD READS IT BACK 🦆
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
