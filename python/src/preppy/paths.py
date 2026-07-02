"""Output-directory layout constants and path helpers for the source-pack contract."""

from __future__ import annotations

from pathlib import Path

CHAPTERS_DIR = "chapters"
ASSETS_DIR = "assets"
MANIFEST_FILENAME = "manifest.json"
FIGURES_FILENAME = "figures.json"
DIAGNOSTICS_FILENAME = "diagnostics.json"
DOCUMENT_FILENAME = "document.json"


def chapter_filename(index: int, slug: str) -> str:
    return f"{index:03d}-{slug}.md"


def chapter_relpath(index: int, slug: str) -> str:
    return f"{CHAPTERS_DIR}/{chapter_filename(index, slug)}"


def asset_relpath(filename: str) -> str:
    return f"{ASSETS_DIR}/{filename}"


def markdown_asset_link(filename: str) -> str:
    """Relative path to an asset as referenced from inside a chapter Markdown file."""
    return f"../{ASSETS_DIR}/{filename}"


def output_paths(output_dir: Path) -> dict[str, Path]:
    return {
        "root": output_dir,
        "chapters": output_dir / CHAPTERS_DIR,
        "assets": output_dir / ASSETS_DIR,
        "manifest": output_dir / MANIFEST_FILENAME,
        "figures": output_dir / FIGURES_FILENAME,
        "diagnostics": output_dir / DIAGNOSTICS_FILENAME,
        "document": output_dir / DOCUMENT_FILENAME,
    }
