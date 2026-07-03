"""Regression tests for PDF boundary detection edge cases."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from preppy.engines.pdf_docling import _FlatItem, _detect_candidates, _running_heading_refs


class _Doc:
    name = "sample"
    pages = {
        1: SimpleNamespace(size=SimpleNamespace(height=700.0)),
        2: SimpleNamespace(size=SimpleNamespace(height=700.0)),
    }

    def iterate_items(self, with_groups: bool = False):  # noqa: ARG002
        return iter(())

    def num_pages(self) -> int:
        return len(self.pages)


def _heading(index: int, page: int, text: str, bbox: list[float]) -> _FlatItem:
    item = SimpleNamespace(level=1)
    return _FlatItem(
        item=item,
        level=1,
        index=index,
        label="section_header",
        page_no=page,
        bbox=bbox,
        text=text,
        self_ref=f"#/texts/{index}",
    )


def test_repeated_edge_heading_is_demoted_from_pdf_chapter_boundary() -> None:
    doc = _Doc()
    flat_items = [
        _heading(0, 1, "2 Neurotransmitters and Receptors", [42.0, 670.0, 180.0, 660.0]),
        _heading(1, 1, "2.1 Real Section", [42.0, 500.0, 180.0, 480.0]),
        _heading(2, 2, "2 Neurotransmitters and Receptors", [42.0, 670.0, 180.0, 660.0]),
    ]

    running_refs = _running_heading_refs(flat_items, doc)  # type: ignore[arg-type]
    candidates = _detect_candidates(flat_items, None, Path("sample.pdf"), doc, running_refs)  # type: ignore[arg-type]

    repeated = [c for c in candidates if c.title == "2 Neurotransmitters and Receptors"]
    assert repeated
    assert all(c.reason == "running-header" for c in repeated)
    assert all(c.selected is False for c in repeated)
    assert all(c.confidence == 0.2 for c in repeated)

    fallback = candidates[-1]
    assert fallback.reason == "fallback-single-chapter"
    assert fallback.selected is True
    assert fallback.pdf_item_index == 0


def test_repeated_non_edge_headings_are_not_running_headers() -> None:
    doc = _Doc()
    flat_items = [
        _heading(0, 1, "OVERVIEW", [60.0, 510.0, 120.0, 495.0]),
        _heading(1, 2, "OVERVIEW", [60.0, 510.0, 120.0, 495.0]),
    ]

    assert _running_heading_refs(flat_items, doc) == set()  # type: ignore[arg-type]
