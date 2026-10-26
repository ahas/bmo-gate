"""How the server keeps checkpoints between their turns on the card, and how many the card takes at once:
run by tests/python.rs

The copies themselves need torch; where the interpreter has none, those tests are skipped and the rest run.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "runtime", "laya-server"))
sys.path.insert(0, os.path.join(HERE, "..", "support"))

from server import Checkpoint, MappedCopies, PinnedCopies, card_fit, host_copies, share_tokenizer  # noqa: E402

try:
    import torch
except ImportError:
    torch = None

MIB = 1 << 20


class CardFitTest(unittest.TestCase):
    def test_a_desktop_card_keeps_its_share_and_the_decision_room(self) -> None:
        # A 10 GiB card, 2 GiB kept for the desktop, 2 GiB for the decision, checkpoints of 1.3 GiB.
        self.assertEqual(card_fit(10240 * MIB, 2048 * MIB, 2048 * MIB, 1300 * MIB), 4)

    def test_a_card_of_its_own_takes_more(self) -> None:
        self.assertEqual(card_fit(12282 * MIB, 0, 2048 * MIB, 1300 * MIB), 7)

    def test_at_least_one_whatever_the_card(self) -> None:
        self.assertEqual(card_fit(1024 * MIB, 2048 * MIB, 2048 * MIB, 1300 * MIB), 1)
        self.assertEqual(card_fit(1024 * MIB, 0, 0, 0), 1)


class SharedTokenizerTest(unittest.TestCase):
    def test_checkpoints_whose_tokenizer_files_are_the_same_share_the_first_loaded(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            folders = []
            for name, text in (("a", "vocab"), ("b", "vocab"), ("c", "other"), ("d", None)):
                folder = os.path.join(root, name)
                os.makedirs(folder)
                if text is not None:
                    os.makedirs(os.path.join(folder, "tokenizer"))
                    with open(os.path.join(folder, "tokenizer", "tokenizer.json"), "w") as out:
                        out.write(text)
                folders.append(folder)
            agents = [SimpleNamespace(tok=object()) for _ in folders]
            own = [agent.tok for agent in agents]
            shared: dict = {}
            for agent, folder in zip(agents, folders):
                share_tokenizer(agent, folder, shared)
            self.assertIs(agents[1].tok, own[0])
            self.assertEqual([agent.tok for agent in agents[::2]], [own[0], own[2]])
            self.assertIs(agents[3].tok, own[3])


class HostCopiesSettingTest(unittest.TestCase):
    def test_the_two_ways_and_nothing_else(self) -> None:
        self.assertIsInstance(host_copies("pinned", "/d"), PinnedCopies)
        mapped = host_copies("mapped", "/d")
        self.assertIsInstance(mapped, MappedCopies)
        self.assertEqual(mapped.folder, "/d")
        with self.assertRaises(SystemExit):
            host_copies("swap", "/d")


class DumpNameTest(unittest.TestCase):
    def test_named_by_the_source_and_changed_when_its_files_change(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            source = os.path.join(root, "checkpoints", "output-format", "run", "step-000092")
            os.makedirs(source)
            weights = os.path.join(source, "model.safetensors")
            with open(weights, "wb") as out:
                out.write(b"one")
            copies = MappedCopies(os.path.join(root, "dumps"))
            first = copies.path(source)
            self.assertTrue(first.startswith(os.path.join(root, "dumps", "")))
            self.assertIn("output-format--run--step-000092--", first)
            self.assertEqual(copies.path(source), first)
            with open(weights, "wb") as out:
                out.write(b"other")
            os.utime(weights, ns=(os.stat(weights).st_mtime_ns + 10**9, os.stat(weights).st_mtime_ns + 10**9))
            self.assertNotEqual(copies.path(source), first)


@unittest.skipIf(torch is None, "torch is not importable here")
class KeptCopiesTest(unittest.TestCase):
    """A real checkpoint's host copies, kept each way, from a small module standing in for Laya's model."""

    def agent(self) -> SimpleNamespace:
        model = torch.nn.Sequential(torch.nn.Linear(4, 3), torch.nn.LayerNorm(3))
        with torch.no_grad():
            model[0].weight.copy_(torch.tensor([[0.5, 0.25, 0.125, 1.0]] * 3))
            model[0].bias.copy_(torch.tensor([0.1, 0.2, 0.3]))
        return SimpleNamespace(model=model, device="cpu", dtype=torch.float32)

    def test_mapped_copies_stand_in_a_dump_and_read_back_exactly(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            source = os.path.join(root, "step-000001")
            os.makedirs(source)
            with open(os.path.join(source, "model.safetensors"), "wb") as out:
                out.write(b"weights")
            agent = self.agent()
            expected = [tensor.detach().clone() for tensor in agent.model.state_dict().values()]
            copies = MappedCopies(os.path.join(root, "dumps"))

            checkpoint = Checkpoint("output-format", "step-000001", agent, 1, copies, source)

            dumps = os.listdir(os.path.join(root, "dumps"))
            self.assertEqual(len(dumps), 1)
            self.assertEqual(checkpoint.described()["where"], "card")
            checkpoint.on_card = False
            self.assertEqual(checkpoint.described()["where"], "mapped")
            # Exact weights narrow to 16 bits; the bias does not and keeps its width.
            hosts = [host for _, _, _, host in checkpoint.slots]
            self.assertEqual(hosts[0].dtype, torch.float16)
            self.assertEqual(hosts[1].dtype, torch.float32)
            for host, original in zip(hosts, expected):
                self.assertTrue(torch.equal(host.to(original.dtype), original))

            stamp = os.stat(os.path.join(root, "dumps", dumps[0])).st_mtime_ns
            Checkpoint("output-format", "step-000001", self.agent(), 1, copies, source)
            self.assertEqual(os.stat(os.path.join(root, "dumps", dumps[0])).st_mtime_ns, stamp)

    def test_a_mapped_checkpoint_on_the_card_holds_no_mapping_and_maps_its_dump_again_for_each_move(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            source = os.path.join(root, "step-000001")
            os.makedirs(source)
            with open(os.path.join(source, "model.safetensors"), "wb") as out:
                out.write(b"weights")
            agent = self.agent()
            expected = [tensor.detach().clone() for tensor in agent.model.state_dict().values()]
            checkpoint = Checkpoint("output-format", "step-000001", agent, 1, MappedCopies(os.path.join(root, "dumps")), source)
            host_bytes = checkpoint.described()["hostBytes"]
            with mock.patch("torch.cuda.synchronize"), mock.patch("torch.cuda.empty_cache"):
                for _ in range(2):
                    checkpoint.take_off_card()
                    checkpoint.put_on_card()
                    self.assertEqual({host for _, _, _, host in checkpoint.slots}, {None})
                    for tensor, original in zip(agent.model.state_dict().values(), expected):
                        self.assertTrue(torch.equal(tensor, original))
            self.assertEqual(checkpoint.described()["hostBytes"], host_bytes)

    def test_a_dump_that_does_not_match_is_made_again_and_the_stale_one_removed(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            source = os.path.join(root, "step-000001")
            os.makedirs(source)
            weights = os.path.join(source, "model.safetensors")
            with open(weights, "wb") as out:
                out.write(b"weights")
            copies = MappedCopies(os.path.join(root, "dumps"))
            Checkpoint("output-format", "step-000001", self.agent(), 1, copies, source)
            torch.save([torch.zeros(1)], copies.path(source))

            Checkpoint("output-format", "step-000001", self.agent(), 1, copies, source)
            self.assertIsNotNone(MappedCopies.read(copies.path(source), [host for host in torch.load(copies.path(source))]))

            with open(weights, "wb") as out:
                out.write(b"retrained")
            os.utime(weights, ns=(os.stat(weights).st_mtime_ns + 10**9, os.stat(weights).st_mtime_ns + 10**9))
            Checkpoint("output-format", "step-000001", self.agent(), 1, copies, source)
            self.assertEqual(os.listdir(os.path.join(root, "dumps")), [os.path.basename(copies.path(source))])


if __name__ == "__main__":
    unittest.main()
