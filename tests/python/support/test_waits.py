"""The shared waits, on a clock of the test's own: a condition that holds returns at once, one that comes true on a
later beat returns then, and one that never does fails once the bound has passed on that clock. Run by
tests/python.rs."""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from waits import Waits  # noqa: E402


class Ticking:
    """A clock that moves only when the waits pause on it."""

    def __init__(self) -> None:
        self.now = 0.0
        self.pauses = 0

    def __call__(self) -> float:
        return self.now

    def pause(self, seconds: float) -> None:
        self.pauses += 1
        self.now += seconds


class WaitsTest(unittest.TestCase):
    def test_a_condition_that_holds_is_not_waited_on(self) -> None:
        clock = Ticking()
        Waits(clock, clock.pause).until(lambda: True, "nothing")
        self.assertEqual(clock.pauses, 0)

    def test_a_condition_that_comes_true_is_waited_on_until_it_does(self) -> None:
        clock = Ticking()
        Waits(clock, clock.pause, beat_s=1.0).until(lambda: clock.now >= 3, "the third beat")
        self.assertEqual(clock.pauses, 3)

    def test_a_condition_that_never_holds_fails_once_the_bound_passes_on_the_clock_handed(self) -> None:
        clock = Ticking()
        with self.assertRaises(AssertionError) as failed:
            Waits(clock, clock.pause, bound_s=5.0, beat_s=1.0).until(lambda: False, "the impossible")
        self.assertIn("the impossible", str(failed.exception))
        self.assertEqual(clock.pauses, 6)


if __name__ == "__main__":
    unittest.main()
