# @flight
#   flowchart TD
#     config{Config valid?}:::check -->|ok| probe{Postgres reachable?}:::check
#     probe -->|ok| target[Ensure target database]:::load
#     target --> extract[Extract tables from Postgres]:::extract
#     extract --> normalize[Normalize to parquet]:::transform
#     normalize --> load[Load into MotherDuck]:::load
#     load --> trigger[Trigger transform Flight]:::wait
# @end-flight
"""Sync Postgres tables to MotherDuck with dlt, over a direct connection.

For any Postgres the Flight can reach over the internet: Neon, Supabase, Amazon RDS or
Aurora with a public endpoint, Google Cloud SQL with a public IP, Azure Database for
PostgreSQL, Heroku, Render, Crunchy Bridge, Railway, and the like. A Postgres that is
only reachable inside a VPC needs the tunnel variant in ../rds-ssm-dlt-sync, which is
this file plus an SSM port-forward.

dlt's sql_database source and motherduck destination do the copy instead of hand-written
CREATE OR REPLACE statements. That buys: per-table replace vs incremental, cursors kept in
the destination so a stateless Flight container resumes where the last run stopped,
schema evolution, and one config line per table instead of one Flight per table.

How this runs as a MotherDuck Flight
------------------------------------
* One run = one fresh container. Debian, CPython 3.12, deps installed by `uv` from
  requirements.txt, then this file runs top to bottom and exits. Nothing on disk
  survives, so dlt's cursor is NOT kept in a local file: dlt writes it to
  <TARGET_DB>.<TARGET_SCHEMA>._dlt_pipeline_state and restores it on the next run.

* Two compute planes. SQL sent over `md:` runs on a Duckling, not in this process. The
  Postgres read happens here (dlt over SQLAlchemy/psycopg2) and only the finished rows
  go to MotherDuck through dlt's motherduck destination.

* Outbound connections come from a fixed set of egress IPs per MotherDuck region
  (https://motherduck.com/docs/concepts/flights/#connecting-to-external-systems). A
  Postgres host with an IP allow list needs those addresses.

* Credentials arrive as environment variables.
    MOTHERDUCK_TOKEN                 injected by Flights; dlt reads it natively.
    pg_DATABASE_URL                  from the `pg` Flights secret, a full connection
                                     string as the provider's Connect dialog gives it; or
    pg_USER, pg_PASSWORD             with the host, port, database in `config` (PG_*).
  Non-secret settings live in the Flight's `config` map (visible in MD_GET_FLIGHT_VERSION)
  and arrive as plain env vars with the same name; see the block below.

* Lifecycle is SQL. MD_CREATE_FLIGHT creates it; every MD_UPDATE_FLIGHT writes a new
  immutable version (pass the full config map and secret list each time); MD_RUN_FLIGHT
  starts a run; MD_GET_FLIGHT_RUN and MD_GET_FLIGHT_LOGS inspect it.

* Limits. Max runtime per run is 1 h on Lite and 8 h by default on Business and
  Enterprise; cron schedules need Business or above. The instance size (F4/F16/F32) sets
  CPU and memory for this process only; SQL on `md:` scales with the Duckling.

Run order: validate config -> probe Postgres (retrying, so a scaled-to-zero Neon or
Supabase compute has time to wake) -> ensure the target database exists ->
dlt extract/normalize/load -> trigger the transform Flight.

Flight Explainer: the `# @flight` Mermaid block above declares these steps, and the
`@flight-run` / `@flight-log` lines printed below drive the live run visualization in
the MotherDuck UI. Step ids in the chart and in the log are identical.
"""

import os
import re
import time
from urllib.parse import parse_qs, urlsplit

# --- Flight config (non-secret; set via `config := MAP {...}` on the Flight, visible in
# MD_GET_FLIGHT_VERSION). Each key is surfaced to the Flight as an env var of the same name.
# PG_HOST/PG_PORT/PG_DATABASE/PG_SSLMODE are ignored when the `pg` secret carries DATABASE_URL.
PG_HOST = os.environ.get("PG_HOST", "")
PG_PORT = os.environ.get("PG_PORT", "5432")
PG_DATABASE = os.environ.get("PG_DATABASE", "postgres")
PG_SSLMODE = os.environ.get(
    "PG_SSLMODE", "require"
)  # "disable" only for a local test server
SOURCE_SCHEMA = os.environ.get("SOURCE_SCHEMA", "public")
TABLES = [
    t.strip()
    for t in os.environ.get("TABLES", "customers,products,orders,order_items").split(
        ","
    )
    if t.strip()
]
# "table:cursor_column:key_column[|key2]" entries; those tables are read incrementally (rows
# at or after the last seen cursor), everything else is a full replace.
INCREMENTAL_TABLES = os.environ.get("INCREMENTAL_TABLES", "")
# How incremental tables land:
#   merge  - dlt upserts on the key (delete+insert via a staging dataset). Target holds
#            current rows only. No PK constraint or index is created in MotherDuck.
#   append - append-only raw landing, history preserved, never a MERGE here. Updates
#            arrive as new rows (cursor = updated_at); the transform Flight
#            (../transform/flight.py) dedupes per key into the curated layer.
INCREMENTAL_MODE = os.environ.get("INCREMENTAL_MODE", "append")
TARGET_DB = os.environ.get("TARGET_DB", "pg_sync")  # MotherDuck database
TARGET_SCHEMA = os.environ.get("TARGET_SCHEMA", "raw")  # dlt dataset_name (raw landing)
# Flight to start after a successful load (the curated-layer transform, ../transform/flight.py).
# Empty: skip. The dedupe lives there, not here; this Flight only lands raw.
TRIGGER_FLIGHT_ID = os.environ.get("TRIGGER_FLIGHT_ID", "")
DLT_BACKEND = os.environ.get("DLT_BACKEND", "sqlalchemy")  # or "pyarrow"
PROBE_TIMEOUT_S = int(
    os.environ.get("PROBE_TIMEOUT_S", "90")
)  # covers a scale-to-zero wake-up

# Secrets come from Flight secrets (<secret>_<KEY>): pg_DATABASE_URL, or pg_USER + pg_PASSWORD.
# MOTHERDUCK_TOKEN is injected by Flights.

INCREMENTAL_MODES = {"merge", "append"}
DLT_BACKENDS = {"sqlalchemy", "pyarrow", "pandas", "connectorx"}


def validate_config() -> None:
    """Fail fast, before any connection, with one message naming every bad setting."""
    problems = []
    if INCREMENTAL_MODE not in INCREMENTAL_MODES:
        problems.append(
            f"INCREMENTAL_MODE={INCREMENTAL_MODE!r}; expected one of {sorted(INCREMENTAL_MODES)}"
        )
    if DLT_BACKEND not in DLT_BACKENDS:
        problems.append(
            f"DLT_BACKEND={DLT_BACKEND!r}; expected one of {sorted(DLT_BACKENDS)}"
        )
    if not TABLES:
        problems.append(
            "TABLES is empty; expected a comma-separated list of source tables"
        )
    for entry in filter(None, (e.strip() for e in INCREMENTAL_TABLES.split(","))):
        parts = entry.split(":")
        if len(parts) != 3 or not all(parts) or not all(parts[2].split("|")):
            problems.append(
                f"INCREMENTAL_TABLES entry {entry!r}; expected table:cursor_column:key[|key2]"
            )
            continue
        if parts[0] not in TABLES:
            problems.append(
                f"INCREMENTAL_TABLES names {parts[0]!r}, which is not in TABLES {TABLES}"
            )
    if not os.environ.get("pg_DATABASE_URL"):
        for name in ("pg_USER", "pg_PASSWORD"):
            if not os.environ.get(name):
                problems.append(
                    f"secret env var {name} is missing; attach a `pg` Flight secret with "
                    "DATABASE_URL, or with USER and PASSWORD plus PG_HOST in config"
                )
        if not PG_HOST:
            problems.append(
                "PG_HOST is required unless the `pg` secret carries DATABASE_URL"
            )
    if problems:
        raise ValueError("invalid Flight config: " + "; ".join(problems))
    flog(
        "config",
        f"mode={INCREMENTAL_MODE} backend={DLT_BACKEND} tables={TABLES} "
        f"incremental={INCREMENTAL_TABLES or '(none)'} target=md:{TARGET_DB}.{TARGET_SCHEMA} "
        f"trigger={TRIGGER_FLIGHT_ID or '(none)'}",
    )


# dlt wants a writable HOME and pipelines dir; a Flight container has neither by default.
os.environ.setdefault("HOME", "/tmp")
os.environ.setdefault("DLT_DATA_DIR", "/tmp/dlt")
os.environ.setdefault("RUNTIME__DLTHUB_TELEMETRY", "false")
os.environ.setdefault("RUNTIME__LOG_LEVEL", "WARNING")

import dlt  # noqa: E402  (after the env defaults above)
from dlt.sources.credentials import ConnectionStringCredentials  # noqa: E402
from dlt.sources.sql_database import sql_database  # noqa: E402
from sqlalchemy import create_engine, text  # noqa: E402


# ------------------------------------------------------------ Flight Explainer markers


def fr(step: str, state: str, **fields) -> None:
    """Print one `@flight-run` state line: fr("extract", "ok", rows=12)."""
    extra = " ".join(
        f'{k}="{v}"' if k == "error" else f"{k}={v}" for k, v in fields.items()
    )
    print(f"@flight-run {step} {state}{(' ' + extra) if extra else ''}", flush=True)


def flog(step: str, message: str) -> None:
    """Print a log line that belongs to a step."""
    print(f"@flight-log {step} {message}", flush=True)


def redact(s: str) -> str:
    """Strip the password from anything that might carry a connection string."""
    return re.sub(r"://([^:/@]+):[^@]+@", r"://\1:<redacted>@", s)


def step(step_id: str, fn, *args, **kwargs):
    """Run fn under `@flight-run` running/ok/failed markers and return its result."""
    fr(step_id, "running")
    try:
        result = fn(*args, **kwargs)
    except Exception as e:  # noqa: BLE001
        fr(step_id, "failed", error=redact(str(e)).replace('"', "'")[:300])
        raise
    fr(step_id, "ok")
    return result


# ------------------------------------------------------------------- connection


def build_pg_url() -> str:
    """SQLAlchemy URL from the `pg` secret: DATABASE_URL as given, or USER/PASSWORD + PG_* config.

    DATABASE_URL is taken verbatim apart from the scheme, so sslmode, channel_binding and
    options from a provider's Connect dialog are passed through to psycopg2 unchanged."""
    url = os.environ.get("pg_DATABASE_URL", "").strip()
    if url:
        return re.sub(r"^postgres(ql)?://", "postgresql+psycopg2://", url, count=1)
    return (
        f"postgresql+psycopg2://{os.environ['pg_USER']}:{os.environ['pg_PASSWORD']}"
        f"@{PG_HOST}:{PG_PORT}/{PG_DATABASE}?sslmode={PG_SSLMODE}"
    )


def check_provider(pg_url: str) -> None:
    """Stop on connection details that cannot work from a Flight, naming the fix.
    Mirrors the checks in MotherDuck's Postgres ingest cookbook."""
    u = urlsplit(pg_url)
    host, port, user = (u.hostname or "").lower(), u.port or 5432, u.username or ""
    q = {k: v[0] for k, v in parse_qs(u.query).items()}
    problems = []
    if host.endswith(".pooler.supabase.com"):
        if "." not in user:
            problems.append(
                "Supabase pooler user must be 'postgres.<project_ref>' (copy it from Connect > Session pooler)"
            )
        if port == 6543:
            problems.append(
                "port 6543 is Supabase's transaction pooler; use the Session pooler on port 5432"
            )
    elif host.endswith(".supabase.co") and host.startswith("db."):
        problems.append(
            "Supabase direct host is IPv6-only and Flights connect over IPv4; use the Session pooler host"
        )
    if host.endswith(".postgres.database.azure.com"):
        if ".private." in host:
            problems.append(
                "Azure private-access host is not reachable from a Flight; use the public endpoint"
            )
        if port == 6432:
            problems.append("port 6432 is Azure's PgBouncer; use 5432")
    if host.startswith("dpg-") and "." not in host:
        problems.append(
            "Render Internal Database URL has no public hostname; use the External Database URL"
        )
    if "[YOUR-PASSWORD]" in pg_url:
        problems.append("DATABASE_URL still contains the [YOUR-PASSWORD] placeholder")
    if problems:
        raise ValueError("connection cannot work from a Flight: " + "; ".join(problems))
    if host.endswith(".neon.tech") and "-pooler" in host:
        flog(
            "probe",
            "WARNING: Neon -pooler host; the direct endpoint is more reliable for long bulk reads",
        )
    if q.get("sslmode", "require") == "disable":
        flog("probe", "WARNING: sslmode=disable, the connection is not encrypted")
    flog("probe", f"host={host} port={port} db={u.path.lstrip('/')} user={user}")


def wait_for_postgres(pg_url: str, timeout_s: int = PROBE_TIMEOUT_S) -> None:
    """Retry a real Postgres handshake. A scale-to-zero compute (Neon, Supabase free tier)
    can take several seconds to wake on the first connection."""
    check_provider(pg_url)
    deadline = time.monotonic() + timeout_s
    last_error = None
    engine = create_engine(pg_url, connect_args={"connect_timeout": 10})
    attempt = 0
    while time.monotonic() < deadline:
        attempt += 1
        try:
            with engine.connect() as con:
                version = con.execute(text("SHOW server_version")).scalar()
            flog("probe", f"Postgres {version} reachable after {attempt} attempt(s)")
            return
        except Exception as e:  # noqa: BLE001
            last_error = redact(str(e)).splitlines()[0]
            time.sleep(min(2 * attempt, 10))
    raise TimeoutError(f"Postgres not reachable after {timeout_s}s: {last_error}")


# ------------------------------------------------------------------------------ dlt


def parse_incremental(raw: str) -> dict[str, tuple[str, list[str]]]:
    """'orders:updated_at:id,lines:updated_at:order_id|line_no' -> {table: (cursor, [keys])}."""
    out = {}
    for entry in filter(None, (e.strip() for e in raw.split(","))):
        table, cursor, keys = entry.split(":")
        out[table] = (cursor, keys.split("|"))
    return out


def relax_constraints(table) -> None:
    """Reflect every column as nullable. Raw landing tables carry no constraints, and a
    NOT NULL column added in Postgres later would otherwise make dlt emit
    ALTER TABLE ... ADD COLUMN ... NOT NULL, which DuckDB rejects ("Adding columns with
    constraints not yet supported")."""
    for col in table.columns:
        col.nullable = True


def build_source(pg_url: str):
    source = sql_database(
        credentials=ConnectionStringCredentials(pg_url),
        schema=SOURCE_SCHEMA,
        table_names=TABLES,
        backend=DLT_BACKEND,
        table_adapter_callback=relax_constraints,
    )
    incremental = parse_incremental(INCREMENTAL_TABLES)
    for table in TABLES:
        resource = source.resources[table]
        if table in incremental:
            cursor, keys = incremental[table]
            if INCREMENTAL_MODE == "append":
                resource.apply_hints(
                    write_disposition="append",
                    incremental=dlt.sources.incremental(cursor),
                )
                flog(
                    "extract",
                    f"{table}: append-only raw, cursor {cursor} (dedupe on {keys} downstream)",
                )
            else:
                resource.apply_hints(
                    write_disposition="merge",
                    primary_key=keys if len(keys) > 1 else keys[0],
                    incremental=dlt.sources.incremental(cursor),
                )
                flog("extract", f"{table}: merge on {keys}, cursor {cursor}")
        else:
            resource.apply_hints(write_disposition="replace")
            flog("extract", f"{table}: replace")
    return source


def ensure_target() -> None:
    """dlt attaches md:<db> and fails if it doesn't exist; create it up front."""
    import duckdb  # bundled by dlt[motherduck]

    con = duckdb.connect("md:")
    con.execute(f'CREATE DATABASE IF NOT EXISTS "{TARGET_DB}"')
    con.close()


def run_pipeline(pg_url: str) -> None:
    step("target", ensure_target)
    flog("target", f"md:{TARGET_DB} ready, dataset {TARGET_SCHEMA}")
    # MOTHERDUCK_TOKEN is read natively by the destination; only the database is set here.
    pipeline = dlt.pipeline(
        pipeline_name="pg_dlt",
        destination=dlt.destinations.motherduck(credentials=f"md:{TARGET_DB}"),
        dataset_name=TARGET_SCHEMA,
        pipelines_dir="/tmp/dlt/pipelines",
    )

    # pipeline.run() == sync_destination + extract + normalize + load; calling them
    # separately lets each stage report its own state to the Explainer. The sync is what
    # restores the incremental cursor from _dlt_pipeline_state in a fresh container.
    fr("extract", "running")
    try:
        pipeline.sync_destination()
        source = build_source(pg_url)
        pipeline.extract(source)
    except Exception as e:  # noqa: BLE001
        fr("extract", "failed", error=redact(str(e)).replace('"', "'")[:300])
        raise
    fr("extract", "ok", done=len(TABLES), total=len(TABLES))

    fr("normalize", "running")
    try:
        normalize_info = pipeline.normalize()
    except Exception as e:  # noqa: BLE001
        fr("normalize", "failed", error=redact(str(e)).replace('"', "'")[:300])
        raise
    counts = normalize_info.row_counts if normalize_info else {}
    fr("normalize", "ok", rows=sum(counts.get(t, 0) for t in TABLES))

    fr("load", "running")
    try:
        load_info = pipeline.load()
    except Exception as e:  # noqa: BLE001
        fr("load", "failed", error=redact(str(e)).replace('"', "'")[:300])
        raise
    for table in TABLES:  # one fan-out instance per table, with what it wrote
        fr(
            "load",
            "ok",
            key=table,
            rows=counts.get(table, 0),
            effect=f"table:{TARGET_DB}.{TARGET_SCHEMA}.{table}",
        )
    fr("load", "ok", rows=sum(counts.get(t, 0) for t in TABLES))
    flog(
        "load",
        f"{len(load_info.loads_ids)} load package(s) into md:{TARGET_DB}.{TARGET_SCHEMA}",
    )

    for s in pipeline.last_trace.steps:
        secs = (s.finished_at - s.started_at).total_seconds()
        flog(
            s.step if s.step in ("extract", "normalize", "load") else "load",
            f"{s.step} took {secs:.1f}s",
        )


def trigger_transform() -> None:
    """Start the curated-layer Flight after a clean ingest. MD_RUN_FLIGHT returns as soon as
    the run is queued; this Flight does not wait for it."""
    import duckdb  # bundled by dlt[motherduck]

    # This Flight is the single source of truth for where raw landed and which tables are
    # incremental; the transform gets both as per-run config overrides and discovers the
    # table list from the raw schema itself. In merge mode raw is already one row per key,
    # so the transform snapshots everything.
    overrides = {
        "TARGET_DB": TARGET_DB,
        "RAW_SCHEMA": TARGET_SCHEMA,
        "INCREMENTAL_TABLES": INCREMENTAL_TABLES
        if INCREMENTAL_MODE == "append"
        else "",
    }
    # A Python dict binds as a STRUCT, not a MAP, so build the MAP literal explicitly.
    lit = lambda v: "'" + str(v).replace("'", "''") + "'"  # noqa: E731
    config_map = (
        "MAP {" + ", ".join(f"{lit(k)}: {lit(v)}" for k, v in overrides.items()) + "}"
    )
    con = duckdb.connect("md:")
    run_number = con.execute(
        f"SELECT run_number FROM MD_RUN_FLIGHT(flight_id := ?, config := {config_map})",
        [TRIGGER_FLIGHT_ID],
    ).fetchone()[0]
    con.close()
    flog(
        "trigger",
        f"MD_RUN_FLIGHT {TRIGGER_FLIGHT_ID} -> run {run_number} with {overrides}",
    )


def main() -> None:
    fr("@flight", "running")
    try:
        step("config", validate_config)
        pg_url = build_pg_url()
        step("probe", wait_for_postgres, pg_url)
        run_pipeline(pg_url)
        if TRIGGER_FLIGHT_ID:
            step("trigger", trigger_transform)
        else:
            fr("trigger", "skipped")
    except Exception:
        fr("@flight", "failed", exit=1)
        raise
    fr("@flight", "ok", exit=0)


if __name__ == "__main__":
    main()
