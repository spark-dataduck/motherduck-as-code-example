# @flight
#   flowchart TD
#     config{Config valid?}:::check -->|ok| check{Raw tables present?}:::check
#     check -->|ok| snapshot[Rebuild snapshot tables]:::load
#     check -->|missing| done
#     snapshot --> merge[MERGE changed keys into curated]:::load
#     merge --> verify{Curated keys match raw?}:::check
#     verify -->|ok| done[Finish]
#     verify -->|mismatch| done
# @end-flight
"""Build the curated layer from dlt's append-only raw landing, with MERGE INTO.

Second Flight in the chain. The first (ingest/flight.py) lands RDS tables in <RAW_SCHEMA> through
the SSM tunnel and triggers this one with MD_RUN_FLIGHT when its load is done. This one is
SQL only: every statement runs on a Duckling over `md:`, so the Flight size barely matters; F16 is the default.

Per table:
  * replace tables (full snapshots in raw): CREATE OR REPLACE TABLE curated.<t> AS SELECT the
    raw rows minus dlt's bookkeeping columns. Atomic swap, schema evolution for free.
  * incremental tables (append-only in raw, listed in INCREMENTAL_TABLES as
    table:cursor:key[|key2]): keep one current row per key in curated.<t>.
      - first run: CREATE TABLE AS the deduped raw (max_by(row, (cursor, _dlt_load_id)) per key)
      - later runs: take raw rows with _dlt_load_id newer than the max _dlt_load_id already in
        curated, dedupe those per key, and MERGE INTO curated on the key. curated keeps
        _dlt_load_id so it is its own watermark; no state table.
  Raw is never modified or pruned here; it keeps every version it received.

Config. The table list is NOT configured here: every table in <RAW_SCHEMA> (except dlt's
`_dlt_*` bookkeeping) is processed. The ingest Flight is the single source of truth and passes
the per-run values through MD_RUN_FLIGHT(config := ...):
  INCREMENTAL_TABLES  table:cursor:key[|key2],...  -> MERGE; everything else -> snapshot
  TARGET_DB, RAW_SCHEMA                             -> where the ingest Flight landed raw
Stored on this Flight: CURATED_SCHEMA, and the three keys above as "" so they can be
overridden per run (MD_RUN_FLIGHT can only override keys the Flight already defines).
MOTHERDUCK_TOKEN is injected by Flights. No other secrets.
"""
import os
import sys

import duckdb

TARGET_DB = os.environ.get("TARGET_DB") or "rds_sync"
RAW_SCHEMA = os.environ.get("RAW_SCHEMA") or "raw"
CURATED_SCHEMA = os.environ.get("CURATED_SCHEMA") or "curated"
INCREMENTAL_TABLES = os.environ.get("INCREMENTAL_TABLES", "")
BOOKKEEPING = ("_dlt_id",)  # dropped from curated; _dlt_load_id is kept as the watermark


def fr(step: str, state: str, **fields) -> None:
    extra = " ".join(f'{k}="{v}"' if k == "error" else f"{k}={v}" for k, v in fields.items())
    print(f"@flight-run {step} {state}{(' ' + extra) if extra else ''}", flush=True)


def flog(step: str, message: str) -> None:
    print(f"@flight-log {step} {message}", flush=True)


def q(ident: str) -> str:
    return '"' + ident.replace('"', '""') + '"'


def parse_incremental(raw: str) -> dict[str, tuple[str, list[str]]]:
    out = {}
    for entry in filter(None, (e.strip() for e in raw.split(","))):
        table, cursor, keys = entry.split(":")
        out[table] = (cursor, keys.split("|"))
    return out


def validate_config() -> None:
    """Fail fast with one message naming every bad setting."""
    problems = []
    for name, value in (("TARGET_DB", TARGET_DB), ("RAW_SCHEMA", RAW_SCHEMA), ("CURATED_SCHEMA", CURATED_SCHEMA)):
        if not value:
            problems.append(f"{name} is empty")
    if RAW_SCHEMA == CURATED_SCHEMA:
        problems.append(f"RAW_SCHEMA and CURATED_SCHEMA are both {RAW_SCHEMA!r}; curated would overwrite raw")
    for entry in filter(None, (e.strip() for e in INCREMENTAL_TABLES.split(","))):
        parts = entry.split(":")
        if len(parts) != 3 or not all(parts) or not all(parts[2].split("|")):
            problems.append(f"INCREMENTAL_TABLES entry {entry!r}; expected table:cursor_column:key[|key2]")
    if problems:
        raise ValueError("invalid Flight config: " + "; ".join(problems))
    flog("config", f"db={TARGET_DB} raw={RAW_SCHEMA} curated={CURATED_SCHEMA} "
                   f"incremental={INCREMENTAL_TABLES or '(none)'} (tables discovered from raw)")


def discover_tables(con) -> list[str]:
    """Every table dlt landed in the raw schema, minus its bookkeeping tables."""
    rows = con.execute(
        "SELECT table_name FROM duckdb_tables() WHERE database_name = ? AND schema_name = ? "
        "AND NOT starts_with(table_name, '_dlt') ORDER BY table_name",
        [TARGET_DB, RAW_SCHEMA],
    ).fetchall()
    return [r[0] for r in rows]


def dedupe_sql(raw_rel: str, cursor: str, keys: list[str], where: str = "TRUE") -> str:
    """Latest row per key: newest cursor wins, newest load breaks ties."""
    return (
        f"SELECT * EXCLUDE ({', '.join(BOOKKEEPING)}) FROM ("
        f"  SELECT unnest(max_by(r, (r.{q(cursor)}, r._dlt_load_id))) "
        f"  FROM {raw_rel} AS r WHERE {where} GROUP BY {', '.join(q(k) for k in keys)})"
    )


def columns(con, schema: str, table: str) -> list[tuple[str, str]]:
    """(name, type) per column, in table order, minus dropped bookkeeping."""
    rows = con.execute(
        "SELECT column_name, data_type FROM duckdb_columns() "
        "WHERE database_name = ? AND schema_name = ? AND table_name = ? ORDER BY column_index",
        [TARGET_DB, schema, table],
    ).fetchall()
    return [(n, t) for n, t in rows if n not in BOOKKEEPING]


def ensure_columns(con, table: str) -> list[str]:
    """Add to curated any column raw has gained (a column added in Postgres flows through
    dlt as nullable). Returns the merge column list. Columns dropped upstream stay in
    curated as NULLs; nothing is ever removed."""
    raw_cols = columns(con, RAW_SCHEMA, table)
    cur_names = {n for n, _ in columns(con, CURATED_SCHEMA, table)}
    for name, dtype in raw_cols:
        if name not in cur_names:
            con.execute(f"ALTER TABLE {q(TARGET_DB)}.{q(CURATED_SCHEMA)}.{q(table)} ADD COLUMN {q(name)} {dtype}")
            flog("merge", f"{table}: added column {name} {dtype} to curated")
    return [n for n, _ in raw_cols]


def table_exists(con, schema: str, table: str) -> bool:
    return con.execute(
        "SELECT count(*) FROM duckdb_tables() WHERE database_name = ? AND schema_name = ? AND table_name = ?",
        [TARGET_DB, schema, table],
    ).fetchone()[0] > 0


def main() -> int:
    fr("@flight", "running")
    fr("config", "running")
    try:
        validate_config()
    except ValueError as e:
        fr("config", "failed", error=str(e).replace('"', "'")[:300])
        for s in ("check", "snapshot", "merge", "verify"):
            fr(s, "skipped")
        fr("@flight", "failed", exit=1)
        return 1
    fr("config", "ok")
    db, raw, cur = q(TARGET_DB), q(RAW_SCHEMA), q(CURATED_SCHEMA)
    incremental = parse_incremental(INCREMENTAL_TABLES)
    con = duckdb.connect("md:")
    ok = True

    fr("check", "running")
    tables = discover_tables(con)
    unknown = [t for t in incremental if t not in tables]
    if not tables or unknown:
        reason = f"no tables in {TARGET_DB}.{RAW_SCHEMA}" if not tables else f"INCREMENTAL_TABLES not in raw: {unknown}"
        fr("check", "failed", error=reason)
        fr("snapshot", "skipped"); fr("merge", "skipped"); fr("verify", "skipped")
        fr("@flight", "failed", exit=1)
        return 1
    con.execute(f"CREATE SCHEMA IF NOT EXISTS {db}.{cur}")
    snapshot_tables = [t for t in tables if t not in incremental]
    merge_tables = [t for t in tables if t in incremental]
    flog("check", f"raw has {tables}; snapshot={snapshot_tables} merge={merge_tables}")
    fr("check", "ok", done=len(tables), total=len(tables))

    fr("snapshot", "running")
    try:
        for t in snapshot_tables:
            con.execute(
                f"CREATE OR REPLACE TABLE {db}.{cur}.{q(t)} AS "
                f"SELECT * EXCLUDE ({', '.join(BOOKKEEPING)}) FROM {db}.{raw}.{q(t)}"
            )
            n = con.execute(f"SELECT count(*) FROM {db}.{cur}.{q(t)}").fetchone()[0]
            fr("snapshot", "ok", key=t, rows=n, effect=f"table:{TARGET_DB}.{CURATED_SCHEMA}.{t}")
        fr("snapshot", "ok", done=len(snapshot_tables), total=len(snapshot_tables))
    except Exception as e:  # noqa: BLE001
        fr("snapshot", "failed", error=str(e).replace('"', "'")[:300])
        fr("merge", "skipped"); fr("verify", "skipped"); fr("@flight", "failed", exit=1)
        return 1

    fr("merge", "running")
    try:
        for t in merge_tables:
            cursor, keys = incremental[t]
            raw_rel, cur_rel = f"{db}.{raw}.{q(t)}", f"{db}.{cur}.{q(t)}"
            if not table_exists(con, CURATED_SCHEMA, t):
                con.execute(f"CREATE TABLE {cur_rel} AS {dedupe_sql(raw_rel, cursor, keys)}")
                n = con.execute(f"SELECT count(*) FROM {cur_rel}").fetchone()[0]
                flog("merge", f"{t}: first run, built from full raw dedupe ({n} rows)")
                fr("merge", "ok", key=t, rows=n, effect=f"table:{TARGET_DB}.{CURATED_SCHEMA}.{t}")
                continue
            cols = ensure_columns(con, t)
            watermark = con.execute(f"SELECT coalesce(max(_dlt_load_id), '') FROM {cur_rel}").fetchone()[0]
            on = " AND ".join(f"c.{q(k)} = s.{q(k)}" for k in keys)
            set_list = ", ".join(f"{q(c)} = s.{q(c)}" for c in cols if c not in keys)
            col_list = ", ".join(q(c) for c in cols)
            val_list = ", ".join(f"s.{q(c)}" for c in cols)
            merge = (
                f"MERGE INTO {cur_rel} AS c "
                f"USING ({dedupe_sql(raw_rel, cursor, keys, where=f'r._dlt_load_id > {watermark!r}')}) AS s "
                f"ON {on} "
                # NULL cursor in curated (column added after the row landed) counts as oldest
                f"WHEN MATCHED AND (c.{q(cursor)} IS NULL OR s.{q(cursor)} >= c.{q(cursor)}) "
                f"THEN UPDATE SET {set_list} "
                f"WHEN NOT MATCHED THEN INSERT ({col_list}) VALUES ({val_list})"
            )
            result = con.execute(merge).fetchone()
            changed = result[0] if result else 0
            flog("merge", f"{t}: watermark _dlt_load_id > {watermark}, {changed} rows merged")
            fr("merge", "ok", key=t, rows=changed, effect=f"table:{TARGET_DB}.{CURATED_SCHEMA}.{t}")
        fr("merge", "ok", done=len(merge_tables), total=len(merge_tables))
    except Exception as e:  # noqa: BLE001
        fr("merge", "failed", error=str(e).replace('"', "'")[:300])
        fr("verify", "skipped"); fr("@flight", "failed", exit=1)
        return 1

    fr("verify", "running")
    for t in merge_tables:
        cursor, keys = incremental[t]
        key_expr = ", ".join(q(k) for k in keys)
        raw_keys = con.execute(f"SELECT count(DISTINCT ({key_expr})) FROM {db}.{raw}.{q(t)}").fetchone()[0]
        cur_rows, cur_keys = con.execute(
            f"SELECT count(*), count(DISTINCT ({key_expr})) FROM {db}.{cur}.{q(t)}"
        ).fetchone()
        good = raw_keys == cur_keys == cur_rows
        flog("verify", f"{t}: raw keys={raw_keys} curated rows={cur_rows} curated keys={cur_keys}")
        if not good:
            ok = False
    fr("verify", "ok" if ok else "failed", **({} if ok else {"error": "curated does not match raw keys"}))
    con.close()
    fr("@flight", "ok" if ok else "failed", exit=0 if ok else 1)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
