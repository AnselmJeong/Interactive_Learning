"""PyMuPDF fallback: degraded single-chapter recovery when Docling conversion fails.

Only invoked when the primary Docling pipeline raises (see
``pdf_docling.convert``). Produces a valid but degraded source pack: the
whole document as one chapter, best-effort text and image extraction, no
real chapter boundaries or caption inference. Always recorded in
diagnostics per PRD section 11 ("Fallbacks ... must be visible in diagnostics").
"""

from __future__ import annotations

import time
from pathlib import Path

import pymupdf

from preppy.figures.export import FigureExporter
from preppy.hashing import sha256_file
from preppy.markdown.render import render_chapter_markdown
from preppy.models import (
    Chapter,
    ChapterContent,
    ChapterDetectionDiagnostics,
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
from preppy.paths import asset_relpath, chapter_relpath
from preppy.split.slug import slugify


def convert(pdf_path: Path, *, reason: str, elapsed_seconds: float = 0.0) -> PreppyDocument:
    start_time = time.monotonic()
    doc = pymupdf.open(str(pdf_path))
    try:
        metadata = doc.metadata or {}
        title = metadata.get("title") or pdf_path.stem
        author = metadata.get("author") or None

        pages_text = [page.get_text("text") for page in doc]
        body_text = "\n\n".join(text.strip() for text in pages_text if text.strip())

        exporter = FigureExporter()
        figures: list[FigureAsset] = []
        figure_ids: list[str] = []
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
                    figures.append(FigureAsset(meta=figure_meta, image_bytes=image_bytes))
                figure_ids.append(exported.figure_id)

        markdown = render_chapter_markdown(title, body_text)
        slug = slugify(title)
        chapter_meta = Chapter(
            index=1,
            title=title,
            kind="chapter",
            slug=slug,
            path=chapter_relpath(1, slug),
            source_locator=SourceLocator(page_start=1, page_end=doc.page_count),
            char_count=len(body_text),
            figure_ids=figure_ids,
            boundary_reason="fallback-pymupdf-whole-document",
            boundary_confidence=0.2,
        )
        chapters = [ChapterContent(meta=chapter_meta, markdown=markdown)]

        source = SourceInfo(
            path=str(pdf_path),
            filename=pdf_path.name,
            type="pdf",
            sha256=sha256_file(pdf_path),
            title=title,
            author=author,
            language=None,
        )

        document_model = DocumentModel(
            source_type="pdf",
            items=[DocumentItem(kind="fallback-whole-document", text=title)],
            meta={"num_pages": doc.page_count, "engine": "pymupdf-fallback"},
        )

        elapsed = elapsed_seconds + (time.monotonic() - start_time)
        duplicate_count = len(figure_ids) - len(figures)
        diagnostics = Diagnostics(
            conversion=ConversionDiagnostics(
                input_type="pdf",
                engine="fallback_pymupdf",
                options={},
                elapsed_seconds=elapsed,
                fallback_used=True,
                fallback_reason=reason,
            ),
            chapter_detection=ChapterDetectionDiagnostics(
                method="fallback-single-chapter",
                candidates=[],
                selected_count=1,
            ),
            figures=FigureDiagnostics(
                found=len(figure_ids),
                exported=len(figures),
                skipped=0,
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
                skipped_images=0,
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
            errors=[ErrorRecord(message=f"Docling conversion failed: {reason}", fatal=False)],
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


def convert_unreadable(pdf_path: Path, *, reason: str, elapsed_seconds: float = 0.0) -> PreppyDocument:
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
        chapter_detection=ChapterDetectionDiagnostics(method="unreadable", candidates=[], selected_count=0),
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
