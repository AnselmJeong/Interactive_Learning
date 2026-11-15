"""Chapter HTML must cover the same items as the chapter Markdown.

Docling counts groups and the text nested inside pictures (axis labels,
legends) when slicing ``export_to_html``. Preppy's flat item indexes skip
those, so passing them through unchanged truncated figure-heavy chapters.
"""

from __future__ import annotations

from docling_core.types.doc import DocItemLabel, GroupLabel
from docling_core.types.doc.document import DoclingDocument

from preppy.engines import pdf_docling


def _figure_heavy_document() -> DoclingDocument:
    doc = DoclingDocument(name="figure-heavy")
    doc.add_heading("Section one", level=1)
    doc.add_text(label=DocItemLabel.TEXT, text="Intro paragraph.")
    for figure_no in range(1, 4):
        picture = doc.add_picture()
        for label_no in range(6):
            doc.add_text(
                label=DocItemLabel.TEXT,
                text=f"axis label {figure_no}.{label_no}",
                parent=picture,
            )
        doc.add_text(label=DocItemLabel.TEXT, text=f"After figure {figure_no}.")
    doc.add_heading("Section two", level=1)
    group = doc.add_group(label=GroupLabel.LIST)
    doc.add_list_item(text="First list item", parent=group)
    doc.add_text(label=DocItemLabel.TEXT, text="Closing paragraph.")
    return doc


def test_html_bounds_cover_the_flat_item_interval() -> None:
    doc = _figure_heavy_document()
    flat = pdf_docling._flatten(doc)
    bounds = pdf_docling._html_element_bounds(doc, flat)
    assert len(bounds) == len(flat) + 1

    whole = doc.export_to_html(from_element=bounds[0], to_element=bounds[len(flat)])
    for text in ("After figure 3.", "Section two", "First list item", "Closing paragraph."):
        assert text in whole

    # The raw flat index would have stopped long before the end of the
    # document, which is exactly the truncation users saw.
    truncated = doc.export_to_html(from_element=0, to_element=len(flat))
    assert "Closing paragraph." not in truncated


def test_html_bounds_split_chapters_without_loss_or_overlap() -> None:
    doc = _figure_heavy_document()
    flat = pdf_docling._flatten(doc)
    bounds = pdf_docling._html_element_bounds(doc, flat)
    split = next(item.index for item in flat if item.text == "Section two")

    first = doc.export_to_html(from_element=bounds[0], to_element=bounds[split])
    second = doc.export_to_html(from_element=bounds[split], to_element=bounds[len(flat)])

    assert "After figure 3." in first
    assert "Section two" not in first
    assert "Section two" in second
    assert "First list item" in second
    assert "Closing paragraph." in second
    assert "After figure 3." not in second


def test_chapter_html_links_pictures_to_exported_assets() -> None:
    doc = _figure_heavy_document()
    flat = pdf_docling._flatten(doc)
    bounds = pdf_docling._html_element_bounds(doc, flat)
    pictures = [item for item in flat if item.label == "picture"]
    links = {
        pictures[0].self_ref: "../assets/fig-0001.png",
        pictures[2].self_ref: "../assets/fig-0002.png",
    }

    html = pdf_docling._export_chapter_html(
        doc,
        from_element=bounds[0],
        to_element=bounds[len(flat)],
        picture_links=links,
        slice_items=flat,
    )

    assert html.count("<img") == 2
    assert 'src="../assets/fig-0001.png"' in html
    assert 'src="../assets/fig-0002.png"' in html
    assert html.index("fig-0001.png") < html.index("After figure 1.")
    assert html.index("After figure 2.") < html.index("fig-0002.png")
    # The document is restored for the later JSON export.
    assert all(picture.item.image is None for picture in pictures)
