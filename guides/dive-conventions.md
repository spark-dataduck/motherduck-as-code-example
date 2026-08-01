# Agent commerce Dive style

Visual tokens for the **Agent Commerce Overview** Dive. Match these when adding
a tab or chart so new work is indistinguishable from what is already there.

## Rules

- Dark canvas only. Never emit a light-background chart into this Dive.
- Use `ACCENT` for the single highlighted series. Do not introduce a second
  accent hue — the design carries emphasis through one color against neutrals.
- Chart gridlines use `GRID`; the zero baseline uses `BASELINE`. They are
  deliberately different values.
- Every tab renders a skeleton while `useSQLQuery` is loading. Do not ship a
  tab that renders an empty chart frame on first paint.

## Tokens

| Token | Value | Use |
| --- | --- | --- |
| `CANVAS` | `#0a0a0a` | Card and chart backgrounds |
| `PAGE` | `#000000` | Page background |
| `INK` | `#ffffff` | Primary text |
| `INK2` | `#c3c2b7` | Secondary text |
| `MUTED` | `#898781` | Axis labels, captions |
| `GRID` | `#383835` | Chart gridlines |
| `BASELINE` | `#4d4d49` | Zero baseline |
| `BORDER` | `rgba(255,255,255,0.10)` | Card borders |
| `ACCENT` | `#3987e5` | The highlighted series |

Font stack: `"Poppins", "Century Gothic", system-ui, sans-serif`.

## Formatting

- Currency via `fmtUSD` — compact notation, no cents at scale.
- Counts via `fmtNum` — compact notation.
- Latency in whole milliseconds with a `ms` suffix.
- Percentages to one decimal place with a `%` suffix.
