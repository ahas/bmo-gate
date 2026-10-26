"""Asking a checkpoint outside the service, against a stand-in checkpoint: run by tests/python.rs"""

from __future__ import annotations

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "runtime", "laya-server"))
sys.path.insert(0, os.path.join(HERE, "..", "support"))

from predict import answer_rows  # noqa: E402


class StandIn:
    """A checkpoint that answers yes with the length of each question's instructions over ten."""

    def __init__(self):
        self.asked = []

    def predict(self, state, questions):
        self.asked.append((state, questions))
        return {"answers": {qid: {"noul": len(question["instructions"]) / 10} for qid, question in questions.items()}}


def row(rid, questions, turn="t1"):
    return json.dumps({"id": rid, "gate": "reply-wanted", "split": "test", "turn": turn,
                       "state": json.dumps("Owner: \uc751"), "questions": json.dumps(questions), "gold": "{}"})


class AnswerRows(unittest.TestCase):
    def test_each_row_is_asked_as_it_stands_and_answered_per_question(self):
        agent = StandIn()
        lines = [row("r1", {"a": {"type": "noul", "instructions": "abcd"}, "b": {"type": "noul", "instructions": "ab"}}), "",
                 row("r2", {"c": {"type": "noul", "instructions": "abcdef"}}, turn="t2")]

        answered = list(answer_rows(agent, lines))

        self.assertEqual(answered, [
            {"id": "r1", "gate": "reply-wanted", "turn": "t1", "answers": {"a": 0.4, "b": 0.2}},
            {"id": "r2", "gate": "reply-wanted", "turn": "t2", "answers": {"c": 0.6}},
        ])
        self.assertEqual(agent.asked[0][0], "Owner: \uc751")

    def test_a_question_the_checkpoint_left_unanswered_has_no_yes(self):
        class Silent(StandIn):
            def predict(self, state, questions):
                return {"answers": {}}

        answered = list(answer_rows(Silent(), [row("r1", {"a": {"type": "noul", "instructions": "abcd"}})]))

        self.assertEqual(answered[0]["answers"], {"a": None})


if __name__ == "__main__":
    unittest.main()
