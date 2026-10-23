"""How a dataset row becomes training items, and what a calibration writes into a checkpoint's
configuration: run by tests/python.rs

The items are made by laya's own functions, on a tokenizer of whole words that stands in for the
checkpoint's, so nothing is downloaded and no card is used. laya and torch are needed; where the
interpreter has none, the tests are skipped. Run the file with a venv's python that has them.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "training", "laya"))
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "runtime", "laya-server"))

try:
    from laya.common import TEMP_MAX, TEMP_MIN

    import calibrate
    import finetune
except ImportError:
    finetune = None

# The checkpoint's budgets at a size a test can read: the whole sequence, and the question's share.
BUDGETS = {"max_len": 64, "head_max_len": 48}


class WordTokenizer:
    """A tokenizer of whole words: each word one id, the same word the same id."""

    mask_token = "[MASK]"
    pad_token_id, cls_token_id, sep_token_id, mask_token_id = 0, 1, 2, 3

    def __init__(self) -> None:
        self.ids = {}

    def __call__(self, text, add_special_tokens=False, truncation=False, max_length=None, **_):
        ids = [self.ids.setdefault(word, len(self.ids) + 4) for word in str(text).split()]
        return {"input_ids": ids[:max_length] if truncation and max_length else ids}


def noul(instructions: str = "Does the message ask for a change?") -> dict:
    return {"type": "noul", "instructions": instructions}


def yes(share: float = 0.8) -> dict:
    return {"probabilities": {"true": share, "false": 1 - share}}


def row(questions: dict, gold: dict, gate: str = "sample-gate", state: str = "A neutral sample message.") -> dict:
    return {"id": "r", "gate": gate, "split": "train", "state": json.dumps(state),
            "questions": json.dumps(questions), "gold": json.dumps(gold)}


@unittest.skipIf(finetune is None, "laya and torch are not installed in this interpreter")
class TrainingItemTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tok = WordTokenizer()
        self.state_ids = self.tok("A neutral sample message.")["input_ids"]

    def item(self, question: dict, gold: dict, budgets=None):
        return finetune.training_item(self.tok, budgets or BUDGETS, self.state_ids, "q", question, gold)

    def test_a_question_that_fits_is_an_item_with_one_marker_an_option(self):
        item, reason = self.item(noul(), yes(0.8))
        self.assertIsNone(reason)
        self.assertEqual(len(item["markers"]), 2)
        self.assertTrue(all(item["ids"][marker] == self.tok.mask_token_id for marker in item["markers"]))
        self.assertLessEqual(len(item["ids"]), BUDGETS["max_len"])
        self.assertAlmostEqual(item["target"][0], 0.2)
        self.assertAlmostEqual(item["target"][1], 0.8)
        self.assertEqual(item["label"], 1)
        self.assertEqual(item["question"], "q")

    def test_the_state_follows_the_question_once(self):
        item, _ = self.item(noul(), yes())
        self.assertEqual(item["ids"][-len(self.state_ids) - 1:-1], self.state_ids)

    def test_options_cut_to_the_same_tokens_are_left_out_as_collapsed(self):
        labels = ["the same long shared prefix one", "the same long shared prefix two"]
        question = {"type": "choice", "instructions": "Which one?", "criteria": labels}
        gold = {"probabilities": {labels[0]: 0.5, labels[1]: 0.5}}
        item, reason = self.item(question, gold, {"max_len": 64, "head_max_len": 16})
        self.assertIsNone(item)
        self.assertEqual(reason, "options_collapsed")

    def test_a_question_past_the_whole_budget_is_left_out(self):
        item, reason = self.item(noul(), yes(), {"max_len": 12, "head_max_len": 48})
        self.assertIsNone(item)
        self.assertEqual(reason, "options_beyond_max_len")

    def test_a_question_that_is_not_well_formed_is_left_out(self):
        item, reason = self.item({"type": "score", "instructions": "How urgent?"}, {"probabilities": {"0": 1.0}})
        self.assertIsNone(item)
        self.assertEqual(reason, "invalid_question")

    def test_a_gold_that_does_not_fit_is_left_out(self):
        item, reason = self.item(noul(), {"probabilities": {"true": -1.0, "false": 2.0}})
        self.assertIsNone(item)
        self.assertEqual(reason, "invalid_target")

    def test_a_row_counts_what_it_left_out_and_skips_what_its_gold_does_not_answer(self):
        labels = ["the same long shared prefix one", "the same long shared prefix two"]
        questions = {
            "kept": noul(),
            "collapsed": {"type": "choice", "instructions": "Which one?", "criteria": labels},
            "malformed": {"type": "score", "instructions": "How urgent?"},
            "unasked": noul("Is it about a meeting?"),
        }
        gold = {"kept": yes(), "collapsed": {"probabilities": {labels[0]: 1.0}}, "malformed": {"probabilities": {"0": 1.0}}}
        items, skipped = finetune.row_items(self.tok, {"max_len": 64, "head_max_len": 16}, row(questions, gold))
        self.assertEqual([qid for qid, _ in items], ["kept"])
        self.assertEqual(skipped, {"options_collapsed": 1, "invalid_question": 1})

    def test_reading_a_split_counts_the_left_out_questions_by_reason(self):
        rows = [
            row({"a": noul(), "b": {"type": "score", "instructions": "How urgent?"}},
                {"a": yes(0.9), "b": {"probabilities": {"0": 1.0}}}),
            row({"a": noul()}, {"a": yes(0.1)}, gate="other-gate"),
        ]
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "train.jsonl")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("\n".join(json.dumps(one) for one in rows) + "\n")
            by_gate, skipped = finetune.read_items(path, self.tok, BUDGETS, None, None, 1)
        self.assertEqual({gate: len(items) for gate, items in by_gate.items()}, {"sample-gate": 1, "other-gate": 1})
        self.assertEqual(skipped, {"invalid_question": 1})


@unittest.skipIf(finetune is None, "laya and torch are not installed in this interpreter")
class CalibratedConfigTest(unittest.TestCase):
    INHERITED = {
        "max_len": 1024, "head_max_len": 256, "fine_tuned": True,
        "temperature": [1.0, 1.0, 1.0], "temperature_by_options": {"noul:2": 0.7, "choice:3-5": 2.0},
    }

    def test_a_trained_configuration_keeps_no_temperature_per_option_count(self):
        trained = finetune.without_option_temperatures(self.INHERITED)
        self.assertNotIn("temperature_by_options", trained)
        self.assertEqual(trained["temperature"], [1.0, 1.0, 1.0])
        self.assertEqual(trained["head_max_len"], 256)
        self.assertIn("temperature_by_options", self.INHERITED)

    def test_inherited_buckets_go_when_the_fit_has_none(self):
        written = calibrate.calibrated_config(self.INHERITED, [1.4, 1.0, 0.8], {})
        self.assertNotIn("temperature_by_options", written)
        self.assertEqual(written["temperature"], [1.4, 1.0, 0.8])
        self.assertEqual((written["max_len"], written["head_max_len"]), (1024, 256))

    def test_inherited_buckets_are_replaced_by_the_fitted_ones_alone(self):
        written = calibrate.calibrated_config(self.INHERITED, [1.4, 1.0, 0.8], {"noul:2": 1.3})
        self.assertEqual(written["temperature_by_options"], {"noul:2": 1.3})
        self.assertEqual(self.INHERITED["temperature_by_options"], {"noul:2": 0.7, "choice:3-5": 2.0})

    def test_a_fit_is_held_to_the_range_the_loader_applies(self):
        import numpy as np

        overconfident = [(np.array([12.0, -12.0], dtype=np.float32), [0.5, 0.5])] * calibrate.MIN_BUCKET
        underconfident = [(np.array([0.5, -0.5], dtype=np.float32), [1.0, 0.0])] * calibrate.MIN_BUCKET
        self.assertEqual(calibrate.fit_one_temp(overconfident), TEMP_MAX)
        self.assertEqual(calibrate.fit_one_temp(underconfident), TEMP_MIN)

    def test_a_fit_mixes_option_counts_without_padding_them_into_one(self):
        import numpy as np

        mixed = ([(np.array([2.0, -2.0], dtype=np.float32), [0.7, 0.3])] * 6
                 + [(np.array([2.0, 0.0, -2.0, -4.0], dtype=np.float32), [0.4, 0.3, 0.2, 0.1])] * 6)
        fitted = calibrate.fit_one_temp(mixed)
        self.assertGreater(fitted, 1.0)
        self.assertLess(fitted, TEMP_MAX)


if __name__ == "__main__":
    unittest.main()
