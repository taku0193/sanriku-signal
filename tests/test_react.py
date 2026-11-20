import json
import unittest
from datetime import date
from unittest.mock import Mock, patch

from yamada_calendars import AmbiguousDistrict, collection_bounds, find_collection_calendar, find_collection_days
from yamada_rag import load_records, search
from yamada_react import asks_collection_date, run_turn, stream_grounded_answer
from yamada_web import public_source, read_history


class ReactTests(unittest.TestCase):
    def test_stream_decodes_split_json_escapes_without_exposing_source_ids(self):
        answer = '入館料は「300円」です。\n資料の表記は "大人" 🐋'
        content = json.dumps({"action": "answer", "sources": ["museum-fees"], "answer": answer})
        deltas = []
        receive = stream_grounded_answer({"museum-fees"}, deltas.append)
        for length in range(1, len(content)):
            receive(content[:length])
        self.assertGreater(len(deltas), 1)
        self.assertEqual("".join(deltas), answer)

    def test_stream_waits_for_all_sources_to_be_known(self):
        deltas = []
        receive = stream_grounded_answer({"seen"}, deltas.append)
        receive('{"action":"answer","sources":["seen","unseen"],"answer":"300円"}')
        receive('{"action":"answer","answer":"300円","sources":["seen"]}')
        receive('{"action":"insufficient","sources":["seen"],"answer":"確認できません"}')
        self.assertEqual(deltas, [])

    def test_history_resolves_references_but_only_search_results_can_be_cited(self):
        history = read_history([{"question": "科学館の料金は？", "answer": "大人300円です。"}])
        events = []
        states = []

        def decide(state, *, actions):
            states.append((state["history"], actions))
            if len(states) == 1:
                return {"action": "search", "target": "official_documents", "query": "科学館 開館時間"}
            return {"action": "answer", "answer": "17時です。", "sources": ["past-source"]}

        with patch("yamada_react.search", return_value=[{"id": "current-source", "text": "17時まで"}]):
            result = run_turn("そこは何時まで？", [], decide, history=history, on_progress=events.append)
        self.assertEqual(states[0][0], history)
        self.assertNotIn("answer", states[0][1])
        self.assertEqual(events, ["planning", "searching", "reviewing"])
        self.assertEqual(result.action, "insufficient")
        self.assertEqual(result.sources, [])

    def test_district_clarification_precedes_search_and_resumes(self):
        events = []
        clarify = Mock(return_value={"action": "clarify", "field": "district", "answer": "どの地区ですか？"})
        with patch("yamada_react.search") as search_documents, patch("yamada_react.find_collection_days") as calendar:
            first = run_turn("うちの地区のごみ収集日は？", [], clarify, on_action=events.append)
            search_documents.assert_not_called()
            calendar.assert_not_called()
        self.assertEqual(first.action, "clarify")
        self.assertEqual(events, [{"action": "clarify"}])

        continuation = Mock(side_effect=[
            {"action": "search", "target": "collection_calendars", "district": "大沢地区", "fiscal_year": 2026,
             "waste_types": ["burnable"]},
            {"action": "answer", "answer": "11月22日です。", "sources": ["calendar-2026-osawa"]},
        ])
        on_delta = Mock()
        second = run_turn("大沢です。", [], continuation, pending=first.pending, today=date(2026, 11, 20),
                          on_delta=on_delta)
        on_delta.assert_not_called()
        self.assertEqual(second.action, "answer")
        self.assertIsNone(second.pending)
        self.assertEqual(second.sources[0]["id"], "calendar-2026-osawa")
        self.assertIn("2026年11月21日（土）", second.answer)
        self.assertNotIn("11月22日", second.answer)
        self.assertNotIn("url", public_source(second.sources[0]))
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
        with patch("yamada_react.find_collection_days", side_effect=FileNotFoundError):
            result = run_turn("大沢のごみ収集日は？", [], decide, on_action=events.append)
        self.assertEqual(result.action, "insufficient")
        self.assertEqual(events[0]["status"], "error")
        self.assertEqual(decide.call_args.args[0]["observations"][0]["status"], "error")

    def test_calendar_aliases_and_year(self):
        self.assertEqual(find_collection_calendar("八千代", 2026)[0]["id"], "calendar-2026-toyomane-1")
        self.assertEqual(find_collection_calendar("大沢１区", 2026)[0]["id"], "calendar-2026-osawa")
        self.assertEqual(find_collection_calendar("柳沢", 2026), [])
        self.assertEqual(find_collection_calendar("大沢", 2025), [])

    def test_calendar_exact_dates_around_new_year(self):
        day = date(2027, 1, 2)
        year, start, end = collection_bounds({"period": "today"}, day)
        result = find_collection_days("大沢", year, start, end, ["burnable"])[0]
        self.assertIn("収集予定はありません", result["calendar_answer"])
        self.assertIn("1月1日〜3日は収集休止", result["calendar_answer"])
        self.assertEqual(year, 2026)

    def test_calendar_multiple_explicit_collection_days(self):
        result = find_collection_days("大沢", 2026, date(2026, 12, 1), date(2026, 12, 31), ["plastic"])[0]
        self.assertIn("12月8日（火）", result["calendar_answer"])
        self.assertIn("12月25日（金）", result["calendar_answer"])
        self.assertNotIn("ペットボトル", result["calendar_answer"])

    def test_calendar_outside_collected_year(self):
        self.assertEqual(find_collection_days("大沢", 2027, date(2027, 4, 2), None, []), [])

    def test_exact_date_without_period_is_respected(self):
        day = date(2026, 12, 25)
        self.assertEqual(collection_bounds({"start_date": "2026-12-25"}, date(2026, 11, 20)), (2026, day, day))
        with self.assertRaises(ValueError):
            collection_bounds({"period": "today", "start_date": "2026-12-25"}, date(2026, 11, 20))

    def test_explicit_calendar_month_survives_missing_model_arguments(self):
        q = "大沢の2026年12月のプラスチック収集日は？"
        decide = Mock(side_effect=[
            {"action": "search", "target": "collection_calendars", "district": "大沢",
             "fiscal_year": 2026, "waste_types": ["plastic"]},
            {"action": "answer", "sources": ["calendar-2026-osawa"]},
        ])
        result = run_turn(q, [], decide, today=date(2026, 11, 20))
        self.assertIn("12月8日（火）", result.answer)
        self.assertIn("12月25日（金）", result.answer)

    def test_ambiguous_location_is_not_narrowed_by_model(self):
        with self.assertRaises(AmbiguousDistrict):
            find_collection_days("山田1", 2026, date(2026, 11, 21), None, ["burnable"], wording=("北浜のごみの日",))

    def test_ambiguous_location_keeps_district_for_the_next_turn(self):
        today = date(2026, 11, 20)
        first = run_turn("北浜の燃やせるごみの収集日は？", [], Mock(side_effect=[
            {"action": "search", "target": "collection_calendars", "district": "山田1"},
            {"action": "clarify", "field": "district"},
        ]), today=today)
        self.assertEqual(first.pending["district_hint"], "北浜")
        second = run_turn("9区です", [], Mock(side_effect=[
            {"action": "search", "target": "collection_calendars", "district": "北浜9区", "waste_types": ["burnable"]},
            {"action": "answer", "sources": ["calendar-2026-yamada-4-1"]},
        ]), pending=first.pending, today=today)
        self.assertIn("11月23日（月）", second.answer)

    def test_verified_station_landmark_can_resolve_a_split_area(self):
        result = find_collection_days(
            "北浜2区", 2026, date(2026, 11, 21), None, ["burnable"], wording=("元藤原鉄筋の近くです",),
        )
        self.assertEqual(result[0]["id"], "calendar-2026-yamada-5-1")

    def test_collection_date_intent_distinguishes_reservation_and_disposal(self):
        self.assertFalse(asks_collection_date("粗大ごみの申し込みは何日までですか？"))
        for question in ("大沢で新聞を出せるのはいつ？", "大沢のプラはいつ？", "大沢の次の缶はいつ？"):
            self.assertTrue(asks_collection_date(question), question)

    def test_mixed_question_keeps_both_grounded_answers(self):
        records = load_records(include_imported=False)
        decide = Mock(side_effect=[
            {"action": "search", "target": "collection_calendars", "district": "大沢", "waste_types": ["burnable"]},
            {"action": "search", "target": "official_documents", "query": "鯨と海の科学館 大人 入館料"},
            {"action": "answer", "other_answer": "科学館の大人料金は300円です。",
             "sources": ["calendar-2026-osawa", "museum-fees"]},
        ])
        result = run_turn("大沢の燃やせるごみの収集日と科学館の料金は？", records, decide, today=date(2026, 11, 20))
        self.assertIn("11月21日（土）", result.answer)
        self.assertIn("300円", result.answer)

    def test_legacy_calendar_link_is_not_used_to_answer_dates(self):
        decide = Mock(side_effect=[
            {"action": "search", "target": "official_documents", "query": "ごみ収集日"},
            {"action": "answer", "answer": "PDFで確認してください。", "sources": ["collection-calendar"]},
        ])
        result = run_turn("大沢の燃やせるごみの収集日は？", load_records(include_imported=False), decide)
        self.assertEqual(result.action, "insufficient")
        self.assertEqual(result.sources, [])
        self.assertNotIn("PDF", result.answer)

    def test_markdown_and_json_use_the_same_search(self):
        records = load_records(include_imported=False)
        self.assertEqual(search(records, "山田町の町の花と木と鳥は？")[0]["id"], "md-town-symbols")
        self.assertEqual(search(records, "科学館の大人の入館料は？")[0]["id"], "museum-fees")
