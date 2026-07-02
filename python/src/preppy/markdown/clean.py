"""Markdown/text cleanup: blank-line collapsing and repeated running-header removal."""

from __future__ import annotations

import re
from collections import Counter

_BLANK_RUN_RE = re.compile(r"\n{3,}")
_PAGE_NUMBER_LINE_RE = re.compile(r"^\s*(page\s+)?[\divxlcdm]{1,6}\s*$", re.IGNORECASE)


def collapse_blank_lines(text: str) -> str:
    return _BLANK_RUN_RE.sub("\n\n", text).strip()


def strip_page_number_lines(text: str) -> str:
    lines = [line for line in text.split("\n") if not _PAGE_NUMBER_LINE_RE.match(line)]
    return "\n".join(lines)


def normalize_line(line: str) -> str:
    return re.sub(r"\s+", " ", line).strip()


def find_repeated_lines(
    page_lines: list[list[str]], *, min_pages: int = 4, min_ratio: float = 0.6
) -> set[str]:
    """Detect lines that repeat across many pages: running headers/footers/titles."""
    if len(page_lines) < min_pages:
        return set()
    counts: Counter[str] = Counter()
    for lines in page_lines:
        seen = {normalize_line(line) for line in lines if line.strip()}
        counts.update(seen)
    threshold = max(min_pages, int(len(page_lines) * min_ratio))
    return {line for line, count in counts.items() if line and count >= threshold}
