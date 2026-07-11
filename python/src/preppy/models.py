"""Normalized data model shared by every Preppy engine, writer, and inspector."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

SourceType = Literal["pdf", "epub"]

ChapterKind = Literal[
    "chapter",
    "frontmatter",
    "backmatter",
    "appendix",
    "notes",
    "bibliography",
    "index",
    "unknown",
]

CaptionStatus = Literal[
    "docling_caption",
    "epub_figcaption",
    "epub_adjacent_text",
    "nearby_text",
    "missing",
    "ambiguous",
]

Severity = Literal["info", "warning", "error"]


class PreppyModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SourceInfo(PreppyModel):
    path: str
    filename: str
    type: SourceType
    sha256: str
    title: str | None = None
    author: str | None = None
    language: str | None = None


class SourceLocator(PreppyModel):
    page_start: int | None = None
    page_end: int | None = None
    page: int | None = None
    bbox: list[float] | None = None
    epub_href: str | None = None
    anchor: str | None = None
    docling_ref: str | None = None


class Chapter(PreppyModel):
    index: int
    title: str
    kind: ChapterKind
    slug: str
    path: str
    source_locator: SourceLocator = Field(default_factory=SourceLocator)
    char_count: int
    figure_ids: list[str] = Field(default_factory=list)
    boundary_reason: str
    boundary_confidence: float = 1.0
    # Optional structural context for books whose chapters are nested under
    # Part / Book / Unit containers in the PDF outline.
    parent_title: str | None = None
    outline_level: int | None = None


class Figure(PreppyModel):
    id: str
    asset_path: str
    source_type: SourceType
    chapter_index: int | None
    caption: str | None
    caption_status: CaptionStatus
    source_locator: SourceLocator = Field(default_factory=SourceLocator)
    width: int | None
    height: int | None
    sha256: str


class OutputPaths(PreppyModel):
    chapters_dir: str = "chapters"
    assets_dir: str = "assets"
    figures_index: str = "figures.json"
    diagnostics: str = "diagnostics.json"
    document_model: str = "document.json"


class Manifest(PreppyModel):
    schema_version: int = 1
    tool: str = "preppy"
    tool_version: str
    source: SourceInfo
    output: OutputPaths = Field(default_factory=OutputPaths)
    chapters: list[Chapter] = Field(default_factory=list)


class FiguresIndex(PreppyModel):
    figures: list[Figure] = Field(default_factory=list)


class DocumentItem(PreppyModel):
    kind: str
    level: int | None = None
    text: str | None = None
    source_locator: SourceLocator = Field(default_factory=SourceLocator)


class DocumentModel(PreppyModel):
    source_type: SourceType
    items: list[DocumentItem] = Field(default_factory=list)
    meta: dict[str, Any] = Field(default_factory=dict)


class ConversionDiagnostics(PreppyModel):
    input_type: SourceType
    engine: str
    options: dict[str, Any] = Field(default_factory=dict)
    elapsed_seconds: float = 0.0
    fallback_used: bool = False
    fallback_reason: str | None = None


class BoundaryDiagnostic(PreppyModel):
    title: str
    kind: ChapterKind
    reason: str
    confidence: float
    selected: bool
    source_locator: SourceLocator = Field(default_factory=SourceLocator)


class ChapterDetectionDiagnostics(PreppyModel):
    method: str
    candidates: list[BoundaryDiagnostic] = Field(default_factory=list)
    selected_count: int = 0


class FigureDiagnostics(PreppyModel):
    found: int = 0
    exported: int = 0
    skipped: int = 0
    duplicates: int = 0
    missing_captions: int = 0


class QualityWarning(PreppyModel):
    code: str
    message: str
    severity: Severity = "warning"
    context: dict[str, Any] = Field(default_factory=dict)


class QualityDiagnostics(PreppyModel):
    chapter_count: int = 0
    selected_boundary_count: int = 0
    mean_chapter_chars: float = 0.0
    min_chapter_chars: int = 0
    figures_exported: int = 0
    figures_with_captions: int = 0
    skipped_images: int = 0
    fallback_usage_count: int = 0
    warnings: list[QualityWarning] = Field(default_factory=list)


class ErrorRecord(PreppyModel):
    message: str
    fatal: bool = False
    context: dict[str, Any] = Field(default_factory=dict)


class Diagnostics(PreppyModel):
    conversion: ConversionDiagnostics
    chapter_detection: ChapterDetectionDiagnostics
    figures: FigureDiagnostics = Field(default_factory=FigureDiagnostics)
    quality: QualityDiagnostics = Field(default_factory=QualityDiagnostics)
    errors: list[ErrorRecord] = Field(default_factory=list)

    @property
    def has_fatal_errors(self) -> bool:
        return any(error.fatal for error in self.errors)


@dataclass(slots=True)
class ChapterContent:
    """A chapter's manifest metadata paired with its rendered Markdown body."""

    meta: Chapter
    markdown: str


@dataclass(slots=True)
class FigureAsset:
    """A figure's manifest metadata paired with its raw image bytes."""

    meta: Figure
    image_bytes: bytes


@dataclass(slots=True)
class PreppyDocument:
    """Everything an engine produces for a single conversion run.

    ``writers.py`` consumes this to write the full source-pack contract:
    manifest.json, figures.json, diagnostics.json, document.json, chapter
    Markdown files, and exported figure assets.
    """

    source: SourceInfo
    chapters: list[ChapterContent] = field(default_factory=list)
    figures: list[FigureAsset] = field(default_factory=list)
    document_model: DocumentModel = field(
        default_factory=lambda: DocumentModel(source_type="pdf")
    )
    diagnostics: Diagnostics | None = None
