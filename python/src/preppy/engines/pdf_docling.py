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
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from collections.abc import Iterable
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
    DocumentType,
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
    Table,
    TableDiagnostics,
)
from preppy.paths import asset_relpath, chapter_relpath, markdown_asset_link
from preppy.split.classify import classify_kind, compile_boundary_pattern, is_chapter_like, normalize_title
from preppy.split.plan import (
    SplitCandidate,
    SplitPlan,
    apply_matter_flags,
    demote_nested_headings,
)
from preppy.split.slug import slugify

HEADING_LABELS = {"title", "section_header"}
SKIP_BODY_LABELS = {"page_header", "page_footer"}
MAX_AUTO_CHAPTER_PAGES = 80
_REFERENCE_HEADING_RE = re.compile(
    r"^(?:references?|bibliography|works cited|literature cited|literaturverzeichnis|"
    r"références|referencias|참고\s*문헌|参考文献)\s*[:.]?$",
    re.IGNORECASE,
)
_DOI_RE = re.compile(r"\b10\.\d{4,9}/[-._;()/:A-Z0-9]+\b", re.IGNORECASE)
_YEAR_RE = re.compile(r"\b(?:19|20)\d{2}\b")
_ABSTRACT_HEADING_RE = re.compile(r"^abstract\s*[:.]?$", re.IGNORECASE)
_AUTHOR_NOISE_RE = re.compile(
    r"(?:@|https?://|\b(?:university|department|institute|faculty|hospital|laboratory|"
    r"school|college|correspondence|received|accepted|published|copyright|doi|orcid)\b)",
    re.IGNORECASE,
)

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
class _CompoundPictureGroup:
    member_indices: tuple[int, ...]
    member_refs: tuple[str, ...]
    leader_index: int
    page_no: int
    bbox: list[float]
    caption: str
    caption_status: Literal["docling_caption", "nearby_text", "pdf_text_caption"]


@dataclass(slots=True)
class _ArticleMetadata:
    title: str
    subtitle: str | None = None
    authors: list[str] = field(default_factory=list)
    year: int | None = None
    journal: str | None = None
    doi: str | None = None


@dataclass(slots=True)
class _NativePdfMetadata:
    title: str | None = None
    authors: list[str] = field(default_factory=list)
    year: int | None = None
    journal: str | None = None
    doi: str | None = None


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
        pdf_path,
        ocr=ocr,
        table_structure=table_structure,
        extract_figures=False,
        images_scale=1.0,
    )
    doc = result.document
    flat_items = _flatten(doc)
    running_header_refs = _running_heading_refs(flat_items, doc)
    candidates = _detect_candidates(
        flat_items, compiled_boundary_pattern, pdf_path, doc, running_header_refs
    )
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
    document_type: DocumentType = "book",
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
                pdf_path,
                reason=str(exc),
                elapsed_seconds=time.monotonic() - start_time,
                document_type=document_type,
                include_backmatter=include_backmatter,
            )
        except Exception as fallback_exc:  # noqa: BLE001 - file is unreadable by any engine
            return fallback_pymupdf.convert_unreadable(
                pdf_path,
                reason=f"Docling: {exc}; PyMuPDF fallback: {fallback_exc}",
                elapsed_seconds=time.monotonic() - start_time,
                document_type=document_type,
            )

    flat_items = _flatten(doc)
    running_header_refs = _running_heading_refs(flat_items, doc)
    native_metadata = _pdf_native_metadata(pdf_path)
    article_metadata: _ArticleMetadata | None = None
    references_start_index: int | None = None
    if document_type == "article":
        article_metadata = _extract_article_metadata(
            flat_items, pdf_path, native_metadata
        )
        references_start_index = (
            None if include_backmatter else _find_references_start(flat_items)
        )
        candidates = [
            SplitCandidate(
                id=1,
                order=1,
                title=article_metadata.title,
                kind="article",
                reason="article-single-document",
                confidence=1.0,
                selected=True,
                source_locator=SourceLocator(page_start=1, page_end=_num_pages(doc)),
                pdf_item_index=0,
                pdf_content_start_index=0,
            )
        ]
    else:
        candidates = (
            plan.candidates
            if plan is not None
            else _detect_candidates(
                flat_items, compiled_boundary_pattern, pdf_path, doc, running_header_refs
            )
        )

    source = SourceInfo(
        path=str(pdf_path),
        filename=pdf_path.name,
        type="pdf",
        sha256=sha256_file(pdf_path),
        document_type=document_type,
        title=(
            article_metadata.title
            if article_metadata is not None
            else (plan.title if plan is not None else _doc_title(doc, pdf_path))
        ),
        subtitle=article_metadata.subtitle if article_metadata is not None else None,
        author=(
            "; ".join(article_metadata.authors)
            if article_metadata is not None and article_metadata.authors
            else (
                plan.author
                if plan is not None
                else "; ".join(native_metadata.authors) or None
            )
        ),
        authors=(
            article_metadata.authors
            if article_metadata is not None
            else native_metadata.authors
        ),
        year=article_metadata.year
        if article_metadata is not None
        else native_metadata.year,
        journal=article_metadata.journal
        if article_metadata is not None
        else native_metadata.journal,
        doi=article_metadata.doi
        if article_metadata is not None
        else native_metadata.doi,
        language=(plan.language if plan is not None else None),
    )

    consumed_caption_refs: set[str] = set()
    for pic in doc.pictures:
        for ref in pic.captions:
            consumed_caption_refs.add(ref.cref)
    for tbl in doc.tables:
        for ref in getattr(tbl, "captions", None) or []:
            consumed_caption_refs.add(ref.cref)
    nearby_captions: dict[int, str] = {}
    for item in flat_items:
        if item.label not in {"picture", "table"}:
            continue
        caption = _nearby_caption_text(
            flat_items,
            item,
            consumed_caption_refs,
            kind="figure" if item.label == "picture" else "table",
        )
        if caption:
            nearby_captions[item.index] = caption
    pdf_spatial_captions = _pdf_spatial_caption_map(pdf_path, flat_items)
    picture_captions = {
        item.index: _item_caption(
            item.item,
            doc,
            nearby_caption=nearby_captions.get(item.index),
            spatial_caption=pdf_spatial_captions.get(item.index),
        )
        for item in flat_items
        if item.label == "picture"
    }
    compound_groups = _detect_compound_picture_groups(flat_items, picture_captions)
    compound_by_member = {
        member_index: group
        for group in compound_groups
        for member_index in group.member_indices
    }

    if document_type == "book":
        apply_matter_flags(
            candidates,
            include_frontmatter=include_frontmatter,
            include_backmatter=include_backmatter,
        )
    selected = sorted(
        (c for c in candidates if c.selected and c.pdf_item_index is not None),
        key=lambda c: c.pdf_item_index or 0,
    )

    exporter = FigureExporter()
    figures: list[FigureAsset] = []
    tables: list[Table] = []
    chapters: list[ChapterContent] = []
    warnings: list[QualityWarning] = []
    errors: list[ErrorRecord] = []
    figures_found = 0
    figures_skipped = 0
    figures_duplicate = 0
    compound_groups_exported = 0
    compound_panels_processed = 0
    table_render_failures = 0

    if article_metadata is not None:
        missing_metadata = [
            field_name
            for field_name, value in (
                ("authors", article_metadata.authors),
                ("year", article_metadata.year),
                ("journal", article_metadata.journal),
            )
            if not value
        ]
        if missing_metadata:
            warnings.append(
                QualityWarning(
                    code="article-metadata-incomplete",
                    message="Could not confidently extract: "
                    + ", ".join(missing_metadata)
                    + ".",
                    context={"missing_fields": missing_metadata},
                )
            )
        if references_start_index is not None:
            warnings.append(
                QualityWarning(
                    code="article-references-removed",
                    message="Removed the References section from the article learning text.",
                    severity="info",
                    context={"start_item": references_start_index},
                )
            )

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
        if document_type == "article" and references_start_index is not None:
            end_idx = min(end_idx, references_start_index)
        matter_fence = _next_outline_matter_index(candidates, after_index=boundary_idx)
        if matter_fence is not None:
            end_idx = min(end_idx, matter_fence)
        slice_items = flat_items[start_idx:end_idx]
        if not slice_items:
            continue
        slice_indexes = {item.index for item in slice_items}

        chapter_figure_ids: list[str] = []
        chapter_table_ids: list[str] = []
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
                group = compound_by_member.get(fi.index)
                valid_group = (
                    group is not None and set(group.member_indices) <= slice_indexes
                )
                if valid_group and group is not None and fi.index != group.leader_index:
                    continue
                if valid_group and group is not None:
                    figures_found += len(group.member_indices)
                    compound_groups_exported += 1
                    compound_panels_processed += len(group.member_indices)
                    outcome = _handle_compound_picture(
                        group,
                        pdf_path=pdf_path,
                        exporter=exporter,
                        extract_figures=extract_figures,
                        images_scale=images_scale,
                        chapter_index=output_index,
                    )
                else:
                    figures_found += 1
                    outcome = _handle_picture(
                        fi.item,
                        doc=doc,
                        exporter=exporter,
                        extract_figures=extract_figures,
                        chapter_index=output_index,
                        nearby_caption=nearby_captions.get(fi.index),
                        spatial_caption=pdf_spatial_captions.get(fi.index),
                    )
                if outcome.kind == "skipped":
                    figures_skipped += (
                        len(group.member_indices) if valid_group and group else 1
                    )
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
                caption, caption_status = _item_caption(
                    fi.item,
                    doc,
                    nearby_caption=nearby_captions.get(fi.index),
                    spatial_caption=pdf_spatial_captions.get(fi.index),
                )
                table_id = f"tbl-{len(tables) + 1:04d}"
                tables.append(
                    Table(
                        id=table_id,
                        source_type="pdf",
                        chapter_index=output_index,
                        caption=caption,
                        caption_status=caption_status,
                        markdown=table_md,
                        source_locator=SourceLocator(
                            page=fi.page_no, bbox=fi.bbox, docling_ref=fi.self_ref
                        ),
                    )
                )
                chapter_table_ids.append(table_id)
                if not ok:
                    table_render_failures += 1
                lines.append(f"**{caption}**\n\n{table_md}" if caption else table_md)
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
                level = (
                    getattr(fi.item, "level", 1) if fi.label == "section_header" else 1
                )
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
            table_ids=chapter_table_ids,
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
        "article-single-document"
        if document_type == "article"
        else (
            "docling-headers+pdf-outline"
            if any(c.reason.startswith("pdf-outline-") for c in candidates)
            else "docling-headers"
        )
    )

    document_model = DocumentModel(
        source_type="pdf",
        items=[
            DocumentItem(
                kind=fi.label,
                level=(
                    getattr(fi.item, "level", None)
                    if fi.label == "section_header"
                    else None
                ),
                text=fi.text,
                source_locator=SourceLocator(
                    page=fi.page_no, bbox=fi.bbox, docling_ref=fi.self_ref
                ),
            )
            for fi in flat_items
            if fi.label in HEADING_LABELS
        ],
        meta={
            "num_pages": _num_pages(doc),
            "item_count": len(flat_items),
            "document_type": document_type,
            "references_removed": references_start_index is not None,
            "references_start_item": references_start_index,
        },
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
                "document_type": document_type,
                "references_removed": references_start_index is not None,
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
            compound_groups=compound_groups_exported,
            compound_panels=compound_panels_processed,
        ),
        tables=TableDiagnostics(
            found=len(tables),
            rendered=len(tables) - table_render_failures,
            failed=table_render_failures,
            missing_captions=sum(
                1 for table in tables if table.caption_status == "missing"
            ),
        ),
        quality=QualityDiagnostics(
            chapter_count=len(chapters),
            selected_boundary_count=len(chapters),
            mean_chapter_chars=(sum(char_counts) / len(char_counts))
            if char_counts
            else 0.0,
            min_chapter_chars=min(char_counts) if char_counts else 0,
            figures_exported=len(figures),
            figures_with_captions=len(figures) - missing_captions,
            tables_rendered=len(tables) - table_render_failures,
            tables_with_captions=sum(
                1 for table in tables if table.caption_status != "missing"
            ),
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
        tables=tables,
        document_model=document_model,
        diagnostics=diagnostics,
    )


def _run_docling(
    pdf_path: Path,
    *,
    ocr: bool,
    table_structure: bool,
    extract_figures: bool,
    images_scale: float,
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
        bbox = (
            _bbox_to_list(prov[0].bbox)
            if prov and getattr(prov[0], "bbox", None)
            else None
        )
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
        kind: ChapterKind = (
            "chapter" if chapter_like else classify_kind(title, unmatched="unknown")
        )
        level = getattr(fi.item, "level", 1) if fi.label == "section_header" else 1
        confidence = (
            0.2
            if is_running_header
            else (0.85 if fi.label == "title" else (0.75 if level == 1 else 0.55))
        )
        candidates.append(
            SplitCandidate(
                id=0,
                order=0,
                title=title,
                kind=kind,
                reason="running-header"
                if is_running_header
                else f"docling-{fi.label.replace('_', '-')}",
                confidence=confidence,
                selected=False if is_running_header else kind == "chapter",
                heading_level=level,
                source_locator=SourceLocator(
                    page_start=fi.page_no, bbox=fi.bbox, docling_ref=fi.self_ref
                ),
                pdf_item_index=fi.index,
            )
        )

    # Docling's own heading level is a reliable depth signal (unlike EPUB's
    # sometimes-flat TOC), but a numbered subsection like "1.2.1 Foo" can
    # still slip through `is_chapter_like`. Only auto-select the shallowest
    # heading level; deeper ones stay in the plan for manual selection.
    demote_nested_headings(
        candidates,
        reasons={"docling-title", "docling-section-header"},
        demoted_reason="docling-nested",
    )

    if pattern:
        existing_idx = {c.pdf_item_index for c in candidates}
        for fi in flat_items:
            if (
                fi.index in existing_idx
                or fi.label in HEADING_LABELS
                or fi.label in SKIP_BODY_LABELS
            ):
                continue
            if not fi.text or not fi.text.strip():
                continue
            first_line = fi.text.strip().splitlines()[0]
            if not pattern.search(first_line):
                continue
            title = normalize_title(first_line)
            if not title:
                continue
            kind = classify_kind(
                title,
                unmatched="chapter" if is_chapter_like(title, pattern) else "unknown",
            )
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

    candidates.sort(
        key=lambda c: c.pdf_item_index if c.pdf_item_index is not None else 0
    )
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


def _running_heading_refs(
    flat_items: list[_FlatItem], doc: DoclingDocument
) -> set[str]:
    """Detect Docling headings that are actually repeated page furniture.

    Docling sometimes labels running titles as ``section_header`` instead of
    ``page_header``. Repeated edge-positioned headings are not safe chapter
    boundaries and should not be rendered into the body.
    """
    page_heights = _page_heights(doc)
    occurrences: dict[str, list[_FlatItem]] = {}
    for fi in flat_items:
        if (
            fi.label not in HEADING_LABELS
            or not fi.text
            or not fi.self_ref
            or fi.page_no is None
        ):
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
        kind = classify_kind(
            node.title, unmatched="chapter" if node.index in selected_set else "unknown"
        )
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
        parent_title = (
            parent.title
            if parent is not None and parent.index in container_set
            else None
        )
        content_start_idx = boundary_idx
        if (
            node.index in selected_set
            and parent is not None
            and parent.index in container_set
        ):
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


def _build_outline_tree(
    outline: list[tuple[int, str, int]], *, num_pages: int
) -> list[_OutlineNode]:
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
        if candidate_key and (
            candidate_key == target_key or target_key in candidate_key
        ):
            return candidate.pdf_item_index

    # Printed chapter titles are often split into a number and a title, or
    # extracted with tracking spaces between capital letters. Concatenate the
    # nearby headings before falling back to the first item on the target page.
    same_page = [
        candidate
        for candidate in nearby
        if candidate.source_locator.page_start == node.page
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
        (
            fi.index
            for fi in flat_items
            if fi.page_no is not None and 0 < fi.page_no - node.page <= 1
        ),
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


def _detect_compound_picture_groups(
    flat_items: list[_FlatItem],
    captions: dict[int, tuple[str | None, str]],
) -> list[_CompoundPictureGroup]:
    """Find compact multi-panel figures without relying on paper-specific ids.

    Geometry only proposes a connected component. A component is accepted
    only when its captions agree on one figure number and either enumerate the
    same number of panels or repeat the same caption across multiple panels.
    """
    pictures_by_page: dict[int, list[_FlatItem]] = {}
    for item in flat_items:
        if item.label == "picture" and item.page_no is not None and item.bbox:
            pictures_by_page.setdefault(item.page_no, []).append(item)

    groups: list[_CompoundPictureGroup] = []
    for page_no, pictures in pictures_by_page.items():
        remaining = {item.index: item for item in pictures}
        while remaining:
            _seed_index, seed = remaining.popitem()
            component = [seed]
            frontier = [seed]
            while frontier:
                current = frontier.pop()
                neighbors = [
                    item
                    for item in remaining.values()
                    if _picture_items_are_neighbors(current, item)
                ]
                for neighbor in neighbors:
                    remaining.pop(neighbor.index, None)
                    component.append(neighbor)
                    frontier.append(neighbor)

            if not 2 <= len(component) <= 8:
                continue
            union = _picture_bbox_union(component)
            if union is None or _picture_component_density(component, union) < 0.5:
                continue

            caption_entries = [
                (item.index, *captions.get(item.index, (None, "missing")))
                for item in component
                if captions.get(item.index, (None, "missing"))[0]
            ]
            figure_keys = {
                key
                for _index, caption, _status in caption_entries
                if (key := _figure_caption_key(caption)) is not None
            }
            if len(figure_keys) != 1:
                continue
            figure_key = next(iter(figure_keys))
            matching = [
                (index, caption, status)
                for index, caption, status in caption_entries
                if _figure_caption_key(caption) == figure_key
            ]
            best_caption = min(
                matching,
                key=lambda entry: (
                    _caption_status_rank(entry[2]),
                    -len(entry[1] or ""),
                ),
            )
            panel_count = _caption_panel_count(best_caption[1])
            repeated_caption_count = len(matching)
            strong_panel_evidence = panel_count == len(component) and panel_count >= 2
            strong_repetition_evidence = (
                repeated_caption_count >= 2
                and len(component) <= repeated_caption_count * 2
                and _picture_component_density(component, union) >= 0.65
            )
            if not (strong_panel_evidence or strong_repetition_evidence):
                continue

            ordered = sorted(component, key=lambda item: item.index)
            groups.append(
                _CompoundPictureGroup(
                    member_indices=tuple(item.index for item in ordered),
                    member_refs=tuple(
                        item.self_ref for item in ordered if item.self_ref
                    ),
                    leader_index=ordered[0].index,
                    page_no=page_no,
                    bbox=union,
                    caption=best_caption[1] or "",
                    caption_status=best_caption[2],
                )
            )
    return groups


def _picture_items_are_neighbors(first: _FlatItem, second: _FlatItem) -> bool:
    first_rect = _normalized_bbox(first.bbox)
    second_rect = _normalized_bbox(second.bbox)
    if first_rect is None or second_rect is None:
        return False
    first_width = first_rect[2] - first_rect[0]
    second_width = second_rect[2] - second_rect[0]
    first_height = first_rect[3] - first_rect[1]
    second_height = second_rect[3] - second_rect[1]
    horizontal_gap = max(
        0.0,
        max(first_rect[0], second_rect[0]) - min(first_rect[2], second_rect[2]),
    )
    vertical_gap = max(
        0.0,
        max(first_rect[1], second_rect[1]) - min(first_rect[3], second_rect[3]),
    )
    horizontal_overlap = max(
        0.0,
        min(first_rect[2], second_rect[2]) - max(first_rect[0], second_rect[0]),
    )
    vertical_overlap = max(
        0.0,
        min(first_rect[3], second_rect[3]) - max(first_rect[1], second_rect[1]),
    )
    row_neighbors = (
        horizontal_gap <= min(48.0, max(12.0, min(first_width, second_width) * 0.35))
        and vertical_overlap / max(1.0, min(first_height, second_height)) >= 0.35
    )
    column_neighbors = (
        vertical_gap <= min(48.0, max(12.0, min(first_height, second_height) * 0.35))
        and horizontal_overlap / max(1.0, min(first_width, second_width)) >= 0.35
    )
    return row_neighbors or column_neighbors


def _picture_bbox_union(items: list[_FlatItem]) -> list[float] | None:
    rects = [rect for item in items if (rect := _normalized_bbox(item.bbox))]
    if not rects:
        return None
    return [
        min(rect[0] for rect in rects),
        max(rect[3] for rect in rects),
        max(rect[2] for rect in rects),
        min(rect[1] for rect in rects),
    ]


def _picture_component_density(items: list[_FlatItem], union: list[float]) -> float:
    union_rect = _normalized_bbox(union)
    if union_rect is None:
        return 0.0
    union_area = (union_rect[2] - union_rect[0]) * (union_rect[3] - union_rect[1])
    if union_area <= 0:
        return 0.0
    item_area = 0.0
    for item in items:
        rect = _normalized_bbox(item.bbox)
        if rect:
            item_area += (rect[2] - rect[0]) * (rect[3] - rect[1])
    return item_area / union_area


def _normalized_bbox(
    bbox: list[float] | None,
) -> tuple[float, float, float, float] | None:
    if not bbox or len(bbox) != 4:
        return None
    return (
        min(bbox[0], bbox[2]),
        min(bbox[1], bbox[3]),
        max(bbox[0], bbox[2]),
        max(bbox[1], bbox[3]),
    )


def _figure_caption_key(caption: str | None) -> str | None:
    if not caption:
        return None
    match = re.match(
        r"^fig(?:ure)?\.?\s*([A-Z0-9]+(?:[.-][A-Z0-9]+)*)\b",
        caption,
        re.IGNORECASE,
    )
    return match.group(1).casefold() if match else None


def _caption_panel_count(caption: str | None) -> int:
    if not caption:
        return 0
    labels = {
        label.upper()
        for label in re.findall(r"\bpanels?\s+([A-H])\b", caption, re.IGNORECASE)
    }
    parenthetical = {
        label.upper() for label in re.findall(r"\(([A-H])\)", caption, re.IGNORECASE)
    }
    if len(parenthetical) >= 2:
        labels.update(parenthetical)
    for start, end in re.findall(
        r"\bpanels?\s+([A-H])\s*[-–—]\s*([A-H])\b", caption, re.IGNORECASE
    ):
        start_ord, end_ord = ord(start.upper()), ord(end.upper())
        if start_ord <= end_ord:
            labels.update(chr(value) for value in range(start_ord, end_ord + 1))
    return len(labels)


def _caption_status_rank(status: str) -> int:
    return {
        "docling_caption": 0,
        "pdf_text_caption": 1,
        "nearby_text": 2,
        "missing": 3,
    }.get(status, 4)


def _handle_compound_picture(
    group: _CompoundPictureGroup,
    *,
    pdf_path: Path,
    exporter: FigureExporter,
    extract_figures: bool,
    images_scale: float,
    chapter_index: int,
) -> _PictureOutcome:
    if not extract_figures:
        return _PictureOutcome(kind="skipped")
    try:
        with pymupdf.open(str(pdf_path)) as pdf:
            page = pdf[group.page_no - 1]
            base_rect = _docling_bbox_to_pdf_rect(group.bbox, page.rect.height)
            if base_rect is None:
                return _PictureOutcome(kind="skipped")
            width = base_rect[2] - base_rect[0]
            height = base_rect[3] - base_rect[1]
            horizontal_pad = min(12.0, max(6.0, width * 0.02))
            top_pad = min(36.0, max(12.0, height * 0.1))
            clip = pymupdf.Rect(
                max(page.rect.x0, base_rect[0] - horizontal_pad),
                max(page.rect.y0, base_rect[1] - top_pad),
                min(page.rect.x1, base_rect[2] + horizontal_pad),
                min(page.rect.y1, base_rect[3] + 4.0),
            )
            caption_key = _figure_caption_key(group.caption)
            caption_tops = [
                float(block[1])
                for block in page.get_text("blocks")
                if float(block[1]) >= base_rect[3] - 8.0
                and _figure_caption_key(clean_caption_text(block[4])) == caption_key
            ]
            if caption_tops:
                clip.y1 = min(clip.y1, min(caption_tops) - 3.0)
            pixmap = page.get_pixmap(
                matrix=pymupdf.Matrix(images_scale, images_scale),
                clip=clip,
                alpha=False,
            )
            image_bytes = pixmap.tobytes("png")
    except Exception:  # noqa: BLE001 - degrade to skipped rather than abort conversion
        return _PictureOutcome(kind="skipped")

    exported = exporter.register(image_bytes, ".png")
    markdown_line = f"![{group.caption}]({markdown_asset_link(exported.filename)})\n\n{group.caption}"
    if not exported.is_new:
        return _PictureOutcome(
            kind="duplicate", figure_id=exported.figure_id, markdown=markdown_line
        )
    figure_meta = Figure(
        id=exported.figure_id,
        asset_path=asset_relpath(exported.filename),
        source_type="pdf",
        chapter_index=chapter_index,
        caption=group.caption,
        caption_status=group.caption_status,
        source_locator=SourceLocator(
            page=group.page_no,
            bbox=group.bbox,
            docling_ref=group.member_refs[0] if group.member_refs else None,
        ),
        component_refs=list(group.member_refs),
        width=exported.width,
        height=exported.height,
        sha256=exported.sha256,
    )
    return _PictureOutcome(
        kind="exported",
        figure_id=exported.figure_id,
        asset=FigureAsset(meta=figure_meta, image_bytes=image_bytes),
        markdown=markdown_line,
    )


def _handle_picture(
    picture_item: PictureItem,
    *,
    doc: DoclingDocument,
    exporter: FigureExporter,
    extract_figures: bool,
    chapter_index: int,
    nearby_caption: str | None = None,
    spatial_caption: str | None = None,
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
    bbox = (
        _bbox_to_list(prov[0].bbox) if prov and getattr(prov[0], "bbox", None) else None
    )
    page_size = _page_size(doc, page)
    if is_too_small_figure(
        pil_image.width,
        pil_image.height,
        bbox=bbox,
        page_size=page_size,
    ):
        return _PictureOutcome(kind="skipped")

    save_format = (
        "JPEG"
        if pil_image.mode not in ("RGBA", "P", "LA") and pil_image.format == "JPEG"
        else "PNG"
    )
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

    caption_text, caption_status = _item_caption(
        picture_item,
        doc,
        nearby_caption=nearby_caption,
        spatial_caption=spatial_caption,
    )

    markdown_line = f"![{caption_text or ''}]({markdown_asset_link(exported.filename)})"
    if caption_text:
        markdown_line = f"{markdown_line}\n\n{caption_text}"

    if not exported.is_new:
        return _PictureOutcome(
            kind="duplicate", figure_id=exported.figure_id, markdown=markdown_line
        )

    figure_meta = Figure(
        id=exported.figure_id,
        asset_path=asset_relpath(exported.filename),
        source_type="pdf",
        chapter_index=chapter_index,
        caption=caption_text,
        caption_status=caption_status,
        source_locator=SourceLocator(
            page=page, bbox=bbox, docling_ref=getattr(picture_item, "self_ref", None)
        ),
        component_refs=(
            [getattr(picture_item, "self_ref")]
            if getattr(picture_item, "self_ref", None)
            else []
        ),
        width=exported.width,
        height=exported.height,
        sha256=exported.sha256,
    )
    asset = FigureAsset(meta=figure_meta, image_bytes=image_bytes)
    return _PictureOutcome(
        kind="exported",
        figure_id=exported.figure_id,
        asset=asset,
        markdown=markdown_line,
    )


def _render_table(table_item: TableItem, doc: DoclingDocument) -> tuple[str, bool]:
    try:
        markdown = table_item.export_to_markdown(doc=doc)
        if markdown and markdown.strip():
            return markdown.strip(), True
    except Exception:  # noqa: BLE001
        pass
    return "*[table omitted: rendering failed]*", False


def _item_caption(
    item: PictureItem | TableItem,
    doc: DoclingDocument,
    *,
    nearby_caption: str | None = None,
    spatial_caption: str | None = None,
) -> tuple[
    str | None,
    Literal["docling_caption", "nearby_text", "pdf_text_caption", "missing"],
]:
    try:
        caption = clean_caption_text(item.caption_text(doc))
    except Exception:  # noqa: BLE001
        caption = None
    if caption:
        return caption, "docling_caption"
    nearby = clean_caption_text(nearby_caption)
    if nearby:
        return nearby, "nearby_text"
    spatial = clean_caption_text(spatial_caption)
    if spatial:
        return spatial, "pdf_text_caption"
    return None, "missing"


def _nearby_caption_text(
    flat_items: list[_FlatItem],
    target: _FlatItem,
    consumed_refs: set[str],
    *,
    kind: Literal["figure", "table"],
) -> str | None:
    """Recover an unlinked caption without stealing ordinary body text."""
    marker = re.compile(r"^(?:fig(?:ure)?\.?|table)\s*[A-Z0-9IVX.-]+\b", re.IGNORECASE)
    candidates = (
        flat_items[max(0, target.index - 3) : target.index]
        + flat_items[target.index + 1 : target.index + 4]
    )
    for item in candidates:
        if item.page_no != target.page_no or not item.text:
            continue
        if item.self_ref and item.self_ref in consumed_refs:
            continue
        text = clean_caption_text(item.text)
        if not text or len(text) > 1000:
            continue
        is_caption_label = item.label == "caption"
        marker_match = marker.search(text)
        if not is_caption_label and not marker_match:
            continue
        if (
            kind == "figure"
            and marker_match
            and marker_match.group(0).casefold().startswith("table")
        ):
            continue
        if (
            kind == "table"
            and marker_match
            and not marker_match.group(0).casefold().startswith("table")
        ):
            continue
        if item.self_ref:
            consumed_refs.add(item.self_ref)
        return text
    return None


def _pdf_spatial_caption_map(
    pdf_path: Path, flat_items: list[_FlatItem]
) -> dict[int, str]:
    """Recover captions Docling omitted by matching PDF text blocks spatially.

    Docling can identify a picture/table while dropping its caption item from
    the document tree. PyMuPDF still exposes that caption in the PDF text
    layer. Only explicit Figure/Fig./Table-prefixed blocks on the same page,
    with meaningful horizontal overlap and a small vertical gap, qualify.
    """
    targets_by_page: dict[int, list[_FlatItem]] = {}
    for item in flat_items:
        if item.label in {"picture", "table"} and item.page_no and item.bbox:
            targets_by_page.setdefault(item.page_no, []).append(item)
    if not targets_by_page:
        return {}

    resolved: dict[int, str] = {}
    try:
        with pymupdf.open(str(pdf_path)) as pdf:
            for page_no, targets in targets_by_page.items():
                if not (1 <= page_no <= pdf.page_count):
                    continue
                page = pdf[page_no - 1]
                candidates: list[
                    tuple[str, tuple[float, float, float, float], str]
                ] = []
                for block in page.get_text("blocks"):
                    text = clean_caption_text(block[4])
                    kind = _caption_marker_kind(text)
                    if not text or not kind or len(text) > 5000:
                        continue
                    candidates.append(
                        (
                            kind,
                            (
                                float(block[0]),
                                float(block[1]),
                                float(block[2]),
                                float(block[3]),
                            ),
                            text,
                        )
                    )

                used: set[int] = set()
                for target in targets:
                    target_rect = _docling_bbox_to_pdf_rect(
                        target.bbox, page.rect.height
                    )
                    if target_rect is None:
                        continue
                    target_kind = "figure" if target.label == "picture" else "table"
                    ranked: list[tuple[float, int, str]] = []
                    for index, (kind, caption_rect, text) in enumerate(candidates):
                        if index in used or kind != target_kind:
                            continue
                        overlap = max(
                            0.0,
                            min(target_rect[2], caption_rect[2])
                            - max(target_rect[0], caption_rect[0]),
                        )
                        min_width = min(
                            target_rect[2] - target_rect[0],
                            caption_rect[2] - caption_rect[0],
                        )
                        if min_width <= 0 or overlap / min_width < 0.3:
                            continue
                        gap = _vertical_gap(target_rect, caption_rect)
                        if gap > 120:
                            continue
                        center_delta = abs(
                            ((target_rect[0] + target_rect[2]) / 2)
                            - ((caption_rect[0] + caption_rect[2]) / 2)
                        )
                        ranked.append((gap + center_delta * 0.02, index, text))
                    if ranked:
                        _score, index, text = min(ranked)
                        used.add(index)
                        resolved[target.index] = text
    except Exception:  # noqa: BLE001 - this is a best-effort caption fallback
        return {}
    return resolved


def _caption_marker_kind(text: str | None) -> Literal["figure", "table"] | None:
    if not text:
        return None
    match = re.match(r"^(fig(?:ure)?\.?|table)\s*[A-Z0-9IVX.-]+\b", text, re.IGNORECASE)
    if not match:
        return None
    return "table" if match.group(1).casefold() == "table" else "figure"


def _docling_bbox_to_pdf_rect(
    bbox: list[float] | None, page_height: float
) -> tuple[float, float, float, float] | None:
    if not bbox or len(bbox) != 4:
        return None
    left, top, right, bottom = bbox
    return (
        min(left, right),
        page_height - max(top, bottom),
        max(left, right),
        page_height - min(top, bottom),
    )


def _vertical_gap(
    first: tuple[float, float, float, float],
    second: tuple[float, float, float, float],
) -> float:
    if second[3] < first[1]:
        return first[1] - second[3]
    if second[1] > first[3]:
        return second[1] - first[3]
    return 0.0


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


def _find_references_start(flat_items: list[_FlatItem]) -> int | None:
    """Return a conservative reading-order boundary for an article bibliography."""
    minimum_index = max(1, len(flat_items) // 5)
    for item in flat_items:
        if item.index < minimum_index or not item.text:
            continue
        if item.label not in HEADING_LABELS:
            continue
        heading = normalize_title(item.text)
        if _REFERENCE_HEADING_RE.fullmatch(heading):
            return item.index
    return None


def _extract_article_metadata(
    flat_items: list[_FlatItem],
    pdf_path: Path,
    native: _NativePdfMetadata,
) -> _ArticleMetadata:
    first_page = [item for item in flat_items if item.page_no in (None, 1)]
    title_items = [item for item in first_page if item.label == "title" and item.text]
    extracted_title = normalize_title(title_items[0].text) if title_items else ""
    title = _prefer_article_title(extracted_title, native.title, pdf_path.stem)

    subtitle: str | None = None
    if len(title_items) > 1:
        candidate = normalize_title(title_items[1].text or "")
        if candidate and _title_key(candidate) not in _title_key(title):
            subtitle = candidate

    authors = native.authors or _extract_author_lines(flat_items, title_items)
    front_text = "\n".join(
        item.text or "" for item in flat_items if item.page_no in (None, 1, 2)
    )
    doi_match = _DOI_RE.search(front_text)
    doi = _normalize_doi(native.doi or (doi_match.group(0) if doi_match else None))
    year = native.year or _extract_year(front_text)
    journal = native.journal or _extract_journal_hint(first_page)

    return _ArticleMetadata(
        title=title,
        subtitle=subtitle,
        authors=authors,
        year=year,
        journal=journal,
        doi=doi,
    )


def _prefer_article_title(extracted: str, native: str | None, fallback: str) -> str:
    native = normalize_title(native or "")
    fallback = normalize_title(fallback)
    # PDF metadata often contains a filename, scanner label, or a truncated
    # running title. Prefer a structured first-page title when it is plausible.
    if (
        extracted
        and 4 <= len(extracted) <= 500
        and extracted.casefold() not in {"untitled", "title"}
    ):
        return extracted
    if native and native.casefold() not in {"untitled", "title"}:
        return native
    return fallback


def _extract_author_lines(
    flat_items: list[_FlatItem], title_items: list[_FlatItem]
) -> list[str]:
    if not title_items:
        return []
    title_index = title_items[-1].index
    names: list[str] = []
    for item in flat_items[title_index + 1 :]:
        if item.page_no not in (None, 1, 2):
            break
        text = clean_caption_text(item.text)
        if not text:
            continue
        if item.label in HEADING_LABELS or _ABSTRACT_HEADING_RE.fullmatch(text):
            break
        if _AUTHOR_NOISE_RE.search(text) or len(text) > 300 or text.endswith("."):
            continue
        if not (2 <= len(text.split()) <= 35):
            continue
        cleaned = re.sub(r"(?<=\D)[*†‡,]?\s*\d+(?:\s*,\s*\d+)*\b", "", text)
        for name in re.split(r"\s*(?:;|\band\b|&)\s*", cleaned, flags=re.IGNORECASE):
            name = name.strip(" ,;*†‡")
            if name and any(char.isalpha() for char in name):
                names.append(name)
        if names:
            break
    return _dedupe_strings(names)


def _extract_year(text: str) -> int | None:
    years = [int(match.group(0)) for match in _YEAR_RE.finditer(text)]
    plausible = [year for year in years if 1900 <= year <= 2100]
    return plausible[0] if plausible else None


def _extract_journal_hint(first_page: list[_FlatItem]) -> str | None:
    for item in first_page:
        text = clean_caption_text(item.text)
        if not text or len(text) > 240:
            continue
        marker = re.search(
            r"\b(?:vol(?:ume)?\.?\s*\d+|issue\s*\d+|issn\b)", text, re.IGNORECASE
        )
        if marker:
            journal = text[: marker.start()].rstrip(" ,;:|-")
            return journal or text
    return None


def _pdf_native_metadata(pdf_path: Path) -> _NativePdfMetadata:
    try:
        with pymupdf.open(str(pdf_path)) as pdf:
            raw = pdf.metadata or {}
            xmp = pdf.get_xml_metadata() or ""
    except Exception:  # noqa: BLE001 - structured extraction remains usable
        return _NativePdfMetadata()

    xmp_values = _parse_xmp(xmp)
    authors = xmp_values.get("creator", []) or _split_authors(raw.get("author"))
    date_text = (
        _first(xmp_values.get("publicationDate")) or raw.get("creationDate") or ""
    )
    title = _first(xmp_values.get("title")) or clean_caption_text(raw.get("title"))
    journal = (
        _first(xmp_values.get("publicationName"))
        or _first(xmp_values.get("source"))
        or None
    )
    raw_doi = _first(xmp_values.get("doi"))
    if not raw_doi:
        haystack = " ".join(str(raw.get(key) or "") for key in ("subject", "keywords"))
        match = _DOI_RE.search(haystack)
        raw_doi = match.group(0) if match else None
    return _NativePdfMetadata(
        title=title,
        authors=_dedupe_strings(authors),
        year=_extract_year(date_text),
        journal=clean_caption_text(journal),
        doi=_normalize_doi(raw_doi),
    )


def _parse_xmp(xml: str) -> dict[str, list[str]]:
    if not xml.strip():
        return {}
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return {}
    wanted = {
        "title",
        "creator",
        "source",
        "publicationName",
        "publicationDate",
        "doi",
    }
    values: dict[str, list[str]] = {}
    for element in root.iter():
        local = element.tag.rsplit("}", 1)[-1]
        if local not in wanted:
            continue
        children = [
            clean_caption_text("".join(child.itertext()))
            for child in element.iter()
            if child is not element and child.tag.rsplit("}", 1)[-1] == "li"
        ]
        extracted = [value for value in children if value]
        if not extracted:
            value = clean_caption_text("".join(element.itertext()))
            extracted = [value] if value else []
        if extracted:
            values.setdefault(local, []).extend(extracted)
    return values


def _split_authors(value: str | None) -> list[str]:
    if not value:
        return []
    return _dedupe_strings(
        part.strip()
        for part in re.split(r"\s*(?:;|\band\b|&)\s*", value, flags=re.IGNORECASE)
    )


def _dedupe_strings(values: Iterable[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        cleaned = clean_caption_text(str(value))
        if not cleaned or cleaned.casefold() in seen:
            continue
        seen.add(cleaned.casefold())
        result.append(cleaned)
    return result


def _first(values: list[str] | None) -> str | None:
    return values[0] if values else None


def _normalize_doi(value: str | None) -> str | None:
    if not value:
        return None
    match = _DOI_RE.search(value)
    if not match:
        return None
    doi = match.group(0).rstrip(".,;")
    while doi.endswith(")") and doi.count(")") > doi.count("("):
        doi = doi[:-1]
    return doi


def _doc_title(doc: DoclingDocument, pdf_path: Path) -> str:
    for item, _level in doc.iterate_items(with_groups=False):
        label = getattr(item, "label", None)
        label_value = label.value if hasattr(label, "value") else str(label)
        if label_value == "title":
            title = normalize_title(getattr(item, "text", "") or "")
            if title:
                return title
    return pdf_path.stem
