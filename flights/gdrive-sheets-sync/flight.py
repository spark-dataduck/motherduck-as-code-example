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
  DISCOVER_ONLY       true  = walk Drive, resolve every table name, print the
                              plan, then return BEFORE connecting to MotherDuck.
                              No database, no tables, no audit rows, and no
                              MotherDuck compute is used at all.
                      false = load every discovered tab              (default: false)
  FAIL_ON_COLLISION   abort before loading if two items collide     (default: true)
  SKIP_UNCHANGED      true  = skip every file whose Drive modifiedTime matches
                              the watermark recorded at its last fully-successful
                              load (kept in <TARGET_DATABASE>.main.gsheets_sync_state),
                              unless a target table has gone missing. Flights bill
                              by the second, so a no-change run finishes in seconds
                              instead of paying for every re-load.
                      false = reload every discovered tab            (default: true)
  MAX_ATTEMPTS        per-item total attempts (not "retries")       (default: 5)
  RETRY_BASE_SECONDS  exponential-backoff multiplier                (default: 2)

Secret (Flight secret, TYPE flights, named by flight_secret_names):
  gsheets_SERVICE_ACCOUNT_JSON   full Google service-account key JSON
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import unicodedata
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

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
    modified_time: str = ""


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


# --- change detection ---------------------------------------------------

def plan_loads(
    planned: list[PlannedItem],
    synced: dict[str, str],
    existing_tables: set[tuple[str, str]],
    skip_unchanged: bool,
) -> tuple[list[PlannedItem], list[PlannedItem]]:
    """Partition planned items into (to_load, skipped).

    A tab is skipped only when every reason to load it is absent: skipping is
    enabled, Drive reported a modifiedTime, that time equals the watermark
    recorded at the file's last fully-successful sync, and the target table
    still exists — dropping a table in MotherDuck must not require touching
    the sheet to get it back. An empty modifiedTime always loads: the failure
    mode of change detection must be a redundant reload, never a missed
    update.
    """
    to_load: list[PlannedItem] = []
    skipped: list[PlannedItem] = []
    for item in planned:
        unchanged = (
            skip_unchanged
            and item.modified_time != ""
            and synced.get(item.file_id) == item.modified_time
            and (item.schema, item.table) in existing_tables
        )
        (skipped if unchanged else to_load).append(item)
    return to_load, skipped


def watermark_updates(
    results: list[tuple[PlannedItem, bool]],
) -> tuple[dict[str, str], set[str]]:
    """Turn per-tab load results into per-file watermark writes.

    Returns (upserts, deletes). upserts maps file_id -> modified_time for
    files whose loaded tabs all succeeded. deletes holds files where any tab
    failed: their watermark must go, so the next run retries the whole file
    rather than trusting a half-loaded one.
    """
    succeeded: dict[str, str] = {}
    failed: set[str] = set()
    for item, ok in results:
        if ok:
            succeeded.setdefault(item.file_id, item.modified_time)
        else:
            failed.add(item.file_id)
    return (
        {fid: mtime for fid, mtime in succeeded.items() if fid not in failed},
        failed,
    )


# --- discovery --------------------------------------------------------------

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
    non_native_skipped = 0

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
                non_native_skipped += 1
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
                        modified_time=child.get("modifiedTime", ""),
                    )
                )

    if non_native_skipped:
        warnings.append(
            f"{non_native_skipped} file(s) skipped as not native Google Sheets"
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
                    fields="nextPageToken, files(id, name, mimeType, modifiedTime)",
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
    """Resolve a root folder's own name, which becomes the top path segment.

    Also validates the ID is actually a folder: pasting a spreadsheet ID into
    ROOT_FOLDER_IDS would otherwise yield a silent zero-result walk instead of
    a clear error.
    """
    meta = (
        service.files()
        .get(fileId=folder_id, fields="name, mimeType", supportsAllDrives=True)
        .execute()
    )
    if meta["mimeType"] != FOLDER_MIME:
        raise RuntimeError(
            f"{folder_id} is not a folder (mimeType={meta['mimeType']})"
        )
    return meta["name"]


# --- constants ---------------------------------------------------------

SCOPES = [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/spreadsheets.readonly",
]

SYNC_LOG_COLUMNS = [
    "run_id", "source_ref", "target_ref", "rows", "attempts",
    "status", "error", "started_at", "finished_at",
]


# --- SQL helpers ------------------------------------------------------------

# NOTE: duckdb, google-*, and tenacity are imported INSIDE main(), not here.
# The test suite loads this file with importlib.exec_module to reach the pure
# helpers, so a third-party import at module scope would force CI to install the
# Flight's full runtime dependencies just to unit-test slugify().


def quote_ident(ident: str) -> str:
    if not isinstance(ident, str):
        raise TypeError(f"quote_ident() requires a string, got {type(ident).__name__}")
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


# --- config parsing -----------------------------------------------------

_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}


def _env_bool(key: str, default: bool) -> bool:
    raw = os.environ.get(key)
    if raw is None or not raw.strip():
        return default
    value = raw.strip().lower()
    if value in _TRUE:
        return True
    if value in _FALSE:
        return False
    raise RuntimeError(
        f"{key}={raw!r} is not a boolean; use one of {sorted(_TRUE | _FALSE)}"
    )


def _env_json(key: str, default):
    raw = os.environ.get(key, "").strip()
    if not raw:
        return default
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{key} is not valid JSON: {exc}") from exc


def _env_str_list(key: str, default: list[str]) -> list[str]:
    value = _env_json(key, default)
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise RuntimeError(f"{key} must be a JSON array of strings, got {value!r}")
    return value


def _env_int(key: str, default: int) -> int:
    raw = os.environ.get(key, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{key}={raw!r} is not an integer") from exc


def _env_float(key: str, default: float) -> float:
    raw = os.environ.get(key, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise RuntimeError(f"{key}={raw!r} is not a number") from exc


# --- main -------------------------------------------------------------------

def _warn_orphans(con, target_db: str, planned: list[PlannedItem]) -> None:
    """Warn about tables in the database that discovery did not find.

    Names are the key, so a Drive rename creates a new table and leaves the old
    one stale. Warn only — never drop, because these are customer data tables.
    """
    existing = con.execute(
        "SELECT table_schema, table_name FROM information_schema.tables "
        "WHERE table_catalog = ? AND table_type = 'BASE TABLE' "
        "AND NOT (table_schema = 'main' "
        "AND table_name IN ('gsheets_sync_log', 'gsheets_sync_state'))",
        [target_db],
    ).fetchall()
    expected = {(item.schema, item.table) for item in planned}
    for schema, table in sorted(set(existing) - expected):
        print(
            f"WARNING: orphan table {target_db}.{schema}.{table} was not found in "
            "Drive this run (renamed or deleted?); not dropped"
        )


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

    root_ids = _env_str_list("ROOT_FOLDER_IDS", [])
    if not root_ids:
        raise RuntimeError("ROOT_FOLDER_IDS config is required")

    target_db = os.environ.get("TARGET_DATABASE", "").strip() or "google_drive"
    exclude_folder_ids = set(_env_str_list("EXCLUDE_FOLDER_IDS", []))
    exclude_patterns = _env_str_list("EXCLUDE_PATTERNS", [])
    all_varchar = _env_bool("ALL_VARCHAR", True)
    discover_only = _env_bool("DISCOVER_ONLY", False)
    fail_on_collision = _env_bool("FAIL_ON_COLLISION", True)
    skip_unchanged = _env_bool("SKIP_UNCHANGED", True)
    max_attempts = _env_int("MAX_ATTEMPTS", 5)
    retry_base = _env_float("RETRY_BASE_SECONDS", 2)

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
    # Printed as collected (not batched) so the diagnostic survives even if
    # discover() itself raises before the later combined-warnings print runs.
    roots: list[tuple[str, str]] = []
    for fid in root_ids:
        try:
            roots.append((fid, folder_name(drive, fid)))
        except Exception as exc:  # noqa: BLE001 - one bad root must not stop the rest
            warning = (
                f"root folder {fid} is unreadable ({exc}); is it shared with "
                f"{key['client_email']}?"
            )
            print(f"WARNING: {warning}")
    if not roots:
        raise RuntimeError("no readable root folders; nothing to discover")

    planned, warnings = discover(
        drive_lister(drive),
        sheets_tab_lister(sheets),
        roots,
        exclude_folder_ids,
        exclude_patterns,
    )
    # Root warnings were already printed above as they were collected; only
    # the discovery warnings are new here.
    for warning in warnings:
        print(f"WARNING: {warning}")

    print(f"Resolved {len(planned)} table(s) across {len(roots)} root folder(s):")
    for item in planned:
        print(f"  {target_db}.{item.schema}.{item.table}  <-  {item.source_ref}")

    collisions = detect_collisions(planned)
    if collisions:
        for (schema, table), refs in collisions.items():
            print(f"COLLISION: {schema}.{table} <- {', '.join(refs)}")
        if fail_on_collision:
            raise RuntimeError(
                f"{len(collisions)} table-name collision(s); nothing was loaded"
            )

    if discover_only:
        print("DISCOVER_ONLY=true; nothing written")
        return

    if not planned:
        print(
            "WARNING: discovery found nothing loadable; check the warnings "
            "above (excluded roots, excluded folders, filtered patterns, or "
            "non-native files)"
        )
        return

    con = duckdb.connect("md:")
    try:
        con.execute(f"CREATE DATABASE IF NOT EXISTS {quote_ident(target_db)}")
        log_table = f"{quote_ident(target_db)}.main.gsheets_sync_log"
        con.execute(
            f"CREATE TABLE IF NOT EXISTS {log_table} ("
            "run_id VARCHAR, source_ref VARCHAR, target_ref VARCHAR, rows BIGINT, "
            "attempts INTEGER, status VARCHAR, error VARCHAR, "
            "started_at TIMESTAMP WITH TIME ZONE, finished_at TIMESTAMP WITH TIME ZONE)"
        )
        state_table = f"{quote_ident(target_db)}.main.gsheets_sync_state"
        con.execute(
            f"CREATE TABLE IF NOT EXISTS {state_table} ("
            "file_id VARCHAR, source_file VARCHAR, modified_time VARCHAR, "
            "synced_at TIMESTAMP WITH TIME ZONE)"
        )

        synced = dict(
            con.execute(
                f"SELECT file_id, modified_time FROM {state_table}"
            ).fetchall()
        )
        existing_tables = set(
            con.execute(
                "SELECT table_schema, table_name FROM information_schema.tables "
                "WHERE table_catalog = ? AND table_type = 'BASE TABLE'",
                [target_db],
            ).fetchall()
        )
        to_load, skipped = plan_loads(
            planned, synced, existing_tables, skip_unchanged
        )
        if skipped:
            print(
                f"Unchanged since last sync: "
                f"{len({item.file_id for item in skipped})} file(s), "
                f"{len(skipped)} tab(s) skipped"
            )

        # A file that vanished from Drive keeps its tables (_warn_orphans
        # covers those) but loses its watermark row: state is bookkeeping,
        # not customer data, and a stale row would mask a later re-share.
        for fid in sorted(set(synced) - {item.file_id for item in planned}):
            con.execute(f"DELETE FROM {state_table} WHERE file_id = ?", [fid])

        if not to_load:
            _warn_orphans(con, target_db, planned)
            print(
                f"Done: nothing changed; {len(skipped)} item(s) skipped, "
                "nothing loaded"
            )
            return

        # Deferred until something actually loads: a no-change run never
        # installs the extension or ships the key through the query path.
        con.execute("INSTALL gsheets FROM community")
        con.execute("LOAD gsheets")
        # CREATE SECRET has no parameter-binding form, so the private key
        # necessarily transits the query path and may appear in query history.
        # Readers of this public example should know what they're putting here.
        con.execute(
            f"CREATE OR REPLACE SECRET gsheet_auth "
            f"(TYPE gsheet, PROVIDER key_file, EMAIL {sql_str(key['client_email'])}, "
            f"SECRET {sql_str(key['private_key'])})"
        )

        run_id = str(uuid.uuid4())
        for schema in sorted({item.schema for item in to_load}):
            con.execute(
                f"CREATE SCHEMA IF NOT EXISTS {quote_ident(target_db)}.{quote_ident(schema)}"
            )

        failures = 0
        results: list[tuple[PlannedItem, bool]] = []
        for item in to_load:
            # target_ref is the unquoted, human/audit-log form so it stays
            # joinable to a plain information_schema listing; target_sql is
            # the quoted form used in every DDL/DML statement below.
            target_ref = f"{target_db}.{item.schema}.{item.table}"
            target_sql = (
                f"{quote_ident(target_db)}.{quote_ident(item.schema)}.{quote_ident(item.table)}"
            )
            started = datetime.now(timezone.utc)
            attempts = 0

            def job():
                nonlocal attempts
                attempts += 1
                con.execute(
                    f"CREATE OR REPLACE TABLE {target_sql} AS "
                    f"{build_read_sql(item, all_varchar)}"
                )
                return con.execute(f"SELECT count(*) FROM {target_sql}").fetchone()[0]

            # Retries are not restricted by exception type: a permanently
            # broken sheet burns all max_attempts with backoff (~30s at the
            # default multiplier), so 50 broken sheets means ~25 minutes of
            # sleeping. Worst case, not a bug — do not change this behavior.
            retryer = Retrying(
                stop=stop_after_attempt(max_attempts),
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
            results.append((item, status == "ok"))

            con.execute(
                f"INSERT INTO {log_table} ({', '.join(SYNC_LOG_COLUMNS)}) "
                f"VALUES ({', '.join(['?'] * len(SYNC_LOG_COLUMNS))})",
                [
                    run_id, item.source_ref, target_ref, rows, attempts,
                    status, error, started, datetime.now(timezone.utc),
                ],
            )

        upserts, deletes = watermark_updates(results)
        source_files = {
            item.file_id: item.source_ref.rsplit("[", 1)[0] for item in to_load
        }
        for fid in sorted(set(upserts) | deletes):
            con.execute(f"DELETE FROM {state_table} WHERE file_id = ?", [fid])
        for fid, mtime in sorted(upserts.items()):
            con.execute(
                f"INSERT INTO {state_table} VALUES (?, ?, ?, ?)",
                [fid, source_files[fid], mtime, datetime.now(timezone.utc)],
            )

        _warn_orphans(con, target_db, planned)

        print(
            f"Done: {len(to_load) - failures} item(s) succeeded, "
            f"{failures} failed, {len(skipped)} skipped as unchanged"
        )
        if failures:
            raise SystemExit(1)
    finally:
        con.close()


if __name__ == "__main__":
    main()
