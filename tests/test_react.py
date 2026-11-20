import unittest
from unittest.mock import Mock, patch

from yamada_calendars import find_collection_calendar
from yamada_rag import load_records, search
from yamada_react import run_turn


class ReactTests(unittest.TestCase):
    def test_district_clarification_precedes_search_and_resumes(self):
        events = []
        clarify = Mock(return_value={"action": "clarify", "field": "district", "answer": "どの地区ですか？"})
        with patch("yamada_react.search") as search_documents, patch("yamada_react.find_collection_calendar") as calendar:
            first = run_turn("うちの地区のごみ収集日は？", [], clarify, on_action=events.append)
            search_documents.assert_not_called()
            calendar.assert_not_called()
        self.assertEqual(first.action, "clarify")
        self.assertEqual(events, [{"action": "clarify"}])

        continuation = Mock(side_effect=[
            {"action": "search", "target": "collection_calendars", "district": "大沢地区", "fiscal_year": 2026},
            {"action": "answer", "answer": "大沢の令和8年度の日程表です。", "sources": ["calendar-2026-osawa"]},
        ])
        second = run_turn("大沢です。", [], continuation, pending=first.pending)
        self.assertEqual(second.action, "answer")
        self.assertIsNone(second.pending)
        self.assertEqual(second.sources[0]["id"], "calendar-2026-osawa")
        self.assertEqual(continuation.call_args.args[0]["question"], "うちの地区のごみ収集日は？")
        self.assertEqual(continuation.call_args.args[0]["follow_up"]["reply"], "大沢です。")

    def test_reuses_previous_search_and_rejects_unseen_source(self):
        events = []
        decide = Mock(side_effect=[
            {"action": "search", "target": "official_documents", "query": " 科学館 開館時間 "},
            {"action": "search", "target": "official_documents", "query": "科学館　開館時間"},
            {"action": "answer", "answer": "回答", "sources": ["unseen"]},
        ])
        with patch("yamada_react.search", return_value=[{"id": "seen", "text": "本文"}]) as retrieve:
            result = run_turn("科学館は何時まで？", [], decide, on_action=events.append)
        retrieve.assert_called_once()
        self.assertEqual([event.get("status") for event in events[:2]], ["found", "reused"])
        self.assertEqual(result.action, "insufficient")
        self.assertEqual(result.sources, [])
        self.assertNotIn("search", decide.call_args.kwargs["actions"])
        self.assertEqual(decide.call_count, 3)

    def test_search_and_decision_caps(self):
        decide = Mock(side_effect=[
            {"action": "search", "target": "official_documents", "query": "一つ目"},
            {"action": "search", "target": "official_documents", "query": "二つ目"},
            {"action": "search", "target": "official_documents", "query": "三つ目"},
        ])
        with patch("yamada_react.search", return_value=[]) as retrieve:
            result = run_turn("質問", [], decide)
        self.assertEqual(result.action, "insufficient")
        self.assertEqual(retrieve.call_count, 2)
        self.assertEqual(decide.call_count, 3)

    def test_tool_error_returns_an_observation(self):
        events = []
        decide = Mock(side_effect=[
            {"action": "search", "target": "collection_calendars", "district": "大沢"},
            {"action": "insufficient"},
        ])
        with patch("yamada_react.find_collection_calendar", side_effect=FileNotFoundError):
            result = run_turn("大沢のごみ収集日は？", [], decide, on_action=events.append)
        self.assertEqual(result.action, "insufficient")
        self.assertEqual(events[0]["status"], "error")
        self.assertEqual(decide.call_args.args[0]["observations"][0]["status"], "error")

    def test_calendar_aliases_and_year(self):
        self.assertEqual(find_collection_calendar("八千代", 2026)[0]["id"], "calendar-2026-toyomane-1")
        self.assertEqual(find_collection_calendar("大沢１区", 2026)[0]["id"], "calendar-2026-osawa")
        self.assertEqual(find_collection_calendar("柳沢", 2026), [])
        self.assertEqual(find_collection_calendar("大沢", 2025), [])

    def test_markdown_and_json_use_the_same_search(self):
        records = load_records(include_imported=False)
        self.assertEqual(search(records, "山田町の町の花と木と鳥は？")[0]["id"], "md-town-symbols")
        self.assertEqual(search(records, "科学館の大人の入館料は？")[0]["id"], "museum-fees")
