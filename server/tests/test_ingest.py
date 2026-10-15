import asyncio

import pytest

from app.core import ingest
from app.core.ingest import (
    _collapse_delimiter_pieces,
    _decode_span,
    _embed_with_retry,
    _font_family,
    _frag_score,
    _repair_targets,
    _rows_from_spans,
    chunk_pages,
)


def test_chunk_pages_preserves_page_numbers() -> None:
    pages = [(1, "a" * 600), (2, "b" * 300)]
    chunks = chunk_pages(pages, chunk_size=500, overlap=50)
    assert [c["page"] for c in chunks] == [1, 1, 2]
    assert all(len(c["text"]) <= 500 for c in chunks)


def test_chunk_pages_overlap() -> None:
    chunks = chunk_pages([(1, "x" * 600)], chunk_size=500, overlap=50)
    assert len(chunks) == 2
    assert chunks[1]["text"].startswith(chunks[0]["text"][-50:])


def test_chunk_pages_skips_blank() -> None:
    assert chunk_pages([(1, "   \n  "), (2, "")]) == []


def test_decode_span_symbol_pua() -> None:
    text, lost = _decode_span("\uf062\uf057\uf03d", "symbol")
    assert text == "βΩ="
    assert lost == 0


def test_decode_span_wingding_pua() -> None:
    text, lost = _decode_span("\uf06e\uf08c", "wingding1")
    assert text == "■❶"
    assert lost == 0


def test_decode_span_glitch_chars() -> None:
    text, lost = _decode_span("\u0b36\u0b34\u0b3e", "symbol")
    assert text == "20+"
    assert lost == 0


def test_decode_span_glitch_delims_and_primes() -> None:
    text, lost = _decode_span("\u1242\u11f1\u1264\u1243", "symbol")
    assert text == "[′|]"
    assert lost == 0


def test_decode_span_glitch_drop() -> None:
    text, lost = _decode_span("Z\u04a7", "symbol")
    assert text == "Z"
    assert lost == 1


def test_decode_span_unknown_chars() -> None:
    text, lost = _decode_span("\uf000\u0b31", "symbol")
    assert text == "□"
    assert lost == 2


def test_decode_span_nfkc_math_alphanumeric() -> None:
    text, lost = _decode_span("\U0001d400\ufb01", "symbol")
    assert text == "Afi"
    assert lost == 0


def test_font_family_by_name() -> None:
    assert _font_family("SymbolMT", set()) == "symbol"
    assert _font_family("Wingdings", set()) == "wingding1"
    assert _font_family("Wingdings 2", set()) == "wingding2"
    assert _font_family("Wingdings 3", set()) == "wingding3"


def test_font_family_anonymous_subset_by_codes() -> None:
    assert _font_family("ABCDEF+CMR10", {0x8C}) == "wingding1"
    assert _font_family("ABCDEF+CMR10", {0x44, 0x57}) == "symbol"


def test_rows_from_spans_merges_fragments() -> None:
    spans = [
        (110, 101, 160, 113, 12, "电压"),
        (10, 100, 60, 112, 12, "已知"),
        (10, 130, 60, 142, 12, "求解"),
    ]
    assert _rows_from_spans(spans) == ["已知 电压", "求解"]


def test_rows_from_spans_adjacent_no_space() -> None:
    spans = [(10, 100, 40, 112, 12, "已知"), (41, 100, 80, 112, 12, "电压")]
    assert _rows_from_spans(spans) == ["已知电压"]


def test_rows_from_spans_splits_far_apart_rows() -> None:
    spans = [
        (0, 100, 50, 112, 12, "第一行"),
        (0, 130, 50, 142, 12, "第二行"),
    ]
    assert _rows_from_spans(spans) == ["第一行", "第二行"]


def test_collapse_delimiter_pieces() -> None:
    text, pieces = _collapse_delimiter_pieces("⎛\n⎜\n⎝\n(R)")
    assert text == "(R)"
    assert pieces == 3


def test_collapse_delimiter_pieces_keeps_nested() -> None:
    text, pieces = _collapse_delimiter_pieces("((a+b)) 与 (c)")
    assert text == "((a+b)) 与 (c)"
    assert pieces == 0


def test_frag_score() -> None:
    assert _frag_score("一行正常长度的文字，不构成碎片") == 0
    assert _frag_score("\n".join(["1"] * 12)) == 4
    assert _frag_score("\n".join(["a"] * 100)) == 20


def test_repair_targets_threshold_and_length() -> None:
    pages = [(1, "x" * 100, 3), (2, "x" * 100, 4), (3, "太短", 10), (4, "x" * 100, 0)]
    assert _repair_targets(pages) == [(2, "x" * 100)]


def test_repair_targets_caps_pages() -> None:
    pages = [(i, "y" * 100, 5) for i in range(1, 71)]
    assert len(_repair_targets(pages)) == 60


def test_repair_targets_prefers_worst_pages() -> None:
    pages = [(1, "a" * 100, 5), (2, "b" * 100, 20), (3, "c" * 100, 10)]
    assert _repair_targets(pages) == [(2, "b" * 100), (3, "c" * 100), (1, "a" * 100)]


def test_embed_with_retry_succeeds_after_transient_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"n": 0}

    async def fake_embed(batch: list[str]) -> list[list[float]]:
        calls["n"] += 1
        if calls["n"] < 3:
            raise RuntimeError("502 Bad Gateway")
        return [[1.0, 2.0]]

    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(ingest.llm, "embed", fake_embed)
    monkeypatch.setattr(asyncio, "sleep", no_sleep)
    assert asyncio.run(_embed_with_retry(["x"])) == [[1.0, 2.0]]
    assert calls["n"] == 3


def test_embed_with_retry_reraises_after_last_attempt(monkeypatch: pytest.MonkeyPatch) -> None:
    async def always_fail(batch: list[str]) -> list[list[float]]:
        raise RuntimeError("502 Bad Gateway")

    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(ingest.llm, "embed", always_fail)
    monkeypatch.setattr(asyncio, "sleep", no_sleep)
    with pytest.raises(RuntimeError, match="502"):
        asyncio.run(_embed_with_retry(["x"]))
