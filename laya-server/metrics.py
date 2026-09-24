"""What a trained gate came to, counted (docs/training.md, 「The tables」): agreement with
the LLM's verdicts plain and balanced over the answers, the counts behind both, the difference from
the base model measured the same way, and — for a gate that may settle one answer on its own — how
many calls that answer would have missed at each threshold.

Nothing here loads a model or touches a GPU. It is handed one record per judged question and gives
back the report the verification table is assembled from, so every figure in that table can be
checked on fixed numbers rather than on a training run.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional, Sequence

REPORT_KIND = "laya-calibration"

# The thresholds a gate's own table carries, the same ones the agreement table has always shown
# (BMO's docs/laya.md, 「Agreement」), so a figure read here sits beside one read there.
THRESHOLDS = (0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99)


def answer_names(question: Dict[str, Any]) -> List[str]:
    """The answers a question can be given, in the order the model's own outputs stand in. A yes/no
    question is false then true, which is the order the training builds its target in."""
    kind = question.get("type")
    if kind == "noul":
        return ["false", "true"]
    if kind == "choice":
        criteria = question.get("criteria", {})
        return list(criteria.keys()) if isinstance(criteria, dict) else [str(one) for one in criteria]
    if kind == "score":
        criteria = question.get("criteria", [])
        return [str(level) for level in range(len(criteria) if isinstance(criteria, list) else 4)]
    return []


def parse_asymmetric(text: str) -> Dict[str, str]:
    """`<게이트>:<질문>:<답>` — the gate, the question of it that is asymmetric, and the one answer
    Laya may settle there. It is given rather than looked up, because which answer a gate may settle
    is that gate's own declaration and not this script's to know."""
    parts = text.split(":")
    if len(parts) != 3 or not all(part.strip() for part in parts):
        raise ValueError(f"asymmetric rule {text!r} is not <gate>:<question>:<settled answer>")
    return {"gate": parts[0].strip(), "question": parts[1].strip(), "settles": parts[2].strip()}


def _share(part: int, whole: int) -> Optional[float]:
    return None if whole <= 0 else round(part / whole, 4)


def figures(judged: Sequence[Dict[str, Any]], ece: Optional[Callable[[List[float], List[float]], float]]) -> Dict[str, Any]:
    """One set of questions counted: how many, how often the model agreed, the same averaged over the
    answers the gold gave, the calibration error, and the counts each of those rests on."""
    if not judged:
        return {"questions": 0, "agreement": None, "balanced": None, "ece": None, "answers": {}, "correct": {}}

    answers: Dict[str, int] = {}
    correct: Dict[str, int] = {}
    for one in judged:
        name = one["answers"][one["gold"]] if one["gold"] < len(one["answers"]) else str(one["gold"])
        answers[name] = answers.get(name, 0) + 1
        correct[name] = correct.get(name, 0) + (1 if one["predicted"] == one["gold"] else 0)

    agreed = sum(correct.values())
    # Balanced: each answer weighs the same however often it was given, which is what tells a real
    # judgement from a model that always gives the gate's common answer.
    shares = [correct[name] / answers[name] for name in sorted(answers)]

    return {
        "questions": len(judged),
        "agreement": round(agreed / len(judged), 4),
        "balanced": round(sum(shares) / len(shares), 4),
        "ece": None if ece is None else round(float(ece([one["confidence"] for one in judged], [1.0 if one["predicted"] == one["gold"] else 0.0 for one in judged])), 4),
        "answers": {name: answers[name] for name in sorted(answers)},
        "correct": {name: correct[name] for name in sorted(answers)},
    }


def missed_calls(
    judged: Sequence[Dict[str, Any]], rule: Dict[str, str], thresholds: Sequence[float] = THRESHOLDS,
) -> Optional[Dict[str, Any]]:
    """What a gate's one settleable answer would cost at each threshold. Laya settles only that answer;
    everything else goes to the model and costs nothing but a call. So a missed call is a question whose
    gold says otherwise and which the model answers with the settleable one at or above the threshold —
    for 응답 여부 판정기 that is a message that wanted an answer and would not have had one.

    None where this set holds none of that gate's question at all, since a count over nothing is not a
    zero."""
    rows = [one for one in judged if one["gate"] == rule["gate"] and one["question"] == rule["question"]]
    if not rows:
        return None
    if rule["settles"] not in rows[0]["answers"]:
        return None

    settles = rows[0]["answers"].index(rule["settles"])
    wanted = [one for one in rows if one["gold"] != settles]
    at: List[Dict[str, Any]] = []
    for tau in thresholds:
        settled = [one for one in rows if one["predicted"] == settles and one["confidence"] >= tau]
        missed = [one for one in settled if one["gold"] != settles]
        at.append({
            "tau": tau,
            "settled": len(settled),
            "coverage": _share(len(settled), len(rows)),
            "missed": len(missed),
            "missed_rate": _share(len(missed), len(wanted)),
        })

    return {
        "question": rule["question"],
        "settles": rule["settles"],
        "questions": len(rows),
        "wanted": len(wanted),
        "thresholds": at,
    }


def by_gate(judged: Sequence[Dict[str, Any]], ece=None) -> Dict[str, Any]:
    """Every gate in this set counted on its own, and the whole set beside them."""
    gates = sorted({one["gate"] for one in judged})

    return {
        "overall": figures(judged, ece),
        "gates": {gate: figures([one for one in judged if one["gate"] == gate], ece) for gate in gates},
    }


def difference(tuned: Dict[str, Any], base: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """What the training moved: the trained model's figures less the base model's, measured the same
    way on the same rows. A figure either side is missing where its set held nothing."""
    if base is None:
        return None
    moved: Dict[str, Any] = {}
    for name in ("agreement", "balanced", "ece"):
        here, there = tuned.get(name), base.get(name)
        moved[name] = None if here is None or there is None else round(here - there, 4)

    return moved


def report(
    model: str,
    data: str,
    judged: Sequence[Dict[str, Any]],
    base_judged: Optional[Sequence[Dict[str, Any]]] = None,
    base_model: Optional[str] = None,
    rules: Sequence[Dict[str, str]] = (),
    ece=None,
    written_at: str = "",
    thresholds: Sequence[float] = THRESHOLDS,
) -> Dict[str, Any]:
    """The machine-readable account of one calibration: what was measured, what the base came to on the
    same rows, what the training moved, and what a settleable answer would have missed."""
    tuned = by_gate(judged, ece)
    base = None if base_judged is None else by_gate(base_judged, ece)
    gates: Dict[str, Any] = {}

    for gate, counted in tuned["gates"].items():
        gate_base = None if base is None else base["gates"].get(gate)
        asymmetric = [one for one in (missed_calls(judged, rule, thresholds) for rule in rules if rule["gate"] == gate) if one is not None]
        gates[gate] = {
            **counted,
            "base": gate_base,
            "difference": difference(counted, gate_base),
            "asymmetric": asymmetric,
        }

    return {
        "kind": REPORT_KIND,
        "model": model,
        "base_model": base_model,
        "data": data,
        "written_at": written_at,
        "thresholds": list(thresholds),
        "overall": {
            **tuned["overall"],
            "base": None if base is None else base["overall"],
            "difference": difference(tuned["overall"], None if base is None else base["overall"]),
        },
        "gates": gates,
    }
