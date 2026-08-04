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
    if slug[0].isdigit():
        return ("d" if kind == "schema" else "t") + slug
    return slug


def resolve_schema(folder_path: list[str]) -> str:
    """Schema = underscore-joined relative path from the configured root.

    MotherDuck has exactly db.schema.table, so nesting flattens into the name.
    """
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
