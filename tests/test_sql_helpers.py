import importlib.util
import sys
from pathlib import Path

import pytest

FLIGHT = Path(__file__).parent.parent / "flights" / "gdrive-sheets-sync" / "flight.py"
_spec = importlib.util.spec_from_file_location("gdrive_sheets_sync", FLIGHT)
mod = importlib.util.module_from_spec(_spec)
# Required: flight.py uses `from __future__ import annotations`, so @dataclass
# resolves its stringified annotations by looking the module up in sys.modules.
# Without this line, exec_module raises AttributeError on PlannedItem.
sys.modules[_spec.name] = mod
_spec.loader.exec_module(mod)


def test_quote_ident_doubles_embedded_quotes():
    assert mod.quote_ident('we"ird') == '"we""ird"'


def test_sql_str_doubles_embedded_apostrophes():
    assert mod.sql_str("O'Brien") == "'O''Brien'"


def test_build_read_sql_quotes_tab_and_sets_all_varchar():
    item = mod.PlannedItem("finance", "budget_q1", "Finance/Budget[Q1]", "abc123", "Q1")
    sql = mod.build_read_sql(item, all_varchar=True)
    assert "read_gsheet('abc123'" in sql
    assert "sheet='Q1'" in sql
    assert "all_varchar=true" in sql


def test_build_read_sql_omits_all_varchar_when_disabled():
    item = mod.PlannedItem("finance", "budget_q1", "Finance/Budget[Q1]", "abc123", "Q1")
    assert "all_varchar" not in mod.build_read_sql(item, all_varchar=False)


def test_build_read_sql_escapes_hostile_tab_and_file_id():
    item = mod.PlannedItem("s", "t", "ref", "a'b", "Q1'); DROP TABLE x; --")
    sql = mod.build_read_sql(item, all_varchar=True)
    assert "read_gsheet('a''b'" in sql
    assert "sheet='Q1''); DROP TABLE x; --'" in sql


def test_sql_str_rejects_non_string():
    with pytest.raises(TypeError):
        mod.sql_str(42)
