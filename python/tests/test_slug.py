from preppy.split.slug import slugify


def test_slugify_preserves_ascii_filename_behavior() -> None:
    assert slugify("The Straight Path: Philosophy and Islam") == "the-straight-path-philosophy-and-islam"


def test_slugify_preserves_korean_chapter_titles() -> None:
    assert slugify("제7장 문화와 관련된 아테네") == "제7장-문화와-관련된-아테네"


def test_slugify_preserves_greek_names() -> None:
    assert slugify("Πρωταγόρας") == "πρωταγόρασ"
