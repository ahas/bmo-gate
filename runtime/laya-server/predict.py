"""Asks one checkpoint about rows outside the service, the way the service would answer them
(docs/laya-server.md, 「Asking a checkpoint outside the service」).

    .venv/bin/python predict.py --model <checkpoint dir> --rows <rows.jsonl> --out <answers.jsonl> [--device cpu] [--card-lock <path>]

With `--card-lock` it holds the node's card as a turn that gives way, as a calibration does.

Each row's state and questions are put to the checkpoint as they stand in the row, through the same
predict call the server makes, under the temperatures the checkpoint carries. One line is written a
row: its id, gate and turn, and each question's probability of yes, so two checkpoints asked about
the same rows can be set side by side question by question. Nothing is trained or fitted.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, Iterable, Iterator

os.environ.setdefault("USE_TF", "0")


def yes_of(answer: Any) -> Any:
    """A yes/no question's probability of yes as the service answers it, or None for any other."""
    return answer.get("noul") if isinstance(answer, dict) else None


def answer_rows(agent: Any, lines: Iterable[str]) -> Iterator[Dict[str, Any]]:
    """Each row asked of the checkpoint, in the order read."""
    for line in lines:
        if not line.strip():
            continue
        row = json.loads(line)
        state, questions = json.loads(row["state"]), json.loads(row["questions"])
        answers = agent.predict(state, questions).get("answers", {})
        yield {
            "id": row["id"],
            "gate": row["gate"],
            "turn": row.get("turn"),
            "answers": {qid: yes_of(answers.get(qid)) for qid in questions},
        }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", required=True, help="the checkpoint directory to ask")
    parser.add_argument("--rows", required=True, help="the rows to ask about, one a line")
    parser.add_argument("--out", required=True, help="where the answers go, one line a row")
    parser.add_argument("--device", default="cuda", help="where the checkpoint runs: cuda, or cpu to leave the card to whoever holds it")
    parser.add_argument("--card-lock", default=None, metavar="PATH",
                        help="hold the node's card lock at PATH as a turn that gives way, declared as BMO_CARD_SERVICE")
    parser.add_argument("--quiet-s", type=float, default=30.0,
                        help="after giving way, how long the card stands quiet before it is asked for again")
    args = parser.parse_args()

    import laya

    # Held as a calibration holds it: told that an occupant above wants the card, it parks the model after
    # the row in hand and takes the card back once it has stood quiet.
    card = None
    if args.card_lock is not None:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from parking import HeldCard

        card = HeldCard(args.card_lock, args.out)
    agent = laya.load(args.model, device=args.device)
    written = 0
    with open(args.rows, encoding="utf-8") as rows, open(args.out + ".partial", "w", encoding="utf-8") as out:
        for answered in answer_rows(agent, rows):
            out.write(json.dumps(answered, ensure_ascii=False) + "\n")
            written += 1
            if card is not None and card.asked_for() is not None:
                card.give_way(agent.model, None, agent.device, args.quiet_s)
    del agent
    if card is not None:
        card.put_down(args.device)
    os.replace(args.out + ".partial", args.out)
    sys.stderr.write(f"predict: {written} rows from {args.model}\n")


if __name__ == "__main__":
    main()
