"""Tests for canonical chapter Markdown rendering."""

from __future__ import annotations

from preppy.markdown.render import render_chapter_markdown


def test_render_chapter_markdown_drops_duplicate_leading_heading() -> None:
    rendered = render_chapter_markdown("Chapter One", "# Chapter One\n\nBody")

    assert rendered == "# Chapter One\n\nBody\n"


def test_render_chapter_markdown_preserves_distinct_leading_heading() -> None:
    rendered = render_chapter_markdown("extract", "## OVERVIEW\n\nBody")

    assert rendered == "# extract\n\n## OVERVIEW\n\nBody\n"
