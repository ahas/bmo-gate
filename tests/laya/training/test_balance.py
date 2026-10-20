"""How a gate's sequences are balanced, counted on a handful of dictionaries:
run by tests/python.rs

No model is loaded and no card is touched.
"""

from __future__ import annotations

import os
import random
import sys
import unittest
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "training", "laya"))

from balance import balanced_as, balanced_items, kind_ratios_of, repeated_rare  # noqa: E402

NOUL = 0
NO, YES = 0, 1


def sequences(question: str, yes: int, no: int) -> list:
    return [{"question": question, "qtype": NOUL, "label": YES} for _ in range(yes)] + [
        {"question": question, "qtype": NOUL, "label": NO} for _ in range(no)
    ]


def tally(items: list) -> Counter:
    return Counter((item["question"], item["label"]) for item in items)


class BalancedItems(unittest.TestCase):
    def test_a_gate_of_one_question_keeps_the_rarest_and_three_times_it(self) -> None:
        kept = tally(balanced_items(sequences("leak", 10, 100), 3.0, random.Random(1)))

        self.assertEqual(kept, Counter({("leak", YES): 10, ("leak", NO): 30}))

    def test_each_candidate_is_held_to_its_own_ratio(self) -> None:
        items = sequences("structure", 60, 240) + sequences("speech", 6, 94)
        kept = tally(balanced_items(items, 3.0, random.Random(1)))

        self.assertEqual(kept[("structure", YES)], 60)
        self.assertEqual(kept[("structure", NO)], 180)
        self.assertEqual(kept[("speech", YES)], 6)
        self.assertEqual(kept[("speech", NO)], 18)

    def test_the_candidate_carrying_most_yes_answers_is_not_taught_yes_always(self) -> None:
        items = sequences("structure", 60, 240) + [
            item for piece in range(40) for item in sequences(f"lore-{piece}", 0, 100)
        ]
        kept = tally(balanced_items(items, 3.0, random.Random(1)))

        self.assertLess(kept[("structure", YES)], kept[("structure", NO)])

    def test_candidates_never_answered_yes_share_three_times_the_rarest_answer(self) -> None:
        items = sequences("structure", 60, 240) + [
            item for piece in range(40) for item in sequences(f"lore-{piece}", 0, 100)
        ]
        kept = tally(balanced_items(items, 3.0, random.Random(1)))

        lore = [kept[(f"lore-{piece}", NO)] for piece in range(40)]
        self.assertEqual(set(lore), {60 * 3 // 40})

    def test_a_candidate_never_answered_yes_keeps_at_least_one(self) -> None:
        items = sequences("structure", 1, 3) + [
            item for piece in range(10) for item in sequences(f"lore-{piece}", 0, 5)
        ]
        kept = tally(balanced_items(items, 3.0, random.Random(1)))

        self.assertTrue(all(kept[(f"lore-{piece}", NO)] == 1 for piece in range(10)))

    def test_a_piece_is_held_to_its_ratio_within_each_kind_of_input_its_rows_name(self) -> None:
        turn, work = balanced_as("nodes", {"stratum": "turn"}), balanced_as("nodes", {"stratum": "work"})
        items = sequences(turn, 60, 1000) + sequences(work, 6, 1000)
        kept = tally(balanced_items(items, 3.0, random.Random(1)))

        self.assertEqual(balanced_as("nodes", {}), "nodes")
        self.assertEqual((kept[(turn, YES)], kept[(turn, NO)]), (60, 180))
        self.assertEqual((kept[(work, YES)], kept[(work, NO)]), (6, 18))

    def test_a_kind_named_with_a_ratio_of_its_own_is_held_to_it_and_the_rest_to_the_gate_s(self) -> None:
        turn, work = balanced_as("nodes", {"stratum": "turn"}), balanced_as("nodes", {"stratum": "work"})
        items = [{**item, "kind": "turn"} for item in sequences(turn, 60, 1000)] + [
            {**item, "kind": "work"} for item in sequences(work, 60, 1000)
        ]
        kept = tally(balanced_items(items, 3.0, random.Random(1), kind_ratios_of(["work=8"])))

        self.assertEqual((kept[(turn, YES)], kept[(turn, NO)]), (60, 180))
        self.assertEqual((kept[(work, YES)], kept[(work, NO)]), (60, 480))

    def test_a_kind_ratio_is_a_kind_and_a_ratio_above_zero(self) -> None:
        self.assertIsNone(kind_ratios_of([]))
        self.assertEqual(kind_ratios_of(["work=8", "work=6"]), {"work": 6.0})
        for wrong in ("work", "=8", "work=0"):
            with self.assertRaises(ValueError):
                kind_ratios_of([wrong])

    def test_a_gate_with_one_answer_or_no_ratio_is_left_whole(self) -> None:
        one_answer = [item for piece in range(3) for item in sequences(f"lore-{piece}", 0, 5)]

        self.assertEqual(len(balanced_items(one_answer, 3.0, random.Random(1))), 15)
        self.assertEqual(len(balanced_items(sequences("leak", 1, 50), None, random.Random(1))), 51)



class RepeatedRare(unittest.TestCase):
    def test_every_sequence_stays_and_each_rarer_answer_is_repeated_toward_the_ratio_up_to_the_cap(self) -> None:
        items = sequences("structure", 60, 240) + sequences("speech", 6, 94) + sequences("leak", 2, 3000) + sequences("lore", 0, 50)
        kept = tally(repeated_rare(items, 3.0, 50, random.Random(1)))

        self.assertEqual(kept, Counter({
            ("structure", YES): 120, ("structure", NO): 240,
            ("speech", YES): 36, ("speech", NO): 94,
            ("leak", YES): 100, ("leak", NO): 3000,
            ("lore", NO): 50,
        }))

    def test_a_cap_of_four_repeats_every_rarer_answer_four_times(self) -> None:
        kept = tally(repeated_rare(sequences("speech", 6, 94), 3.0, 4, random.Random(1)))

        self.assertEqual(kept, Counter({("speech", YES): 24, ("speech", NO): 94}))

if __name__ == "__main__":
    unittest.main()
