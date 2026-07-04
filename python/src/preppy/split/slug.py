"""Stable slug generation for chapter filenames."""

from __future__ import annotations

import re
import unicodedata


def slugify(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold()
    value = re.sub(r"[^\w]+", "-", value, flags=re.UNICODE)
    value = value.replace("_", "-")
    return value.strip("-") or "section"
