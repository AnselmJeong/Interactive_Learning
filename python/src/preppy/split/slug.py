"""Stable slug generation for chapter filenames."""

from __future__ import annotations

import re


def slugify(value: str) -> str:
    value = value.casefold()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-") or "section"
