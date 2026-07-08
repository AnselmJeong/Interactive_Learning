import json

from bs4 import BeautifulSoup

from preppy.engines.epub_dom import _handle_image, _replace_epub_noteref_links
from preppy.figures.export import FigureExporter
from preppy.inspect import inspect_output
from preppy.markdown.render import html_to_markdown


class _FakeItem:
    def __init__(self, item_type: int, content: bytes = b"") -> None:
        self._item_type = item_type
        self._content = content

    def get_type(self) -> int:
        return self._item_type

    def get_content(self) -> bytes:
        return self._content


class _FakeBook:
    def __init__(self, items: dict[str, _FakeItem]) -> None:
        self._items = items

    def get_item_with_href(self, href: str) -> _FakeItem | None:
        return self._items.get(href)


def test_html_fragment_image_reference_is_skipped() -> None:
    soup = BeautifulSoup(
        '<p><img alt="note" src="part0074_split_060.html#actrade-note-657"/></p>',
        "html.parser",
    )
    book = _FakeBook({"text/part0074_split_060.html": _FakeItem(9, b"<html></html>")})

    outcome = _handle_image(
        soup.find("img"),
        soup,
        book=book,
        doc_href="text/part0074_split_059.html",
        extract_figures=True,
        exporter=FigureExporter(),
        chapter_index=70,
    )

    assert outcome.kind == "skipped"
    assert soup.find("img") is None


def test_epub_noteref_links_are_replaced_before_markdown_conversion() -> None:
    soup = BeautifulSoup(
        '<p>Important!<sup><a href="notes.xhtml#endnote-001" role="doc-noteref">1</a></sup></p>',
        "html.parser",
    )

    _replace_epub_noteref_links(soup)
    markdown = html_to_markdown(str(soup))

    assert "Important![1]" in markdown
    assert "notes.xhtml#endnote-001" not in markdown


def test_broken_markdown_image_link_is_warning(tmp_path) -> None:
    (tmp_path / "chapters").mkdir()
    (tmp_path / "assets").mkdir()
    (tmp_path / "chapters" / "001-intro.md").write_text(
        "# Intro\n\nText is usable.\n\n![note](missing-note-target.html#note-1)\n",
        encoding="utf-8",
    )
    (tmp_path / "figures.json").write_text(json.dumps({"figures": []}), encoding="utf-8")
    (tmp_path / "diagnostics.json").write_text(json.dumps({"errors": []}), encoding="utf-8")
    (tmp_path / "document.json").write_text(json.dumps({"source_type": "epub", "items": []}), encoding="utf-8")
    (tmp_path / "manifest.json").write_text(
        json.dumps(
            {
                "tool_version": "test",
                "source": {
                    "path": "book.epub",
                    "filename": "book.epub",
                    "type": "epub",
                    "sha256": "0" * 64,
                },
                "chapters": [
                    {
                        "index": 1,
                        "title": "Intro",
                        "kind": "chapter",
                        "slug": "intro",
                        "path": "chapters/001-intro.md",
                        "char_count": 42,
                        "boundary_reason": "test",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    report = inspect_output(tmp_path)

    assert report.ok
    assert not report.errors
    assert any("broken image link" in issue.message for issue in report.warnings)
