"""Shared, editable chapter split-plan schema used by both the EPUB and PDF engines.

`preppy plan` writes a :class:`SplitPlan` to disk so an author can flip
`selected`/`kind` before running `preppy build --plan`. The same schema is
produced internally by `build()` when no `--plan` is supplied, so there is a
single code path for "detect boundaries" regardless of whether the result is
shown to a user or consumed immediately.
"""

from __future__ import annotations

import json
from pathlib import Path

from pydantic import Field

from preppy.models import ChapterKind, PreppyModel, SourceLocator, SourceType


class SplitCandidate(PreppyModel):
    id: int
    order: int
    title: str
    kind: ChapterKind
    reason: str
    confidence: float = 1.0
    selected: bool = False
    # Semantic heading depth (1 = top-level chapter, 2 = section, 3 =
    # subsection, ...), when it could be determined. EPUB reads this from the
    # target node's actual h1-h6 tag; PDF reads it from Docling's
    # SectionHeaderItem.level. Only candidates at the shallowest level found
    # in a document are auto-selected as chapters; deeper ones stay in the
    # plan, unselected, so a reviewer can promote a specific section by hand.
    heading_level: int | None = None
    # Hierarchy supplied by a PDF outline. This is intentionally separate
    # from ``heading_level`` because Docling's visual heading depth and the
    # PDF outline depth can disagree.
    outline_level: int | None = None
    parent_title: str | None = None
    source_locator: SourceLocator = Field(default_factory=SourceLocator)
    # EPUB-only bookkeeping: which spine document and child-node offset the
    # boundary starts at, so a re-loaded plan can be re-applied deterministically
    # even when there is no anchor id to search for.
    epub_start_idx: int | None = None
    # PDF-only bookkeeping: position of the boundary in the flattened Docling
    # reading-order item stream, so a re-loaded plan can be re-sliced without
    # re-running boundary detection.
    pdf_item_index: int | None = None
    # A container divider (Part / Book / Unit) may precede the first child
    # chapter. Its short prelude belongs with that child without turning the
    # entire container into one giant chapter.
    pdf_content_start_index: int | None = None


class SplitPlan(PreppyModel):
    schema_version: int = 1
    source_path: str
    source_type: SourceType
    title: str
    author: str | None = None
    language: str | None = None
    boundary_pattern: str | None = None
    candidates: list[SplitCandidate] = Field(default_factory=list)


def save_plan(plan: SplitPlan, path: Path) -> None:
    path.write_text(plan.model_dump_json(indent=2) + "\n", encoding="utf-8")


def load_plan(path: Path) -> SplitPlan:
    data = json.loads(path.read_text(encoding="utf-8"))
    return SplitPlan.model_validate(data)


def apply_matter_flags(
    candidates: list[SplitCandidate], *, include_frontmatter: bool, include_backmatter: bool
) -> None:
    """Opt frontmatter/backmatter candidates into ``selected`` when requested.

    Only ever turns ``selected`` on, never off. This keeps `--plan`'s
    boundaries authoritative (a hand-reviewed plan that already selected a
    frontmatter chapter is never silently overridden) while still letting
    ``--include-frontmatter``/``--include-backmatter`` loosen the default
    auto-detected selection.
    """
    has_outline_matter = any(candidate.reason == "pdf-outline-matter" for candidate in candidates)
    for candidate in candidates:
        outline_authoritative = not has_outline_matter or candidate.reason == "pdf-outline-matter"
        if include_frontmatter and candidate.kind == "frontmatter" and outline_authoritative:
            candidate.selected = True
        if (
            include_backmatter
            and candidate.kind in {"backmatter", "notes", "bibliography", "index"}
            and outline_authoritative
        ):
            candidate.selected = True


def demote_nested_headings(
    candidates: list[SplitCandidate], *, reasons: set[str], demoted_reason: str
) -> None:
    """Auto-select only the shallowest heading level among matching candidates.

    Candidates whose ``reason`` is in ``reasons`` and whose ``heading_level``
    is deeper than the minimum level found among them are unselected and
    re-tagged with ``demoted_reason``. This keeps a flat or ambiguously
    nested TOC/heading list from turning every subsection into its own
    top-level chapter by default; deeper candidates remain in the plan for a
    reviewer to select by hand.
    """
    scoped = [c for c in candidates if c.reason in reasons and c.heading_level is not None]
    if not scoped:
        return
    min_level = min(c.heading_level for c in scoped)
    for candidate in scoped:
        if candidate.heading_level > min_level:
            candidate.selected = False
            candidate.reason = demoted_reason
            candidate.confidence = min(candidate.confidence, 0.5)
