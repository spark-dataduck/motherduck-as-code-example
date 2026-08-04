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
