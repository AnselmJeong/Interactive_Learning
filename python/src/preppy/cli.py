"""Typer CLI: `preppy INPUT` (defaults to build), `preppy plan`, `preppy inspect`."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

import click
import typer
from rich.console import Console
from typer.core import TyperGroup

from preppy.diagnostics import render_diagnostics
from preppy.engines import epub_dom, pdf_docling
from preppy.inspect import InspectReport, inspect_output
from preppy.models import PreppyDocument
from preppy.split.plan import SplitPlan, load_plan, save_plan
from preppy.writers import write_source_pack


class _DefaultBuildGroup(TyperGroup):
    """Lets `preppy INPUT` work without typing `build` explicitly.

    If the first CLI token isn't a known subcommand name (`build`, `plan`,
    `inspect`), it's assumed to be `build`'s input file and `build` is
    inserted ahead of it. Named subcommands are matched exactly first, so
    `preppy plan ...` / `preppy inspect ...` are unaffected.
    """

    def resolve_command(
        self, ctx: click.Context, args: list[str]
    ) -> tuple[str | None, click.Command | None, list[str]]:
        if args and args[0] not in self.commands:
            args = ["build", *args]
        return super().resolve_command(ctx, args)


app = typer.Typer(
    cls=_DefaultBuildGroup,
    name="preppy",
    help="Build Interactive_Learning-ready chapter Markdown source packs from PDF and EPUB books.",
    no_args_is_help=True,
    add_completion=False,
)
console = Console()


def _detect_input_type(path: Path) -> Literal["pdf", "epub"]:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return "pdf"
    if suffix == ".epub":
        return "epub"
    console.print(f"[bold red]Unsupported input type {path.suffix!r}. Expected .pdf or .epub.[/bold red]")
    raise typer.Exit(code=1)


@app.command()
def build(
    input_path: Path = typer.Argument(..., exists=True, dir_okay=False, metavar="INPUT", help="Path to the source PDF or EPUB."),
    output: Path | None = typer.Option(
        None,
        "-o",
        "--output",
        file_okay=False,
        help="Directory to write the source pack into. Defaults to ./output.",
    ),
    plan: Path | None = typer.Option(
        None, "--plan", exists=True, dir_okay=False, help="Use a reviewed split-plan JSON instead of auto-detecting boundaries."
    ),
    include_frontmatter: bool = typer.Option(
        False, "--include-frontmatter/--exclude-frontmatter", help="Include cover, preface, TOC, and similar front matter."
    ),
    include_backmatter: bool = typer.Option(
        False, "--include-backmatter/--exclude-backmatter", help="Include notes, index, bibliography, and similar back matter."
    ),
    ocr: bool = typer.Option(False, "--ocr/--no-ocr", help="PDF only: enable OCR for scanned pages (Docling)."),
    table_structure: bool = typer.Option(
        True, "--table-structure/--no-table-structure", help="PDF only: enable table structure recognition."
    ),
    extract_figures: bool = typer.Option(
        True, "--extract-figures/--no-extract-figures", help="Export figures into assets/ and link them from Markdown."
    ),
    images_scale: float = typer.Option(2.0, "--images-scale", help="PDF only: resolution multiplier for exported figures."),
    boundary_pattern: str | None = typer.Option(
        None, "--boundary-pattern", help=r"Regex for headings that start a new chapter, e.g. '^(Chapter|CHAPTER)\b'."
    ),
    min_chapter_chars: int = typer.Option(1000, "--min-chapter-chars", help="Warn when a chapter has fewer characters than this."),
    overwrite: bool = typer.Option(False, "--overwrite", help="Replace an existing output directory."),
    json_output: bool = typer.Option(False, "--json", help="Print a machine-readable JSON summary instead of a Rich report."),
) -> None:
    """Convert a PDF or EPUB book into an Interactive_Learning-ready source pack."""
    output_console = Console(stderr=json_output)
    input_type = _detect_input_type(input_path)
    if output is None:
        output = Path("output")

    if output.exists() and not overwrite:
        output_console.print(f"[bold red]Output already exists: {output}. Use --overwrite to replace it.[/bold red]")
        raise typer.Exit(code=1)

    with output_console.status(f"[bold green]Converting {input_path.name}...[/bold green]", spinner="dots12"):
        document = _run_build(
            input_path,
            input_type,
            plan_path=plan,
            include_frontmatter=include_frontmatter,
            include_backmatter=include_backmatter,
            ocr=ocr,
            table_structure=table_structure,
            extract_figures=extract_figures,
            images_scale=images_scale,
            boundary_pattern=boundary_pattern,
            min_chapter_chars=min_chapter_chars,
        )
        write_source_pack(document, output, overwrite=overwrite)

    report = inspect_output(output)

    if json_output:
        console.print_json(data=_json_summary(document, output, report))
    else:
        output_console.print(f"[bold green]Wrote source pack to {output}[/bold green]")
        if document.diagnostics is not None:
            render_diagnostics(document.diagnostics, output_console)
        _print_inspect_issues(report)

    has_fatal = document.diagnostics is not None and document.diagnostics.has_fatal_errors
    if not report.ok or has_fatal:
        raise typer.Exit(code=1)


def _run_build(
    input_path: Path,
    input_type: Literal["pdf", "epub"],
    *,
    plan_path: Path | None,
    include_frontmatter: bool,
    include_backmatter: bool,
    ocr: bool,
    table_structure: bool,
    extract_figures: bool,
    images_scale: float,
    boundary_pattern: str | None,
    min_chapter_chars: int,
) -> PreppyDocument:
    if input_type == "epub":
        split_plan = load_plan(plan_path) if plan_path is not None else epub_dom.build_plan(
            input_path, boundary_pattern=boundary_pattern
        )
        return epub_dom.convert(
            input_path,
            split_plan,
            include_frontmatter=include_frontmatter,
            include_backmatter=include_backmatter,
            extract_figures=extract_figures,
            min_chapter_chars=min_chapter_chars,
        )

    pdf_plan = load_plan(plan_path) if plan_path is not None else None
    return pdf_docling.convert(
        input_path,
        pdf_plan,
        ocr=ocr,
        table_structure=table_structure,
        extract_figures=extract_figures,
        images_scale=images_scale,
        boundary_pattern=boundary_pattern,
        include_frontmatter=include_frontmatter,
        include_backmatter=include_backmatter,
        min_chapter_chars=min_chapter_chars,
    )


@app.command(name="plan")
def make_plan(
    input_path: Path = typer.Argument(..., exists=True, dir_okay=False, metavar="INPUT", help="Path to the source PDF or EPUB."),
    output: Path = typer.Option(..., "-o", "--output", dir_okay=False, help="Where to write the editable split-plan JSON."),
    boundary_pattern: str | None = typer.Option(
        None, "--boundary-pattern", help=r"Regex for headings that start a new chapter, e.g. '^(Chapter|CHAPTER)\b'."
    ),
    ocr: bool = typer.Option(False, "--ocr/--no-ocr", help="PDF only: enable OCR while detecting boundaries."),
    table_structure: bool = typer.Option(
        True, "--table-structure/--no-table-structure", help="PDF only: enable table structure recognition."
    ),
) -> None:
    """Detect chapter boundaries and write an editable split plan, without building the source pack."""
    input_type = _detect_input_type(input_path)

    with console.status(f"[bold green]Analyzing {input_path.name}...[/bold green]", spinner="dots12"):
        if input_type == "epub":
            split_plan = epub_dom.build_plan(input_path, boundary_pattern=boundary_pattern)
        else:
            split_plan = pdf_docling.build_plan(
                input_path, boundary_pattern=boundary_pattern, ocr=ocr, table_structure=table_structure
            )

    save_plan(split_plan, output)
    selected = sum(1 for candidate in split_plan.candidates if candidate.selected)
    console.print(
        f"Wrote split plan to [cyan]{output}[/cyan] "
        f"({selected}/{len(split_plan.candidates)} candidates selected as chapters)"
    )
    _print_plan_table(split_plan)


@app.command(name="inspect")
def inspect_cmd(
    output: Path = typer.Argument(..., exists=True, file_okay=False, help="Source-pack directory to validate."),
    json_output: bool = typer.Option(False, "--json", help="Print a machine-readable JSON report instead of text."),
) -> None:
    """Validate an existing source pack and report import risks."""
    report = inspect_output(output)

    if json_output:
        console.print_json(
            data={
                "ok": report.ok,
                "chapter_count": report.chapter_count,
                "figure_count": report.figure_count,
                "issues": [{"severity": i.severity, "message": i.message} for i in report.issues],
            }
        )
    else:
        console.print(
            f"[bold]{output}[/bold]: {report.chapter_count} chapters, {report.figure_count} figures"
        )
        _print_inspect_issues(report)
        console.print("[bold green]OK[/bold green]" if report.ok else "[bold red]BROKEN[/bold red]")

    raise typer.Exit(code=0 if report.ok else 1)


def _print_inspect_issues(report: InspectReport) -> None:
    if not report.issues:
        console.print("[green]No issues found.[/green]")
        return
    for issue in report.issues:
        style = "bold red" if issue.severity == "error" else "yellow"
        console.print(f"[{style}]{issue.severity.upper()}[/{style}] {issue.message}")


def _print_plan_table(split_plan: SplitPlan) -> None:
    from rich.table import Table

    table = Table(title=f"{split_plan.title} ({split_plan.source_type})")
    table.add_column("#", justify="right", style="cyan", no_wrap=True)
    table.add_column("Use", style="green")
    table.add_column("Lvl", justify="right")
    table.add_column("Kind", style="magenta")
    table.add_column("Title", style="bold")
    table.add_column("Reason", style="yellow")
    table.add_column("Conf.", justify="right")
    for candidate in split_plan.candidates:
        table.add_row(
            str(candidate.order),
            "yes" if candidate.selected else "no",
            str(candidate.outline_level or candidate.heading_level or "-"),
            candidate.kind,
            candidate.title,
            candidate.reason,
            f"{candidate.confidence:.2f}",
        )
    console.print(table)


def _json_summary(document: PreppyDocument, output: Path, report: InspectReport) -> dict:
    return {
        "output": str(output),
        "ok": report.ok,
        "chapter_count": report.chapter_count,
        "figure_count": report.figure_count,
        "issues": [{"severity": i.severity, "message": i.message} for i in report.issues],
        "diagnostics": document.diagnostics.model_dump(mode="json") if document.diagnostics else None,
    }


if __name__ == "__main__":
    app()
