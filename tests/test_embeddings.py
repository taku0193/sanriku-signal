import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from evaluate_rag import evaluate_case
from yamada_embeddings import RetrievalResult, _hybrid, build_index, make_retriever
from yamada_rag import load_records


class TestEmbedder:
    model = "test:latest"
    dimensions = 2

    def __init__(self):
        self.digest = "first"
        self.replace_on_query = False

    def model_digest(self):
        return self.digest

    def embed(self, inputs):
        if self.replace_on_query and inputs[0].startswith("task:"):
            self.digest = "second"
        return [[1, 0] for _ in inputs]


class EmbeddingTests(unittest.TestCase):
    def setUp(self):
        self.documents = {record["id"]: record for record in load_records(include_imported=False)}
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.cache = Path(folder.name) / "index.json"
        self.embedder = TestEmbedder()

    def test_updated_passage_falls_back_until_reindexed(self):
        records = [self.documents[key] for key in ("museum-fees", "oisuta-hours")]
        result = build_index(records, cache_path=self.cache, embedder=self.embedder)
        self.assertEqual(result.embedded, 2)
        updated = [{**records[0], "text": records[0]["text"] + " 一般料金です。"}, records[1]]
        retrieve = make_retriever(updated, mode="hybrid", cache_path=self.cache, embedder=self.embedder)
        self.assertEqual(retrieve("科学館の入館料は？").mode, "keyword_fallback")
        rebuilt = build_index(updated, cache_path=self.cache, embedder=self.embedder)
        self.assertEqual((rebuilt.reused, rebuilt.embedded), (1, 1))
        self.assertEqual(retrieve("科学館の入館料は？").mode, "hybrid")

    def test_model_replacement_during_query_uses_keyword(self):
        records = [self.documents["museum-fees"]]
        build_index(records, cache_path=self.cache, embedder=self.embedder)
        retrieve = make_retriever(records, mode="hybrid", cache_path=self.cache, embedder=self.embedder)
        self.embedder.replace_on_query = True
        self.assertEqual(retrieve("科学館の入館料は？").mode, "keyword_fallback")
        self.embedder.digest = "first"
        self.embedder.replace_on_query = False
        self.assertEqual(retrieve("科学館の入館料は？").mode, "hybrid")

    def test_agreed_section_can_share_a_source_with_an_exact_match(self):
        keyword = [self.documents[key] for key in ("museum-fees", "museum-hours", "museum-access")]
        semantic = [self.documents[key] for key in ("museum-hours", "oisuta-hours", "pet-bottles")]
        result = _hybrid(keyword, semantic, "鯨と海の科学館の大人の入館料と、受付締切を教えてください。")
        self.assertEqual([record["id"] for record in result[:2]], ["museum-fees", "museum-hours"])

    def test_weak_keyword_matches_leave_room_for_semantic_candidates(self):
        keyword = [self.documents[key] for key in ("museum-fees", "museum-hours", "museum-access")]
        semantic = [self.documents[key] for key in ("oisuta-hours", "oversized-waste", "museum-hours")]
        result = _hybrid(keyword, semantic, "袋に入らない家具の回収はいつまでに誰へ連絡しますか？")
        self.assertIn("oversized-waste", [record["id"] for record in result])

    def test_evaluation_records_the_method_after_a_fallback(self):
        record = self.documents["museum-fees"]
        retriever = Mock(return_value=RetrievalResult([record], "keyword_fallback"))
        decide = Mock(return_value={"action": "answer", "answer": "300円です。", "sources": ["museum-fees"]})
        case = {
            "id": "fee", "category": "観光", "question": "科学館の入館料は？", "expected_answer": "300円",
            "required_patterns": ["300円"], "required_sources": {record["id"]: record["url"]},
        }
        result = evaluate_case(case, "baseline", [record], decide, retriever=retriever)
        self.assertEqual(result["retrieval_fallbacks"], 1)
        self.assertEqual(result["searches"][0]["retrieval"], "keyword_fallback")
