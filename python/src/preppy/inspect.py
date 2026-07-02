"""Validates an existing source pack against the output contract.

Used by `preppy inspect OUTPUT` and internally by `preppy build` right after
writing, so both entry points share one definition of "valid output"
(IMPLEMENTATION_PLAN section 10, PRD section 14).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from preppy.models import FiguresIndex, Manifest
from preppy.paths import DIAGNOSTICS_FILENAME, DOCUMENT_FILENAME, FIGURES_FILENAME, MANIFEST_FILENAME

_IMAGE_LINK_RE = re.compile(r"!\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
_REMOTE_SCHEME_RE = re.compile(r"^(https?://|data:)", re.IGNORECASE)

Severity = Literal["error", "warning"]


@dataclass(slots=True)
class InspectIssue:
    severity: Severity
    message: str


@dataclass(slots=True)
class InspectReport:
    output_dir: Path
    chapter_count: int = 0
    figure_count: int = 0
    issues: list[InspectIssue] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not any(issue.severity == "error" for issue in self.issues)

    @property
    def errors(self) -> list[InspectIssue]:
        return [issue for issue in self.issues if issue.severity == "error"]

    @property
    def warnings(self) -> list[InspectIssue]:
        return [issue for issue in self.issues if issue.severity == "warning"]


def inspect_output(output_dir: Path) -> InspectReport:
    report = InspectReport(output_dir=output_dir)

    if not output_dir.is_dir():
        report.issues.append(InspectIssue("error", f"Output directory does not exist: {output_dir}"))
        return report

    manifest = _load_manifest(output_dir, report)
    figures_index = _load_figures(output_dir, report)
    _check_diagnostics_present(output_dir, report)

    if manifest is None:
        return report

    report.chapter_count = len(manifest.chapters)
    report.figure_count = len(figures_index.figures) if figures_index else 0

    if manifest.source.type not in ("pdf", "epub"):
        report.issues.append(InspectIssue("error", f"Unsupported source type: {manifest.source.type!r}"))

    if not manifest.chapters:
        report.issues.append(InspectIssue("error", "Manifest lists zero chapters."))

    _check_chapter_indexes(manifest, report)
    _check_chapter_paths(manifest, output_dir, report)
    _check_markdown_image_links(manifest, output_dir, report)

    figure_ids: set[str] = set()
    if figures_index is not None:
        figure_ids = _check_figure_ids(figures_index, report)
        _check_figure_assets(figures_index, output_dir, report)
    _check_figure_id_references(manifest, figure_ids, report)

    return report


def _load_manifest(output_dir: Path, report: InspectReport) -> Manifest | None:
    path = output_dir / MANIFEST_FILENAME
    if not path.exists():
        report.issues.append(InspectIssue("error", f"Missing {MANIFEST_FILENAME}"))
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        report.issues.append(InspectIssue("error", f"Could not parse {MANIFEST_FILENAME}: {exc}"))
        return None
    try:
        return Manifest.model_validate(data)
    except Exception as exc:  # noqa: BLE001 - surfaced as an inspect finding, not a crash
        report.issues.append(
            InspectIssue("error", f"{MANIFEST_FILENAME} does not match the manifest schema: {exc}")
        )
        return None


def _load_figures(output_dir: Path, report: InspectReport) -> FiguresIndex | None:
    path = output_dir / FIGURES_FILENAME
    if not path.exists():
        report.issues.append(InspectIssue("error", f"Missing {FIGURES_FILENAME}"))
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        report.issues.append(InspectIssue("error", f"Could not parse {FIGURES_FILENAME}: {exc}"))
        return None
    try:
        return FiguresIndex.model_validate(data)
    except Exception as exc:  # noqa: BLE001
        report.issues.append(
            InspectIssue("error", f"{FIGURES_FILENAME} does not match the figures schema: {exc}")
        )
        return None


def _check_diagnostics_present(output_dir: Path, report: InspectReport) -> None:
    path = output_dir / DIAGNOSTICS_FILENAME
    if not path.exists():
        report.issues.append(InspectIssue("error", f"Missing {DIAGNOSTICS_FILENAME}"))
        return
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        report.issues.append(InspectIssue("error", f"Could not parse {DIAGNOSTICS_FILENAME}: {exc}"))
        return
    for error in data.get("errors", []):
        if error.get("fatal"):
            report.issues.append(
                InspectIssue("error", f"Conversion reported a fatal error: {error.get('message')}")
            )
    if not (output_dir / DOCUMENT_FILENAME).exists():
        report.issues.append(InspectIssue("warning", f"Missing {DOCUMENT_FILENAME}"))


def _check_chapter_indexes(manifest: Manifest, report: InspectReport) -> None:
    indexes = sorted(chapter.index for chapter in manifest.chapters)
    expected = list(range(1, len(indexes) + 1))
    if indexes != expected:
        report.issues.append(
            InspectIssue("error", f"Chapter indexes are not contiguous starting at 1: {indexes}")
        )


def _check_chapter_paths(manifest: Manifest, output_dir: Path, report: InspectReport) -> None:
    seen: set[str] = set()
    for chapter in manifest.chapters:
        if chapter.path in seen:
            report.issues.append(InspectIssue("error", f"Duplicate chapter path: {chapter.path}"))
        seen.add(chapter.path)
        if not (output_dir / chapter.path).is_file():
            report.issues.append(
                InspectIssue("error", f"Chapter {chapter.index} path does not exist: {chapter.path}")
            )


def _check_figure_ids(figures_index: FiguresIndex, report: InspectReport) -> set[str]:
    seen: set[str] = set()
    for figure in figures_index.figures:
        if figure.id in seen:
            report.issues.append(InspectIssue("error", f"Duplicate figure id: {figure.id}"))
        seen.add(figure.id)
    return seen


def _check_figure_assets(figures_index: FiguresIndex, output_dir: Path, report: InspectReport) -> None:
    for figure in figures_index.figures:
        if not (output_dir / figure.asset_path).is_file():
            report.issues.append(
                InspectIssue("error", f"Figure {figure.id} asset does not exist: {figure.asset_path}")
            )


def _check_markdown_image_links(manifest: Manifest, output_dir: Path, report: InspectReport) -> None:
    for chapter in manifest.chapters:
        chapter_path = output_dir / chapter.path
        if not chapter_path.is_file():
            continue
        text = chapter_path.read_text(encoding="utf-8")
        for match in _IMAGE_LINK_RE.finditer(text):
            link = match.group(1)
            if _REMOTE_SCHEME_RE.match(link):
                continue
            resolved = (chapter_path.parent / link).resolve()
            if not resolved.is_file():
                report.issues.append(
                    InspectIssue(
                        "error",
                        f"Chapter {chapter.index} ({chapter.path}) has a broken image link: {link}",
                    )
                )


def _check_figure_id_references(manifest: Manifest, figure_ids: set[str], report: InspectReport) -> None:
    for chapter in manifest.chapters:
        for figure_id in chapter.figure_ids:
            if figure_id not in figure_ids:
                report.issues.append(
                    InspectIssue(
                        "error", f"Chapter {chapter.index} references unknown figure id: {figure_id}"
                    )
                )
