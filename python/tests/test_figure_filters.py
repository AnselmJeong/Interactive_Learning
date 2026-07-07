from __future__ import annotations

import io
from types import SimpleNamespace

from bs4 import BeautifulSoup
from PIL import Image

from preppy.engines.epub_dom import _handle_image
from preppy.engines.pdf_docling import _handle_picture
from preppy.figures.export import FigureExporter
from preppy.figures.filters import is_too_small_figure


class _FakeEpubItem:
    def __init__(self, content: bytes) -> None:
        self._content = content

    def get_type(self) -> int:
        return 9

    def get_content(self) -> bytes:
        return self._content


class _FakeBook:
    def __init__(self, content: bytes) -> None:
        self._content = content

    def get_item_with_href(self, href: str) -> _FakeEpubItem | None:  # noqa: ARG002
        return _FakeEpubItem(self._content)


class _FakePicture:
    self_ref = "#/pictures/1"
    prov = []

    def __init__(self, image: Image.Image) -> None:
        self._image = image

    def get_image(self, doc: object) -> Image.Image:  # noqa: ARG002
        return self._image

    def caption_text(self, doc: object) -> str:  # noqa: ARG002
        return "Figure 1. Tiny decorative icon."


def _png(width: int, height: int) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, format="PNG")
    return buffer.getvalue()


def test_size_filter_prefers_pdf_placement_over_pixel_dimensions() -> None:
    assert is_too_small_figure(
        900,
        900,
        bbox=[36.0, 36.0, 84.0, 84.0],
        page_size=(612.0, 792.0),
    )
    assert not is_too_small_figure(
        64,
        64,
        bbox=[72.0, 120.0, 420.0, 360.0],
        page_size=(612.0, 792.0),
    )


def test_size_filter_uses_pixels_when_no_layout_is_available() -> None:
    assert is_too_small_figure(96, 96)
    assert not is_too_small_figure(120, 600)


def test_docling_picture_handler_skips_tiny_figures() -> None:
    outcome = _handle_picture(
        _FakePicture(Image.new("RGB", (64, 64), "white")),  # type: ignore[arg-type]
        doc=SimpleNamespace(pages={}),
        exporter=FigureExporter(),
        extract_figures=True,
        chapter_index=1,
    )

    assert outcome.kind == "skipped"
    assert outcome.asset is None
    assert outcome.markdown is None


def test_epub_image_handler_skips_tiny_figures() -> None:
    soup = BeautifulSoup('<p><img alt="decorative" src="../images/icon.png"/></p>', "html.parser")

    outcome = _handle_image(
        soup.find("img"),
        soup,
        book=_FakeBook(_png(64, 64)),  # type: ignore[arg-type]
        doc_href="text/chapter.xhtml",
        extract_figures=True,
        exporter=FigureExporter(),
        chapter_index=1,
    )

    assert outcome.kind == "skipped"
    assert soup.find("img") is None
