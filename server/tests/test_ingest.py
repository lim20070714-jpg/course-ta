from app.core.ingest import chunk_pages


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
