"""PDF engine: Docling structured document model drives chapter detection,
figure extraction, and caption pairing (PRD section 11 / IMPLEMENTATION_PLAN
section 7). PDF outline/bookmarks (read via PyMuPDF) boost confidence and
selection for boundaries Docling already found; a whole-document fallback
chapter keeps output valid when no reliable heading structure exists.
"""

from __future__ import annotations

import io
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import pymupdf
from docling.datamodel.base_models import InputFormat
from docling.datamodel.document import ConversionResult
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling.pipeline.standard_pdf_pipeline import StandardPdfPipeline
from docling_core.types.doc.document import DoclingDocument, PictureItem, TableItem

from preppy.figures.captions import clean_caption_text
from preppy.figures.export import FigureExporter
from preppy.figures.filters import is_too_small_figure
from preppy.hashing import sha256_file
from preppy.markdown.render import render_chapter_markdown
from preppy.models import (
    BoundaryDiagnostic,
    Chapter,
    ChapterContent,
    ChapterDetectionDiagnostics,
    ChapterKind,
    ConversionDiagnostics,
    Diagnostics,
    DocumentItem,
    DocumentModel,
    ErrorRecord,
    Figure,
    FigureAsset,
    FigureDiagnostics,
    PreppyDocument,
    QualityDiagnostics,
    QualityWarning,
    SourceInfo,
    SourceLocator,
)
from preppy.paths import asset_relpath, chapter_relpath, markdown_asset_link
from preppy.split.classify import classify_kind, compile_boundary_pattern, is_chapter_like, normalize_title
from preppy.split.plan import SplitCandidate, SplitPlan, apply_matter_flags, demote_nested_headings
from preppy.split.slug import slugify

HEADING_LABELS = {"title", "section_header"}
SKIP_BODY_LABELS = {"page_header", "page_footer"}
MAX_AUTO_CHAPTER_PAGES = 80

_CONTAINER_TITLE_RE = re.compile(
    r"^(?:(?:part|book|volume|unit)\b|[ivxlcdm]+\s*[:.\-])",
    re.IGNORECASE,
)


@dataclass(slots=True)
class _FlatItem:
    item: object
    level: int
    index: int
    label: str
    page_no: int | None
    bbox: list[float] | None
    text: str | None
    self_ref: str | None


@dataclass(slots=True)
class _PictureOutcome:
    kind: Literal["exported", "duplicate", "skipped"]
    figure_id: str | None = None
    asset: FigureAsset | None = None
    markdown: str | None = None


@dataclass(slots=True)
class _OutlineNode:
    index: int
    level: int
    title: str
    page: int
    parent_index: int | None = None
    children: list[int] = field(default_factory=list)
    end_page: int | None = None


def build_plan(
    pdf_path: Path,
    *,
    boundary_pattern: str | None = None,
    ocr: bool = False,
    table_structure: bool = True,
) -> SplitPlan:
    compiled_boundary_pattern = compile_boundary_pattern(boundary_pattern)
    result = _run_docling(
        pdf_path, ocr=ocr, table_structure=table_structure, extract_figures=False, images_scale=1.0
    )
    doc = result.document
    flat_items = _flatten(doc)
    running_header_refs = _running_heading_refs(flat_items, doc)
    candidates = _detect_candidates(flat_items, compiled_boundary_pattern, pdf_path, doc, running_header_refs)
    return SplitPlan(
        source_path=str(pdf_path),
        source_type="pdf",
        title=_doc_title(doc, pdf_path),
        author=None,
        language=None,
        boundary_pattern=boundary_pattern,
        candidates=candidates,
    )


def convert(
    pdf_path: Path,
    plan: SplitPlan | None = None,
    *,
    ocr: bool = False,
    table_structure: bool = True,
    extract_figures: bool = True,
    images_scale: float = 2.0,
    boundary_pattern: str | None = None,
    include_frontmatter: bool = False,
    include_backmatter: bool = False,
    min_chapter_chars: int = 1000,
) -> PreppyDocument:
    start_time = time.monotonic()
    compiled_boundary_pattern = compile_boundary_pattern(boundary_pattern)

    try:
        result = _run_docling(
            pdf_path,
            ocr=ocr,
            table_structure=table_structure,
            extract_figures=extract_figures,
            images_scale=images_scale,
        )
        if result.status.value not in {"success", "partial_success"}:
            raise RuntimeError(f"Docling conversion status was {result.status.value!r}")
        doc = result.document
    except Exception as exc:  # noqa: BLE001 - any Docling failure triggers the fallback engine
        from preppy.engines import fallback_pymupdf

        try:
            return fallback_pymupdf.convert(
                pdf_path, reason=str(exc), elapsed_seconds=time.monotonic() - start_time
            )
        except Exception as fallback_exc:  # noqa: BLE001 - file is unreadable by any engine
            return fallback_pymupdf.convert_unreadable(
                pdf_path,
                reason=f"Docling: {exc}; PyMuPDF fallback: {fallback_exc}",
                elapsed_seconds=time.monotonic() - start_time,
            )

    flat_items = _flatten(doc)
    running_header_refs = _running_heading_refs(flat_items, doc)
    candidates = plan.candidates if plan is not None else _detect_candidates(
        flat_items, compiled_boundary_pattern, pdf_path, doc, running_header_refs
    )

    source = SourceInfo(
        path=str(pdf_path),
        filename=pdf_path.name,
        type="pdf",
        sha256=sha256_file(pdf_path),
        title=(plan.title if plan is not None else _doc_title(doc, pdf_path)),
        author=(plan.author if plan is not None else None),
        language=(plan.language if plan is not None else None),
    )

    consumed_caption_refs: set[str] = set()
    for pic in doc.pictures:
        for ref in pic.captions:
            consumed_caption_refs.add(ref.cref)
    for tbl in doc.tables:
        for ref in getattr(tbl, "captions", None) or []:
            consumed_caption_refs.add(ref.cref)

    apply_matter_flags(candidates, include_frontmatter=include_frontmatter, include_backmatter=include_backmatter)
    selected = sorted(
        (c for c in candidates if c.selected and c.pdf_item_index is not None),
        key=lambda c: c.pdf_item_index or 0,
    )

    exporter = FigureExporter()
    figures: list[FigureAsset] = []
    chapters: list[ChapterContent] = []
    warnings: list[QualityWarning] = []
    errors: list[ErrorRecord] = []
    figures_found = 0
    figures_skipped = 0
    figures_duplicate = 0
    table_render_failures = 0

    output_index = 1
    for pos, candidate in enumerate(selected):
        boundary_idx = candidate.pdf_item_index or 0
        start_idx = candidate.pdf_content_start_index
        if start_idx is None:
            start_idx = boundary_idx
        if pos + 1 < len(selected):
            next_candidate = selected[pos + 1]
            end_idx = next_candidate.pdf_content_start_index
            if end_idx is None:
                end_idx = next_candidate.pdf_item_index
            if end_idx is None:
                end_idx = len(flat_items)
        else:
            end_idx = len(flat_items)
        matter_fence = _next_outline_matter_index(candidates, after_index=boundary_idx)
        if matter_fence is not None:
            end_idx = min(end_idx, matter_fence)
        slice_items = flat_items[start_idx:end_idx]
        if not slice_items:
            continue

        chapter_figure_ids: list[str] = []
        lines: list[str] = []
        text_parts: list[str] = []

        if candidate.parent_title and start_idx < boundary_idx:
            lines.append(f"## {candidate.parent_title}")

        for fi in slice_items:
            if fi.label in SKIP_BODY_LABELS:
                continue
            if fi.self_ref in running_header_refs:
                continue
            if fi.label == "caption" and fi.self_ref in consumed_caption_refs:
                continue

            if fi.label == "picture":
                figures_found += 1
                outcome = _handle_picture(
                    fi.item,
                    doc=doc,
                    exporter=exporter,
                    extract_figures=extract_figures,
                    chapter_index=output_index,
                )
                if outcome.kind == "skipped":
                    figures_skipped += 1
                    continue
                if outcome.kind == "exported" and outcome.asset is not None:
                    figures.append(outcome.asset)
                elif outcome.kind == "duplicate":
                    figures_duplicate += 1
                if outcome.figure_id:
                    chapter_figure_ids.append(outcome.figure_id)
                if outcome.markdown:
                    lines.append(outcome.markdown)
                continue

            if fi.label == "table":
                table_md, ok = _render_table(fi.item, doc)
                if not ok:
                    table_render_failures += 1
                lines.append(table_md)
                if fi.text:
                    text_parts.append(fi.text)
                continue

            if fi.label in HEADING_LABELS:
                # Container prelude headings are rendered once from the
                # canonical outline title above. Likewise, omit the printed
                # chapter-title fragments because render_chapter_markdown()
                # supplies the single canonical H1.
                if fi.index < boundary_idx:
                    continue
                if (
                    fi.page_no == candidate.source_locator.page_start
                    and _title_key(fi.text or "")
                    and _title_key(fi.text or "") in _title_key(candidate.title)
                ):
                    continue
                level = getattr(fi.item, "level", 1) if fi.label == "section_header" else 1
                heading_text = normalize_title(fi.text or "")
                if heading_text:
                    lines.append(f"{'#' * min(6, max(1, level))} {heading_text}")
                    text_parts.append(heading_text)
                continue

            if fi.label == "list_item":
                if fi.text:
                    lines.append(f"- {fi.text.strip()}")
                    text_parts.append(fi.text)
                continue

            if fi.text:
                lines.append(fi.text.strip())
                text_parts.append(fi.text)

        body_markdown = "\n\n".join(line for line in lines if line and line.strip())
        markdown = render_chapter_markdown(candidate.title, body_markdown)
        text_len = len(" ".join(part.strip() for part in text_parts if part.strip()))

        slug = slugify(candidate.title)
        chapter_meta = Chapter(
            index=output_index,
            title=candidate.title,
            kind=candidate.kind,
            slug=slug,
            path=chapter_relpath(output_index, slug),
            source_locator=candidate.source_locator,
            char_count=text_len,
            figure_ids=chapter_figure_ids,
            boundary_reason=candidate.reason,
            boundary_confidence=candidate.confidence,
            parent_title=candidate.parent_title,
            outline_level=candidate.outline_level,
        )
        if text_len < min_chapter_chars:
            warnings.append(
                QualityWarning(
                    code="short-chapter",
                    message=(
                        f"Chapter {output_index} ('{candidate.title}') has {text_len} "
                        f"characters, below --min-chapter-chars={min_chapter_chars}."
                    ),
                    context={"chapter_index": output_index},
                )
            )
        chapters.append(ChapterContent(meta=chapter_meta, markdown=markdown))
        output_index += 1

    if not chapters:
        warnings.append(
            QualityWarning(
                code="no-chapters",
                message="No chapters were selected. Check the split plan or --boundary-pattern.",
                severity="error",
            )
        )
    if table_render_failures:
        warnings.append(
            QualityWarning(
                code="table-render-failed",
                message=f"{table_render_failures} table(s) could not be rendered to Markdown.",
                context={"count": table_render_failures},
            )
        )

    missing_captions = sum(1 for f in figures if f.meta.caption_status == "missing")
    char_counts = [c.meta.char_count for c in chapters]
    elapsed = time.monotonic() - start_time
    method = (
        "docling-headers+pdf-outline"
        if any(c.reason.startswith("pdf-outline-") for c in candidates)
        else "docling-headers"
    )

    document_model = DocumentModel(
        source_type="pdf",
        items=[
            DocumentItem(
                kind=fi.label,
                level=(getattr(fi.item, "level", None) if fi.label == "section_header" else None),
                text=fi.text,
                source_locator=SourceLocator(page=fi.page_no, bbox=fi.bbox, docling_ref=fi.self_ref),
            )
            for fi in flat_items
            if fi.label in HEADING_LABELS
        ],
        meta={"num_pages": _num_pages(doc), "item_count": len(flat_items)},
    )

    diagnostics = Diagnostics(
        conversion=ConversionDiagnostics(
            input_type="pdf",
            engine="pdf_docling",
            options={
                "ocr": ocr,
                "table_structure": table_structure,
                "extract_figures": extract_figures,
                "images_scale": images_scale,
                "min_chapter_chars": min_chapter_chars,
                "boundary_pattern": boundary_pattern,
            },
            elapsed_seconds=elapsed,
        ),
        chapter_detection=ChapterDetectionDiagnostics(
            method=method,
            candidates=[
                BoundaryDiagnostic(
                    title=c.title,
                    kind=c.kind,
                    reason=c.reason,
                    confidence=c.confidence,
                    selected=c.selected,
                    source_locator=c.source_locator,
                )
                for c in candidates
            ],
            selected_count=len(chapters),
        ),
        figures=FigureDiagnostics(
            found=figures_found,
            exported=len(figures),
            skipped=figures_skipped,
            duplicates=figures_duplicate,
            missing_captions=missing_captions,
        ),
        quality=QualityDiagnostics(
            chapter_count=len(chapters),
            selected_boundary_count=len(chapters),
            mean_chapter_chars=(sum(char_counts) / len(char_counts)) if char_counts else 0.0,
            min_chapter_chars=min(char_counts) if char_counts else 0,
            figures_exported=len(figures),
            figures_with_captions=len(figures) - missing_captions,
            skipped_images=figures_skipped,
            fallback_usage_count=0,
            warnings=warnings,
        ),
        errors=errors,
    )

    return PreppyDocument(
        source=source,
        chapters=chapters,
        figures=figures,
        document_model=document_model,
        diagnostics=diagnostics,
    )


def _run_docling(
    pdf_path: Path, *, ocr: bool, table_structure: bool, extract_figures: bool, images_scale: float
) -> ConversionResult:
    pipeline_options = PdfPipelineOptions()
    pipeline_options.do_ocr = ocr
    pipeline_options.do_table_structure = table_structure
    pipeline_options.generate_picture_images = extract_figures
    pipeline_options.images_scale = images_scale

    converter = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(
                pipeline_cls=StandardPdfPipeline,
                pipeline_options=pipeline_options,
            )
        }
    )
    return converter.convert(str(pdf_path))


def _flatten(doc: DoclingDocument) -> list[_FlatItem]:
    flat: list[_FlatItem] = []
    for index, (item, level) in enumerate(doc.iterate_items(with_groups=False)):
        label = getattr(item, "label", None)
        label_value = label.value if hasattr(label, "value") else str(label)
        prov = getattr(item, "prov", None) or []
        page_no = prov[0].page_no if prov else None
        bbox = _bbox_to_list(prov[0].bbox) if prov and getattr(prov[0], "bbox", None) else None
        text = getattr(item, "text", None)
        self_ref = getattr(item, "self_ref", None)
        flat.append(
            _FlatItem(
                item=item,
                level=level,
                index=index,
                label=label_value,
                page_no=page_no,
                bbox=bbox,
                text=text,
                self_ref=self_ref,
            )
        )
    return flat


def _detect_candidates(
    flat_items: list[_FlatItem],
    boundary_pattern: re.Pattern[str] | None,
    pdf_path: Path,
    doc: DoclingDocument,
    running_header_refs: set[str] | None = None,
) -> list[SplitCandidate]:
    pattern = boundary_pattern
    running_header_refs = running_header_refs or set()
    candidates: list[SplitCandidate] = []

    for fi in flat_items:
        if fi.label not in HEADING_LABELS or not fi.text:
            continue
        title = normalize_title(fi.text)
        if not title:
            continue
        is_running_header = fi.self_ref in running_header_refs
        chapter_like = False if is_running_header else is_chapter_like(title, pattern)
        kind: ChapterKind = "chapter" if chapter_like else classify_kind(title, unmatched="unknown")
        level = getattr(fi.item, "level", 1) if fi.label == "section_header" else 1
        confidence = 0.2 if is_running_header else (0.85 if fi.label == "title" else (0.75 if level == 1 else 0.55))
        candidates.append(
            SplitCandidate(
                id=0,
                order=0,
                title=title,
                kind=kind,
                reason="running-header" if is_running_header else f"docling-{fi.label.replace('_', '-')}",
                confidence=confidence,
                selected=False if is_running_header else kind == "chapter",
                heading_level=level,
                source_locator=SourceLocator(page_start=fi.page_no, bbox=fi.bbox, docling_ref=fi.self_ref),
                pdf_item_index=fi.index,
            )
        )

    # Docling's own heading level is a reliable depth signal (unlike EPUB's
    # sometimes-flat TOC), but a numbered subsection like "1.2.1 Foo" can
    # still slip through `is_chapter_like`. Only auto-select the shallowest
    # heading level; deeper ones stay in the plan for manual selection.
    demote_nested_headings(
        candidates, reasons={"docling-title", "docling-section-header"}, demoted_reason="docling-nested"
    )

    if pattern:
        existing_idx = {c.pdf_item_index for c in candidates}
        for fi in flat_items:
            if fi.index in existing_idx or fi.label in HEADING_LABELS or fi.label in SKIP_BODY_LABELS:
                continue
            if not fi.text or not fi.text.strip():
                continue
            first_line = fi.text.strip().splitlines()[0]
            if not pattern.search(first_line):
                continue
            title = normalize_title(first_line)
            if not title:
                continue
            kind = classify_kind(title, unmatched="chapter" if is_chapter_like(title, pattern) else "unknown")
            candidates.append(
                SplitCandidate(
                    id=0,
                    order=0,
                    title=title,
                    kind=kind,
                    reason="boundary-pattern",
                    confidence=0.65,
                    selected=kind == "chapter",
                    source_locator=SourceLocator(page_start=fi.page_no),
                    pdf_item_index=fi.index,
                )
            )

    _enrich_with_outline(
        candidates,
        _pdf_outline(pdf_path),
        flat_items=flat_items,
        num_pages=_num_pages(doc),
    )

    candidates.sort(key=lambda c: c.pdf_item_index if c.pdf_item_index is not None else 0)
    for order, candidate in enumerate(candidates, start=1):
        candidate.id = order
        candidate.order = order

    if not any(c.selected for c in candidates):
        candidates.append(
            SplitCandidate(
                id=len(candidates) + 1,
                order=len(candidates) + 1,
                title=_doc_title(doc, pdf_path),
                kind="chapter",
                reason="fallback-single-chapter",
                confidence=0.3,
                selected=True,
                source_locator=SourceLocator(page_start=1, page_end=_num_pages(doc)),
                pdf_item_index=0,
            )
        )

    return candidates


def _running_heading_refs(flat_items: list[_FlatItem], doc: DoclingDocument) -> set[str]:
    """Detect Docling headings that are actually repeated page furniture."""
    page_heights = _page_heights(doc)
    occurrences: dict[str, list[_FlatItem]] = {}
    for fi in flat_items:
        if fi.label not in HEADING_LABELS or not fi.text or not fi.self_ref or fi.page_no is None:
            continue
        height = page_heights.get(fi.page_no)
        if height is None or not _is_page_edge_bbox(fi.bbox, height):
            continue
        key = normalize_title(fi.text).casefold()
        if key:
            occurrences.setdefault(key, []).append(fi)

    refs: set[str] = set()
    for items in occurrences.values():
        pages = {fi.page_no for fi in items}
        if len(pages) < 2:
            continue
        refs.update(fi.self_ref for fi in items if fi.self_ref)
    return refs


def _page_heights(doc: DoclingDocument) -> dict[int, float]:
    heights: dict[int, float] = {}
    pages = getattr(doc, "pages", {}) or {}
    for page_no, page in pages.items():
        try:
            heights[int(page_no)] = float(page.size.height)
        except Exception:  # noqa: BLE001
            continue
    return heights


def _is_page_edge_bbox(bbox: list[float] | None, page_height: float) -> bool:
    if not bbox or page_height <= 0:
        return False
    y_values = [bbox[1], bbox[3]]
    top_y = max(y_values)
    bottom_y = min(y_values)
    return top_y >= page_height * 0.9 or bottom_y <= page_height * 0.1


def _enrich_with_outline(
    candidates: list[SplitCandidate],
    outline: list[tuple[int, str, int]],
    *,
    flat_items: list[_FlatItem],
    num_pages: int,
) -> None:
    """Use the PDF outline as a semantic tree, not a fixed-depth list.

    Container nodes (Part / Book / Unit) are grouping metadata. Their first
    content-bearing descendants become chapter boundaries. A content node is
    only pushed down to its children when it exceeds the conservative page
    budget, so ordinary Chapter -> Section outlines still split by chapter.
    """
    nodes = _build_outline_tree(outline, num_pages=num_pages)
    selected_indices = _select_outline_units(nodes)
    if not selected_indices:
        return

    # A usable outline is stronger than visual number/title guesses. Reset
    # them first; this also prevents numbered headings in Notes from being
    # rediscovered as duplicate chapters.
    for candidate in candidates:
        candidate.selected = False

    selected_set = set(selected_indices)
    container_set = {node.index for node in nodes if _is_outline_container(node, nodes)}

    for node in nodes:
        kind = classify_kind(node.title, unmatched="chapter" if node.index in selected_set else "unknown")
        if node.index in container_set:
            reason = "pdf-outline-container"
        elif kind in {"frontmatter", "backmatter", "notes", "bibliography", "index"}:
            reason = "pdf-outline-matter"
        elif node.index in selected_set:
            reason = "pdf-outline-chapter"
        else:
            reason = "pdf-outline-nested"

        boundary_idx = _outline_item_index(node, candidates, flat_items)
        if boundary_idx is None:
            continue

        parent = nodes[node.parent_index] if node.parent_index is not None else None
        parent_title = parent.title if parent is not None and parent.index in container_set else None
        content_start_idx = boundary_idx
        if node.index in selected_set and parent is not None and parent.index in container_set:
            first_selected_child = next(
                (child for child in parent.children if child in selected_set),
                None,
            )
            if first_selected_child == node.index:
                parent_start = _page_item_index(flat_items, parent.page)
                if parent_start is not None:
                    content_start_idx = parent_start

        candidates.append(
            SplitCandidate(
                id=0,
                order=0,
                title=node.title,
                kind=kind,
                reason=reason,
                confidence=0.98 if node.index in selected_set else 0.9,
                selected=node.index in selected_set,
                heading_level=None,
                outline_level=node.level,
                parent_title=parent_title,
                source_locator=SourceLocator(page_start=node.page),
                pdf_item_index=boundary_idx,
                pdf_content_start_index=content_start_idx,
            )
        )


def _build_outline_tree(outline: list[tuple[int, str, int]], *, num_pages: int) -> list[_OutlineNode]:
    nodes: list[_OutlineNode] = []
    stack: list[int] = []
    for level, raw_title, page in outline:
        title = normalize_title(raw_title)
        if not title or level < 1 or page < 1:
            continue
        while len(stack) >= level:
            stack.pop()
        parent_index = stack[-1] if stack else None
        node = _OutlineNode(
            index=len(nodes),
            level=level,
            title=title,
            page=page,
            parent_index=parent_index,
        )
        nodes.append(node)
        if parent_index is not None:
            nodes[parent_index].children.append(node.index)
        stack.append(node.index)

    for node in nodes:
        following = next(
            (
                other
                for other in nodes[node.index + 1 :]
                if other.level <= node.level and other.page >= node.page
            ),
            None,
        )
        node.end_page = (following.page - 1) if following is not None else num_pages
    return nodes


def _select_outline_units(nodes: list[_OutlineNode]) -> list[int]:
    selected: list[int] = []

    def visit(node: _OutlineNode) -> None:
        kind = classify_kind(node.title, unmatched="unknown")
        if kind in {"frontmatter", "backmatter", "notes", "bibliography", "index"}:
            return
        if _is_outline_container(node, nodes):
            for child_index in node.children:
                visit(nodes[child_index])
            return

        page_span = max(1, (node.end_page or node.page) - node.page + 1)
        if page_span > MAX_AUTO_CHAPTER_PAGES and node.children:
            for child_index in node.children:
                visit(nodes[child_index])
            return
        selected.append(node.index)

    for node in nodes:
        if node.parent_index is None:
            visit(node)
    return selected


def _is_outline_container(node: _OutlineNode, nodes: list[_OutlineNode]) -> bool:
    if not node.children:
        return False
    if _CONTAINER_TITLE_RE.search(node.title):
        return True

    children = [nodes[index] for index in node.children]
    chapter_like_children = sum(is_chapter_like(child.title) for child in children)
    first_child_gap = max(0, children[0].page - node.page)
    return len(children) >= 2 and chapter_like_children >= 2 and first_child_gap <= 3


def _outline_item_index(
    node: _OutlineNode,
    candidates: list[SplitCandidate],
    flat_items: list[_FlatItem],
) -> int | None:
    target_key = _title_key(node.title)
    nearby = [
        candidate
        for candidate in candidates
        if candidate.pdf_item_index is not None
        and candidate.source_locator.page_start is not None
        and abs(candidate.source_locator.page_start - node.page) <= 1
    ]
    nearby.sort(
        key=lambda candidate: (
            abs((candidate.source_locator.page_start or node.page) - node.page),
            candidate.pdf_item_index or 0,
        )
    )
    for candidate in nearby:
        candidate_key = _title_key(candidate.title)
        if candidate_key and (candidate_key == target_key or target_key in candidate_key):
            return candidate.pdf_item_index

    # Printed chapter titles are often split into a number and a title, or
    # extracted with tracking spaces between capital letters. Concatenate the
    # nearby headings before falling back to the first item on the target page.
    same_page = [
        candidate for candidate in nearby if candidate.source_locator.page_start == node.page
    ]
    same_page.sort(key=lambda candidate: candidate.pdf_item_index or 0)
    combined = ""
    first_index: int | None = None
    for candidate in same_page[:6]:
        if first_index is None:
            first_index = candidate.pdf_item_index
        combined += _title_key(candidate.title)
        if target_key and (combined == target_key or target_key in combined):
            return first_index
    if first_index is not None:
        return first_index
    exact_page = _page_item_index(flat_items, node.page)
    if exact_page is not None:
        return exact_page
    return next(
        (fi.index for fi in flat_items if fi.page_no is not None and 0 < fi.page_no - node.page <= 1),
        None,
    )


def _page_item_index(flat_items: list[_FlatItem], page: int) -> int | None:
    return next((fi.index for fi in flat_items if fi.page_no == page), None)


def _title_key(value: str) -> str:
    return "".join(char for char in normalize_title(value).casefold() if char.isalnum())


def _next_outline_matter_index(
    candidates: list[SplitCandidate], *, after_index: int
) -> int | None:
    fences = [
        candidate.pdf_content_start_index
        if candidate.pdf_content_start_index is not None
        else candidate.pdf_item_index
        for candidate in candidates
        if candidate.reason == "pdf-outline-matter"
        and candidate.pdf_item_index is not None
        and candidate.pdf_item_index > after_index
    ]
    return min((index for index in fences if index is not None), default=None)


def _pdf_outline(pdf_path: Path) -> list[tuple[int, str, int]]:
    try:
        with pymupdf.open(str(pdf_path)) as doc:
            return [(lvl, title, page) for lvl, title, page in doc.get_toc(simple=True)]
    except Exception:  # noqa: BLE001 - outline is a best-effort enrichment
        return []


def _handle_picture(
    picture_item: PictureItem,
    *,
    doc: DoclingDocument,
    exporter: FigureExporter,
    extract_figures: bool,
    chapter_index: int,
) -> _PictureOutcome:
    if not extract_figures:
        return _PictureOutcome(kind="skipped")

    try:
        pil_image = picture_item.get_image(doc=doc)
    except Exception:  # noqa: BLE001
        pil_image = None
    if pil_image is None:
        return _PictureOutcome(kind="skipped")

    prov = getattr(picture_item, "prov", None) or []
    page = prov[0].page_no if prov else None
    bbox = _bbox_to_list(prov[0].bbox) if prov and getattr(prov[0], "bbox", None) else None
    page_size = _page_size(doc, page)
    if is_too_small_figure(pil_image.width, pil_image.height, bbox=bbox, page_size=page_size):
        return _PictureOutcome(kind="skipped")

    save_format = "JPEG" if pil_image.mode not in ("RGBA", "P", "LA") and pil_image.format == "JPEG" else "PNG"
    buffer = io.BytesIO()
    try:
        pil_image.save(buffer, format=save_format)
    except Exception:  # noqa: BLE001
        save_format = "PNG"
        buffer = io.BytesIO()
        pil_image.convert("RGB").save(buffer, format=save_format)
    image_bytes = buffer.getvalue()
    suffix = ".jpg" if save_format == "JPEG" else ".png"
    exported = exporter.register(image_bytes, suffix)

    caption_text: str | None = None
    try:
        raw_caption = picture_item.caption_text(doc)
        caption_text = clean_caption_text(raw_caption)
    except Exception:  # noqa: BLE001
        caption_text = None
    caption_status = "docling_caption" if caption_text else "missing"

    markdown_line = f"![{caption_text or ''}]({markdown_asset_link(exported.filename)})"
    if caption_text:
        markdown_line = f"{markdown_line}\n\n{caption_text}"

    if not exported.is_new:
        return _PictureOutcome(kind="duplicate", figure_id=exported.figure_id, markdown=markdown_line)

    figure_meta = Figure(
        id=exported.figure_id,
        asset_path=asset_relpath(exported.filename),
        source_type="pdf",
        chapter_index=chapter_index,
        caption=caption_text,
        caption_status=caption_status,
        source_locator=SourceLocator(page=page, bbox=bbox, docling_ref=getattr(picture_item, "self_ref", None)),
        width=exported.width,
        height=exported.height,
        sha256=exported.sha256,
    )
    asset = FigureAsset(meta=figure_meta, image_bytes=image_bytes)
    return _PictureOutcome(kind="exported", figure_id=exported.figure_id, asset=asset, markdown=markdown_line)


def _render_table(table_item: TableItem, doc: DoclingDocument) -> tuple[str, bool]:
    try:
        markdown = table_item.export_to_markdown(doc=doc)
        if markdown and markdown.strip():
            return markdown.strip(), True
    except Exception:  # noqa: BLE001
        pass
    return "*[table omitted: rendering failed]*", False


def _bbox_to_list(bbox: object) -> list[float] | None:
    try:
        return [float(bbox.l), float(bbox.t), float(bbox.r), float(bbox.b)]
    except Exception:  # noqa: BLE001
        return None


def _page_size(doc: DoclingDocument, page_no: int | None) -> tuple[float, float] | None:
    if page_no is None:
        return None
    pages = getattr(doc, "pages", {}) or {}
    page = pages.get(page_no)
    if page is None:
        return None
    try:
        return float(page.size.width), float(page.size.height)
    except Exception:  # noqa: BLE001
        return None


def _num_pages(doc: DoclingDocument) -> int | None:
    try:
        return doc.num_pages()
    except Exception:  # noqa: BLE001
        return None


def _doc_title(doc: DoclingDocument, pdf_path: Path) -> str:
    for item, _level in doc.iterate_items(with_groups=False):
        label = getattr(item, "label", None)
        label_value = label.value if hasattr(label, "value") else str(label)
        if label_value == "title":
            title = normalize_title(getattr(item, "text", "") or "")
            if title:
                return title
    return pdf_path.stem
