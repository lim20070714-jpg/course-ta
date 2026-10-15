from app.core.pages import merge_page_chunks, merge_texts, snippet_around
from app.models import Chunk


def _chunk(page: int, seq: int, text: str) -> Chunk:
    return Chunk(course_id=1, material_id=1, page=page, seq=seq, text=text)


def test_merge_texts_rejoins_overlap() -> None:
    part1 = "a" * 450 + "b" * 50
    part2 = "b" * 50 + "c" * 450
    assert merge_texts([part1, part2]) == "a" * 450 + "b" * 50 + "c" * 450


def test_merge_texts_without_overlap_concatenates() -> None:
    assert merge_texts(["abc", "def"]) == "abcdef"


def test_merge_texts_empty() -> None:
    assert merge_texts([]) == ""


def test_merge_page_chunks_groups_by_page_and_keeps_order() -> None:
    chunks = [
        _chunk(1, 0, "x" * 100),
        _chunk(1, 1, "x" * 20 + "y" * 80),
        _chunk(2, 2, "z" * 50),
    ]
    merged = merge_page_chunks(chunks)
    assert merged[1] == "x" * 100 + "y" * 80
    assert merged[2] == "z" * 50


def test_snippet_around_finds_query_and_adds_ellipsis() -> None:
    text = "前" * 200 + "目标词" + "后" * 200
    snip = snippet_around(text, "目标词", width=20)
    assert "目标词" in snip
    assert snip.startswith("…") and snip.endswith("…")
    assert len(snip) < 60


def test_snippet_around_no_match_returns_head() -> None:
    snip = snippet_around("abcdef", "zzz", width=2)
    assert snip == "abcd"
