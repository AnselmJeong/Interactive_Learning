"""Figure asset registration: stable ids, byte-level dedup, dimension probing."""

from __future__ import annotations

import io
from dataclasses import dataclass

from PIL import Image

from preppy.hashing import sha256_bytes


@dataclass(slots=True)
class ExportedFigure:
    figure_id: str
    filename: str
    sha256: str
    width: int | None
    height: int | None
    is_new: bool


class FigureExporter:
    """Assigns stable ``fig-XXXX`` ids and dedups identical image bytes document-wide."""

    def __init__(self) -> None:
        self._by_hash: dict[str, ExportedFigure] = {}
        self._count = 0

    def register(self, image_bytes: bytes, suffix: str) -> ExportedFigure:
        digest = sha256_bytes(image_bytes)
        existing = self._by_hash.get(digest)
        if existing is not None:
            return ExportedFigure(
                figure_id=existing.figure_id,
                filename=existing.filename,
                sha256=digest,
                width=existing.width,
                height=existing.height,
                is_new=False,
            )

        self._count += 1
        figure_id = f"fig-{self._count:04d}"
        filename = f"{figure_id}{suffix}"
        width, height = probe_dimensions(image_bytes)
        exported = ExportedFigure(
            figure_id=figure_id,
            filename=filename,
            sha256=digest,
            width=width,
            height=height,
            is_new=True,
        )
        self._by_hash[digest] = exported
        return exported


def probe_dimensions(image_bytes: bytes) -> tuple[int | None, int | None]:
    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            return img.width, img.height
    except Exception:
        return None, None
