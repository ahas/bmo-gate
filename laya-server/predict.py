"""Asks one checkpoint about rows outside the service, the way the service would answer them
(docs/laya-server.md, 「Asking a checkpoint outside the service」).

    .venv/bin/python predict.py --model <checkpoint dir> --rows <rows.jsonl> --out <answers.jsonl>

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
    args = parser.parse_args()

    import laya

    agent = laya.load(args.model, device="cuda")
    written = 0
    with open(args.rows, encoding="utf-8") as rows, open(args.out + ".partial", "w", encoding="utf-8") as out:
        for answered in answer_rows(agent, rows):
            out.write(json.dumps(answered, ensure_ascii=False) + "\n")
            written += 1
    os.replace(args.out + ".partial", args.out)
    sys.stderr.write(f"predict: {written} rows from {args.model}\n")


if __name__ == "__main__":
    main()
