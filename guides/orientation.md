# MotherDuck as Code — orientation

What lives in this account, and which guide to open next. This guide has no
topic, so it appears in every overview. It is a map, not a manual.

## Rules

- **Start here, then open one topic.** Do not load every guide. Call
  `list_guides(topic)` for the area you need.
- **`agent_commerce` is the source data**, and it is read-only — it arrives as
  a share. Never write to it.
- **`agent_commerce_marts` holds derived tables** written by Flights. Read from
  here for anything pre-aggregated; do not hand-edit it, because the next
  Flight run replaces its tables.
- **Everything in this account is deployed from Git.** Editing a Flight, Dive,
  or Guide in the UI will be overwritten by the next deploy. Change the
  repository instead.

## What is where

| Database | Contents | Written by |
| --- | --- | --- |
| `agent_commerce` | `tenants`, `agent_services`, `agent_transactions`, `service_state_history` | Read-only share |
| `agent_commerce_marts` | `monthly_spend` | `agent-commerce-monthly-rollup` Flight |

## Topic map

| Topic | Open it when you need |
| --- | --- |
| `agent-commerce` | Revenue definitions, join rules, and pitfalls for the dataset |
| `platform-observability` | How to attribute MotherDuck usage to Dives, Flights, and MCP clients |
| `dives` | Visual and structural conventions for building Dives here |
| `flights` | How Flights are written, configured, and scheduled here |

`dives` and `flights` are reserved topics — agents reach them through their own
entry points rather than through this overview.
