"""How a test waits for what another thread does, on a clock it is handed rather than the wall clock read in the
test itself: the condition asked again on each beat of that clock, and given up only once the bound has passed on
it. The bound is a failure's, never a measurement: no test asserts how long anything took."""

from __future__ import annotations

import time
from typing import Callable


class Waits:
    def __init__(self, clock: Callable[[], float] = time.monotonic, pause: Callable[[float], None] = time.sleep,
                 bound_s: float = 30.0, beat_s: float = 0.01) -> None:
        self.clock = clock
        self.pause = pause
        self.bound_s = bound_s
        self.beat_s = beat_s

    def until(self, holds: Callable[[], object], what: str) -> None:
        """Returns once `holds` answers true; fails naming `what` where the bound passes first."""
        deadline = self.clock() + self.bound_s
        while not holds():
            if self.clock() > deadline:
                raise AssertionError(f"waited in vain for {what}")
            self.pause(self.beat_s)
