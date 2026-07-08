"""Tests for canonical chapter Markdown rendering."""

from __future__ import annotations

from preppy.markdown.render import html_to_markdown, render_chapter_markdown


def test_render_chapter_markdown_drops_duplicate_leading_heading() -> None:
    rendered = render_chapter_markdown("Chapter One", "# Chapter One\n\nBody")

    assert rendered == "# Chapter One\n\nBody\n"


def test_render_chapter_markdown_preserves_distinct_leading_heading() -> None:
    rendered = render_chapter_markdown("extract", "## OVERVIEW\n\nBody")

    assert rendered == "# extract\n\n## OVERVIEW\n\nBody\n"


def test_html_to_markdown_separates_exclamation_from_following_text_link() -> None:
    rendered = html_to_markdown('<p>Important!<a href="notes.xhtml#note-1">1</a></p>')

    assert "Important! [1](notes.xhtml#note-1)" in rendered
    assert "Important![1](notes.xhtml#note-1)" not in rendered


def test_html_to_markdown_keeps_real_image_links() -> None:
    rendered = html_to_markdown('<p><img src="../assets/fig-0001.jpg" alt="Map"/></p>')

    assert "![Map](../assets/fig-0001.jpg)" in rendered
