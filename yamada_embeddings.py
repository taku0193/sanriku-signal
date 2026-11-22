"""EmbeddingGemma 文書検索と、資料から再生成できるローカル索引。"""

import argparse
import base64
import hashlib
import json
import math
import os
import sys
import tempfile
from array import array
from dataclasses import dataclass
from http.client import HTTPException
from operator import mul
from pathlib import Path
from threading import Lock
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit
from urllib.request import ProxyHandler, Request, build_opener

from yamada_rag import SEARCH_LIMIT, lexical_text, load_records, matched_name_length, name_queries, normalize, search


DEFAULT_MODEL = "embeddinggemma-2:270m"
DEFAULT_EMBED_URL = "http://127.0.0.1:11434/api/embed"
DEFAULT_CACHE = Path(__file__).with_name("embeddings-cache.json")
DOCUMENT_FORMAT = "title: {title} | text: {text}"
QUERY_FORMAT = "task: search result | query: {query}"
CACHE_FORMAT = 1
BATCH_SIZE = 16
RRF_K = 60
SEMANTIC_DEPTH = 12


class EmbeddingError(RuntimeError):
    """埋め込みに失敗したか、ベクトルの互換性を確認できなかった。"""


@dataclass(frozen=True)
class IndexBuildResult:
    indexed: int
    reused: int
    embedded: int
    dimensions: int


@dataclass(frozen=True)
class RetrievalResult:
    records: list
    mode: str


def _model_tag(model):
    return model if ":" in model.rsplit("/", 1)[-1] else f"{model}:latest"


class OllamaEmbedder:
    def __init__(self, model=DEFAULT_MODEL, url=DEFAULT_EMBED_URL, *, timeout=60):
        self.model = model
        self.url = url
        self.timeout = timeout
        self.dimensions = 768 if _model_tag(model) == DEFAULT_MODEL else None
        self._opener = build_opener(ProxyHandler({}))

    def _request(self, url, payload=None):
        try:
            if urlsplit(url).scheme not in ("http", "https"):
                raise ValueError
            if payload is None:
                request = Request(url)
            else:
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                request = Request(url, body, {"Content-Type": "application/json"})
            with self._opener.open(request, timeout=self.timeout) as response:
                data = json.load(response)
            if not isinstance(data, dict):
                raise ValueError
            return data
        except HTTPError as error:
            raise EmbeddingError(f"埋め込み用OllamaがHTTP {error.code}を返しました。") from error
        except (OSError, HTTPException) as error:
            raise EmbeddingError("埋め込み用Ollamaに接続できませんでした。") from error
        except (ValueError, RecursionError) as error:
            raise EmbeddingError("埋め込み用Ollamaの応答または接続先が不正です。") from error

    def model_digest(self):
        data = self._request(urljoin(self.url, "tags"))
        models = data.get("models")
        if not isinstance(models, list):
            raise EmbeddingError("Ollamaのモデル一覧を読み取れませんでした。")
        for item in models:
            if not isinstance(item, dict):
                continue
            name = item.get("name") or item.get("model")
            if isinstance(name, str) and _model_tag(name) == _model_tag(self.model):
                digest = item.get("digest")
                if isinstance(digest, str) and digest:
                    return digest
                break
        raise EmbeddingError(f"Ollamaのモデル一覧で {self.model} の識別情報を確認できません。")

    def embed(self, inputs):
        data = self._request(self.url, {"model": self.model, "input": inputs, "truncate": True})
        model = data.get("model")
        if not isinstance(model, str) or _model_tag(model) != _model_tag(self.model):
            raise EmbeddingError("Ollamaが指定したモデルと異なるモデルを返しました。")
        return data.get("embeddings")


def _default_embedder():
    return OllamaEmbedder(
        model=os.environ.get("YAMADA_EMBED_MODEL") or DEFAULT_MODEL,
        url=os.environ.get("YAMADA_EMBED_URL") or DEFAULT_EMBED_URL,
    )


def _unit_vector(values, dimensions=None):
    if not isinstance(values, (list, tuple)) or not values or (
        dimensions is not None and len(values) != dimensions
    ):
        raise EmbeddingError("埋め込みベクトルの次元が一致しません。")
    if any(type(value) not in (int, float) for value in values):
        raise EmbeddingError("埋め込みベクトルに数値以外の値があります。")
    try:
        norm = math.hypot(*values)
    except OverflowError as error:
        raise EmbeddingError("埋め込みベクトルの値が範囲を超えています。") from error
    if not math.isfinite(norm) or norm == 0:
        raise EmbeddingError("埋め込みベクトルの長さが不正です。")
    return array("f", (value / norm for value in values))


def _embed(embedder, inputs, dimensions=None):
    vectors = embedder.embed(inputs)
    if not isinstance(vectors, (list, tuple)) or len(vectors) != len(inputs):
        raise EmbeddingError("Ollamaが入力と同じ件数の埋め込みを返しませんでした。")
    unit_vectors = []
    for vector in vectors:
        unit = _unit_vector(vector, dimensions)
        dimensions = len(unit)
        unit_vectors.append(unit)
    return unit_vectors


def _documents(records):
    documents = {}
    for record in records:
        record_id = record["id"]
        if record_id in documents:
            raise ValueError(f"資料IDが重複しています ({record_id})。")
        text = DOCUMENT_FORMAT.format(title=record.get("title") or "none", text=record["text"])
        documents[record_id] = (record, text, hashlib.sha256(text.encode("utf-8")).hexdigest())
    return documents


def _model_digest(embedder):
    digest = getattr(embedder, "model_digest", None)
    return digest() if digest is not None else None


def _cache_header(embedder):
    return {
        "version": CACHE_FORMAT,
        "model": _model_tag(embedder.model),
        "model_digest": _model_digest(embedder),
        "input_format": {"document": DOCUMENT_FORMAT, "query": QUERY_FORMAT},
        "vector_format": "float32-le-base64",
    }


def _read_cache(path):
    try:
        with path.open(encoding="utf-8") as file:
            cache = json.load(file)
        if isinstance(cache, dict):
            return cache
    except (OSError, ValueError, RecursionError):
        pass
    return {}


def _compatible_cache(cache, embedder):
    dimensions = cache.get("dimensions")
    expected = getattr(embedder, "dimensions", None)
    return (
        cache.get("version") == CACHE_FORMAT
        and cache.get("model") == _model_tag(embedder.model)
        and cache.get("input_format") == {"document": DOCUMENT_FORMAT, "query": QUERY_FORMAT}
        and cache.get("vector_format") == "float32-le-base64"
        and isinstance(cache.get("records"), dict)
        and type(dimensions) is int
        and dimensions > 0
        and (expected is None or dimensions == expected)
    )


def _encode(vector):
    if sys.byteorder != "little":
        vector = array("f", vector)
        vector.byteswap()
    return base64.b64encode(vector.tobytes()).decode("ascii")


def _decode(encoded, dimensions):
    if not isinstance(encoded, str) or len(encoded) != 4 * ((dimensions * 4 + 2) // 3):
        return None
    try:
        raw = base64.b64decode(encoded, validate=True)
    except ValueError:
        return None
    if len(raw) != dimensions * 4:
        return None
    vector = array("f")
    vector.frombytes(raw)
    if sys.byteorder != "little":
        vector.byteswap()
    # 索引には正規化済みの float32 を保存する。ゼロ・NaN・壊れた長さを除く。
    if not math.isclose(math.hypot(*vector), 1.0, rel_tol=1e-5):
        return None
    return vector


def _cached_entry(entries, record_id, input_hash, dimensions):
    entry = entries.get(record_id)
    if isinstance(entry, dict) and entry.get("input_sha256") == input_hash:
        vector = _decode(entry.get("vector"), dimensions)
        if vector is not None:
            return entry, vector
    return None, None


def _write_cache(path, contents):
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False,
        ) as file:
            temp_path = Path(file.name)
            json.dump(contents, file, ensure_ascii=False, separators=(",", ":"))
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp_path, path)
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def build_index(records, *, cache_path=DEFAULT_CACHE, embedder=None, on_progress=None):
    """変更のある資料をバッチで埋め込み、索引を原子的に置き換える。"""
    if embedder is None:
        embedder = _default_embedder()
    path = Path(cache_path)
    documents = _documents(records)
    header = _cache_header(embedder)
    old_cache = _read_cache(path)
    dimensions = getattr(embedder, "dimensions", None)
    old_entries = {}
    if _compatible_cache(old_cache, embedder) and old_cache.get("model_digest") == header["model_digest"]:
        dimensions = old_cache["dimensions"]
        old_entries = old_cache["records"]

    entries = {}
    pending = []
    for record_id, (_, text, input_hash) in documents.items():
        entry, _ = _cached_entry(old_entries, record_id, input_hash, dimensions)
        if entry is None:
            pending.append((record_id, text, input_hash))
        else:
            entries[record_id] = entry

    total = len(documents)
    reused = len(entries)
    if on_progress is not None:
        on_progress(reused, total)
    for start in range(0, len(pending), BATCH_SIZE):
        batch = pending[start:start + BATCH_SIZE]
        vectors = _embed(embedder, [text for _, text, _ in batch], dimensions)
        dimensions = len(vectors[0])
        for (record_id, _, input_hash), vector in zip(batch, vectors):
            entries[record_id] = {"input_sha256": input_hash, "vector": _encode(vector)}
        if on_progress is not None:
            on_progress(len(entries), total)

    if pending and header != _cache_header(embedder):
        raise EmbeddingError("索引の作成中にOllamaの埋め込みモデルが変わりました。")
    dimensions = dimensions or 0
    cache = {**header, "dimensions": dimensions, "records": entries}
    if cache != old_cache:
        _write_cache(path, cache)
    return IndexBuildResult(total, reused, len(pending), dimensions)


def _load_index(path, documents, embedder):
    cache = _read_cache(path)
    if not _compatible_cache(cache, embedder):
        return None
    dimensions = cache["dimensions"]
    entries = cache["records"]
    index = []
    for record_id, (record, _, input_hash) in documents.items():
        _, vector = _cached_entry(entries, record_id, input_hash, dimensions)
        if vector is None:
            return None
        index.append((record, vector))
    return cache.get("model_digest"), dimensions, index


def _semantic(index, query_vector, limit):
    # 各ページで最も近い節を比較し、同じページの節が候補枠を埋めないようにする。
    pages = {}
    for record, vector in index:
        score = sum(map(mul, query_vector, vector))
        page = record["url"]
        if page not in pages or score > pages[page][0]:
            pages[page] = (score, record)
    ranked = sorted(pages.values(), key=lambda item: item[0], reverse=True)
    return [record for _, record in ranked[:limit]]


def _strong_match(record, query):
    if matched_name_length(record, name_queries(query)):
        return True
    if any(normalize(word) in query for word in record.get("keywords", [])):
        return any(normalize(topic) in query for topic in record.get("topics", []))
    # 自動取り込み記事は、明示された記事名や節名の完全一致を優先する。
    title = record.get("title", "").split(" / ", 1)[0]
    query_text = lexical_text(query)
    for label in (title, record.get("heading", "")):
        term = lexical_text(label)
        if len(term) >= 4 and term in query_text:
            return True
    return False


def _hybrid(keyword, semantic, query):
    scores = {}
    records = {}
    for rank_list in (keyword, semantic):
        for rank, record in enumerate(rank_list, start=1):
            record_id = record["id"]
            scores[record_id] = scores.get(record_id, 0.0) + 1 / (RRF_K + rank)
            records[record_id] = record
    query = normalize(query)
    shared_ids = {record["id"] for record in keyword} & {record["id"] for record in semantic}
    result = [record for record in keyword if _strong_match(record, query)]
    if not result:
        # 強い文字一致がない質問では、意味検索の上位候補を先に残す。
        result = semantic[:SEARCH_LIMIT - 1]
    seen_ids = {record["id"] for record in result}
    seen_urls = {record["url"] for record in result}
    remaining = []
    for record_id in sorted(scores, key=scores.get, reverse=True):
        record = records[record_id]
        if record_id in seen_ids:
            continue
        if record["url"] in seen_urls and record_id not in shared_ids:
            remaining.append(record)
        else:
            result.append(record)
            seen_urls.add(record["url"])
    return (result + remaining)[:SEARCH_LIMIT]


def make_retriever(records, *, mode="keyword", cache_path=DEFAULT_CACHE, embedder=None):
    """質問を受け取り、候補と実際に使用した検索方式を返す検索器を作る。"""
    if mode not in ("keyword", "semantic", "hybrid"):
        raise ValueError(f"検索方式が不明です ({mode})。")
    records = tuple(records)
    if mode == "keyword":
        return lambda query: RetrievalResult(search(records, query), mode)
    if embedder is None:
        embedder = _default_embedder()
    documents = _documents(records)
    path = Path(cache_path)
    cached_state = None
    lock = Lock()

    def current_index():
        nonlocal cached_state
        with lock:
            try:
                info = path.stat()
            except OSError:
                cached_state = None
                return None
            fingerprint = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
            if cached_state is None or cached_state[0] != fingerprint:
                cached_state = (fingerprint, _load_index(path, documents, embedder))
            return cached_state[1]

    def retrieve(query):
        try:
            cached_index = current_index()
            if cached_index is None:
                raise EmbeddingError("利用できる埋め込み索引がありません。")
            digest, dimensions, index = cached_index
            if _model_digest(embedder) != digest:
                raise EmbeddingError("索引とOllamaの埋め込みモデルが一致しません。")
            query_vector, = _embed(embedder, [QUERY_FORMAT.format(query=query)], dimensions)
            if _model_digest(embedder) != digest:
                raise EmbeddingError("検索中にOllamaの埋め込みモデルが変わりました。")
        except (RuntimeError, OSError, ValueError):
            return RetrievalResult(search(records, query), "keyword_fallback")
        limit = SEMANTIC_DEPTH if mode == "hybrid" else SEARCH_LIMIT
        result = _semantic(index, query_vector, limit)
        if mode == "hybrid":
            result = _hybrid(search(records, query), result, query)
        return RetrievalResult(result, mode)

    return retrieve


def main():
    parser = argparse.ArgumentParser(description="やまだ案内の資料から埋め込み索引を作成します。")
    parser.add_argument("--output", type=Path, default=DEFAULT_CACHE, help="索引JSONの保存先")
    args = parser.parse_args()
    last_reported = None

    def report(done, total):
        nonlocal last_reported
        if last_reported is None or done == total or done - last_reported >= 128:
            print(f"索引 {done}/{total} 件", file=sys.stderr)
            last_reported = done

    try:
        result = build_index(load_records(), cache_path=args.output, on_progress=report)
    except (EmbeddingError, OSError, ValueError) as error:
        parser.exit(1, f"索引作成に失敗しました。{error}\n")
    print(f"{args.output} に {result.indexed} 件を保存しました（再利用 {result.reused} 件、新規計算 {result.embedded} 件）。")


if __name__ == "__main__":
    main()
