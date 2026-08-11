import importlib.util
import sys
from pathlib import Path

FLIGHT = Path(__file__).parent.parent / "flights" / "gdrive-sheets-sync" / "flight.py"
_spec = importlib.util.spec_from_file_location("gdrive_sheets_sync", FLIGHT)
mod = importlib.util.module_from_spec(_spec)
# Required: flight.py uses `from __future__ import annotations`, so @dataclass
# resolves its stringified annotations by looking the module up in sys.modules.
# Without this line, exec_module raises AttributeError on PlannedItem.
sys.modules[_spec.name] = mod
_spec.loader.exec_module(mod)

SHEET = "application/vnd.google-apps.spreadsheet"

T1 = "2026-08-10T06:00:00.000Z"
T2 = "2026-08-11T09:30:00.000Z"


def item(file_id, tab, mtime, schema="finance", table=None):
    return mod.PlannedItem(
        schema=schema,
        table=table or f"sheet_{mod.slugify(tab)}",
        source_ref=f"Finance/Sheet[{tab}]",
        file_id=file_id,
        tab=tab,
        modified_time=mtime,
    )


def tables_for(items):
    return {(i.schema, i.table) for i in items}


# --- plan_loads ---------------------------------------------------------


def test_plan_loads_skips_files_whose_watermark_matches():
    planned = [item("a", "Jan", T1), item("a", "Feb", T1)]
    to_load, skipped = mod.plan_loads(
        planned,
        synced={"a": T1},
        existing_tables=tables_for(planned),
        skip_unchanged=True,
    )
    assert to_load == []
    assert skipped == planned


def test_plan_loads_loads_new_and_changed_files():
    changed = item("a", "Jan", T2)
    new = item("b", "Jan", T1)
    to_load, skipped = mod.plan_loads(
        [changed, new],
        synced={"a": T1},
        existing_tables=tables_for([changed, new]),
        skip_unchanged=True,
    )
    assert to_load == [changed, new]
    assert skipped == []


def test_plan_loads_repairs_a_missing_target_table():
    present = item("a", "Jan", T1)
    dropped = item("a", "Feb", T1)
    to_load, skipped = mod.plan_loads(
        [present, dropped],
        synced={"a": T1},
        existing_tables=tables_for([present]),
        skip_unchanged=True,
    )
    assert to_load == [dropped]
    assert skipped == [present]


def test_plan_loads_disabled_loads_everything():
    planned = [item("a", "Jan", T1)]
    to_load, skipped = mod.plan_loads(
        planned,
        synced={"a": T1},
        existing_tables=tables_for(planned),
        skip_unchanged=False,
    )
    assert to_load == planned
    assert skipped == []


def test_plan_loads_never_skips_an_item_without_a_modified_time():
    unknown = item("a", "Jan", "")
    to_load, skipped = mod.plan_loads(
        [unknown],
        synced={"a": ""},
        existing_tables=tables_for([unknown]),
        skip_unchanged=True,
    )
    assert to_load == [unknown]
    assert skipped == []


# --- watermark_updates --------------------------------------------------


def test_watermark_updates_advances_only_fully_successful_files():
    a_jan, a_feb = item("a", "Jan", T2), item("a", "Feb", T2)
    b_jan, b_feb = item("b", "Jan", T2), item("b", "Feb", T2)
    upserts, deletes = mod.watermark_updates(
        [(a_jan, True), (a_feb, True), (b_jan, True), (b_feb, False)]
    )
    assert upserts == {"a": T2}
    assert deletes == {"b"}


def test_watermark_updates_with_no_results_changes_nothing():
    upserts, deletes = mod.watermark_updates([])
    assert upserts == {}
    assert deletes == set()


# --- discovery threads modifiedTime -------------------------------------


def test_discover_threads_modified_time_onto_every_tab():
    tree = {
        "root": [
            {"id": "s1", "name": "2026 Q3", "mimeType": SHEET, "modifiedTime": T1},
        ],
    }
    planned, _ = mod.discover(
        lambda folder_id: tree.get(folder_id, []),
        lambda file_id: ["Jan", "Feb"],
        root_folders=[("root", "Finance")],
        exclude_folder_ids=set(),
        exclude_patterns=[],
    )
    assert [p.modified_time for p in planned] == [T1, T1]


def test_discover_tolerates_a_missing_modified_time():
    tree = {
        "root": [
            {"id": "s1", "name": "2026 Q3", "mimeType": SHEET},
        ],
    }
    planned, _ = mod.discover(
        lambda folder_id: tree.get(folder_id, []),
        lambda file_id: ["Jan"],
        root_folders=[("root", "Finance")],
        exclude_folder_ids=set(),
        exclude_patterns=[],
    )
    assert planned[0].modified_time == ""


# --- drive_lister requests the field ------------------------------------


class _Exec:
    def __init__(self, payload):
        self._payload = payload

    def execute(self):
        return self._payload


class _FakeFiles:
    def __init__(self, pages):
        self._pages = list(pages)
        self.list_calls = []

    def list(self, **kwargs):
        self.list_calls.append(kwargs)
        return _Exec(self._pages.pop(0))


class _FakeDrive:
    def __init__(self, files):
        self._files = files

    def files(self):
        return self._files


def test_drive_lister_requests_modified_time():
    files = _FakeFiles(pages=[{"files": []}])
    mod.drive_lister(_FakeDrive(files))("f")
    assert "modifiedTime" in files.list_calls[0]["fields"]
