"""Filesystem writer: turns a PreppyDocument into the full source-pack contract.

Writes to a temporary directory first and only swaps it into place after
every file has been written successfully, so a crash mid-write never leaves
a half-written output directory behind (IMPLEMENTATION_PLAN section 9).
"""

from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path

from preppy import __version__
from preppy.models import (
    FiguresIndex,
    Manifest,
    OutputPaths,
    PreppyDocument,
    TablesIndex,
)
from preppy.paths import output_paths


def write_source_pack(
    document: PreppyDocument, output_dir: Path, *, overwrite: bool = False
) -> None:
    output_dir = output_dir.resolve()
    if output_dir.exists():
        if not overwrite:
            raise FileExistsError(
                f"Output directory already exists: {output_dir}. Use --overwrite to replace it."
            )
        if not output_dir.is_dir():
            raise NotADirectoryError(
                f"Output path exists and is not a directory: {output_dir}"
            )

    output_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=".preppy-build-", dir=output_dir.parent
    ) as tmp:
        staging = Path(tmp) / output_dir.name
        _write_into(document, staging)

        if output_dir.exists():
            shutil.rmtree(output_dir)
        shutil.move(str(staging), str(output_dir))


def _write_into(document: PreppyDocument, root: Path) -> None:
    paths = output_paths(root)
    paths["chapters"].mkdir(parents=True, exist_ok=True)
    paths["assets"].mkdir(parents=True, exist_ok=True)

    for chapter in document.chapters:
        (root / chapter.meta.path).write_text(chapter.markdown, encoding="utf-8")

    for figure in document.figures:
        (root / figure.meta.asset_path).write_bytes(figure.image_bytes)

    manifest = Manifest(
        tool_version=__version__,
        source=document.source,
        output=OutputPaths(),
        chapters=[chapter.meta for chapter in document.chapters],
    )
    _write_json(paths["manifest"], manifest.model_dump(mode="json"))

    figures_index = FiguresIndex(figures=[figure.meta for figure in document.figures])
    _write_json(paths["figures"], figures_index.model_dump(mode="json"))

    tables_index = TablesIndex(tables=document.tables)
    _write_json(paths["tables"], tables_index.model_dump(mode="json"))

    diagnostics_data = (
        document.diagnostics.model_dump(mode="json") if document.diagnostics else {}
    )
    _write_json(paths["diagnostics"], diagnostics_data)

    _write_json(paths["document"], document.document_model.model_dump(mode="json"))


def _write_json(path: Path, data: object) -> None:
    path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
