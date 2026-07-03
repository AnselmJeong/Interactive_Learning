"""EPUB engine: TOC/spine-based chapter boundaries and DOM-native figure export.

Adapted from the proven splitting logic in the sibling ``Epub_Split`` project
(``/Volumes/Aquatope/_DEV_/Epub_Split/src/epub_split/core.py``), retargeted to
Preppy's shared models, figure caption inference, and diagnostics contract.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Iterable, Literal

import ebooklib
from bs4 import BeautifulSoup, Tag
from ebooklib import epub

from preppy.figures.captions import infer_caption, is_decorative
from preppy.figures.export import FigureExporter
from preppy.hashing import sha256_file
from preppy.markdown.render import html_to_markdown, render_chapter_markdown
from preppy.models import (
    BoundaryDiagnostic,
    Chapter,
    ChapterDetectionDiagnostics,
    ChapterContent,
    ConversionDiagnostics,
    Diagnostics,
    DocumentItem,
    DocumentModel,
    ErrorRecord,
    Figure,
    FigureAsset,
    FigureDiagnostics,
    PreppyDocument,
    QualityDiagnostics,
    QualityWarning,
    SourceInfo,
    SourceLocator,
)
from preppy.paths import asset_relpath, chapter_relpath, markdown_asset_link
from preppy.split.classify import classify_kind, fallback_title, normalize_title
from preppy.split.plan import SplitCandidate, SplitPlan, apply_matter_flags, demote_nested_headings
from preppy.split.slug import slugify

BLOCK_NAMES = {
    "article",
    "aside",
    "blockquote",
    "div",
    "dl",
    "figure",
    "h1",
    "h2",
    "h3",
    "header",
    "img",
    "main",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "ul",
}
CONTAINER_NAMES = {"div", "section", "article", "main"}
_WEAK_TITLE_RE = re.compile(
    r"^(?:\d+|[ivxlcdm]+|chapter\s+(?:\d+|[ivxlcdm]+))[.\-:]?$",
    re.IGNORECASE,
)


@dataclass(slots=True)
class _TocEntry:
    href: str
    depth: int
    title: str


@dataclass(slots=True)
class _ImageOutcome:
    kind: Literal["exported", "duplicate", "skipped"]
    figure_id: str | None = None
    asset: FigureAsset | None = None


def build_plan(epub_path: Path, boundary_pattern: str | None = None) -> SplitPlan:
    book = epub.read_epub(str(epub_path))
    toc_entries = [entry for entry in _flatten_toc(book.toc) if entry.depth == 1]
    toc_map = _map_toc_entries(toc_entries)
    docs = _ordered_documents(book)
    pattern = re.compile(boundary_pattern, re.IGNORECASE) if boundary_pattern else None

    candidates: list[SplitCandidate] = []
    candidate_id = 1
    order = 1

    for item in docs:
        soup = BeautifulSoup(item.get_content(), "html.parser")
        parent = _choose_content_parent(soup)
        children = _content_children(parent)
        if not children:
            continue

        doc_href = _normalize_href(item.file_name)
        doc_candidates: dict[int, SplitCandidate] = {}
        entry_list = toc_map.get(doc_href, [])

        for entry in entry_list:
            start_idx, heading_level = _locate_toc_boundary(parent, children, entry.href)
            kind = classify_kind(entry.title, item.file_name)
            title = normalize_title(entry.title) or fallback_title(item.file_name, order)
            doc_candidates.setdefault(
                start_idx,
                SplitCandidate(
                    id=candidate_id + len(doc_candidates),
                    order=0,
                    title=title,
                    kind=kind,
                    reason="toc-top-level",
                    confidence=0.95,
                    selected=kind == "chapter",
                    heading_level=heading_level,
                    source_locator=SourceLocator(
                        epub_href=doc_href, anchor=_fragment_from_href(entry.href)
                    ),
                    epub_start_idx=start_idx,
                ),
            )

        if pattern:
            for idx, child in enumerate(children):
                title = _infer_segment_title(child)
                if not title or not pattern.search(title):
                    continue
                kind = classify_kind(title, item.file_name)
                doc_candidates.setdefault(
                    idx,
                    SplitCandidate(
                        id=candidate_id + len(doc_candidates),
                        order=0,
                        title=title,
                        kind=kind,
                        reason="boundary-pattern",
                        confidence=0.7,
                        selected=kind == "chapter",
                        source_locator=SourceLocator(epub_href=doc_href, anchor=child.get("id")),
                        epub_start_idx=idx,
                    ),
                )

        if not doc_candidates:
            title = _infer_document_title(soup, item.file_name)
            kind = classify_kind(title, item.file_name)
            doc_candidates[0] = SplitCandidate(
                id=candidate_id,
                order=0,
                title=title,
                kind=kind,
                reason="spine-document",
                confidence=0.5,
                selected=kind == "chapter",
                source_locator=SourceLocator(epub_href=doc_href, anchor=None),
                epub_start_idx=0,
            )

        for start_idx in sorted(doc_candidates):
            candidate = doc_candidates[start_idx]
            candidate.id = candidate_id
            candidate.order = order
            candidates.append(candidate)
            candidate_id += 1
            order += 1

    # A book's nav/TOC is often structurally flat (every heading listed as a
    # sibling, regardless of its real h1/h2/h3 depth), so "depth == 1 TOC
    # entry" alone can't tell a chapter from a subsection. Use the actual
    # HTML heading level instead: only the shallowest level found is
    # auto-selected, so a book with "1", "1.1", "1.1.1" style headings
    # produces one chapter per top-level "1", not one per numbered heading.
    demote_nested_headings(candidates, reasons={"toc-top-level"}, demoted_reason="toc-nested")

    book_title = book.title or epub_path.stem
    author = _first_metadata(book, "DC", "creator")
    language = _first_metadata(book, "DC", "language")
    return SplitPlan(
        source_path=str(epub_path),
        source_type="epub",
        title=book_title,
        author=author,
        language=language,
        boundary_pattern=boundary_pattern,
        candidates=candidates,
    )


def convert(
    epub_path: Path,
    plan: SplitPlan,
    *,
    include_frontmatter: bool = False,
    include_backmatter: bool = False,
    extract_figures: bool = True,
    min_chapter_chars: int = 1000,
) -> PreppyDocument:
    start_time = time.monotonic()
    book = epub.read_epub(str(epub_path))
    docs = {_normalize_href(item.file_name): item for item in _ordered_documents(book)}

    source = SourceInfo(
        path=str(epub_path),
        filename=epub_path.name,
        type="epub",
        sha256=sha256_file(epub_path),
        title=plan.title,
        author=plan.author,
        language=plan.language,
    )

    apply_matter_flags(plan.candidates, include_frontmatter=include_frontmatter, include_backmatter=include_backmatter)

    exporter = FigureExporter()
    figures: list[FigureAsset] = []
    chapters: list[ChapterContent] = []
    warnings: list[QualityWarning] = []
    errors: list[ErrorRecord] = []

    figures_found = 0
    figures_skipped = 0
    figures_duplicate = 0
    resolved_candidate_titles: dict[int, str] = {}

    output_index = 1
    for doc_href, group in _group_candidates_by_doc(plan.candidates).items():
        item = docs.get(doc_href)
        if item is None:
            errors.append(ErrorRecord(message=f"Spine document not found: {doc_href}"))
            continue

        soup = BeautifulSoup(item.get_content(), "html.parser")
        parent = _choose_content_parent(soup)
        children = _content_children(parent)
        if not children:
            continue

        selected = sorted((c for c in group if c.selected), key=lambda c: c.epub_start_idx or 0)
        if not selected:
            continue

        for pos, candidate in enumerate(selected):
            start_idx = candidate.epub_start_idx or 0
            next_idx = selected[pos + 1].epub_start_idx if pos + 1 < len(selected) else None
            end_idx = next_idx if next_idx is not None else len(children)
            segment_html = "".join(str(child) for child in children[start_idx:end_idx]).strip()
            if not segment_html:
                continue

            segment_soup = BeautifulSoup(segment_html, "html.parser")
            for node in segment_soup.select("script, style, nav"):
                node.decompose()
            _merge_leading_headings(segment_soup)
            chapter_title = _refine_chapter_title(candidate.title, segment_soup)
            resolved_candidate_titles[candidate.id] = chapter_title

            chapter_figure_ids: list[str] = []
            for img in segment_soup.find_all("img"):
                figures_found += 1
                outcome = _handle_image(
                    img,
                    segment_soup,
                    book=book,
                    doc_href=doc_href,
                    extract_figures=extract_figures,
                    exporter=exporter,
                    chapter_index=output_index,
                )
                if outcome.kind == "skipped":
                    figures_skipped += 1
                    continue
                if outcome.kind == "exported" and outcome.asset is not None:
                    figures.append(outcome.asset)
                elif outcome.kind == "duplicate":
                    figures_duplicate += 1
                if outcome.figure_id:
                    chapter_figure_ids.append(outcome.figure_id)

            body_markdown = html_to_markdown(str(segment_soup))
            markdown = render_chapter_markdown(chapter_title, body_markdown)
            text_len = len(segment_soup.get_text(" ", strip=True))

            slug = slugify(chapter_title)
            chapter_meta = Chapter(
                index=output_index,
                title=chapter_title,
                kind=candidate.kind,
                slug=slug,
                path=chapter_relpath(output_index, slug),
                source_locator=candidate.source_locator,
                char_count=text_len,
                figure_ids=chapter_figure_ids,
                boundary_reason=candidate.reason,
                boundary_confidence=candidate.confidence,
            )
            if text_len < min_chapter_chars:
                warnings.append(
                    QualityWarning(
                        code="short-chapter",
                        message=(
                            f"Chapter {output_index} ('{chapter_title}') has {text_len} "
                            f"characters, below --min-chapter-chars={min_chapter_chars}."
                        ),
                        context={"chapter_index": output_index},
                    )
                )
            chapters.append(ChapterContent(meta=chapter_meta, markdown=markdown))
            output_index += 1

    if not chapters:
        warnings.append(
            QualityWarning(
                code="no-chapters",
                message="No chapters were selected. Check the split plan or --boundary-pattern.",
                severity="error",
            )
        )

    missing_captions = sum(1 for f in figures if f.meta.caption_status == "missing")
    char_counts = [c.meta.char_count for c in chapters]
    elapsed = time.monotonic() - start_time

    document_model = DocumentModel(
        source_type="epub",
        items=[
            DocumentItem(
                kind="boundary",
                text=resolved_candidate_titles.get(c.id, c.title),
                source_locator=c.source_locator,
            )
            for c in plan.candidates
        ],
        meta={
            "spine_documents": len(docs),
            "toc_candidates": sum(1 for c in plan.candidates if c.reason == "toc-top-level"),
        },
    )

    diagnostics = Diagnostics(
        conversion=ConversionDiagnostics(
            input_type="epub",
            engine="epub_dom",
            options={
                "include_frontmatter": include_frontmatter,
                "include_backmatter": include_backmatter,
                "extract_figures": extract_figures,
                "min_chapter_chars": min_chapter_chars,
                "boundary_pattern": plan.boundary_pattern,
            },
            elapsed_seconds=elapsed,
        ),
        chapter_detection=ChapterDetectionDiagnostics(
            method="epub-toc-spine",
            candidates=[
                BoundaryDiagnostic(
                    title=resolved_candidate_titles.get(c.id, c.title),
                    kind=c.kind,
                    reason=c.reason,
                    confidence=c.confidence,
                    selected=c.selected,
                    source_locator=c.source_locator,
                )
                for c in plan.candidates
            ],
            selected_count=len(chapters),
        ),
        figures=FigureDiagnostics(
            found=figures_found,
            exported=len(figures),
            skipped=figures_skipped,
            duplicates=figures_duplicate,
            missing_captions=missing_captions,
        ),
        quality=QualityDiagnostics(
            chapter_count=len(chapters),
            selected_boundary_count=len(chapters),
            mean_chapter_chars=(sum(char_counts) / len(char_counts)) if char_counts else 0.0,
            min_chapter_chars=min(char_counts) if char_counts else 0,
            figures_exported=len(figures),
            figures_with_captions=len(figures) - missing_captions,
            skipped_images=figures_skipped,
            fallback_usage_count=0,
            warnings=warnings,
        ),
        errors=errors,
    )

    return PreppyDocument(
        source=source,
        chapters=chapters,
        figures=figures,
        document_model=document_model,
        diagnostics=diagnostics,
    )


def _handle_image(
    img: Tag,
    soup: BeautifulSoup,
    *,
    book: epub.EpubBook,
    doc_href: str,
    extract_figures: bool,
    exporter: FigureExporter,
    chapter_index: int,
) -> _ImageOutcome:
    src = img.get("src")
    if not extract_figures or not src:
        img.decompose()
        return _ImageOutcome(kind="skipped")

    doc_base = PurePosixPath(doc_href).parent
    resolved = _resolve_book_href(doc_base, src)
    item = book.get_item_with_href(resolved)
    if item is None or not _is_image_item(item):
        img.decompose()
        return _ImageOutcome(kind="skipped")

    if is_decorative(img, resolved):
        img.decompose()
        return _ImageOutcome(kind="skipped")

    image_bytes = item.get_content()
    suffix = PurePosixPath(resolved).suffix or ".bin"
    exported = exporter.register(image_bytes, suffix)
    caption_text, caption_status, caption_source = infer_caption(img)
    if caption_source is not None:
        caption_source.decompose()
    _rewrite_image_node(img, soup, exported.filename, caption_text)

    if not exported.is_new:
        return _ImageOutcome(kind="duplicate", figure_id=exported.figure_id)

    figure_meta = Figure(
        id=exported.figure_id,
        asset_path=asset_relpath(exported.filename),
        source_type="epub",
        chapter_index=chapter_index,
        caption=caption_text,
        caption_status=caption_status,
        source_locator=SourceLocator(epub_href=resolved),
        width=exported.width,
        height=exported.height,
        sha256=exported.sha256,
    )
    asset = FigureAsset(meta=figure_meta, image_bytes=image_bytes)
    return _ImageOutcome(kind="exported", figure_id=exported.figure_id, asset=asset)


def _is_image_item(item: object) -> bool:
    get_type = getattr(item, "get_type", None)
    if callable(get_type):
        try:
            return get_type() == ebooklib.ITEM_IMAGE
        except Exception:
            return False
    media_type = str(getattr(item, "media_type", "") or "").lower()
    return media_type.startswith("image/")


def _rewrite_image_node(img: Tag, soup: BeautifulSoup, filename: str, caption: str | None) -> None:
    img["src"] = markdown_asset_link(filename)
    if caption and not img.get("alt"):
        img["alt"] = caption
    if caption:
        caption_p = soup.new_tag("p")
        caption_p.string = caption
        anchor = img.find_parent("figure") or img
        anchor.insert_after(caption_p)


def _group_candidates_by_doc(candidates: list[SplitCandidate]) -> dict[str, list[SplitCandidate]]:
    grouped: dict[str, list[SplitCandidate]] = {}
    for candidate in candidates:
        href = candidate.source_locator.epub_href or ""
        grouped.setdefault(href, []).append(candidate)
    return grouped


def _ordered_documents(book: epub.EpubBook) -> list:
    documents = {
        item.id: item
        for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT)
        if getattr(item, "file_name", None)
    }
    ordered = []
    for item_id, _linear in book.spine:
        item = documents.get(item_id)
        if item and item.file_name != "nav.xhtml":
            ordered.append(item)
    return ordered


def _flatten_toc(toc: Iterable, depth: int = 1) -> list[_TocEntry]:
    entries: list[_TocEntry] = []
    for item in toc:
        if isinstance(item, tuple) and len(item) == 2:
            section, children = item
            section_href = getattr(section, "href", None)
            section_title = getattr(section, "title", None) or ""
            if section_href:
                entries.append(
                    _TocEntry(href=section_href, depth=depth, title=normalize_title(str(section_title)))
                )
            entries.extend(_flatten_toc(children, depth + 1))
            continue

        href = getattr(item, "href", None) or getattr(item, "file_name", None)
        title = getattr(item, "title", None) or getattr(item, "get_name", lambda: "")()
        if href:
            entries.append(_TocEntry(href=href, depth=depth, title=normalize_title(str(title))))
    return entries


def _map_toc_entries(entries: list[_TocEntry]) -> dict[str, list[_TocEntry]]:
    mapping: dict[str, list[_TocEntry]] = {}
    for entry in entries:
        mapping.setdefault(_base_href(entry.href), []).append(entry)
    return mapping


def _choose_content_parent(soup: BeautifulSoup) -> Tag:
    body = soup.body or soup
    direct = [child for child in body.children if isinstance(child, Tag) and child.name in BLOCK_NAMES]
    if len(direct) == 1 and direct[0].name in CONTAINER_NAMES:
        nested = [
            child for child in direct[0].children if isinstance(child, Tag) and child.name in BLOCK_NAMES
        ]
        if len(nested) >= 2:
            return direct[0]
    return body


def _content_children(parent: Tag) -> list[Tag]:
    return [child for child in parent.children if isinstance(child, Tag) and child.name in BLOCK_NAMES]


def _locate_toc_boundary(parent: Tag, children: list[Tag], href: str) -> tuple[int, int | None]:
    fragment = _fragment_from_href(href)
    if fragment:
        node = parent.find(id=fragment)
        if node:
            for idx, child in enumerate(children):
                if child is node or child.find(id=fragment):
                    level = _heading_level_of(node) or _heading_level_of(child)
                    return idx, level
    return 0, None


_HEADING_NAME_RE = re.compile(r"^h([1-6])$")


def _heading_level_of(node: Tag) -> int | None:
    """The semantic h1-h6 depth of `node` itself, or of its first heading descendant."""
    match = _HEADING_NAME_RE.match(node.name or "")
    if match:
        return int(match.group(1))
    heading = node.find(["h1", "h2", "h3", "h4", "h5", "h6"])
    if heading is not None:
        match = _HEADING_NAME_RE.match(heading.name)
        if match:
            return int(match.group(1))
    return None


def _infer_document_title(soup: BeautifulSoup, file_name: str) -> str:
    body = soup.body or soup
    title = _best_heading_title(_heading_titles(body, limit=6))
    if title:
        return title
    if soup.title and normalize_title(soup.title.get_text(" ", strip=True)):
        return normalize_title(soup.title.get_text(" ", strip=True))
    return fallback_title(file_name, 1)


def _infer_segment_title(node: Tag) -> str | None:
    heading = node if node.name in {"h1", "h2", "h3"} else node.find(["h1", "h2", "h3"])
    if heading:
        title = normalize_title(heading.get_text(" ", strip=True))
        if title:
            return title
    text = normalize_title(node.get_text(" ", strip=True))
    if text:
        return " ".join(text.split()[:10])
    return None


def _refine_chapter_title(candidate_title: str, soup: BeautifulSoup) -> str:
    title = _best_heading_title([candidate_title, *_heading_titles(soup.body or soup, limit=6)])
    return title or candidate_title


def _heading_titles(parent: Tag | BeautifulSoup, *, limit: int) -> list[str]:
    titles: list[str] = []
    for node in parent.find_all(["h1", "h2", "h3"], limit=limit):
        title = normalize_title(node.get_text(" ", strip=True))
        if title:
            titles.append(title)
    return titles


def _best_heading_title(titles: list[str]) -> str | None:
    if not titles:
        return None
    first = titles[0]
    if not _is_weak_title(first):
        return first
    for title in titles[1:]:
        if _is_substantive_heading(title):
            return _join_heading_prefix(first, title)
    return first


def _is_weak_title(title: str) -> bool:
    return bool(_WEAK_TITLE_RE.fullmatch(normalize_title(title)))


def _is_substantive_heading(title: str) -> bool:
    title = normalize_title(title)
    return bool(title and not _is_weak_title(title) and sum(ch.isalpha() for ch in title) >= 3)


def _join_heading_prefix(prefix: str, title: str) -> str:
    clean_prefix = normalize_title(prefix).rstrip(".-:")
    clean_title = normalize_title(title)
    if re.match(rf"^{re.escape(clean_prefix)}(?:[.\-:\s]|$)", clean_title, re.IGNORECASE):
        return clean_title
    return f"{clean_prefix} {clean_title}".strip()


def _merge_leading_headings(soup: BeautifulSoup) -> None:
    body = soup.body or soup
    headings = [child for child in body.children if isinstance(child, Tag) and child.name in {"h1", "h2", "h3"}]
    if len(headings) < 2:
        return
    first, second = headings[0], headings[1]
    first_text = normalize_title(first.get_text(" ", strip=True))
    second_text = normalize_title(second.get_text(" ", strip=True))
    if not first_text or not second_text:
        return
    if not re.fullmatch(r"[0-9ivxlcdm]+[.\-:]?", first_text, re.IGNORECASE):
        return
    second.string = f"{first_text.rstrip('.:-')} {second_text}"
    first.decompose()


def _resolve_book_href(base_dir: PurePosixPath, href: str) -> str:
    parts: list[str] = []
    raw = href.split("#", 1)[0]
    if "://" in raw or raw.startswith("data:"):
        return raw
    for part in (base_dir / raw).parts:
        if part in {"", "."}:
            continue
        if part == "..":
            if parts:
                parts.pop()
            continue
        parts.append(part)
    return "/".join(parts)


def _normalize_href(href: str) -> str:
    return str(PurePosixPath(href))


def _base_href(href: str) -> str:
    return _normalize_href(href.split("#", 1)[0])


def _fragment_from_href(href: str) -> str | None:
    if "#" not in href:
        return None
    return href.split("#", 1)[1] or None


def _first_metadata(book: epub.EpubBook, namespace: str, name: str) -> str | None:
    value = book.get_metadata(namespace, name)
    if not value:
        return None
    return str(value[0][0]).strip().strip(";") or None
