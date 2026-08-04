# Dive conventions

Visual and structural conventions for Dives in this account. Filed under the
reserved `dives` topic, so an agent asked to build or extend a Dive finds it
without loading the rest of the catalog.

The palette is Google-Analytics-style material: a light surface, one blue
accent, and semantic green/red reserved for direction. Data should be the only
thing with strong colour on the page.

## Rules

- **Light surface, one accent.** `pageBg` behind the page, white cards, and
  `blue` for the single highlighted series. Do not introduce a second accent
  hue — emphasis comes from one colour against neutrals.
- **Green and red mean direction, never decoration.** `green` for an increase,
  `red` for a decrease or an error. Never use them to distinguish categories.
- **Numeric table columns are right-aligned and `tabular-nums`.** Digits must
  line up column-wise or the table cannot be scanned.
- **Every table with more than a handful of rows is sortable**, and it sorts
  client-side on data already fetched — never re-query to re-sort.
- **Render a skeleton while loading**, never an empty chart frame or a bare
  "0". A zero that turns out to be a pending query is a lie.
- **Gate `QUERY_HISTORY` behind one probe query.** It requires org admin on a
  Business plan; without a gate, a non-admin viewer triggers one failed query
  per visual instead of one.

## Tokens

```ts
const C = {
  blue:      "#1a73e8",  // the one accent — highlighted series, links, active state
  blueLight: "#669df6",  // secondary series when two are genuinely needed
  green:     "#137333",  // increase
  red:       "#c5221f",  // decrease, error
  text:      "#202124",  // primary text
  muted:     "#5f6368",  // labels, axis text, captions
  border:    "#dadce0",  // card and table borders
  pageBg:    "#f8f9fa",  // page background
};
```

Row separators inside a table use `#f1f3f4` — lighter than `border`, so the
header rule reads as the strongest line.

## Component shapes

**Scorecard** — label above, large light-weight number, delta beneath:

```tsx
<p style={{ color: C.muted, fontSize: 12 }}>Queries</p>
<p style={{ color: C.text, fontSize: 30, fontWeight: 400, lineHeight: 1.1 }}>12.4K</p>
<Delta cur={12438} prev={9120} />
```

Note `fontWeight: 400` at 30px. The number is large, not bold — size carries the
emphasis.

**Table header** — 11px uppercase muted with letter-spacing:

```tsx
<th style={{ color: C.muted, fontSize: 11, fontWeight: 500,
             textTransform: "uppercase", letterSpacing: "0.3px" }}>
```

**Delta** — direction as colour and arrow, magnitude as a percentage:

```tsx
const pct = ((cur - prev) / prev) * 100;
<span style={{ color: pct >= 0 ? C.green : C.red, fontSize: 12, fontWeight: 500 }}>
  {pct >= 0 ? "↑" : "↓"} {Math.abs(pct).toFixed(1)}%
</span>
```

Show `new` rather than a division by zero when the previous period is empty.

**Skeleton** — Tailwind is available in the Dives runtime:

```tsx
<div className="bg-gray-200 animate-pulse rounded" style={{ height: 34, width: 80 }} />
```

## Sorting

Sort in the client over rows already fetched. Keep the state in `useDiveState`
so a sorted view survives a refresh and travels in the shared link:

```tsx
const [sort, setSort] = useDiveState<string>("sort", "queries");
const [dir,  setDir]  = useDiveState<string>("dir",  "desc");

const sorted = [...rows].sort((a, b) => {
  const x = a[sort], y = b[sort];
  const c = typeof x === "number" && typeof y === "number"
    ? x - y
    : String(x).localeCompare(String(y));
  return dir === "asc" ? c : -c;
});
```

Clicking the active column flips direction; clicking another switches column and
resets to descending. Mark the active column with `↑` / `↓` in its header — a
sortable table that doesn't say what it is sorted by is worse than one that
isn't sortable at all.

## Formatting

- Counts: compact notation — `12.4K`, `1.2M`.
- Durations: seconds under a minute, then `m`, then `h`. Never print `3600s`.
- Percentages: one decimal, `%` suffix.
- Timestamps in tables: trim to minutes. Seconds are noise in a rollup.

## The exceptions

Both are deliberate and named here, because an undocumented exception is
indistinguishable from a mistake.

**`Agent Commerce Overview` uses a dark, branded canvas.** It is a product
overview, not a monitoring dashboard. Everything analytical in this account uses
the light palette above.

**`Overall Usage Monitoring` uses red for read compute** in its "Read vs write
compute" chart, against blue for write compute — the one place in this account
where a semantic colour marks a category. Read-vs-write is that dive's central
dichotomy and the two bands are stacked in one column, so they have to be
separable at a glance; `blue` against `blueLight` is not. Treat this as licensed for
a genuine two-way opposition carrying the dive's main argument, not as
permission to colour categories generally: for three or more categories, or for
categories that are merely different rather than opposed, use one accent against
the neutral ramp (as that dive's stacked chart does).
