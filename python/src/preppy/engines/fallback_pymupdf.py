"""PyMuPDF fallback: degraded single-chapter recovery when Docling conversion fails.

Only invoked when the primary Docling pipeline raises (see
``pdf_docling.convert``). Produces a valid but degraded source pack: the
whole document as one chapter, best-effort text and image extraction, no
real chapter boundaries or caption inference. Always recorded in
diagnostics per PRD section 11 ("Fallbacks ... must be visible in diagnostics").
"""

from __future__ import annotations

import re
import time
from pathlib import Path

import pymupdf

from preppy.figures.export import FigureExporter, probe_dimensions
from preppy.figures.filters import is_too_small_figure
from preppy.hashing import sha256_file
from preppy.markdown.render import render_chapter_markdown
from preppy.models import (
    Chapter,
    ChapterContent,
    ChapterDetectionDiagnostics,
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
)
from preppy.paths import asset_relpath, chapter_relpath
from preppy.split.slug import slugify


def convert(
    pdf_path: Path,
    *,
    reason: str,
    elapsed_seconds: float = 0.0,
    document_type: DocumentType = "book",
    include_backmatter: bool = False,
) -> PreppyDocument:
    start_time = time.monotonic()
    doc = pymupdf.open(str(pdf_path))
    try:
        metadata = doc.metadata or {}
        title = metadata.get("title") or pdf_path.stem
        author = metadata.get("author") or None

        pages_text = [page.get_text("text") for page in doc]
        body_text = "\n\n".join(text.strip() for text in pages_text if text.strip())
        references_removed = False
        if document_type == "article" and not include_backmatter:
            body_text, references_removed = _strip_article_references(body_text)

        exporter = FigureExporter()
        figures: list[FigureAsset] = []
        figure_ids: list[str] = []
        figures_found = 0
        figures_skipped = 0
        for page_index, page in enumerate(doc, start=1):
            for image in page.get_images(full=True):
                xref = image[0]
                try:
                    extracted = doc.extract_image(xref)
                except Exception:  # noqa: BLE001 - best-effort recovery only
                    continue
                image_bytes = extracted.get("image")
                if not image_bytes:
                    continue
                figures_found += 1
                width, height = probe_dimensions(image_bytes)
                bbox = _image_bbox(page, xref)
                page_size = (float(page.rect.width), float(page.rect.height))
                if is_too_small_figure(width, height, bbox=bbox, page_size=page_size):
                    figures_skipped += 1
                    continue
                suffix = f".{extracted.get('ext', 'png')}"
                exported = exporter.register(image_bytes, suffix)
                if exported.is_new:
                    figure_meta = Figure(
                        id=exported.figure_id,
                        asset_path=asset_relpath(exported.filename),
                        source_type="pdf",
                        chapter_index=1,
                        caption=None,
                        caption_status="missing",
                        source_locator=SourceLocator(page=page_index),
                        width=exported.width,
                        height=exported.height,
                        sha256=exported.sha256,
                    )
                    figures.append(
                        FigureAsset(meta=figure_meta, image_bytes=image_bytes)
                    )
                figure_ids.append(exported.figure_id)

        markdown = render_chapter_markdown(title, body_text)
        slug = slugify(title)
        chapter_meta = Chapter(
            index=1,
            title=title,
            kind="article" if document_type == "article" else "chapter",
            slug=slug,
            path=chapter_relpath(1, slug),
            source_locator=SourceLocator(page_start=1, page_end=doc.page_count),
            char_count=len(body_text),
            figure_ids=figure_ids,
            boundary_reason=(
                "fallback-pymupdf-article"
                if document_type == "article"
                else "fallback-pymupdf-whole-document"
            ),
            boundary_confidence=0.2,
        )
        chapters = [ChapterContent(meta=chapter_meta, markdown=markdown)]

        source = SourceInfo(
            path=str(pdf_path),
            filename=pdf_path.name,
            type="pdf",
            sha256=sha256_file(pdf_path),
            document_type=document_type,
            title=title,
            author=author,
            authors=[
                part.strip()
                for part in re.split(r";|\band\b", author or "", flags=re.IGNORECASE)
                if part.strip()
            ],
            year=_metadata_year(metadata.get("creationDate")),
            language=None,
        )

        document_model = DocumentModel(
            source_type="pdf",
            items=[DocumentItem(kind="fallback-whole-document", text=title)],
            meta={
                "num_pages": doc.page_count,
                "engine": "pymupdf-fallback",
                "document_type": document_type,
                "references_removed": references_removed,
            },
        )

        elapsed = elapsed_seconds + (time.monotonic() - start_time)
        duplicate_count = len(figure_ids) - len(figures)
        diagnostics = Diagnostics(
            conversion=ConversionDiagnostics(
                input_type="pdf",
                engine="fallback_pymupdf",
                options={
                    "document_type": document_type,
                    "references_removed": references_removed,
                },
                elapsed_seconds=elapsed,
                fallback_used=True,
                fallback_reason=reason,
            ),
            chapter_detection=ChapterDetectionDiagnostics(
                method=(
                    "fallback-single-article"
                    if document_type == "article"
                    else "fallback-single-chapter"
                ),
                candidates=[],
                selected_count=1,
            ),
            figures=FigureDiagnostics(
                found=figures_found,
                exported=len(figures),
                skipped=figures_skipped,
                duplicates=duplicate_count,
                missing_captions=len(figures),
            ),
            quality=QualityDiagnostics(
                chapter_count=1,
                selected_boundary_count=1,
                mean_chapter_chars=float(len(body_text)),
                min_chapter_chars=len(body_text),
                figures_exported=len(figures),
                figures_with_captions=0,
                skipped_images=figures_skipped,
                fallback_usage_count=1,
                warnings=[
                    QualityWarning(
                        code="docling-fallback",
                        message=(
                            "Docling conversion failed; used the degraded PyMuPDF fallback. "
                            f"Reason: {reason}"
                        ),
                        severity="error",
                    )
                ],
            ),
            errors=[
                ErrorRecord(message=f"Docling conversion failed: {reason}", fatal=False)
            ],
        )

        return PreppyDocument(
            source=source,
            chapters=chapters,
            figures=figures,
            document_model=document_model,
            diagnostics=diagnostics,
        )
    finally:
        doc.close()


def _image_bbox(page: pymupdf.Page, xref: int) -> list[float] | None:
    try:
        rects = page.get_image_rects(xref)
    except Exception:  # noqa: BLE001
        return None
    if not rects:
        return None
    rect = max(rects, key=lambda item: abs(float(item.width) * float(item.height)))
    return [float(rect.x0), float(rect.y0), float(rect.x1), float(rect.y1)]


def _strip_article_references(text: str) -> tuple[str, bool]:
    match = re.search(
        r"(?im)^\s*(?:references?|bibliography|works cited|literature cited|"
        r"literaturverzeichnis|références|referencias|참고\s*문헌|参考文献)\s*[:.]?\s*$",
        text,
    )
    if not match or match.start() < len(text) // 5:
        return text, False
    return text[: match.start()].rstrip(), True


def _metadata_year(value: str | None) -> int | None:
    match = re.search(r"\b(?:19|20)\d{2}\b", value or "")
    return int(match.group(0)) if match else None


def convert_unreadable(
    pdf_path: Path,
    *,
    reason: str,
    elapsed_seconds: float = 0.0,
    document_type: DocumentType = "book",
) -> PreppyDocument:
    """Last-resort result when even the PyMuPDF fallback cannot open the file.

    Returns a structurally valid but empty ``PreppyDocument`` (zero chapters,
    a fatal error record) so the CLI can still write a source pack and
    ``preppy inspect`` can report it as broken, instead of the process
    crashing with a raw traceback.
    """
    try:
        digest = sha256_file(pdf_path)
    except OSError:
        digest = ""

    source = SourceInfo(
        path=str(pdf_path),
        filename=pdf_path.name,
        type="pdf",
        sha256=digest,
        document_type=document_type,
        title=pdf_path.stem,
    )
    diagnostics = Diagnostics(
        conversion=ConversionDiagnostics(
            input_type="pdf",
            engine="fallback_pymupdf",
            elapsed_seconds=elapsed_seconds,
            fallback_used=True,
            fallback_reason=reason,
        ),
        chapter_detection=ChapterDetectionDiagnostics(
            method="unreadable", candidates=[], selected_count=0
        ),
        figures=FigureDiagnostics(),
        quality=QualityDiagnostics(
            warnings=[
                QualityWarning(
                    code="unreadable-pdf",
                    message=f"PDF could not be read by Docling or the PyMuPDF fallback: {reason}",
                    severity="error",
                )
            ]
        ),
        errors=[ErrorRecord(message=f"PDF unreadable: {reason}", fatal=True)],
    )
    return PreppyDocument(
        source=source,
        chapters=[],
        figures=[],
        document_model=DocumentModel(source_type="pdf"),
        diagnostics=diagnostics,
    )
