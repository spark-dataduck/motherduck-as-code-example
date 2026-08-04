import importlib.util
import sys
from pathlib import Path

import pytest

FLIGHT = Path(__file__).parent.parent / "flights" / "gdrive-sheets-sync" / "flight.py"
_spec = importlib.util.spec_from_file_location("gdrive_sheets_sync", FLIGHT)
mod = importlib.util.module_from_spec(_spec)
# Register before exec: flight.py uses `from __future__ import annotations`, and
# a frozen dataclass under that needs to resolve its (stringified) annotations
# by looking the module up in sys.modules. Skipping this raises AttributeError
# on Python 3.10+. This is the standard pattern from the importlib docs.
sys.modules[_spec.name] = mod
_spec.loader.exec_module(mod)


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("Faktury 2026", "faktury_2026"),
        ("Cash-flow (final)", "cash_flow_final"),
        ("Přehled", "prehled"),          # NFKD-folded, not dropped
        ("  Budget  ", "budget"),
        ("!!!", "unnamed"),              # never returns empty
        ("Q3__2026", "q3_2026"),         # runs collapse
    ],
)
def test_slugify(raw, expected):
    assert mod.slugify(raw) == expected


def test_resolve_schema_flattens_nesting():
    assert mod.resolve_schema(["Finance", "Invoices"]) == "finance_invoices"


def test_resolve_schema_prefixes_leading_digit_with_d():
    assert mod.resolve_schema(["1"]) == "d1"


def test_resolve_table_prefixes_leading_digit_with_t():
    assert mod.resolve_table("2026 Q3", "Jan") == "t2026_q3_jan"


def test_resolve_table_always_appends_tab():
    assert mod.resolve_table("Campaigns", "List1") == "campaigns_list1"


def test_detect_collisions_reports_only_duplicates():
    items = [
        mod.PlannedItem("finance", "budget_q1", "Finance/Budget[Q1]", "id1", "Q1"),
        mod.PlannedItem("finance", "budget_q1", "Finance/Budget Q1[Sheet1]", "id2", "Sheet1"),
        mod.PlannedItem("finance", "payroll_jan", "Finance/Payroll[Jan]", "id3", "Jan"),
    ]
    collisions = mod.detect_collisions(items)
    assert list(collisions) == [("finance", "budget_q1")]
    assert len(collisions[("finance", "budget_q1")]) == 2
