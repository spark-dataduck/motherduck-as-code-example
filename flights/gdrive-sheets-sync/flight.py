"""Discover Google Sheets across Drive folder trees and load each tab into MotherDuck.

One run walks every folder in ROOT_FOLDER_IDS recursively, enumerates the tabs of
every Google Sheets file it finds, resolves all target table names, aborts on any
collision, then loads each tab with CREATE OR REPLACE TABLE.

Config (surfaced as environment variables by the Flight runtime):
  ROOT_FOLDER_IDS     JSON array of Drive folder IDs to walk        (required)
  TARGET_DATABASE     database imported tables land in              (default: google_drive)
  EXCLUDE_FOLDER_IDS  JSON array of folder IDs to skip              (default: [])
  EXCLUDE_PATTERNS    JSON array of fnmatch patterns on file names  (default: [])
  ALL_VARCHAR         land every column as VARCHAR                  (default: true)
  DISCOVER_ONLY       print the resolved plan and write nothing     (default: false)
  FAIL_ON_COLLISION   abort before loading if two items collide     (default: true)
  MAX_RETRIES         per-item retry attempts                       (default: 5)
  RETRY_BASE_SECONDS  exponential-backoff multiplier                (default: 2)

Secret (Flight secret, TYPE flights, named by flight_secret_names):
  gsheets_SERVICE_ACCOUNT_JSON   full Google service-account key JSON
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

# --- naming -----------------------------------------------------------------

_NON_SLUG = re.compile(r"[^a-z0-9]+")


@dataclass(frozen=True)
class PlannedItem:
    """One resolved load target: a single tab of a single spreadsheet."""

    schema: str
    table: str
    source_ref: str
    file_id: str
    tab: str


def slugify(name: str) -> str:
    """Fold to ASCII and reduce to [a-z0-9_]. Never returns an empty string."""
    folded = (
        unicodedata.normalize("NFKD", name)
        .encode("ascii", "ignore")
        .decode("ascii")
    )
    return _NON_SLUG.sub("_", folded.lower()).strip("_") or "unnamed"


def prefixed(slug: str, kind: str) -> str:
    """DuckDB identifiers cannot start with a digit unquoted.

    Prefix 'd' for a schema and 't' for a table, so a mangled name still says
    which level it came from.
    """
    if not slug:
        raise ValueError("slug must not be empty")
    if slug[0].isdigit():
        return ("d" if kind == "schema" else "t") + slug
    return slug


def resolve_schema(folder_path: list[str]) -> str:
    """Schema = underscore-joined relative path from the configured root.

    MotherDuck has exactly db.schema.table, so nesting flattens into the name.
    An empty folder_path is a caller bug, not a data condition: the root
    folder's own name is always the first path segment, so any real sheet
    resolves a non-empty path. Fail loudly rather than inventing a schema.
    """
    if not folder_path:
        raise ValueError("folder_path must not be empty")
    return prefixed("_".join(slugify(part) for part in folder_path), "schema")


def resolve_table(file_name: str, tab_name: str) -> str:
    """Table = <file>_<tab>. The tab is ALWAYS appended.

    Omitting it for single-tab files would silently rename the table the day a
    second tab is added, breaking every report bound to the old name.
    """
    return prefixed(f"{slugify(file_name)}_{slugify(tab_name)}", "table")


def detect_collisions(
    items: list[PlannedItem],
) -> dict[tuple[str, str], list[str]]:
    """Map each over-subscribed (schema, table) to the source refs that want it."""
    seen: dict[tuple[str, str], list[str]] = {}
    for item in items:
        seen.setdefault((item.schema, item.table), []).append(item.source_ref)
    return {key: refs for key, refs in seen.items() if len(refs) > 1}


# --- discovery --------------------------------------------------------------

import fnmatch

SHEET_MIME = "application/vnd.google-apps.spreadsheet"
FOLDER_MIME = "application/vnd.google-apps.folder"


def discover(
    list_children,
    list_tabs,
    root_folders: list[tuple[str, str]],
    exclude_folder_ids: set[str],
    exclude_patterns: list[str],
) -> tuple[list[PlannedItem], list[str]]:
    """Walk each root folder depth-first and expand every native Sheet's tabs.

    list_children(folder_id) -> [{"id", "name", "mimeType"}, ...]
    list_tabs(file_id)       -> ["Tab name", ...]
    root_folders             -> [(folder_id, display_name), ...]

    Returns (planned_items, warnings). Anything that is not a native Google
    Sheet produces a warning rather than a silent skip.
    """
    planned: list[PlannedItem] = []
    warnings: list[str] = []

    # stack entries are (folder_id, path_parts)
    stack: list[tuple[str, list[str]]] = []
    for fid, name in root_folders:
        if fid in exclude_folder_ids:
            warnings.append(f"excluded root folder: {name}")
            continue
        stack.append((fid, [name]))

    while stack:
        folder_id, path_parts = stack.pop()
        path = "/".join(path_parts)
        for child in list_children(folder_id):
            name, mime, cid = child["name"], child["mimeType"], child["id"]

            if mime == FOLDER_MIME:
                if cid in exclude_folder_ids:
                    warnings.append(f"excluded folder: {path}/{name}")
                    continue
                stack.append((cid, path_parts + [name]))
                continue

            if mime != SHEET_MIME:
                warnings.append(
                    f"{path}/{name} is not a native Google Sheet "
                    f"(mimeType={mime}); skipped"
                )
                continue

            if any(fnmatch.fnmatch(name, pat) for pat in exclude_patterns):
                warnings.append(f"excluded by pattern: {path}/{name}")
                continue

            tabs = list_tabs(cid)
            if not tabs:
                warnings.append(f"{path}/{name} has no readable tabs")
                continue

            schema = resolve_schema(path_parts)
            for tab in tabs:
                planned.append(
                    PlannedItem(
                        schema=schema,
                        table=resolve_table(name, tab),
                        source_ref=f"{path}/{name}[{tab}]",
                        file_id=cid,
                        tab=tab,
                    )
                )

    return planned, warnings


def drive_lister(service):
    """Adapt the Drive client to list_children(folder_id).

    supportsAllDrives/includeItemsFromAllDrives are required because service
    accounts have zero Drive storage quota, so source folders commonly live in
    a Shared Drive rather than being owned by the service account.
    """

    def list_children(folder_id: str) -> list[dict]:
        out: list[dict] = []
        page_token = None
        while True:
            resp = (
                service.files()
                .list(
                    q=f"'{folder_id}' in parents and trashed = false",
                    fields="nextPageToken, files(id, name, mimeType)",
                    pageSize=1000,
                    pageToken=page_token,
                    supportsAllDrives=True,
                    includeItemsFromAllDrives=True,
                )
                .execute()
            )
            out.extend(resp.get("files", []))
            page_token = resp.get("nextPageToken")
            if not page_token:
                return out

    return list_children


def sheets_tab_lister(service):
    """Adapt the Sheets client to list_tabs(file_id)."""

    def list_tabs(file_id: str) -> list[str]:
        meta = (
            service.spreadsheets()
            .get(spreadsheetId=file_id, fields="sheets.properties.title")
            .execute()
        )
        return [s["properties"]["title"] for s in meta.get("sheets", [])]

    return list_tabs


def folder_name(service, folder_id: str) -> str:
    """Resolve a root folder's own name, which becomes the top path segment."""
    meta = (
        service.files()
        .get(fileId=folder_id, fields="name", supportsAllDrives=True)
        .execute()
    )
    return meta["name"]


# --- SQL helpers ------------------------------------------------------------

import json
import os
import uuid
from datetime import datetime, timezone

# NOTE: duckdb, google-*, and tenacity are imported INSIDE main(), not here.
# The test suite loads this file with importlib.exec_module to reach the pure
# helpers, so a third-party import at module scope would force CI to install the
# Flight's full runtime dependencies just to unit-test slugify().

SCOPES = [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/spreadsheets.readonly",
]

SYNC_LOG_COLUMNS = [
    "run_id", "source_ref", "target_ref", "rows", "attempts",
    "status", "error", "started_at", "finished_at",
]


def quote_ident(ident: str) -> str:
    return '"' + ident.replace('"', '""') + '"'


def sql_str(value: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"sql_str() requires a string, got {type(value).__name__}")
    return "'" + value.replace("'", "''") + "'"


def build_read_sql(item: PlannedItem, all_varchar: bool) -> str:
    args = [sql_str(item.file_id), f"sheet={sql_str(item.tab)}"]
    if all_varchar:
        args.append("all_varchar=true")
    return f"SELECT * FROM read_gsheet({', '.join(args)})"


def _env_json(key: str, default):
    raw = os.environ.get(key, "").strip()
    return json.loads(raw) if raw else default


def _env_bool(key: str, default: bool) -> bool:
    return os.environ.get(key, str(default)).strip().lower() in ("1", "true", "yes")


# --- main -------------------------------------------------------------------

def main() -> None:
    # Imported here, not at module scope, so unit tests can load this file
    # without the Flight's runtime dependencies installed.
    import duckdb
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    from tenacity import (
        Retrying,
        stop_after_attempt,
        wait_exponential,
        wait_random,
    )

    root_ids = _env_json("ROOT_FOLDER_IDS", [])
    if not root_ids:
        raise RuntimeError("ROOT_FOLDER_IDS config is required")

    target_db = os.environ.get("TARGET_DATABASE", "google_drive")
    exclude_folder_ids = set(_env_json("EXCLUDE_FOLDER_IDS", []))
    exclude_patterns = _env_json("EXCLUDE_PATTERNS", [])
    all_varchar = _env_bool("ALL_VARCHAR", True)
    discover_only = _env_bool("DISCOVER_ONLY", False)
    fail_on_collision = _env_bool("FAIL_ON_COLLISION", True)
    max_retries = int(os.environ.get("MAX_RETRIES", "5"))
    retry_base = float(os.environ.get("RETRY_BASE_SECONDS", "2"))

    key_json = os.environ.get("gsheets_SERVICE_ACCOUNT_JSON", "")
    if not key_json:
        raise RuntimeError(
            "gsheets_SERVICE_ACCOUNT_JSON is missing; attach the 'gsheets' Flight secret"
        )
    key = json.loads(key_json)
    creds = service_account.Credentials.from_service_account_info(key, scopes=SCOPES)
    drive = build("drive", "v3", credentials=creds, cache_discovery=False)
    sheets = build("sheets", "v4", credentials=creds, cache_discovery=False)

    # A root folder that was never shared with the service account is invisible.
    # Warn per root and carry on; do not fail the run over one misconfigured id.
    roots: list[tuple[str, str]] = []
    root_warnings: list[str] = []
    for fid in root_ids:
        try:
            roots.append((fid, folder_name(drive, fid)))
        except Exception as exc:  # noqa: BLE001 - one bad root must not stop the rest
            root_warnings.append(
                f"root folder {fid} is unreadable ({exc}); is it shared with "
                f"{key['client_email']}?"
            )
    if not roots:
        for warning in root_warnings:
            print(f"WARNING: {warning}")
        raise RuntimeError("no readable root folders; nothing to discover")

    planned, warnings = discover(
        drive_lister(drive),
        sheets_tab_lister(sheets),
        roots,
        exclude_folder_ids,
        exclude_patterns,
    )
    for warning in root_warnings + warnings:
        print(f"WARNING: {warning}")

    collisions = detect_collisions(planned)
    if collisions:
        for (schema, table), refs in collisions.items():
            print(f"COLLISION: {schema}.{table} <- {', '.join(refs)}")
        if fail_on_collision:
            raise RuntimeError(
                f"{len(collisions)} table-name collision(s); nothing was loaded"
            )

    print(f"Resolved {len(planned)} table(s) across {len(roots)} root folder(s):")
    for item in planned:
        print(f"  {target_db}.{item.schema}.{item.table}  <-  {item.source_ref}")

    if discover_only:
        print("DISCOVER_ONLY=true; nothing written")
        return

    con = duckdb.connect("md:")
    con.execute("INSTALL gsheets FROM community")
    con.execute("LOAD gsheets")
    con.execute(
        f"CREATE OR REPLACE SECRET gsheet_auth "
        f"(TYPE gsheet, PROVIDER key_file, EMAIL {sql_str(key['client_email'])}, "
        f"SECRET {sql_str(key['private_key'])})"
    )
    con.execute(f"CREATE DATABASE IF NOT EXISTS {quote_ident(target_db)}")
    log_table = f"{quote_ident(target_db)}.main.gsheets_sync_log"
    con.execute(
        f"CREATE TABLE IF NOT EXISTS {log_table} ("
        "run_id VARCHAR, source_ref VARCHAR, target_ref VARCHAR, rows BIGINT, "
        "attempts INTEGER, status VARCHAR, error VARCHAR, "
        "started_at TIMESTAMP, finished_at TIMESTAMP)"
    )

    run_id = str(uuid.uuid4())
    for schema in sorted({item.schema for item in planned}):
        con.execute(
            f"CREATE SCHEMA IF NOT EXISTS {quote_ident(target_db)}.{quote_ident(schema)}"
        )

    failures = 0
    for item in planned:
        target_ref = (
            f"{quote_ident(target_db)}.{quote_ident(item.schema)}.{quote_ident(item.table)}"
        )
        started = datetime.now(timezone.utc)
        attempts = 0

        def job():
            nonlocal attempts
            attempts += 1
            con.execute(
                f"CREATE OR REPLACE TABLE {target_ref} AS "
                f"{build_read_sql(item, all_varchar)}"
            )
            return con.execute(f"SELECT count(*) FROM {target_ref}").fetchone()[0]

        retryer = Retrying(
            stop=stop_after_attempt(max_retries),
            wait=wait_exponential(multiplier=retry_base, max=60) + wait_random(0, 1),
            reraise=True,
        )
        try:
            rows = retryer(job)
            status, error = "ok", None
            print(f"OK   {item.source_ref} -> {target_ref} ({rows} rows)")
        except Exception as exc:  # noqa: BLE001 - one bad sheet must not stop the rest
            rows, status, error = None, "failed", str(exc)[:2000]
            failures += 1
            print(f"FAIL {item.source_ref}: {error}")

        con.execute(
            f"INSERT INTO {log_table} ({', '.join(SYNC_LOG_COLUMNS)}) "
            f"VALUES ({', '.join('?' * len(SYNC_LOG_COLUMNS))})",
            [
                run_id, item.source_ref, target_ref, rows, attempts,
                status, error, started, datetime.now(timezone.utc),
            ],
        )

    _warn_orphans(con, target_db, planned)

    print(f"Done: {len(planned) - failures} succeeded, {failures} failed")
    if failures:
        raise SystemExit(1)


def _warn_orphans(con, target_db: str, planned: list[PlannedItem]) -> None:
    """Warn about tables in the database that discovery did not find.

    Names are the key, so a Drive rename creates a new table and leaves the old
    one stale. Warn only — never drop, because these are customer data tables.
    """
    existing = con.execute(
        "SELECT table_schema, table_name FROM information_schema.tables "
        "WHERE table_catalog = ? AND table_name <> 'gsheets_sync_log'",
        [target_db],
    ).fetchall()
    expected = {(item.schema, item.table) for item in planned}
    for schema, table in sorted(set(existing) - expected):
        print(
            f"WARNING: orphan table {target_db}.{schema}.{table} was not found in "
            "Drive this run (renamed or deleted?); not dropped"
        )


if __name__ == "__main__":
    main()
