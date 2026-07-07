"""Figure filtering heuristics shared by source import engines."""

from __future__ import annotations

MIN_FIGURE_MAX_EDGE_PX = 180
MIN_FIGURE_AREA_PX = 20_000
MIN_PDF_PLACEMENT_MAX_EDGE_PT = 72.0
MIN_PDF_PLACEMENT_PAGE_AREA_RATIO = 0.01


def is_too_small_figure(
    width: int | None,
    height: int | None,
    *,
    bbox: list[float] | None = None,
    page_size: tuple[float, float] | None = None,
) -> bool:
    """Return true for icon-sized/decorative images that should not be imported.

    PDF placement is more reliable than embedded pixel dimensions, because a
    low-resolution image can still be a large figure on the page. When the
    physical placement is unavailable, fall back to exported pixel dimensions.
    """

    placement_result = _small_by_pdf_placement(bbox, page_size)
    if placement_result is not None:
        return placement_result
    return _small_by_pixels(width, height)


def _small_by_pdf_placement(
    bbox: list[float] | None, page_size: tuple[float, float] | None
) -> bool | None:
    if not bbox or len(bbox) < 4:
        return None

    box_width = abs(float(bbox[2]) - float(bbox[0]))
    box_height = abs(float(bbox[3]) - float(bbox[1]))
    if box_width <= 0 or box_height <= 0:
        return None

    if max(box_width, box_height) < MIN_PDF_PLACEMENT_MAX_EDGE_PT:
        return True

    if page_size is None:
        return False

    page_width, page_height = page_size
    page_area = page_width * page_height
    if page_area <= 0:
        return False

    return (box_width * box_height) / page_area < MIN_PDF_PLACEMENT_PAGE_AREA_RATIO


def _small_by_pixels(width: int | None, height: int | None) -> bool:
    if width is None or height is None or width <= 0 or height <= 0:
        return False
    return (
        max(width, height) < MIN_FIGURE_MAX_EDGE_PX
        or width * height < MIN_FIGURE_AREA_PX
    )
