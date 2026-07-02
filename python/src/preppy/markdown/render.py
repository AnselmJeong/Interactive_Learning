"""HTML-to-Markdown conversion and canonical chapter-heading normalization."""

from __future__ import annotations

import re

from markdownify import ATX, markdownify as _markdownify

from preppy.markdown.clean import collapse_blank_lines

_HEADING_RE = re.compile(r"^(#{1,6})(\s+)(.*)$")


def html_to_markdown(html: str) -> str:
    markdown = _markdownify(
        html,
        heading_style=ATX,
        bullets="-",
        escape_asterisks=False,
        escape_underscores=False,
        strong_em_symbol="*",
    )
    return collapse_blank_lines(markdown)


def render_chapter_markdown(title: str, body_markdown: str) -> str:
    """Prepend a canonical ``# title`` H1 and demote any colliding headings.

    Chapter source content (EPUB HTML, Docling text) often already contains
    a heading for the chapter title. Rather than trust it to match exactly,
    we drop a leading heading line and always emit our own H1, shifting any
    remaining headings down so nothing else in the body is also H1.
    """
    lines = body_markdown.strip("\n").split("\n")

    idx = 0
    while idx < len(lines) and not lines[idx].strip():
        idx += 1
    if idx < len(lines) and _HEADING_RE.match(lines[idx]):
        lines = lines[idx + 1 :]
    else:
        lines = lines[idx:]

    heading_levels = [len(m.group(1)) for line in lines if (m := _HEADING_RE.match(line))]
    if heading_levels and min(heading_levels) < 2:
        shift = 2 - min(heading_levels)
        lines = [_shift_heading(line, shift) for line in lines]

    body = "\n".join(lines).strip("\n")
    header = f"# {title.strip()}"
    combined = f"{header}\n\n{body}" if body else header
    return collapse_blank_lines(combined) + "\n"


def _shift_heading(line: str, shift: int) -> str:
    match = _HEADING_RE.match(line)
    if not match:
        return line
    level = min(6, len(match.group(1)) + shift)
    return f"{'#' * level}{match.group(2)}{match.group(3)}"
