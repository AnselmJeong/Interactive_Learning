"""Title-based chapter-kind classification shared by the EPUB and PDF engines."""

from __future__ import annotations

import re
from pathlib import PurePosixPath

from preppy.models import ChapterKind

FRONTMATTER_KEYWORDS = {
    "cover",
    "title page",
    "half title",
    "series page",
    "copyright",
    "contents",
    "table of contents",
    "toc",
    "epigraph",
    "dedication",
    "preface",
    "introduction",
    "foreword",
    "prologue",
}

NOTES_KEYWORDS = {"notes", "endnotes", "footnotes"}
BIBLIOGRAPHY_KEYWORDS = {"bibliography", "references", "works cited"}
INDEX_KEYWORDS = {"index"}
BACKMATTER_KEYWORDS = {
    "acknowledgments",
    "acknowledgements",
    "glossary",
    "about the author",
    "afterword",
    "back cover",
    "colophon",
}

_FRONTMATTER_STEM_PREFIXES = (
    "00_cover",
    "01_fm",
    "02_fm",
    "03_fm",
    "04_fm",
    "05_fm",
    "06_fm",
    "07_toc",
)
_BACKMATTER_STEM_PREFIXES = (
    "17_bm",
    "18_bm",
    "19_bm",
    "20_bm",
    "21_bm",
    "22_bbcover",
)


# `^\d+\.(?!\d)` deliberately excludes dotted multi-level numbering like
# "1.2" or "1.2.1" (a subsection), while still matching a bare top-level
# "1. Title" or "1 Title". Without the negative lookahead, `^\d+[.\s]`
# matches the "1." prefix of *any* numbered heading regardless of depth.
DEFAULT_CHAPTER_PATTERN = re.compile(
    r"^(chapter|part|book)\b|^\d+\s|^\d+\.(?!\d)|^[ivxlcdm]+[.\s]", re.IGNORECASE
)


def compile_boundary_pattern(boundary_pattern: str | None) -> re.Pattern[str] | None:
    if not boundary_pattern:
        return None
    try:
        return re.compile(boundary_pattern, re.IGNORECASE)
    except re.error as exc:
        raise ValueError(f"Invalid chapter boundary regex {boundary_pattern!r}: {exc}") from exc


def normalize_title(value: str | None) -> str:
    if not value:
        return ""
    value = re.sub(r"\s+", " ", value).strip()
    value = re.sub(r"\s*[|/]+\s*", " ", value)
    return value.strip()


def classify_kind(
    title: str,
    source_path: str | None = None,
    *,
    unmatched: ChapterKind = "chapter",
) -> ChapterKind:
    """Classify a boundary title into a :class:`ChapterKind`.

    ``unmatched`` controls what is returned when no keyword or filename
    heuristic matches. EPUB TOC/spine boundaries are structurally reliable,
    so callers there should keep the default ``"chapter"``. PDF heading
    heuristics are noisier, so the PDF engine passes ``unmatched="unknown"``.
    """
    norm = normalize_title(title).casefold()
    stem = PurePosixPath(source_path).stem.casefold() if source_path else ""

    if norm in INDEX_KEYWORDS:
        return "index"
    if norm in BIBLIOGRAPHY_KEYWORDS:
        return "bibliography"
    if norm in NOTES_KEYWORDS:
        return "notes"
    if norm.startswith("appendix"):
        return "appendix"
    if norm in FRONTMATTER_KEYWORDS:
        return "frontmatter"
    if norm in BACKMATTER_KEYWORDS:
        return "backmatter"
    if stem.startswith(_FRONTMATTER_STEM_PREFIXES):
        return "frontmatter"
    if stem.startswith(_BACKMATTER_STEM_PREFIXES):
        return "backmatter"
    return unmatched


def is_chapter_like(title: str, boundary_pattern: re.Pattern[str] | None = None) -> bool:
    """Whether a heading looks like the start of a numbered chapter/part."""
    norm = normalize_title(title)
    if boundary_pattern is not None and boundary_pattern.search(norm):
        return True
    return bool(DEFAULT_CHAPTER_PATTERN.search(norm))


def fallback_title(file_name: str, index: int) -> str:
    stem = PurePosixPath(file_name).stem.replace("_", " ").replace("-", " ")
    stem = normalize_title(stem)
    return stem.title() or f"Section {index}"
