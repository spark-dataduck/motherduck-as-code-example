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


class _Exec:
    def __init__(self, payload):
        self._payload = payload

    def execute(self):
        return self._payload


class _FakeFiles:
    def __init__(self, pages=None, get_result=None):
        self._pages = list(pages or [])
        self._get_result = get_result
        self.list_calls = []

    def list(self, **kwargs):
        self.list_calls.append(kwargs)
        return _Exec(self._pages.pop(0))

    def get(self, **kwargs):
        return _Exec(self._get_result)


class _FakeDrive:
    def __init__(self, files):
        self._files = files

    def files(self):
        return self._files


class _FakeSpreadsheets:
    def __init__(self, get_result):
        self._get_result = get_result

    def get(self, **kwargs):
        return _Exec(self._get_result)


class _FakeSheets:
    def __init__(self, spreadsheets):
        self._spreadsheets = spreadsheets

    def spreadsheets(self):
        return self._spreadsheets


def test_drive_lister_paginates_until_no_next_page_token():
    files = _FakeFiles(
        pages=[
            {"nextPageToken": "p2", "files": [{"id": "a", "name": "A", "mimeType": SHEET}]},
            {"files": [{"id": "b", "name": "B", "mimeType": SHEET}]},
        ]
    )
    drive = _FakeDrive(files)

    result = mod.drive_lister(drive)("f")

    assert result == [
        {"id": "a", "name": "A", "mimeType": SHEET},
        {"id": "b", "name": "B", "mimeType": SHEET},
    ]
    assert len(files.list_calls) == 2
    assert files.list_calls[1]["pageToken"] == "p2"


def test_drive_lister_sends_shared_drive_flags():
    files = _FakeFiles(pages=[{"files": []}])
    drive = _FakeDrive(files)

    mod.drive_lister(drive)("f")

    assert files.list_calls[0]["supportsAllDrives"] is True
    assert files.list_calls[0]["includeItemsFromAllDrives"] is True


def test_sheets_tab_lister_returns_tab_titles():
    spreadsheets = _FakeSpreadsheets(
        get_result={
            "sheets": [
                {"properties": {"title": "Jan"}},
                {"properties": {"title": "Feb"}},
            ]
        }
    )
    sheets = _FakeSheets(spreadsheets)

    assert mod.sheets_tab_lister(sheets)("s1") == ["Jan", "Feb"]


def test_folder_name_rejects_a_non_folder():
    files = _FakeFiles(get_result={"name": "Finance", "mimeType": FOLDER})
    drive = _FakeDrive(files)
    assert mod.folder_name(drive, "f") == "Finance"

    files = _FakeFiles(get_result={"name": "2026 Q3", "mimeType": SHEET})
    drive = _FakeDrive(files)
    try:
        mod.folder_name(drive, "s1")
    except RuntimeError:
        pass
    else:
        raise AssertionError("expected RuntimeError for a non-folder mimeType")
