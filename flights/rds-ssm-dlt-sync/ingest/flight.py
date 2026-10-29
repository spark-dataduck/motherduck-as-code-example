# @flight
#   flowchart TD
#     config{Config valid?}:::check -->|ok| plugin[Install SSM plugin]:::wait
#     plugin --> tunnel[Open SSM tunnel to bastion]:::wait
#     tunnel --> probe{Postgres reachable through tunnel?}:::check
#     probe -->|ok| target[Ensure target database]:::load
#     probe -->|timeout| teardown
#     target --> extract[Extract tables from RDS]:::extract
#     extract --> normalize[Normalize to parquet]:::transform
#     normalize --> load[Load into MotherDuck]:::load
#     load --> teardown[Close tunnel and SSM session]:::wait
#     teardown --> trigger[Trigger transform Flight]:::wait
# @end-flight
"""Sync private RDS Postgres tables to MotherDuck with dlt, through an SSM tunnel.

Opens an SSM port-forwarding session (boto3 StartSession + session-manager-plugin) and the copy is
done by dlt's sql_database source and motherduck destination instead of hand-written
CREATE OR REPLACE statements. That buys: per-table replace vs merge, incremental
cursors, schema evolution, and pipeline state kept in the destination so a stateless
Flight container still resumes where the last run stopped.

How this runs as a MotherDuck Flight
------------------------------------
A Flight is a Python program MotherDuck runs on a schedule or via MD_RUN_FLIGHT.
Everything below follows from how the runtime works:

* One run = one fresh container. Debian, CPython 3.12, deps installed by `uv` from
  the Flight's requirements_txt, then this file runs top to bottom and exits. Nothing on
  disk survives, so the SSM plugin is downloaded every run and dlt's cursor is NOT kept
  in a local file: dlt writes it to <TARGET_DB>.<TARGET_SCHEMA>._dlt_pipeline_state and
  restores it from there on the next run (restore_from_destination, on by default).

* The container has internet egress and `subprocess`. That is what lets it call the
  AWS SSM API with boto3 and run session-manager-plugin, exactly like a laptop would.
  The RDS side needs no inbound path: the bastion's SSM agent dials OUT to Systems
  Manager, and SSM brokers the stream between the two outbound connections.

* Two compute planes. SQL sent over `md:` runs on a Duckling, not in this process, and
  a Duckling cannot see this container's 127.0.0.1. So the Postgres read must happen
  here (dlt's sql_database source does it over SQLAlchemy/psycopg2), and only the
  finished rows go to MotherDuck through dlt's motherduck destination.

* Credentials arrive as environment variables.
    MOTHERDUCK_TOKEN               injected by Flights; dlt's motherduck destination reads
                                   it natively, so no token appears in this code.
    rds_USER, rds_PASSWORD         from the `rds` Flights secret (<secret>_<KEY>).
    ssm_AWS_ACCESS_KEY_ID,
    ssm_AWS_SECRET_ACCESS_KEY      from the `ssm` Flights secret.
  Non-secret settings live in the Flight's `config` map (visible in MD_GET_FLIGHT_VERSION)
  and arrive as plain env vars with the same name; see the block below.

* Lifecycle is SQL. MD_CREATE_FLIGHT creates it; every MD_UPDATE_FLIGHT writes a new
  immutable version (pass the full config map and secret list each time, both are
  replaced wholesale); MD_RUN_FLIGHT starts a run; MD_GET_FLIGHT_RUN and
  MD_GET_FLIGHT_LOGS inspect it; MD_DELETE_FLIGHT removes it.

* Limits to keep in mind. Max runtime per run is 1 h on Lite/Business, 8 h on
  Enterprise; cron schedules need Business or above. The instance size (F4/F16/F32)
  sets CPU and memory for this Python process only; SQL on `md:` scales with the
  Duckling. Session Manager's own idle timeout (20 min default) also applies to the
  tunnel, so a run that sits idle between tables can lose it.

Run order: install plugin -> StartSession -> wait for a real Postgres handshake through
the tunnel -> ensure the target database exists -> dlt extract/normalize/load ->
print per-stage timings -> always terminate the plugin and the SSM session.

Flight Explainer: the `# @flight` Mermaid block above declares these steps, and the
`@flight-run` / `@flight-log` lines printed below drive the live run visualization in
the MotherDuck UI. Step ids in the chart and in the log are identical.
"""
import json
import os
import platform
import re
import subprocess
import time
import urllib.request

import boto3

# --- Flight config (non-secret; set via `config := MAP {...}` on the Flight, visible in
# MD_GET_FLIGHT_VERSION). Each key is surfaced to the Flight as an env var of the same name.
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
BASTION_INSTANCE_ID = os.environ.get("BASTION_INSTANCE_ID", "")   # bastion_instance_id
RDS_HOST = os.environ.get("RDS_HOST", "")                         # rds_address (private hostname)
RDS_PORT = int(os.environ.get("RDS_PORT", "5432"))
RDS_DATABASE = os.environ.get("RDS_DATABASE", "postgres")        # database_name
SOURCE_SCHEMA = os.environ.get("SOURCE_SCHEMA", "public")
TABLES = [t.strip() for t in os.environ.get("TABLES", "customers,products,orders,order_items").split(",") if t.strip()]
# "table:cursor_column:key_column[|key2]" entries; those tables are read incrementally (rows
# at or after the last seen cursor), everything else is a full replace.
INCREMENTAL_TABLES = os.environ.get("INCREMENTAL_TABLES", "")
# How incremental tables land:
#   merge  - dlt upserts on the key (delete+insert via a staging dataset). Target holds
#            current rows only. No PK constraint or index is created in MotherDuck.
#   append - append-only raw landing, history preserved, never a MERGE here. Updates
#            arrive as new rows (cursor = updated_at); the transform Flight
#            (transform/flight.py) dedupes per key into the curated layer.
INCREMENTAL_MODE = os.environ.get("INCREMENTAL_MODE", "merge")
TARGET_DB = os.environ.get("TARGET_DB", "rds_sync")       # MotherDuck database
TARGET_SCHEMA = os.environ.get("TARGET_SCHEMA", "raw")         # dlt dataset_name (raw landing)
# Flight to start after a successful load (the curated-layer transform, transform/flight.py).
# Empty: skip. The dedupe lives there, not here; this Flight only lands raw.
TRIGGER_FLIGHT_ID = os.environ.get("TRIGGER_FLIGHT_ID", "")
DLT_BACKEND = os.environ.get("DLT_BACKEND", "sqlalchemy")         # or "pyarrow"
SKIP_TUNNEL = os.environ.get("SKIP_TUNNEL", "false").lower() == "true"  # local runs: tunnel already open
SSM_PLUGIN_VERSION = os.environ.get("SSM_PLUGIN_VERSION", "1.2.896.0")

# Secrets come from Flight secrets (<secret>_<KEY>): rds_USER, rds_PASSWORD,
# ssm_AWS_ACCESS_KEY_ID, ssm_AWS_SECRET_ACCESS_KEY. MOTHERDUCK_TOKEN is injected by Flights.

LOCAL_PORT = int(os.environ.get("LOCAL_PORT", "15432"))
PLUGIN_DIR = "/tmp/ssm-plugin"
DOCUMENT = "AWS-StartPortForwardingSessionToRemoteHost"

INCREMENTAL_MODES = {"merge", "append"}
DLT_BACKENDS = {"sqlalchemy", "pyarrow", "pandas", "connectorx"}


def validate_config() -> None:
    """Fail fast, before the tunnel opens, with one message naming every bad setting."""
    problems = []
    if INCREMENTAL_MODE not in INCREMENTAL_MODES:
        problems.append(f"INCREMENTAL_MODE={INCREMENTAL_MODE!r}; expected one of {sorted(INCREMENTAL_MODES)}")
    if DLT_BACKEND not in DLT_BACKENDS:
        problems.append(f"DLT_BACKEND={DLT_BACKEND!r}; expected one of {sorted(DLT_BACKENDS)}")
    if not TABLES:
        problems.append("TABLES is empty; expected a comma-separated list of source tables")
    if not SKIP_TUNNEL:
        for name, value in (("BASTION_INSTANCE_ID", BASTION_INSTANCE_ID), ("RDS_HOST", RDS_HOST)):
            if not value:
                problems.append(f"{name} is required unless SKIP_TUNNEL=true")
        if not BASTION_INSTANCE_ID.startswith("i-"):
            problems.append(f"BASTION_INSTANCE_ID={BASTION_INSTANCE_ID!r}; expected an EC2 instance id (i-...)")
    for entry in filter(None, (e.strip() for e in INCREMENTAL_TABLES.split(","))):
        parts = entry.split(":")
        if len(parts) != 3 or not all(parts) or not all(parts[2].split("|")):
            problems.append(f"INCREMENTAL_TABLES entry {entry!r}; expected table:cursor_column:key[|key2]")
            continue
        if parts[0] not in TABLES:
            problems.append(f"INCREMENTAL_TABLES names {parts[0]!r}, which is not in TABLES {TABLES}")
    for name in ("rds_USER", "rds_PASSWORD") + (() if SKIP_TUNNEL else ("ssm_AWS_ACCESS_KEY_ID", "ssm_AWS_SECRET_ACCESS_KEY")):
        if not os.environ.get(name):
            problems.append(f"secret env var {name} is missing; attach the Flight secret that provides it")
    if problems:
        raise ValueError("invalid Flight config: " + "; ".join(problems))
    flog("config", f"mode={INCREMENTAL_MODE} backend={DLT_BACKEND} tables={TABLES} "
                   f"incremental={INCREMENTAL_TABLES or '(none)'} target=md:{TARGET_DB}.{TARGET_SCHEMA} "
                   f"trigger={TRIGGER_FLIGHT_ID or '(none)'}")

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
    extra = " ".join(f'{k}="{v}"' if k == "error" else f"{k}={v}" for k, v in fields.items())
    print(f"@flight-run {step} {state}{(' ' + extra) if extra else ''}", flush=True)


def flog(step: str, message: str) -> None:
    """Print a log line that belongs to a step."""
    print(f"@flight-log {step} {message}", flush=True)


# ---------------------------------------------------------------- tunnel (same as ingest/flight.py)

def install_session_manager_plugin() -> str:
    """Download the SSM plugin .deb and unpack it without root (no apt-get)."""
    arch = {"x86_64": "ubuntu_64bit", "aarch64": "ubuntu_arm64"}[platform.machine()]
    url = f"https://s3.amazonaws.com/session-manager-downloads/plugin/{SSM_PLUGIN_VERSION}/{arch}/session-manager-plugin.deb"
    deb = "/tmp/session-manager-plugin.deb"
    urllib.request.urlretrieve(url, deb)
    subprocess.run(["dpkg-deb", "-x", deb, PLUGIN_DIR], check=True)
    plugin = f"{PLUGIN_DIR}/usr/local/sessionmanagerplugin/bin/session-manager-plugin"
    version = subprocess.run([plugin, "--version"], capture_output=True, text=True).stdout.strip()
    flog("plugin", f"session-manager-plugin {version} ({arch})")
    return plugin


def start_tunnel(plugin: str):
    """Open localhost:LOCAL_PORT -> bastion -> RDS:5432 via StartSession + the plugin."""
    ssm = boto3.client(
        "ssm",
        region_name=AWS_REGION,
        aws_access_key_id=os.environ["ssm_AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["ssm_AWS_SECRET_ACCESS_KEY"],
    )
    params = {
        "Target": BASTION_INSTANCE_ID,
        "DocumentName": DOCUMENT,
        "Parameters": {
            "host": [RDS_HOST],
            "portNumber": [str(RDS_PORT)],
            "localPortNumber": [str(LOCAL_PORT)],
        },
    }
    session = ssm.start_session(**params)
    session_id = session["SessionId"]
    flog("tunnel", f"SSM session started: {session_id}")
    session_json = {k: session[k] for k in ("SessionId", "StreamUrl", "TokenValue")}
    proc = subprocess.Popen(
        [plugin, json.dumps(session_json), AWS_REGION, "StartSession", "",
         json.dumps(params), ssm.meta.endpoint_url]
    )
    return ssm, session_id, proc


def wait_for_tunnel(proc, pg_url: str, timeout_s: int = 60) -> None:
    """Retry a real Postgres handshake through the tunnel; a TCP accept isn't enough."""
    deadline = time.monotonic() + timeout_s
    last_error = None
    engine = create_engine(pg_url, connect_args={"connect_timeout": 5})
    while time.monotonic() < deadline:
        if proc is not None and proc.poll() is not None:
            raise RuntimeError(f"session-manager-plugin exited early (code {proc.returncode})")
        try:
            with engine.connect() as con:
                con.execute(text("SELECT 1"))
            flog("probe", "Tunnel ready")
            return
        except Exception as e:  # noqa: BLE001
            last_error = re.sub(r":[^:@/]+@", ":<redacted>@", str(e))
            time.sleep(1)
    raise TimeoutError(f"Tunnel not ready after {timeout_s}s: {last_error}")


def step(step_id: str, fn, *args, **kwargs):
    """Run fn under `@flight-run` running/ok/failed markers and return its result."""
    fr(step_id, "running")
    try:
        result = fn(*args, **kwargs)
    except Exception as e:  # noqa: BLE001
        fr(step_id, "failed", error=str(e).replace('"', "'")[:300])
        raise
    fr(step_id, "ok")
    return result


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
                flog("extract", f"{table}: append-only raw, cursor {cursor} (dedupe on {keys} downstream)")
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
        pipeline_name="rds_ssm_dlt",
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
        fr("extract", "failed", error=str(e).replace('"', "'")[:300])
        raise
    fr("extract", "ok", done=len(TABLES), total=len(TABLES))

    fr("normalize", "running")
    try:
        normalize_info = pipeline.normalize()
    except Exception as e:  # noqa: BLE001
        fr("normalize", "failed", error=str(e).replace('"', "'")[:300])
        raise
    counts = normalize_info.row_counts if normalize_info else {}
    fr("normalize", "ok", rows=sum(counts.get(t, 0) for t in TABLES))

    fr("load", "running")
    try:
        load_info = pipeline.load()
    except Exception as e:  # noqa: E722, BLE001
        fr("load", "failed", error=str(e).replace('"', "'")[:300])
        raise
    for table in TABLES:  # one fan-out instance per table, with what it wrote
        fr("load", "ok", key=table, rows=counts.get(table, 0),
           effect=f"table:{TARGET_DB}.{TARGET_SCHEMA}.{table}")
    fr("load", "ok", rows=sum(counts.get(t, 0) for t in TABLES))
    flog("load", f"{len(load_info.loads_ids)} load package(s) into md:{TARGET_DB}.{TARGET_SCHEMA}")

    for s in pipeline.last_trace.steps:
        secs = (s.finished_at - s.started_at).total_seconds()
        flog(s.step if s.step in ("extract", "normalize", "load") else "load", f"{s.step} took {secs:.1f}s")


def trigger_transform() -> None:
    """Start the curated-layer Flight. Runs last, after the tunnel and SSM session are closed,
    so the hand-off only happens after a fully clean ingest. MD_RUN_FLIGHT returns as soon as
    the run is queued; this Flight does not wait for it."""
    import duckdb  # bundled by dlt[motherduck]
    # This Flight is the single source of truth for where raw landed and which tables are
    # incremental; the transform gets both as per-run config overrides and discovers the
    # table list from the raw schema itself. In merge mode raw is already one row per key,
    # so the transform snapshots everything.
    overrides = {
        "TARGET_DB": TARGET_DB,
        "RAW_SCHEMA": TARGET_SCHEMA,
        "INCREMENTAL_TABLES": INCREMENTAL_TABLES if INCREMENTAL_MODE == "append" else "",
    }
    # A Python dict binds as a STRUCT, not a MAP, so build the MAP literal explicitly.
    lit = lambda v: "'" + str(v).replace("'", "''") + "'"  # noqa: E731
    config_map = "MAP {" + ", ".join(f"{lit(k)}: {lit(v)}" for k, v in overrides.items()) + "}"
    con = duckdb.connect("md:")
    run_number = con.execute(
        f"SELECT run_number FROM MD_RUN_FLIGHT(flight_id := ?, config := {config_map})",
        [TRIGGER_FLIGHT_ID],
    ).fetchone()[0]
    con.close()
    flog("trigger", f"MD_RUN_FLIGHT {TRIGGER_FLIGHT_ID} -> run {run_number} with {overrides}")


def main() -> None:
    fr("@flight", "running")
    try:
        step("config", validate_config)
    except Exception:
        fr("@flight", "failed", exit=1)
        raise
    pg_url = (
        f"postgresql+psycopg2://{os.environ['rds_USER']}:{os.environ['rds_PASSWORD']}"
        f"@127.0.0.1:{LOCAL_PORT}/{RDS_DATABASE}?sslmode=require"
    )

    try:
        if SKIP_TUNNEL:
            fr("plugin", "skipped")
            fr("tunnel", "skipped")
            flog("tunnel", f"SKIP_TUNNEL=true: expecting an open tunnel on 127.0.0.1:{LOCAL_PORT}")
            step("probe", wait_for_tunnel, None, pg_url)
            run_pipeline(pg_url)
            fr("teardown", "skipped")
        else:
            plugin = step("plugin", install_session_manager_plugin)
            ssm, session_id, proc = step("tunnel", start_tunnel, plugin)
            try:
                step("probe", wait_for_tunnel, proc, pg_url)
                run_pipeline(pg_url)
            finally:
                # Always close the tunnel, on success or failure, before anything else happens.
                fr("teardown", "running")
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                ssm.terminate_session(SessionId=session_id)
                flog("teardown", f"SSM session terminated: {session_id}")
                fr("teardown", "ok")

        # Hand off to the transform only after a clean ingest and a closed session.
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
