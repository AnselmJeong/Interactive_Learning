from __future__ import annotations

import json
from pathlib import Path

from preppy.inspect import InspectReport, _check_diagnostics_present


def _write_diagnostics(tmp_path: Path, diagnostics: dict[str, object]) -> InspectReport:
    (tmp_path / "diagnostics.json").write_text(
        json.dumps(diagnostics), encoding="utf-8"
    )
    (tmp_path / "document.json").write_text("{}", encoding="utf-8")
    report = InspectReport(output_dir=tmp_path)
    _check_diagnostics_present(tmp_path, report)
    return report


def test_quality_diagnostics_warning_and_error_are_surfaced(tmp_path: Path) -> None:
    report = _write_diagnostics(
        tmp_path,
        {
            "errors": [],
            "quality": {
                "warnings": [
                    {
                        "code": "simulated-warning",
                        "message": "simulated quality warning",
                        "severity": "warning",
                    },
                    {
                        "code": "simulated-error",
                        "message": "simulated quality error",
                        "severity": "error",
                    },
                    {
                        "code": "simulated-info",
                        "message": "simulated informational notice",
                        "severity": "info",
                    },
                ]
            },
        },
    )

    assert any("simulated quality warning" in issue.message for issue in report.warnings)
    assert any("simulated quality error" in issue.message for issue in report.errors)
    assert not any("informational notice" in issue.message for issue in report.issues)


def test_unselected_chapter_like_pdf_heading_is_reported(tmp_path: Path) -> None:
    report = _write_diagnostics(
        tmp_path,
        {
            "errors": [],
            "quality": {"warnings": []},
            "chapter_detection": {
                "method": "docling-headers",
                "candidates": [
                    {
                        "title": "■ CHAPTER 10",
                        "reason": "docling-section-header",
                        "selected": False,
                    }
                ],
            },
        },
    )

    assert any("unselected chapter-like" in issue.message for issue in report.warnings)


def test_outline_authoritative_pdf_does_not_report_suppressed_heading(
    tmp_path: Path,
) -> None:
    report = _write_diagnostics(
        tmp_path,
        {
            "errors": [],
            "quality": {"warnings": []},
            "chapter_detection": {
                "method": "docling-headers+pdf-outline",
                "candidates": [
                    {
                        "title": "■ CHAPTER 10",
                        "reason": "docling-section-header",
                        "selected": False,
                    }
                ],
            },
        },
    )

    assert not any("unselected chapter-like" in issue.message for issue in report.issues)
