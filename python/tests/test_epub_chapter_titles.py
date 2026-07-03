from pathlib import Path

from ebooklib import epub

from preppy.engines import epub_dom


def _numbered_heading_epub(tmp_path: Path) -> Path:
    book = epub.EpubBook()
    book.set_identifier("numbered-heading-test")
    book.set_title("Numbered Heading Test Book")
    book.set_language("en")
    book.add_author("Test Author")

    doc = epub.EpubHtml(title="Body", file_name="body.xhtml", lang="en")
    doc.content = (
        "<html><body>"
        "<h1>1</h1>"
        "<h1>The Straight Path Philosophy and Islam</h1>"
        "<p>Intro text for a numbered-heading chapter, long enough to be meaningful for testing.</p>"
        "</body></html>"
    )
    book.add_item(doc)

    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    book.spine = ["nav", doc]

    path = tmp_path / "numbered_heading.epub"
    epub.write_epub(str(path), book)
    return path


def test_numbered_spine_document_uses_nearby_title_heading(tmp_path: Path) -> None:
    source = _numbered_heading_epub(tmp_path)

    plan = epub_dom.build_plan(source)
    document = epub_dom.convert(source, plan)
    chapter = document.chapters[0]

    assert chapter.meta.title == "1 The Straight Path Philosophy and Islam"
    assert chapter.meta.path == "chapters/001-1-the-straight-path-philosophy-and-islam.md"
    assert chapter.markdown.startswith("# 1 The Straight Path Philosophy and Islam\n\nIntro text")
    assert [item.text for item in document.document_model.items] == [
        "1 The Straight Path Philosophy and Islam"
    ]


def test_legacy_numeric_plan_title_is_refined_from_chapter_headings(tmp_path: Path) -> None:
    source = _numbered_heading_epub(tmp_path)

    plan = epub_dom.build_plan(source)
    plan.candidates[0].title = "1"
    document = epub_dom.convert(source, plan)

    assert document.chapters[0].meta.title == "1 The Straight Path Philosophy and Islam"
    assert document.chapters[0].meta.slug == "1-the-straight-path-philosophy-and-islam"
