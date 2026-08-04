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
FOLDER = "application/vnd.google-apps.folder"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

# Finance/ -> Invoices/ -> "2026 Q3" (2 tabs); Finance/ -> "notes.xlsx"
TREE = {
    "root": [
        {"id": "f_inv", "name": "Invoices", "mimeType": FOLDER},
        {"id": "x1", "name": "notes.xlsx", "mimeType": XLSX},
    ],
    "f_inv": [
        {"id": "s1", "name": "2026 Q3", "mimeType": SHEET},
    ],
}
TABS = {"s1": ["Jan", "Feb"]}


def fake_children(folder_id):
    return TREE.get(folder_id, [])


def fake_tabs(file_id):
    return TABS.get(file_id, [])


def test_discover_walks_nested_folders_and_expands_tabs():
    planned, warnings = mod.discover(
        fake_children, fake_tabs,
        root_folders=[("root", "Finance")],
        exclude_folder_ids=set(),
        exclude_patterns=[],
    )
    assert sorted((p.schema, p.table) for p in planned) == [
        ("finance_invoices", "t2026_q3_feb"),
        ("finance_invoices", "t2026_q3_jan"),
    ]


def test_discover_warns_about_non_native_files_instead_of_skipping_silently():
    _, warnings = mod.discover(
        fake_children, fake_tabs,
        root_folders=[("root", "Finance")],
        exclude_folder_ids=set(),
        exclude_patterns=[],
    )
    assert any("notes.xlsx" in w and "not a native" in w for w in warnings)


def test_discover_honours_folder_exclusions():
    planned, _ = mod.discover(
        fake_children, fake_tabs,
        root_folders=[("root", "Finance")],
        exclude_folder_ids={"f_inv"},
        exclude_patterns=[],
    )
    assert planned == []


def test_discover_honours_filename_patterns():
    planned, _ = mod.discover(
        fake_children, fake_tabs,
        root_folders=[("root", "Finance")],
        exclude_folder_ids=set(),
        exclude_patterns=["2026*"],
    )
    assert planned == []
