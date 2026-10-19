"""How one gate's training sequences are balanced over their answers (docs/laya-server.md, 「The
training loop and calibration」): per question, never over the whole gate.

No model and no card: a sequence here is only the question it asks, its question type and the answer
its gold gives, so the rule is tested on a handful of dictionaries (test_balance.py).
"""

from __future__ import annotations

import math
import random
from collections import defaultdict
from typing import Any, Dict, List, Optional, Tuple


def balanced_as(qid: str, row: Dict[str, Any]) -> str:
    """The question a sequence is balanced under: its own, within the kind of input its row names where
    it names one. A piece the knowledge gate asks over a job's request and over a conversation turn is
    needed at different rates in each, so each kind keeps its own ratio."""
    stratum = row.get("stratum")
    return f"{stratum}\u0000{qid}" if stratum else qid


def kind_ratios_of(given: List[str]) -> Optional[Dict[str, float]]:
    """The ratios `--kind-ratio KIND=RATIO` names, each kind once, the last standing; None where none is
    named, so a run that names none is the run it always was."""
    ratios: Dict[str, float] = {}
    for one in given:
        kind, _, ratio = one.partition("=")
        if not kind or not ratio or float(ratio) <= 0:
            raise ValueError(f"a kind ratio is KIND=RATIO with a ratio above zero, not {one!r}")
        ratios[kind] = float(ratio)
    return ratios or None


def balanced_items(items: List[Dict[str, Any]], ratio: Optional[float], rng: random.Random,
                   kind_ratios: Optional[Dict[str, float]] = None) -> List[Dict[str, Any]]:
    """One gate's sequences with no answer more than `ratio` times as common as the rarest answer of
    the same question. A gate whose verdicts are nearly all one answer — the reference classifier says
    no to almost every candidate — otherwise teaches Laya to give that answer always, which agrees with
    it just as often and decides nothing.

    The count is per question because a reference gate's questions are its candidates, each with a
    rate of its own: counted over the gate, the candidates carrying most of its yes answers would keep
    every yes and lose nearly every no, and be taught to say yes to every turn. The questions only ever
    given one answer have nothing to balance against; together they keep at most `ratio` times the
    gate's rarest answer, shared evenly among them.

    A question asked over a kind of input named in `kind_ratios` is held to that kind's ratio instead:
    where a kind's rarer answers are plentiful, cutting its common answer to three times them would
    teach every piece a rate far above the one it is needed at."""
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
        held_to = (kind_ratios or {}).get(by_question[question][0].get("kind") or "", ratio)
        kept.extend(capped(list(groups.values()), int(min(len(group) for group in groups.values()) * held_to), rng))
    if settled:
        share = int(min(len(group) for group in gate_answers.values()) * ratio) // len(settled)
        kept.extend(capped(settled, max(share, 1), rng))
    rng.shuffle(kept)
    return kept


def repeated_rare(items: List[Dict[str, Any]], ratio: float, cap: int, rng: random.Random) -> List[Dict[str, Any]]:
    """Every one of a gate's sequences kept, and each question's rarer answers repeated until the
    commonest is no more than `ratio` times as common, but never more than `cap` times over: the
    manufacturer's way with a rare answer, which re-weights it rather than dropping the common one
    (Laya's docs/finetune_browser_agent.md repeats its rare operations three and four times).

    Counted per question for the reason `balanced_items` is: a reference gate's questions are its
    candidates, each with a rate of its own. The cap keeps a candidate with two yes answers in three
    thousand from being taught those two sentences a thousand times. A question only ever given one
    answer has nothing rarer and is kept as it stands."""
    kept: List[Dict[str, Any]] = []
    by_question: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for item in items:
        by_question[item["question"]].append(item)
    for question in sorted(by_question):
        groups = answer_groups(by_question[question])
        most = max(len(group) for group in groups.values())
        for group in groups.values():
            times = min(cap, max(1, math.ceil(most / (ratio * len(group))))) if len(groups) > 1 else 1
            kept.extend(group * times)
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
