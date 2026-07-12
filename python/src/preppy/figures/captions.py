"""EPUB figure caption inference and decorative-image detection.

Caption sources are tried in order of reliability: ``<figcaption>``, a
caption-like class on an ancestor, a caption-like following sibling, then a
short caption-like preceding sibling. Anything else is recorded as missing
rather than guessed at, per PRD section 13.
"""

from __future__ import annotations

import re

from bs4 import Tag

from preppy.models import CaptionStatus

_CAPTION_CLASS_RE = re.compile(r"cap(tion)?|fig(ure)?|plate|illustration", re.IGNORECASE)
_DECORATIVE_RE = re.compile(
    r"cover|logo|ornament|divider|spacer|bullet|(^|[_-])rule([_-]|$)|border|icon[_-]|publisher",
    re.IGNORECASE,
)
_MAX_CAPTION_WORDS = 60
_MAX_SHORT_CAPTION_WORDS = 25
_MIN_MEANINGFUL_DIMENSION = 32


def infer_caption(img: Tag) -> tuple[str | None, CaptionStatus, Tag | None]:
    """Infer a figure's caption text.

    Returns ``(text, status, source)`` where ``source`` is the DOM element the
    caption text was read from, or ``None`` when no caption was found. The
    caller should ``decompose()`` ``source`` once done, so its text is not
    rendered a second time as ordinary body content. ``source`` is always a
    sibling of ``img`` (or of its ``<figure>`` wrapper), never an ancestor,
    and never contains another image. This ensures decomposing it cannot
    invalidate either the current image or an image still awaiting processing.
    """
    figure = img.find_parent("figure")

    if figure is not None:
        figcaption = figure.find("figcaption")
        if figcaption is not None and not _contains_image(figcaption):
            text = clean_caption_text(figcaption.get_text(" ", strip=True))
            if text:
                return text, "epub_figcaption", figcaption

    anchor = figure or img

    next_sibling = _next_tag_sibling(anchor)
    # Some illustrated EPUBs represent a two-part plate as adjacent figures,
    # with the shared caption stored only in the second figure. Preserve the
    # existing shared-caption behavior without returning that image-bearing
    # figure as a disposable caption source.
    if figure is not None and next_sibling is not None and _contains_image(next_sibling):
        shared_caption = next_sibling.find("figcaption")
        if shared_caption is not None and not _contains_image(shared_caption):
            text = clean_caption_text(shared_caption.get_text(" ", strip=True))
            if text:
                return text, "epub_adjacent_text", None

    if (
        next_sibling is not None
        and _has_caption_class(next_sibling)
        and not _contains_image(next_sibling)
    ):
        text = clean_caption_text(next_sibling.get_text(" ", strip=True))
        if text:
            return text, "epub_adjacent_text", next_sibling

    # A caption-like element living alongside the image inside a shared
    # non-figure wrapper, e.g. <div class="figure"><img/><span class="caption">.
    if figure is None and img.parent is not None:
        for sibling in img.parent.find_all(class_=_CAPTION_CLASS_RE, recursive=False):
            if sibling is img or _contains_image(sibling):
                continue
            text = clean_caption_text(sibling.get_text(" ", strip=True))
            if text:
                return text, "epub_adjacent_text", sibling

    prev_sibling = _previous_tag_sibling(anchor)
    if prev_sibling is not None and looks_like_caption(prev_sibling, short=True):
        text = clean_caption_text(prev_sibling.get_text(" ", strip=True))
        if text:
            return text, "nearby_text", prev_sibling

    return None, "missing", None


def looks_like_caption(node: Tag, *, short: bool = False) -> bool:
    if _contains_image(node):
        return False
    if _has_caption_class(node):
        return True
    if node.name not in {"p", "span", "div", "small", "em", "i"}:
        return False
    text = node.get_text(" ", strip=True)
    if not text:
        return False
    word_count = len(text.split())
    limit = _MAX_SHORT_CAPTION_WORDS if short else _MAX_CAPTION_WORDS
    return word_count <= limit


def is_decorative(img: Tag, src: str) -> bool:
    class_attr = " ".join(_class_list(img))
    if _DECORATIVE_RE.search(src) or _DECORATIVE_RE.search(class_attr):
        return True
    width = _int_or_none(img.get("width"))
    height = _int_or_none(img.get("height"))
    if (
        width is not None
        and height is not None
        and (width < _MIN_MEANINGFUL_DIMENSION or height < _MIN_MEANINGFUL_DIMENSION)
    ):
        return True
    return False


def clean_caption_text(text: str | None) -> str | None:
    if not text:
        return None
    text = re.sub(r"\s+", " ", text).strip()
    return text or None


def _next_tag_sibling(node: Tag) -> Tag | None:
    for sibling in node.next_siblings:
        if isinstance(sibling, Tag):
            return sibling
    return None


def _previous_tag_sibling(node: Tag) -> Tag | None:
    for sibling in node.previous_siblings:
        if isinstance(sibling, Tag):
            return sibling
    return None


def _has_caption_class(node: Tag) -> bool:
    class_attr = " ".join(_class_list(node))
    return bool(_CAPTION_CLASS_RE.search(class_attr))


def _contains_image(node: Tag) -> bool:
    """Return whether deleting a caption candidate would also delete an image."""
    return node.find("img") is not None


def _class_list(node: Tag) -> list[str]:
    """Normalize bs4's ``class`` attribute value to a list of class tokens.

    ``html.parser`` always gives a list for the registered multi-valued
    ``class`` attribute, but the type stubs allow a bare string too; joining
    a raw string with ``" ".join(...)`` would silently space out its
    characters instead, so this guards against that regardless of parser.
    """
    value: object = node.get("class") or []
    if isinstance(value, str):
        return [value]
    return list(value)


def _int_or_none(value: object) -> int | None:
    if not isinstance(value, (str, int, float)):
        return None
    try:
        return int(float(value))
    except ValueError:
        return None
