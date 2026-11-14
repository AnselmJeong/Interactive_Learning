from pathlib import Path

from bs4 import BeautifulSoup
from ebooklib import epub

from preppy.engines.epub_dom import build_plan, convert
from preppy.writers import write_source_pack


def test_epub_html_sidecar_preserves_semantics(tmp_path: Path) -> None:
    book = epub.EpubBook()
    book.set_identifier("html-test")
    book.set_title("Test book")
    book.set_language("en")
    chapter = epub.EpubHtml(title="Chapter", file_name="chapter.xhtml")
    chapter.content = '<h1>Chapter</h1><p>A <em>precise</em> term: H<sub>2</sub>O.</p><table><tr><td colspan="2">Shared cell</td></tr></table>'
    book.add_item(chapter)
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    book.toc = [epub.Link("chapter.xhtml", "Chapter", "chapter")]
    book.spine = [chapter]
    path = tmp_path / "test.epub"
    epub.write_epub(str(path), book)
    result = convert(path, build_plan(path), min_chapter_chars=0)
    output = tmp_path / "output"
    write_source_pack(result, output)
    html = list((output / "chapters").glob("*.html"))
    assert len(html) == 1
    soup = BeautifulSoup(html[0].read_text(), "html.parser")
    assert soup.em.get_text() == "precise"
    assert soup.sub.get_text() == "2"
    assert soup.td["colspan"] == "2"
    assert list((output / "chapters").glob("*.md"))
