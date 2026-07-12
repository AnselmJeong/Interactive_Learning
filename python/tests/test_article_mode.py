from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import pymupdf

from preppy.engines import pdf_docling
from preppy.inspect import inspect_output
from preppy.writers import write_source_pack


@dataclass
class _Label:
    value: str


@dataclass
class _Prov:
    page_no: int
    bbox: object | None = None


class _Item:
    def __init__(
        self,
        label: str,
        text: str | None,
        index: int,
        *,
        page: int = 1,
        level: int = 1,
    ) -> None:
        self.label = _Label(label)
        self.text = text
        self.self_ref = f"#/items/{index}"
        self.prov = [_Prov(page)]
        self.level = level
        self.captions: list[object] = []


class _TableItem(_Item):
    def export_to_markdown(self, *, doc: object) -> str:
        return "| A | B |\n|---|---|\n| 1 | 2 |"

    def caption_text(self, doc: object) -> str:
        return "Table 1. Main result"


class _FakeDocument:
    def __init__(self) -> None:
        self.items = [
            _Item("title", "A Reliable Article Title", 0),
            _Item("text", "Jane Doe; John Roe", 1),
            _Item("text", "Journal of Useful Tests, Volume 12 (2025)", 2),
            _Item("text", "https://doi.org/10.1234/example.42", 3),
            _Item("section_header", "Abstract", 4),
            _Item("text", "This abstract states the contribution precisely.", 5),
            _Item("section_header", "Introduction", 6),
            _Item("text", "Body evidence that must remain.", 7),
            _TableItem("table", None, 8),
            _Item("section_header", "References", 9, page=3),
            _Item("text", "Doe, J. A token-heavy reference.", 10, page=3),
        ]
        self.pictures: list[object] = []
        self.tables = [self.items[8]]
        self.pages: dict[int, object] = {}

    def iterate_items(self, *, with_groups: bool = False):
        return iter((item, item.level) for item in self.items)

    def num_pages(self) -> int:
        return 3


class _Status:
    value = "success"


class _Result:
    status = _Status()

    def __init__(self) -> None:
        self.document = _FakeDocument()


def test_article_mode_keeps_one_unit_removes_references_and_indexes_tables(
    monkeypatch, tmp_path: Path
) -> None:
    pdf = tmp_path / "paper.pdf"
    pdf.write_bytes(b"not-a-real-pdf")
    monkeypatch.setattr(pdf_docling, "_run_docling", lambda *args, **kwargs: _Result())
    monkeypatch.setattr(
        pdf_docling,
        "_pdf_native_metadata",
        lambda path: pdf_docling._NativePdfMetadata(),
    )

    document = pdf_docling.convert(
        pdf,
        document_type="article",
        extract_figures=False,
    )

    assert document.source.document_type == "article"
    assert document.source.title == "A Reliable Article Title"
    assert document.source.authors == ["Jane Doe", "John Roe"]
    assert document.source.year == 2025
    assert document.source.journal == "Journal of Useful Tests"
    assert document.source.doi == "10.1234/example.42"
    assert len(document.chapters) == 1
    assert document.chapters[0].meta.kind == "article"
    assert (
        "This abstract states the contribution precisely."
        in document.chapters[0].markdown
    )
    assert "Body evidence that must remain." in document.chapters[0].markdown
    assert "token-heavy reference" not in document.chapters[0].markdown
    assert document.chapters[0].meta.table_ids == ["tbl-0001"]
    assert document.tables[0].caption == "Table 1. Main result"
    assert document.diagnostics is not None
    assert document.diagnostics.conversion.options["references_removed"] is True

    output = tmp_path / "article-pack"
    write_source_pack(document, output)
    report = inspect_output(output)
    tables = json.loads((output / "tables.json").read_text(encoding="utf-8"))
    manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
    assert report.ok
    assert report.table_count == 1
    assert tables["tables"][0]["id"] == "tbl-0001"
    assert "abstract" not in manifest["source"]

    retained = pdf_docling.convert(
        pdf,
        document_type="article",
        extract_figures=False,
        include_backmatter=True,
    )
    assert "token-heavy reference" in retained.chapters[0].markdown
    assert retained.diagnostics is not None
    assert retained.diagnostics.conversion.options["references_removed"] is False


def test_reference_heading_must_be_late_and_structural() -> None:
    items = [
        pdf_docling._FlatItem(object(), 1, 0, "text", 1, None, "References", "a"),
        pdf_docling._FlatItem(object(), 1, 1, "text", 1, None, "Body", "b"),
        pdf_docling._FlatItem(
            object(), 1, 2, "section_header", 2, None, "References", "c"
        ),
    ]

    assert pdf_docling._find_references_start(items) == 2


def test_nearby_caption_requires_matching_figure_or_table_marker() -> None:
    items = [
        pdf_docling._FlatItem(object(), 1, 0, "text", 1, None, "ordinary prose", "a"),
        pdf_docling._FlatItem(
            object(), 1, 1, "caption", 1, None, "Figure 2. Result", "b"
        ),
        pdf_docling._FlatItem(object(), 1, 2, "picture", 1, None, None, "c"),
    ]
    consumed: set[str] = set()

    caption = pdf_docling._nearby_caption_text(items, items[2], consumed, kind="figure")

    assert caption == "Figure 2. Result"
    assert consumed == {"b"}


def test_pdf_text_layer_recovers_spatial_figure_caption(tmp_path: Path) -> None:
    pdf_path = tmp_path / "caption.pdf"
    with pymupdf.open() as pdf:
        page = pdf.new_page(width=600, height=800)
        page.insert_textbox(
            pymupdf.Rect(100, 510, 500, 570),
            "Figure 7. Caption recovered from the PDF text layer.",
            fontsize=10,
        )
        pdf.save(pdf_path)
    picture = pdf_docling._FlatItem(
        object(),
        1,
        0,
        "picture",
        1,
        [100, 700, 500, 300],
        None,
        "#/pictures/0",
    )

    captions = pdf_docling._pdf_spatial_caption_map(pdf_path, [picture])

    assert captions[0] == "Figure 7. Caption recovered from the PDF text layer."


def test_compound_figure_groups_adjacent_panels_with_one_shared_caption() -> None:
    caption = (
        "Fig. 5. Compound result. Panel A shows one measure. Panel B shows another. "
        "Panel C shows a third. Panel D shows a fourth."
    )
    pictures = [
        pdf_docling._FlatItem(
            object(), 1, 0, "picture", 6, [105, 401, 252, 270], None, "#/pictures/0"
        ),
        pdf_docling._FlatItem(
            object(), 1, 1, "picture", 6, [114, 251, 263, 129], None, "#/pictures/1"
        ),
        pdf_docling._FlatItem(
            object(), 1, 2, "picture", 6, [295, 395, 488, 284], None, "#/pictures/2"
        ),
        pdf_docling._FlatItem(
            object(), 1, 3, "picture", 6, [284, 234, 476, 116], None, "#/pictures/3"
        ),
    ]
    captions = {
        1: (caption, "pdf_text_caption"),
        2: (caption, "docling_caption"),
    }

    groups = pdf_docling._detect_compound_picture_groups(pictures, captions)

    assert len(groups) == 1
    assert groups[0].member_indices == (0, 1, 2, 3)
    assert groups[0].member_refs == tuple(f"#/pictures/{index}" for index in range(4))
    assert groups[0].caption_status == "docling_caption"
    assert groups[0].bbox == [105, 401, 488, 116]


def test_compound_figure_does_not_merge_conflicting_figure_numbers() -> None:
    pictures = [
        pdf_docling._FlatItem(
            object(), 1, 0, "picture", 1, [50, 400, 250, 200], None, "#/pictures/0"
        ),
        pdf_docling._FlatItem(
            object(), 1, 1, "picture", 1, [270, 400, 470, 200], None, "#/pictures/1"
        ),
    ]
    captions = {
        0: ("Fig. 1. First independent figure.", "docling_caption"),
        1: ("Fig. 2. Second independent figure.", "docling_caption"),
    }

    assert pdf_docling._detect_compound_picture_groups(pictures, captions) == []
