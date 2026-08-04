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


def test_env_bool_returns_default_when_unset(monkeypatch):
    monkeypatch.delenv("FLAG", raising=False)
    assert mod._env_bool("FLAG", True) is True
    assert mod._env_bool("FLAG", False) is False


def test_env_bool_returns_default_when_empty(monkeypatch):
    monkeypatch.setenv("FLAG", "")
    assert mod._env_bool("FLAG", True) is True


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("on", True),
        ("off", False),
        ("TRUE", True),
        ("no", False),
    ],
)
def test_env_bool_parses_recognized_values(monkeypatch, raw, expected):
    monkeypatch.setenv("FLAG", raw)
    assert mod._env_bool("FLAG", False) is expected


def test_env_bool_raises_on_unrecognized_value(monkeypatch):
    monkeypatch.setenv("FLAG", "maybe")
    with pytest.raises(RuntimeError):
        mod._env_bool("FLAG", False)


def test_env_str_list_raises_for_json_string_not_array(monkeypatch):
    monkeypatch.setenv("IDS", '"abc"')
    with pytest.raises(RuntimeError):
        mod._env_str_list("IDS", [])


def test_env_str_list_raises_for_non_string_members(monkeypatch):
    monkeypatch.setenv("IDS", "[1,2]")
    with pytest.raises(RuntimeError):
        mod._env_str_list("IDS", [])


def test_env_str_list_returns_list_for_valid_input(monkeypatch):
    monkeypatch.setenv("IDS", '["a","b"]')
    assert mod._env_str_list("IDS", []) == ["a", "b"]


def test_env_int_raises_naming_the_key(monkeypatch):
    monkeypatch.setenv("MAX_ATTEMPTS", "abc")
    with pytest.raises(RuntimeError, match="MAX_ATTEMPTS"):
        mod._env_int("MAX_ATTEMPTS", 5)
