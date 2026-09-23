"""Times the Laya server's /decide call from wherever it runs (docs/laya-server.md, 「Measured on the 3080」).

python3 bench.py --url http://192.0.2.8x:7431 --token-file <file> [--runs 50]
Standard library only, so it runs on main-host's own Python as well as in the server's venv.
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
import urllib.request

STATE = {
    "room": "개발방",
    "message": "내일 오전에 배포 일정 다시 잡아 주세요. 테스트가 두 개 실패해서 오늘은 못 올릴 것 같아요.",
}


def questions(count: int) -> dict:
    asked = {}
    for index in range(count):
        if index % 2 == 0:
            asked[f"q{index}"] = {"type": "noul", "instructions": f"이 메시지는 일정 변경 요청인가? ({index})"}
        else:
            asked[f"q{index}"] = {
                "type": "choice",
                "instructions": f"이 메시지는 누구의 작업 방식에 관한 것인가? ({index})",
                "criteria": {"universal": "모두", "personal": "한 사람", "room": "이 방", "none": "해당 없음"},
            }
    return asked


def call(url: str, token: str, body: dict) -> tuple[float, float]:
    data = json.dumps(body).encode()
    request = urllib.request.Request(f"{url}/decide", data=data, method="POST", headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json",
    })
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=30) as response:
        answer = json.load(response)
    return (time.perf_counter() - started) * 1000, float(answer["ms"])


def percentile(values: list[float], share: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(round(share * (len(ordered) - 1))))]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:7431")
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--runs", type=int, default=50)
    parser.add_argument("--sizes", default="1,10,50")
    args = parser.parse_args()
    with open(args.token_file, encoding="utf-8") as handle:
        token = handle.read().strip()
    for size in (int(part) for part in args.sizes.split(",")):
        body = {"state": STATE, "questions": questions(size)}
        call(args.url, token, body)  # the first call after a size change warms the kernels
        rounds = [call(args.url, token, body) for _ in range(args.runs)]
        trip = [whole for whole, _ in rounds]
        inside = [server for _, server in rounds]
        print(json.dumps({
            "questions": size,
            "runs": args.runs,
            "roundTripP50Ms": round(statistics.median(trip), 1),
            "roundTripP95Ms": round(percentile(trip, 0.95), 1),
            "serverP50Ms": round(statistics.median(inside), 1),
            "serverP95Ms": round(percentile(inside, 0.95), 1),
        }))


if __name__ == "__main__":
    main()
