# Guides

**The directory tree mirrors the topic tree.** A guide's path under `guides/` is
its `topic` in MotherDuck, and the filename is just a filename — the guide's
identity is its `title` plus `topic` in `manifest.json`.

```
guides/
├── orientation.md                        (no topic — appears in every overview)
├── agent-commerce/
│   ├── metrics.md                        topic: agent-commerce
│   └── forecasting/
│       └── run-rate.md                   topic: agent-commerce/forecasting
├── platform-observability/
│   └── usage-monitoring.md               topic: platform-observability
├── dives/
│   └── conventions.md                    topic: dives      (reserved)
└── flights/
    └── conventions.md                    topic: flights    (reserved)
```

Keeping the two in sync is a convention, not a rule the deployer enforces —
`manifest.json` is still the source of truth for both `topic` and `source`. But
a mismatch between where a file sits and where it lands is the kind of thing
nobody notices for months, so don't create one.

## Why topics

An agent does not load every guide. It calls `list_guides(topic)`, reads the
topic names and their counts, and opens only what looks relevant. Topic names
are therefore the entire basis on which a guide gets read or skipped:
`agent-commerce` earns a look, `misc` does not.

- **Root is expensive.** Guides with no topic appear in *every* overview, so
  they cost tokens in every session. Only `orientation.md` earns it, by being a
  map to everything else rather than a manual.
- **Nesting is by slash and filters by prefix.** Asking for `agent-commerce`
  also returns `agent-commerce/forecasting`. Keep it shallow — one or two levels
  under a top-level topic.
- **`dives/` and `flights/` are reserved** for Dive and Flight conventions.
  Agents reach them through their own entry points, and they are excluded from
  the root overview.

## Adding a guide

1. Put the markdown at the path matching its topic.
2. Add an entry to `manifest.json` with `title`, `topic`, `source`,
   `description`, and `access`.
3. Commit. CI deploys it.

Write the `description` carefully — along with the topic name, it is what an
agent matches on when deciding whether to open the guide.
