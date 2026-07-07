from __future__ import annotations

import pytest

from preppy.split.classify import compile_boundary_pattern


def test_invalid_boundary_pattern_raises_clear_value_error() -> None:
    with pytest.raises(ValueError, match="Invalid chapter boundary regex"):
        compile_boundary_pattern("[")


def test_valid_boundary_pattern_is_case_insensitive() -> None:
    pattern = compile_boundary_pattern(r"^chapter\s+\d+")

    assert pattern is not None
    assert pattern.search("CHAPTER 12")
