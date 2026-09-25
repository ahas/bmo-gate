"""How one gate's training sequences are balanced over their answers (docs/laya-server.md, 「The
training loop and calibration」): per question, never over the whole gate.

No model and no card: a sequence here is only the question it asks, its question type and the answer
its gold gives, so the rule is tested on a handful of dictionaries (test_balance.py).
"""

from __future__ import annotations

import random
from collections import defaultdict
from typing import Any, Dict, List, Optional, Tuple


def balanced_items(items: List[Dict[str, Any]], ratio: Optional[float], rng: random.Random) -> List[Dict[str, Any]]:
    """One gate's sequences with no answer more than `ratio` times as common as the rarest answer of
    the same question. A gate whose verdicts are nearly all one answer — the reference classifier says
    no to almost every candidate — otherwise teaches Laya to give that answer always, which agrees with
    it just as often and decides nothing.

    The count is per question because a reference gate's questions are its candidates, each with a
    rate of its own: counted over the gate, the candidates carrying most of its yes answers would keep
    every yes and lose nearly every no, and be taught to say yes to every turn. The questions only ever
    given one answer have nothing to balance against; together they keep at most `ratio` times the
    gate's rarest answer, shared evenly among them."""
    if ratio is None:
        return items
    by_question: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for item in items:
        by_question[item["question"]].append(item)
    gate_answers = answer_groups(items)
    if len(gate_answers) < 2:
        return items
    kept: List[Dict[str, Any]] = []
    settled: List[List[Dict[str, Any]]] = []
    for question in sorted(by_question):
        groups = answer_groups(by_question[question])
        if len(groups) < 2:
            settled.append(by_question[question])
            continue
        kept.extend(capped(list(groups.values()), int(min(len(group) for group in groups.values()) * ratio), rng))
    if settled:
        share = int(min(len(group) for group in gate_answers.values()) * ratio) // len(settled)
        kept.extend(capped(settled, max(share, 1), rng))
    rng.shuffle(kept)
    return kept


def answer_groups(items: List[Dict[str, Any]]) -> Dict[Tuple[int, int], List[Dict[str, Any]]]:
    """The sequences by the answer their gold gives, told apart by question type as well."""
    groups: Dict[Tuple[int, int], List[Dict[str, Any]]] = defaultdict(list)
    for item in items:
        groups[(item["qtype"], item["label"])].append(item)
    return groups


def capped(groups: List[List[Dict[str, Any]]], most: int, rng: random.Random) -> List[Dict[str, Any]]:
    """At most `most` of each group, drawn at random."""
    kept: List[Dict[str, Any]] = []
    for group in groups:
        group = list(group)
        rng.shuffle(group)
        kept.extend(group[:most])
    return kept
