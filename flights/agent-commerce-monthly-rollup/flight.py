"""Recompute the monthly authorized-spend rollup from the agent_commerce share.

Config (surfaced as environment variables by the Flight runtime):
  SOURCE_SHARE_URL  md:_share/agent_commerce/<uuid>
  SOURCE_ALIAS      attach alias for the share        (default: agent_commerce)
  TARGET_DATABASE   database to write into            (default: agent_commerce_marts)
  TARGET_TABLE      table to write                    (default: monthly_spend)
"""

from __future__ import annotations

import os

import duckdb

ROLLUP_SQL = """
CREATE OR REPLACE TABLE {target_db}.main.{target_table} AS
SELECT
  strftime(t.d, '%Y-%m') AS month,
  count(*) FILTER (WHERE x.transaction_status = 'authorized') AS authorized_txns,
  sum(CASE WHEN x.transaction_status = 'authorized' THEN x.gross_amount_usd END) AS authorized_spend
FROM generate_series(DATE '2024-01-01', DATE '2024-12-01', INTERVAL 1 MONTH) AS t(d)
LEFT JOIN {alias}.main.agent_transactions x
  ON date_trunc('month', x.occurred_at) = t.d
GROUP BY 1
ORDER BY 1
"""


def main() -> None:
    share_url = os.environ.get("SOURCE_SHARE_URL", "")
    if not share_url:
        raise RuntimeError("SOURCE_SHARE_URL config is required")
    alias = os.environ.get("SOURCE_ALIAS", "agent_commerce")
    target_db = os.environ.get("TARGET_DATABASE", "agent_commerce_marts")
    target_table = os.environ.get("TARGET_TABLE", "monthly_spend")

    con = duckdb.connect("md:")
    con.execute(f"ATTACH IF NOT EXISTS '{share_url}' AS {alias}")
    con.execute(f"CREATE DATABASE IF NOT EXISTS {target_db}")
    con.execute(
        ROLLUP_SQL.format(target_db=target_db, target_table=target_table, alias=alias)
    )

    rows = con.execute(
        f"SELECT count(*) FROM {target_db}.main.{target_table}"
    ).fetchone()[0]
    print(f"Wrote {rows} rows to {target_db}.main.{target_table}")


if __name__ == "__main__":
    main()
