"""Rich console rendering of a Diagnostics object, shared by `build` and `inspect`."""

from __future__ import annotations

from rich.console import Console
from rich.table import Table

from preppy.models import Diagnostics

_SEVERITY_STYLE = {"error": "bold red", "warning": "yellow", "info": "cyan"}


def render_diagnostics(diagnostics: Diagnostics, console: Console) -> None:
    conversion = diagnostics.conversion
    quality = diagnostics.quality
    figures = diagnostics.figures
    tables = diagnostics.tables

    table = Table(title="Conversion Summary", show_header=False)
    table.add_row("Engine", f"{conversion.engine} ({conversion.input_type})")
    table.add_row("Elapsed", f"{conversion.elapsed_seconds:.2f}s")
    table.add_row("Content units", f"{quality.chapter_count} selected")
    table.add_row(
        "Content size",
        f"mean {quality.mean_chapter_chars:.0f} chars, min {quality.min_chapter_chars} chars",
    )
    table.add_row(
        "Figures",
        f"{figures.exported} exported, {figures.skipped} skipped, "
        f"{figures.duplicates} duplicates, {figures.missing_captions} missing captions",
    )
    if figures.compound_groups:
        table.add_row(
            "Compound figures",
            f"{figures.compound_groups} groups from {figures.compound_panels} panels",
        )
    table.add_row(
        "Tables",
        f"{tables.rendered} rendered, {tables.failed} failed, "
        f"{tables.missing_captions} missing captions",
    )
    if conversion.fallback_used:
        table.add_row("Fallback", conversion.fallback_reason or "(no reason recorded)")
    console.print(table)

    for warning in quality.warnings:
        style = _SEVERITY_STYLE.get(warning.severity, "white")
        console.print(
            f"[{style}]{warning.severity.upper()}[/{style}] {warning.message}"
        )

    for error in diagnostics.errors:
        label = "FATAL" if error.fatal else "ERROR"
        console.print(f"[bold red]{label}[/bold red] {error.message}")
