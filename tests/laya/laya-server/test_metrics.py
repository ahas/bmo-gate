"""What a trained gate came to, counted on fixed numbers: run by tests/python.rs

No model is loaded and no card is touched. Every figure the verification table carries is decided
here, so a wrong count is caught on a handful of records rather than after a training run.
"""

from __future__ import annotations

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "runtime", "laya-server"))
sys.path.insert(0, os.path.join(HERE, "..", "support"))

import metrics  # noqa: E402

YES_NO = ["false", "true"]


def judged(gate: str, question: str, gold: str, predicted: str, confidence: float, answers=None) -> dict:
    names = answers or YES_NO

    return {
        "gate": gate, "question": question, "answers": names,
        "gold": names.index(gold), "predicted": names.index(predicted), "confidence": confidence,
    }


# A stand-in for laya's own calibration error: the tests that use it are about what is handed to it
# and what comes back, not about the number it computes, which is laya's to compute.
def stub_ece(confidence, correct):
    return sum(confidence) / max(1, len(confidence)) - sum(correct) / max(1, len(correct))


class AnswerNamesTest(unittest.TestCase):
    def test_a_yes_no_question_is_false_then_true(self):
        # The training builds a noul target as [false, true], so index 0 is false wherever it is read.
        self.assertEqual(metrics.answer_names({"type": "noul", "instructions": "x"}), ["false", "true"])

    def test_a_choice_question_keeps_its_own_order(self):
        question = {"type": "choice", "criteria": {"universal": "", "personal": "", "room": "", "none": ""}}

        self.assertEqual(metrics.answer_names(question), ["universal", "personal", "room", "none"])

    def test_a_choice_question_given_a_list(self):
        self.assertEqual(metrics.answer_names({"type": "choice", "criteria": ["a", "b"]}), ["a", "b"])

    def test_a_question_of_no_kind_we_know(self):
        self.assertEqual(metrics.answer_names({"type": "something"}), [])


class AsymmetricRuleTest(unittest.TestCase):
    def test_a_gate_names_its_question_and_its_settleable_answer(self):
        self.assertEqual(metrics.parse_asymmetric("reply-wanted:forAgent:false"),
                         {"gate": "reply-wanted", "question": "forAgent", "settles": "false"})

    def test_anything_else_is_refused_rather_than_guessed_at(self):
        for text in ("reply-wanted", "reply-wanted:forAgent", "a:b:c:d", "::", "reply-wanted::false"):
            with self.assertRaises(ValueError):
                metrics.parse_asymmetric(text)


class FiguresTest(unittest.TestCase):
    def test_agreement_is_the_share_it_got_right(self):
        counted = metrics.figures([
            judged("g", "q", "true", "true", 0.9),
            judged("g", "q", "true", "false", 0.8),
            judged("g", "q", "false", "false", 0.7),
            judged("g", "q", "false", "false", 0.6),
        ], None)

        self.assertEqual(counted["questions"], 4)
        self.assertEqual(counted["agreement"], 0.75)
        self.assertEqual(counted["answers"], {"false": 2, "true": 2})
        self.assertEqual(counted["correct"], {"false": 2, "true": 1})

    def test_balanced_weighs_each_answer_the_same(self):
        # Nine of ten questions are answered no, and the model always says no: plain agreement is high
        # and the balanced figure is the half that says it decided nothing.
        always_no = [judged("g", "q", "false", "false", 0.9) for _ in range(9)] + [judged("g", "q", "true", "false", 0.9)]
        counted = metrics.figures(always_no, None)

        self.assertEqual(counted["agreement"], 0.9)
        self.assertEqual(counted["balanced"], 0.5)

    def test_a_real_judgement_scores_on_both(self):
        counted = metrics.figures([
            *[judged("g", "q", "false", "false", 0.9) for _ in range(9)],
            judged("g", "q", "true", "true", 0.9),
        ], None)

        self.assertEqual(counted["agreement"], 1.0)
        self.assertEqual(counted["balanced"], 1.0)

    def test_nothing_measured_is_nothing_rather_than_zero(self):
        counted = metrics.figures([], None)

        self.assertEqual(counted["questions"], 0)
        self.assertIsNone(counted["agreement"])
        self.assertIsNone(counted["balanced"])
        self.assertIsNone(counted["ece"])

    def test_the_calibration_error_is_given_what_it_asks_for(self):
        seen = {}

        def ece(confidence, correct):
            seen["confidence"], seen["correct"] = confidence, correct

            return 0.25

        counted = metrics.figures([judged("g", "q", "true", "true", 0.8), judged("g", "q", "true", "false", 0.6)], ece)

        self.assertEqual(counted["ece"], 0.25)
        self.assertEqual(seen["confidence"], [0.8, 0.6])
        self.assertEqual(seen["correct"], [1.0, 0.0])

    def test_a_choice_question_counts_by_its_own_answers(self):
        names = ["universal", "personal", "room", "none"]
        counted = metrics.figures([
            judged("k", "scope", "universal", "universal", 0.7, names),
            judged("k", "scope", "room", "none", 0.5, names),
        ], None)

        self.assertEqual(counted["answers"], {"room": 1, "universal": 1})
        self.assertEqual(counted["correct"], {"room": 0, "universal": 1})
        self.assertEqual(counted["balanced"], 0.5)


class ByGateTest(unittest.TestCase):
    def test_each_gate_is_counted_on_its_own(self):
        counted = metrics.by_gate([
            judged("a", "q", "true", "true", 0.9),
            judged("a", "q", "false", "false", 0.9),
            judged("b", "q", "true", "false", 0.9),
            judged("b", "q", "false", "false", 0.9),
        ], None)

        self.assertEqual(sorted(counted["gates"]), ["a", "b"])
        self.assertEqual(counted["gates"]["a"]["agreement"], 1.0)
        self.assertEqual(counted["gates"]["b"]["agreement"], 0.5)
        self.assertEqual(counted["gates"]["b"]["balanced"], 0.5)
        self.assertEqual(counted["overall"]["questions"], 4)


class MissedCallsTest(unittest.TestCase):
    """The reply-wanted gate: Laya may settle only that a message was surely not said to the agent, so a missed
    call is a message that wanted an answer and was settled as not for the agent."""

    rule = {"gate": "reply-wanted", "question": "forAgent", "settles": "false"}

    def rows(self):
        return [
            # Wanted an answer and got one: not a missed call.
            judged("reply-wanted", "forAgent", "true", "true", 0.95),
            # Wanted an answer and was called not-for-the-agent, very surely: missed at every threshold.
            judged("reply-wanted", "forAgent", "true", "false", 0.99),
            # Wanted an answer and was called not-for-the-agent, but not surely: missed only below 0.9.
            judged("reply-wanted", "forAgent", "true", "false", 0.7),
            # Did not want an answer and was settled: what the gate is for.
            judged("reply-wanted", "forAgent", "false", "false", 0.96),
            judged("reply-wanted", "forAgent", "false", "false", 0.55),
        ]

    def test_a_missed_call_is_counted_at_each_threshold(self):
        counted = metrics.missed_calls(self.rows(), self.rule, [0.5, 0.9, 0.99])
        at = {one["tau"]: one for one in counted["thresholds"]}

        self.assertEqual(counted["questions"], 5)
        self.assertEqual(counted["wanted"], 3)
        self.assertEqual(at[0.5]["settled"], 4)
        self.assertEqual(at[0.5]["missed"], 2)
        self.assertEqual(at[0.9]["settled"], 2)
        self.assertEqual(at[0.9]["missed"], 1)
        self.assertEqual(at[0.99]["settled"], 1)
        self.assertEqual(at[0.99]["missed"], 1)

    def test_the_missed_share_is_of_the_calls_that_wanted_an_answer(self):
        counted = metrics.missed_calls(self.rows(), self.rule, [0.5])

        self.assertEqual(counted["thresholds"][0]["missed_rate"], round(2 / 3, 4))
        self.assertEqual(counted["thresholds"][0]["coverage"], 0.8)

    def test_the_other_answer_being_wrong_is_not_a_missed_call(self):
        # A message that wanted no answer and was run through the agent anyway costs a call and nothing else.
        counted = metrics.missed_calls([judged("reply-wanted", "forAgent", "false", "true", 0.99)], self.rule, [0.5])

        self.assertEqual(counted["thresholds"][0]["settled"], 0)
        self.assertEqual(counted["thresholds"][0]["missed"], 0)

    def test_a_gate_that_is_not_in_this_set_is_nothing_rather_than_a_zero(self):
        self.assertIsNone(metrics.missed_calls([judged("output-format", "intrusion", "true", "true", 0.9)], self.rule))

    def test_an_answer_the_question_does_not_have_is_not_counted(self):
        rule = {"gate": "reply-wanted", "question": "forAgent", "settles": "maybe"}

        self.assertIsNone(metrics.missed_calls(self.rows(), rule))

    def test_the_thresholds_are_the_ones_the_table_carries(self):
        self.assertEqual(list(metrics.THRESHOLDS), [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99])


class DifferenceTest(unittest.TestCase):
    def test_what_the_training_moved(self):
        moved = metrics.difference({"agreement": 0.93, "balanced": 0.84, "ece": 0.05},
                                   {"agreement": 0.52, "balanced": 0.5, "ece": 0.3})

        self.assertEqual(moved, {"agreement": 0.41, "balanced": 0.34, "ece": -0.25})

    def test_no_base_is_no_difference(self):
        self.assertIsNone(metrics.difference({"agreement": 0.9}, None))

    def test_a_figure_missing_either_side_is_not_invented(self):
        self.assertEqual(metrics.difference({"agreement": None, "balanced": 0.8, "ece": None},
                                            {"agreement": 0.5, "balanced": 0.5, "ece": 0.1}),
                         {"agreement": None, "balanced": 0.3, "ece": None})


class ReportTest(unittest.TestCase):
    def build(self, **changes):
        tuned = [
            judged("reply-wanted", "forAgent", "true", "true", 0.9),
            judged("reply-wanted", "forAgent", "false", "false", 0.95),
            judged("output-format", "intrusion", "true", "true", 0.8),
        ]
        base = [
            judged("reply-wanted", "forAgent", "true", "false", 0.6),
            judged("reply-wanted", "forAgent", "false", "false", 0.6),
            judged("output-format", "intrusion", "true", "false", 0.6),
        ]

        return metrics.report(
            model="checkpoints/run-reply-wanted", data="data/run-reply-wanted", judged=tuned,
            base_judged=changes.get("base", base), base_model=changes.get("base_model", "/hub/multilingual"),
            rules=[{"gate": "reply-wanted", "question": "forAgent", "settles": "false"}],
            ece=stub_ece, written_at="2026-09-23T08:40:00+0900",
        )

    def test_it_says_what_it_is_and_what_it_measured(self):
        counted = self.build()

        self.assertEqual(counted["kind"], "laya-calibration")
        self.assertEqual(counted["model"], "checkpoints/run-reply-wanted")
        self.assertEqual(counted["base_model"], "/hub/multilingual")
        self.assertEqual(counted["data"], "data/run-reply-wanted")
        self.assertEqual(counted["written_at"], "2026-09-23T08:40:00+0900")
        self.assertEqual(counted["thresholds"], list(metrics.THRESHOLDS))

    def test_every_gate_carries_its_own_base_and_its_difference(self):
        gates = self.build()["gates"]

        self.assertEqual(sorted(gates), ["output-format", "reply-wanted"])
        self.assertEqual(gates["reply-wanted"]["agreement"], 1.0)
        self.assertEqual(gates["reply-wanted"]["base"]["agreement"], 0.5)
        self.assertEqual(gates["reply-wanted"]["difference"]["agreement"], 0.5)
        self.assertEqual(gates["output-format"]["difference"]["agreement"], 1.0)

    def test_the_asymmetric_gate_carries_its_missed_calls_and_the_others_do_not(self):
        gates = self.build()["gates"]

        self.assertEqual(len(gates["reply-wanted"]["asymmetric"]), 1)
        self.assertEqual(gates["reply-wanted"]["asymmetric"][0]["question"], "forAgent")
        self.assertEqual(gates["reply-wanted"]["asymmetric"][0]["settles"], "false")
        self.assertEqual(gates["output-format"]["asymmetric"], [])

    def test_without_a_base_the_difference_is_left_out_rather_than_guessed(self):
        counted = self.build(base=None, base_model=None)

        self.assertIsNone(counted["gates"]["reply-wanted"]["base"])
        self.assertIsNone(counted["gates"]["reply-wanted"]["difference"])
        self.assertIsNone(counted["overall"]["base"])

    def test_the_whole_set_stands_beside_the_gates(self):
        counted = self.build()

        self.assertEqual(counted["overall"]["questions"], 3)
        self.assertEqual(counted["overall"]["agreement"], 1.0)
        self.assertEqual(counted["overall"]["base"]["questions"], 3)
        # One of the base's three lands right, so the training moved the whole set by two thirds.
        self.assertEqual(counted["overall"]["base"]["agreement"], 0.3333)
        self.assertEqual(counted["overall"]["difference"]["agreement"], 0.6667)


if __name__ == "__main__":
    unittest.main()
