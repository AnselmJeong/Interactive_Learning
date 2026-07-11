"""Regression tests for PDF boundary detection edge cases."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from preppy.engines.pdf_docling import (
    _FlatItem,
    _build_outline_tree,
    _detect_candidates,
    _enrich_with_outline,
    _next_outline_matter_index,
    _running_heading_refs,
    _select_outline_units,
)
from preppy.models import SourceLocator
from preppy.split.plan import SplitCandidate, apply_matter_flags


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


def test_outline_tree_selects_chapters_below_part_containers() -> None:
    outline = [
        (1, "Contents", 3),
        (1, "I: Foundations", 10),
        (2, "1. First Chapter", 12),
        (2, "2. Second Chapter", 30),
        (1, "II: Applications", 50),
        (2, "3. Third Chapter", 52),
        (2, "4. Fourth Chapter", 70),
        (1, "Notes", 90),
    ]

    nodes = _build_outline_tree(outline, num_pages=100)
    selected = _select_outline_units(nodes)

    assert [nodes[index].title for index in selected] == [
        "1. First Chapter",
        "2. Second Chapter",
        "3. Third Chapter",
        "4. Fourth Chapter",
    ]


def test_outline_chapters_override_docling_parts_and_numbered_notes() -> None:
    flat_items = [
        _heading(0, 10, "I", [40.0, 500.0, 100.0, 480.0]),
        _heading(1, 10, "Foundations", [40.0, 450.0, 200.0, 430.0]),
        _heading(2, 12, "1", [40.0, 500.0, 100.0, 480.0]),
        _heading(3, 12, "F I R S T C H A P T E R", [40.0, 450.0, 300.0, 430.0]),
        _heading(4, 30, "2. SECOND CHAPTER", [40.0, 500.0, 300.0, 480.0]),
        _heading(5, 90, "1. FIRST CHAPTER", [40.0, 500.0, 300.0, 480.0]),
    ]
    candidates = [
        SplitCandidate(
            id=index + 1,
            order=index + 1,
            title=item.text or "",
            kind="chapter",
            reason="docling-section-header",
            selected=True,
            heading_level=1,
            source_locator=SourceLocator(page_start=item.page_no),
            pdf_item_index=item.index,
        )
        for index, item in enumerate(flat_items)
    ]
    outline = [
        (1, "I: Foundations", 10),
        (2, "1. First Chapter\x00", 12),
        (2, "2. Second Chapter", 30),
        (1, "Notes", 90),
    ]

    _enrich_with_outline(candidates, outline, flat_items=flat_items, num_pages=100)
    selected = [candidate for candidate in candidates if candidate.selected]

    assert [candidate.title for candidate in selected] == [
        "1. First Chapter",
        "2. Second Chapter",
    ]
    assert all(candidate.reason == "pdf-outline-chapter" for candidate in selected)
    assert selected[0].outline_level == 2
    assert selected[0].parent_title == "I: Foundations"
    assert selected[0].pdf_item_index == 2
    assert selected[0].pdf_content_start_index == 0
    assert all(candidate.source_locator.page_start != 90 for candidate in selected)


def test_oversized_content_node_descends_to_outline_sections() -> None:
    outline = [
        (1, "Chapter 1: A Very Large Subject", 1),
        (2, "Origins", 10),
        (2, "Development", 60),
        (2, "Consequences", 110),
        (1, "Chapter 2: Short", 150),
    ]

    nodes = _build_outline_tree(outline, num_pages=170)
    selected = _select_outline_units(nodes)

    assert [nodes[index].title for index in selected] == [
        "Origins",
        "Development",
        "Consequences",
        "Chapter 2: Short",
    ]


def test_outline_matter_is_a_hard_stop_after_last_selected_chapter() -> None:
    candidates = [
        SplitCandidate(
            id=1,
            order=1,
            title="9. Last Chapter",
            kind="chapter",
            reason="pdf-outline-chapter",
            selected=True,
            pdf_item_index=100,
        ),
        SplitCandidate(
            id=2,
            order=2,
            title="Acknowledgments",
            kind="backmatter",
            reason="pdf-outline-matter",
            selected=False,
            pdf_item_index=140,
            pdf_content_start_index=140,
        ),
    ]

    assert _next_outline_matter_index(candidates, after_index=100) == 140
    assert _next_outline_matter_index(candidates, after_index=140) is None


def test_apply_matter_flags_prefers_outline_candidates_and_all_backmatter_kinds() -> None:
    docling_preface = SplitCandidate(
        id=1,
        order=1,
        title="Preface",
        kind="frontmatter",
        reason="docling-section-header",
        selected=False,
    )
    outline_preface = SplitCandidate(
        id=2,
        order=2,
        title="Preface",
        kind="frontmatter",
        reason="pdf-outline-matter",
        selected=False,
    )
    outline_notes = SplitCandidate(
        id=3,
        order=3,
        title="Notes",
        kind="notes",
        reason="pdf-outline-matter",
        selected=False,
    )
    outline_index = SplitCandidate(
        id=4,
        order=4,
        title="Index",
        kind="index",
        reason="pdf-outline-matter",
        selected=False,
    )

    candidates = [docling_preface, outline_preface, outline_notes, outline_index]
    apply_matter_flags(candidates, include_frontmatter=True, include_backmatter=True)

    assert docling_preface.selected is False
    assert outline_preface.selected is True
    assert outline_notes.selected is True
    assert outline_index.selected is True
