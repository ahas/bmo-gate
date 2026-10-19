"""The resume bookkeeping, on the CPU and with no torch: run by tests/python.rs

What needs a GPU is the training itself. Everything a killed run is carried on by — which step
checkpoint is whole, what a resume has to match, the order the items are read in, which checkpoints are
dropped and what says a run finished — is plain state, and is checked here rather than on a node.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "training", "laya"))

import resume  # noqa: E402

RUN = {
    "seed": 42, "epochs": 4, "micro_batch": 4, "effective_batch": 64, "accumulate": 16, "group": 4,
    "items": 1303, "data_sha256": "abc123", "balance_ratio": 3.0, "per_gate": None,
    "freeze_embeddings": False, "optimizer": "adamw", "sigma_start": 0.4, "sigma_end": 0.1,
    "lr_encoder": 2.5e-5, "lr_head": 1.0e-4,
}


def state_at(step: int, epoch: int, item_index: int, run=None) -> dict:
    return {"step": step, "epoch": epoch, "item_index": item_index, "epochs": [],
            "elapsed_seconds": 12.5, "resumes": 0, "run": dict(run or RUN)}


class StepCheckpointTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = os.path.join(self.tmp.name, "run")

    def tearDown(self):
        self.tmp.cleanup()

    def write_step(self, step: int, *, state=True, tensors=True, partial=False, epoch=0, item_index=0) -> str:
        name = resume.step_dir_name(step) + (resume.PARTIAL_SUFFIX if partial else "")
        path = os.path.join(resume.steps_root(self.out), name)
        os.makedirs(path, exist_ok=True)
        if state:
            resume.write_state(path, state_at(step, epoch, item_index))
        if tensors:
            with open(os.path.join(path, resume.TENSOR_NAME), "wb") as handle:
                handle.write(b"tensors")
        return path

    def test_step_dir_name_and_back(self):
        self.assertEqual(resume.step_dir_name(7), "step-000007")
        self.assertEqual(resume.step_dir_name(123456), "step-123456")
        self.assertEqual(resume.step_of_dir("step-000007"), 7)
        self.assertEqual(resume.step_of_dir("step-1234567"), 1234567)
        self.assertIsNone(resume.step_of_dir("checkpoint_latest"))
        self.assertIsNone(resume.step_of_dir("step-7"))

    def test_newest_whole_checkpoint_is_the_one_resumed_from(self):
        self.write_step(10)
        self.write_step(20)
        step, path = resume.latest_step(self.out)
        self.assertEqual(step, 20)
        self.assertEqual(os.path.basename(path), "step-000020")

    def test_a_save_that_was_killed_is_not_read(self):
        self.write_step(10)
        self.write_step(20, partial=True)
        self.write_step(30, tensors=False)
        self.write_step(40, state=False)
        self.assertEqual([step for step, _ in resume.step_dirs(self.out)], [10])
        self.assertEqual(resume.latest_step(self.out)[0], 10)

    def test_no_step_checkpoints_at_all(self):
        self.assertEqual(resume.step_dirs(self.out), [])
        self.assertIsNone(resume.latest_step(self.out))

    def test_state_round_trip(self):
        path = self.write_step(10, epoch=2, item_index=480)
        read = resume.read_state(path)
        self.assertEqual(read["step"], 10)
        self.assertEqual(read["epoch"], 2)
        self.assertEqual(read["item_index"], 480)
        self.assertEqual(read["run"]["seed"], 42)
        self.assertEqual(read["version"], resume.STATE_VERSION)

    def test_a_file_that_is_not_ours_is_not_a_state(self):
        path = self.write_step(10)
        with open(os.path.join(path, resume.STATE_NAME), "w", encoding="utf-8") as handle:
            json.dump({"kind": "something-else", "step": 99}, handle)
        self.assertIsNone(resume.read_state(path))
        self.assertEqual(resume.step_dirs(self.out), [(10, path)])


class RetentionTest(unittest.TestCase):
    def steps(self, *numbers):
        return [(step, f"/run/steps/{resume.step_dir_name(step)}") for step in numbers]

    def test_all_but_the_newest_kept_are_dropped(self):
        dropped = resume.prunable(self.steps(10, 20, 30, 40), keep=2)
        self.assertEqual([os.path.basename(path) for path in dropped], ["step-000010", "step-000020"])

    def test_the_newest_is_never_dropped(self):
        self.assertEqual(resume.prunable(self.steps(10), keep=2), [])
        self.assertEqual(resume.prunable(self.steps(10, 20), keep=0), [path for _, path in self.steps(10)])
        self.assertEqual(resume.prunable(self.steps(10), keep=0), [])
        self.assertEqual(resume.prunable([], keep=2), [])


class CompletionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = os.path.join(self.tmp.name, "run")

    def tearDown(self):
        self.tmp.cleanup()

    def start_a_run(self) -> str:
        path = os.path.join(resume.steps_root(self.out), resume.step_dir_name(20))
        os.makedirs(path, exist_ok=True)
        resume.write_state(path, state_at(20, 1, 100))
        with open(os.path.join(path, resume.TENSOR_NAME), "wb") as handle:
            handle.write(b"tensors")
        return path

    def test_a_started_run_is_not_a_finished_one(self):
        self.start_a_run()
        self.assertTrue(os.path.exists(self.out))
        self.assertFalse(resume.is_finished(self.out))
        self.assertIsNone(resume.completion(self.out))
        self.assertEqual(resume.run_action(self.out), "resume")

    def test_the_marker_says_finished(self):
        self.start_a_run()
        resume.mark_complete(self.out, {"steps": 80, "epochs": 4, "resumes": 1, "seed": 42})
        self.assertTrue(resume.is_finished(self.out))
        self.assertEqual(resume.completion(self.out)["steps"], 80)
        self.assertEqual(resume.run_action(self.out), "measure")

    def test_nothing_there_is_a_run_to_start(self):
        self.assertEqual(resume.run_action(self.out), "train")

    def test_a_directory_with_nothing_to_resume_from_is_stuck(self):
        os.makedirs(self.out, exist_ok=True)
        with open(os.path.join(self.out, "model.safetensors"), "wb") as handle:
            handle.write(b"half a checkpoint")
        self.assertEqual(resume.run_action(self.out), "stuck")

    def test_a_marker_of_another_kind_is_not_one(self):
        os.makedirs(self.out, exist_ok=True)
        with open(os.path.join(self.out, resume.COMPLETE_NAME), "w", encoding="utf-8") as handle:
            json.dump({"kind": "someone-elses", "steps": 80}, handle)
        self.assertFalse(resume.is_finished(self.out))


class ResumeFaultTest(unittest.TestCase):
    def test_the_same_run_carries_on(self):
        self.assertIsNone(resume.resume_fault(state_at(20, 1, 100), dict(RUN)))

    def test_another_seed_is_another_run(self):
        fault = resume.resume_fault(state_at(20, 1, 100), {**RUN, "seed": 7})
        self.assertIn("seed", fault)
        self.assertIn("42", fault)

    def test_data_that_moved_is_named(self):
        fault = resume.resume_fault(state_at(20, 1, 100), {**RUN, "data_sha256": "def456"})
        self.assertIn("data_sha256", fault)

    def test_a_different_batch_is_named(self):
        fault = resume.resume_fault(state_at(20, 1, 100), {**RUN, "micro_batch": 8})
        self.assertIn("micro_batch", fault)

    def test_fields_outside_the_run_do_not_count(self):
        self.assertIsNone(resume.resume_fault(state_at(20, 1, 100), {**RUN, "base": "/somewhere/else"}))

    def test_a_state_without_its_run_cannot_be_resumed(self):
        self.assertIsNotNone(resume.resume_fault({"step": 20, "epoch": 1, "item_index": 100}, dict(RUN)))


class DataOrderTest(unittest.TestCase):
    def test_an_epoch_reads_every_item_once(self):
        order = resume.epoch_order(50, seed=42, epoch=0)
        self.assertEqual(sorted(order), list(range(50)))

    def test_the_same_run_and_epoch_give_the_same_order(self):
        self.assertEqual(resume.epoch_order(50, 42, 2), resume.epoch_order(50, 42, 2))

    def test_each_epoch_and_each_seed_read_in_their_own_order(self):
        self.assertNotEqual(resume.epoch_order(50, 42, 0), resume.epoch_order(50, 42, 1))
        self.assertNotEqual(resume.epoch_order(50, 42, 0), resume.epoch_order(50, 7, 0))

    def test_a_resumed_run_reads_what_the_killed_one_would_have(self):
        count, micro, epochs, seed = 20, 4, 3, 42

        def consume(start_epoch, start_index):
            read = []
            for epoch in range(start_epoch, epochs):
                order = resume.epoch_order(count, seed, epoch)
                first = start_index if epoch == start_epoch else 0
                for start in range(first, count, micro):
                    read.append((epoch, tuple(order[start:start + micro])))
            return read

        whole = consume(0, 0)
        killed_after = 3  # three micro-batches into the run
        killed = whole[:killed_after]
        epoch, item_index = resume.next_position(killed[-1][0], killed_after * micro, count, epochs)
        self.assertEqual(killed + consume(epoch, item_index), whole)

    def test_a_kill_at_an_epoch_boundary_starts_the_next_epoch(self):
        self.assertEqual(resume.next_position(1, 20, 20, 4), (2, 0))
        self.assertEqual(resume.next_position(1, 24, 20, 4), (2, 0))

    def test_a_kill_mid_epoch_stays_in_it(self):
        self.assertEqual(resume.next_position(1, 8, 20, 4), (1, 8))

    def test_nothing_left_to_read(self):
        self.assertEqual(resume.next_position(3, 20, 20, 4), (4, 0))
        self.assertEqual(resume.next_position(0, 0, 0, 4), (4, 0))


class Recorder:
    """A stand-in for a model, an optimizer or a scheduler: it keeps what it was given and hands back
    what it holds, which is all the save and the reload ask of the three."""

    def __init__(self, state):
        self.state = state
        self.loaded = None

    def state_dict(self):
        return self.state

    def load_state_dict(self, state, strict=None):
        self.loaded = state
        self.state = state


class TensorPayloadTest(unittest.TestCase):
    def test_the_three_go_out_and_come_back(self):
        model, optimizer, scheduler = Recorder({"w": [1, 2]}), Recorder({"exp_avg": [0.3]}), Recorder({"last_epoch": 20})
        payload = resume.tensor_payload(model.state_dict(), optimizer, scheduler)
        self.assertEqual(sorted(payload), sorted(resume.TENSOR_KEYS))

        again = Recorder({}), Recorder({}), Recorder({})
        resume.apply_tensors(payload, *again)
        self.assertEqual(again[0].loaded, {"w": [1, 2]})
        self.assertEqual(again[1].loaded, {"exp_avg": [0.3]})
        self.assertEqual(again[2].loaded, {"last_epoch": 20})

    def test_a_payload_short_of_one_is_refused_rather_than_half_applied(self):
        model, optimizer, scheduler = Recorder({}), Recorder({}), Recorder({})
        payload = resume.tensor_payload({"w": [1]}, Recorder({"exp_avg": [1]}), Recorder({"last_epoch": 5}))
        del payload["scheduler"]
        with self.assertRaises(ValueError) as caught:
            resume.apply_tensors(payload, model, optimizer, scheduler)
        self.assertIn("scheduler", str(caught.exception))
        self.assertIsNone(model.loaded)
        self.assertIsNone(optimizer.loaded)


class TorchStateTest(unittest.TestCase):
    """The same round trip through torch, where torch is on the machine. It is skipped where it is not,
    so a checkout without the training venv still runs this file and says nothing about tensors."""

    def setUp(self):
        try:
            import torch  # noqa: F401
        except ImportError:
            self.skipTest("torch is not installed here")

    def test_the_optimizer_and_the_schedule_come_back_where_they_were(self):
        import torch

        with tempfile.TemporaryDirectory() as folder:
            model = torch.nn.Linear(4, 2)
            optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3)
            scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=10, eta_min=1e-6)
            for _ in range(3):
                model(torch.ones(2, 4)).sum().backward()
                optimizer.step()
                scheduler.step()
                optimizer.zero_grad(set_to_none=True)
            path = os.path.join(folder, resume.TENSOR_NAME)
            weights = {key: value.detach().cpu() for key, value in model.state_dict().items()}
            torch.save(resume.tensor_payload(weights, optimizer, scheduler), path)

            fresh = torch.nn.Linear(4, 2)
            fresh_optimizer = torch.optim.AdamW(fresh.parameters(), lr=1e-3)
            fresh_scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(fresh_optimizer, T_max=10, eta_min=1e-6)
            self.assertEqual(fresh_scheduler.state_dict()["last_epoch"], 0)
            resume.apply_tensors(torch.load(path, map_location="cpu", weights_only=False),
                                 fresh, fresh_optimizer, fresh_scheduler)
            self.assertEqual(fresh_scheduler.state_dict()["last_epoch"], 3)
            self.assertTrue(torch.equal(fresh.weight, model.weight))
            moments = fresh_optimizer.state_dict()["state"]
            self.assertTrue(moments and all("exp_avg" in one for one in moments.values()))


class DigestTest(unittest.TestCase):
    def test_the_digest_follows_the_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "train.jsonl")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write('{"gate": "reply-wanted"}\n')
            first = resume.file_digest(path)
            self.assertEqual(first, resume.file_digest(path))
            with open(path, "a", encoding="utf-8") as handle:
                handle.write('{"gate": "sanitizer"}\n')
            self.assertNotEqual(first, resume.file_digest(path))


if __name__ == "__main__":
    unittest.main()
