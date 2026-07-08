"""HTML-to-Markdown conversion and canonical chapter-heading normalization."""

from __future__ import annotations

import re

from markdownify import ATX, markdownify as _markdownify

from preppy.markdown.clean import collapse_blank_lines

_HEADING_RE = re.compile(r"^(#{1,6})(\s+)(.*)$")
_MARKDOWN_IMAGE_RE = re.compile(r"!\[[^\]]*\]\((?P<target>[^)\s]+)(?:\s+\"[^\"]*\")?\)")
_IMAGE_TARGET_RE = re.compile(
    r"^(?:data:image/|.*\.(?:avif|bmp|gif|jpe?g|png|svg|tiff?|webp)(?:[?#].*)?$)",
    re.IGNORECASE,
)


def html_to_markdown(html: str) -> str:
    markdown = _markdownify(
        html,
        heading_style=ATX,
        bullets="-",
        escape_asterisks=False,
        escape_underscores=False,
        strong_em_symbol="*",
    )
    markdown = _separate_accidental_image_links(markdown)
    return collapse_blank_lines(markdown)


def render_chapter_markdown(title: str, body_markdown: str) -> str:
    """Prepend a canonical ``# title`` H1 and demote any colliding headings.

    Chapter source content (EPUB HTML, Docling text) often already contains a
    heading for the chapter title. Drop that duplicate only when it matches
    the selected chapter title; fallback single-chapter PDF output may start
    with a real section heading such as "Overview" that must be preserved.
    """
    lines = body_markdown.strip("\n").split("\n")

    idx = 0
    while idx < len(lines) and not lines[idx].strip():
        idx += 1
    if idx < len(lines) and _is_duplicate_heading(lines[idx], title):
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


def _is_duplicate_heading(line: str, title: str) -> bool:
    match = _HEADING_RE.match(line)
    if not match:
        return False
    return _normalize_heading_text(match.group(3)) == _normalize_heading_text(title)


def _normalize_heading_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().casefold()


def _separate_accidental_image_links(markdown: str) -> str:
    """Avoid turning punctuation plus a following text link into an image.

    `markdownify` renders `<p>Wow!<a href="note.xhtml">1</a></p>` as
    `Wow![1](note.xhtml)`. That is valid Markdown image syntax even though the
    source HTML contained text followed by a link. Real Preppy figures are
    rewritten to image asset paths before this function runs, so non-image
    targets can be safely separated back into punctuation plus a normal link.
    """

    def replace(match: re.Match[str]) -> str:
        target = match.group("target")
        if _IMAGE_TARGET_RE.match(target):
            return match.group(0)
        return "! " + match.group(0)[1:]

    return _MARKDOWN_IMAGE_RE.sub(replace, markdown)
