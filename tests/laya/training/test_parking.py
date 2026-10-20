"""A training run's state parked off its device and put back: run by tests/python.rs

The parking needs torch; where the interpreter has none, the tests are skipped. Run the file with a venv's
python that has torch to have them.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "training", "laya"))

try:
    import torch

    from parking import Parking, card_slots, parking_for
except ImportError:
    torch = None


@unittest.skipIf(torch is None, "torch is not installed in this interpreter")
class ParkingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.folder = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(self.folder, ignore_errors=True))
        torch.manual_seed(0)
        self.model = torch.nn.Sequential(torch.nn.Linear(8, 16), torch.nn.Linear(16, 3))
        self.optimizer = torch.optim.AdamW(self.model.parameters(), weight_decay=0.01)
        self.device = torch.device("cpu")
        self.step()
        # A window in hand: gradients stand beside the moments.
        self.model(torch.ones(4, 8)).sum().backward()

    def step(self) -> None:
        self.model(torch.ones(4, 8)).sum().backward()
        self.optimizer.step()
        self.optimizer.zero_grad(set_to_none=True)

    def held(self) -> list:
        return [value.clone() for value in (*(p.data for p in self.model.parameters()), *(p.grad for p in self.model.parameters()),
                                            *(t for s in self.optimizer.state.values() for t in s.values()))]

    def test_every_tensor_is_parked_in_one_file_and_put_back_as_it_was(self) -> None:
        before = self.held()
        parking = parking_for(str(self.folder / "runs" / "gate-p0001"), self.folder / "parked")
        parked, _ = parking.park(self.model, self.optimizer, self.device)
        self.assertEqual(parking.path.name, "gate-p0001.bin")
        self.assertEqual(parked, sum(value.numel() * value.element_size() for value in before))
        self.assertGreaterEqual(parking.path.stat().st_size, parked)
        self.assertEqual(len(parking.slots), len(card_slots(self.model, self.optimizer, self.device)))
        parking.restore(self.device)
        self.assertFalse(parking.path.exists())
        for was, now in zip(before, self.held()):
            self.assertTrue(torch.equal(was, now))
        self.optimizer.step()

    def test_a_run_parked_and_put_back_trains_as_one_never_parked(self) -> None:
        twin = torch.nn.Sequential(torch.nn.Linear(8, 16), torch.nn.Linear(16, 3))
        twin.load_state_dict(self.model.state_dict())
        twin_optimizer = torch.optim.AdamW(twin.parameters(), weight_decay=0.01)
        twin_optimizer.load_state_dict(self.optimizer.state_dict())
        for p, q in zip(self.model.parameters(), twin.parameters()):
            q.grad = p.grad.clone()
        parking = Parking(self.folder / "parked" / "run.bin")
        parking.park(self.model, self.optimizer, self.device)
        parking.restore(self.device)
        for model, optimizer in ((self.model, self.optimizer), (twin, twin_optimizer)):
            optimizer.step()
        for p, q in zip(self.model.parameters(), twin.parameters()):
            self.assertTrue(torch.equal(p.data, q.data))

    def test_a_device_named_without_an_index_takes_in_every_one_of_its_kind(self) -> None:
        from types import SimpleNamespace

        from parking import on

        first = SimpleNamespace(device=torch.device("cuda", 0))
        self.assertTrue(on(first, torch.device("cuda")))
        self.assertTrue(on(first, torch.device("cuda", 0)))
        self.assertFalse(on(first, torch.device("cuda", 1)))
        self.assertFalse(on(first, torch.device("cpu")))

    def test_clearing_empties_the_folder_of_a_killed_runs_state(self) -> None:
        folder = self.folder / "parked"
        folder.mkdir()
        (folder / "old.bin").write_bytes(b"x")
        Parking.clear(folder)
        self.assertEqual(list(folder.iterdir()), [])
        Parking.clear(self.folder / "absent")


@unittest.skipIf(torch is None, "torch is not installed in this interpreter")
class HeldCardTest(unittest.TestCase):
    """The turn given back only once the card holds nothing of the run: the device stands in for the card,
    and what the allocator says the run holds there is counted from the run's own tensors."""

    def setUp(self) -> None:
        from unittest import mock

        from parking import HeldCard

        torch.manual_seed(0)
        self.model = torch.nn.Sequential(torch.nn.Linear(64, 64), torch.nn.BatchNorm1d(64))
        self.optimizer = torch.optim.AdamW(self.model.parameters())
        self.model(torch.ones(4, 64)).sum().backward()
        self.optimizer.step()
        self.device = torch.device("cpu")
        self.left_at_let_go: list = []
        held = self

        class Turn:
            fd = 3

            def let_go(self) -> None:
                held.left_at_let_go.append(held.allocated())
                self.fd = None

        self.card = HeldCard(None, str(Path(tempfile.mkdtemp()) / "run"))
        self.card.turn = Turn()
        for name, stand_in in (("empty_cache", lambda: None), ("memory_allocated", lambda device=None: self.allocated())):
            patched = mock.patch(f"torch.cuda.{name}", stand_in)
            patched.start()
            self.addCleanup(patched.stop)

    def allocated(self) -> int:
        tensors = [*self.model.parameters(), *self.model.buffers(),
                   *(p.grad for p in self.model.parameters() if p.grad is not None),
                   *(t for s in self.optimizer.state.values() for t in s.values() if torch.is_tensor(t))]
        return sum(t.numel() * t.element_size() for t in tensors)

    def test_a_finished_run_empties_the_card_before_its_turn_is_given_back(self) -> None:
        self.card.finish(self.model, self.optimizer, self.device)
        self.assertEqual(self.left_at_let_go, [0])

    def test_a_run_whose_memory_stays_on_the_card_ends_without_giving_the_turn_back(self) -> None:
        from parking import PARKED_LEFT_BYTES

        self.model.append(torch.nn.Linear(8192, 4096))
        self.assertGreater(self.allocated(), PARKED_LEFT_BYTES)
        with self.assertRaises(SystemExit):
            self.card.let_go(self.device)
        self.assertEqual(self.left_at_let_go, [])


if __name__ == "__main__":
    unittest.main()
