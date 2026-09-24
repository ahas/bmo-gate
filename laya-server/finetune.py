"""Fine-tunes a Laya checkpoint on the gates' distilled rows, on one GPU (docs/laya-server.md, 「The
training loop and calibration」).

    .venv/bin/python finetune.py --data <dir with train.jsonl> --out <checkpoint dir> [options]

The training loop is the official notebook's (laya_finetune_typed_decisions_2xT4_kaggle.ipynb, Laya,
Apache-2.0): RLCD — policy gradients over noised logits with a proper scoring reward, plus soft
cross-entropy on the gold distribution. What differs is where it runs: one GPU instead of two under
DDP, bf16 instead of fp16 with a scaler, gradient accumulation to the notebook's effective batch of 64,
and the gates' own rows in place of the typed-decisions dataset. It writes a new checkpoint directory and never
touches the one the server is running.

Two memory savings can be asked for, `--freeze-embeddings` and `--optimizer adamw8bit`; neither is on
by default, and neither is used for a checkpoint meant for service unless a run beside the unsaved one
shows it costs nothing in agreement or calibration.

A run that is killed is carried on rather than started again (docs/training.md, 「The resume
contract」): every so many optimizer steps, and at each epoch's end, the weights, the optimizer, the
scheduler, the step count and the place reached in the data order are written into a step checkpoint
of the run's own `steps/` folder, and `--resume <dir>` reads the newest whole one and continues from
it. A finished run writes a completion marker, which is what says the directory holds a trained
checkpoint rather than a run that stopped halfway.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import sys
import time
from collections import defaultdict
from typing import Any, Dict, List, Optional, Tuple

os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

import torch  # noqa: E402
from safetensors.torch import load_file, save_file  # noqa: E402
from transformers import AutoTokenizer  # noqa: E402

import resume as resume_state  # noqa: E402

from laya.agent import _fix_tokenizer_config  # noqa: E402
from laya.common import QTYPES, build_model, build_sequence, proper_reward, render_options  # noqa: E402

HUB_REPO = "convaiinnovations/laya"
HUB_SUBFOLDER = "multilingual"


def base_dir(base: Optional[str]) -> str:
    """The checkpoint to start from: a directory as given, or the hub's multilingual checkpoint."""
    if base:
        return base
    from huggingface_hub import snapshot_download

    root = snapshot_download(HUB_REPO, allow_patterns=[f"{HUB_SUBFOLDER}/{name}" for name in (
        "rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*",
    )])
    return os.path.join(root, HUB_SUBFOLDER)


def training_item(tok, cfg: Dict[str, Any], state: Any, question: Dict[str, Any], gold: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """One question as a training sequence with its target distribution, as the notebook builds it;
    None where the options do not fit the head, which the notebook leaves out too."""
    kind = question["type"]
    criteria = question.get("criteria", {})
    if kind == "choice":
        keys = list(criteria.keys()) if isinstance(criteria, dict) else list(criteria)
        criteria = criteria if isinstance(criteria, dict) else {key: None for key in criteria}
        target = [gold["probabilities"].get(key, 0.0) for key in keys]
    elif kind == "noul":
        target = [gold["probabilities"].get("false", 0.5), gold["probabilities"].get("true", 0.5)]
    elif kind == "score":
        levels = len(criteria) if isinstance(criteria, list) else 4
        target = [gold["probabilities"].get(str(level), 0.0) for level in range(levels)]
    else:
        return None
    total = sum(target)
    target = [value / total for value in target] if total > 0 else [1.0 / len(target)] * len(target)
    internal = {"t": kind, "ins": question["instructions"], "crit": criteria}
    sequence, markers = build_sequence(tok, state, internal, cfg["max_len"], cfg["head_max_len"])
    if len(markers) != len(render_options(internal)):
        return None
    return {"ids": sequence, "markers": markers, "qtype": QTYPES[kind], "target": target, "label": target.index(max(target))}


def balanced_items(items: List[Dict[str, Any]], ratio: Optional[float], rng: random.Random) -> List[Dict[str, Any]]:
    """One gate's sequences with no answer more than `ratio` times as common as its rarest. A gate whose
    verdicts are nearly all one answer — the reference classifier says no to almost every candidate —
    otherwise teaches Laya to give that answer always, which agrees with it just as often and decides
    nothing."""
    if ratio is None:
        return items
    by_answer: Dict[Tuple[int, int], List[Dict[str, Any]]] = defaultdict(list)
    for item in items:
        by_answer[(item["qtype"], item["label"])].append(item)
    if len(by_answer) < 2:
        return items
    most = int(min(len(group) for group in by_answer.values()) * ratio)
    kept: List[Dict[str, Any]] = []
    for group in by_answer.values():
        rng.shuffle(group)
        kept.extend(group[:most])
    rng.shuffle(kept)
    return kept


def read_items(path: str, tok, cfg: Dict[str, Any], per_gate: Optional[int], ratio: Optional[float], seed: int) -> Dict[str, List[Dict[str, Any]]]:
    """Every question of every row, grouped by the gate it came from; each group balanced over its
    answers and then cut to `per_gate` sequences drawn at random, so neither one answer nor one gate
    that asks many questions per row can drown the rest."""
    by_gate: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            state, questions, gold = json.loads(row["state"]), json.loads(row["questions"]), json.loads(row["gold"])
            for qid, question in questions.items():
                if qid in gold:
                    item = training_item(tok, cfg, state, question, gold[qid])
                    if item is not None:
                        by_gate[row["gate"]].append(item)
    rng = random.Random(seed)
    for gate, items in by_gate.items():
        items = balanced_items(items, ratio, rng)
        rng.shuffle(items)
        by_gate[gate] = items if per_gate is None else items[:per_gate]
    return dict(by_gate)


def collate(items: List[Dict[str, Any]], pad_id: int) -> Dict[str, torch.Tensor]:
    count, length = len(items), max(len(item["ids"]) for item in items)
    kmax = max(len(item["markers"]) for item in items)
    ids = torch.full((count, length), pad_id, dtype=torch.long)
    attention = torch.zeros((count, length), dtype=torch.long)
    positions = torch.zeros((count, kmax), dtype=torch.long)
    mask = torch.zeros((count, kmax), dtype=torch.bool)
    target = torch.zeros((count, kmax), dtype=torch.float32)
    for index, item in enumerate(items):
        ids[index, : len(item["ids"])] = torch.tensor(item["ids"])
        attention[index, : len(item["ids"])] = 1
        k = len(item["markers"])
        positions[index, :k] = torch.tensor(item["markers"])
        mask[index, :k] = True
        target[index, : len(item["target"])] = torch.tensor(item["target"], dtype=torch.float32)
    return {
        "input_ids": ids, "attention_mask": attention, "marker_pos": positions, "marker_mask": mask, "target": target,
        "qtype": torch.tensor([item["qtype"] for item in items]),
    }


def save_checkpoint(model, tok, cfg: Dict[str, Any], directory: str, meta: Dict[str, Any]) -> None:
    os.makedirs(directory, exist_ok=True)
    weights = {key: value.half().contiguous().cpu() for key, value in model.state_dict().items()}
    save_file(weights, os.path.join(directory, "model.safetensors"))
    model.encoder.config.save_pretrained(os.path.join(directory, "encoder"))
    tok.save_pretrained(os.path.join(directory, "tokenizer"))
    with open(os.path.join(directory, "rl_agent_config.json"), "w") as handle:
        json.dump(cfg, handle, indent=2)
    with open(os.path.join(directory, "train_meta.json"), "w") as handle:
        json.dump(meta, handle, indent=2, ensure_ascii=False)


def save_step(model, tok, cfg: Dict[str, Any], optimizer, scheduler, out: str, step: int, state: Dict[str, Any], keep: int) -> str:
    """One step checkpoint, written whole before it counts. It is a loadable checkpoint in its own right
    — the same files a finished one carries — with the optimizer, the scheduler and the full-precision
    weights beside it, which is what a resume needs and what the served half-precision copy cannot give.

    It is built under a partial name and renamed once everything is in it, so a run killed inside a save
    leaves nothing a resume would read. Only when the new one stands whole are the older ones dropped,
    and never the newest (`resume.prunable`)."""
    root = resume_state.steps_root(out)
    os.makedirs(root, exist_ok=True)
    final = os.path.join(root, resume_state.step_dir_name(step))
    building = final + resume_state.PARTIAL_SUFFIX
    shutil.rmtree(building, ignore_errors=True)
    state = dict(state)
    save_checkpoint(model, tok, cfg, building, state.pop("meta", {}))
    weights = {key: value.detach().cpu() for key, value in model.state_dict().items()}
    payload = resume_state.tensor_payload(weights, optimizer, scheduler)
    # The generators as well, so the noise a resumed run samples is the noise the killed one would have.
    payload["rng"] = {"torch": torch.get_rng_state(), "cuda": torch.cuda.get_rng_state_all()}
    torch.save(payload, os.path.join(building, resume_state.TENSOR_NAME))
    resume_state.write_state(building, state)
    shutil.rmtree(final, ignore_errors=True)
    os.replace(building, final)
    for old in resume_state.prunable(resume_state.step_dirs(out), keep):
        shutil.rmtree(old, ignore_errors=True)
    return final


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", required=True, help="the folder laya-dataset wrote (train.jsonl is read)")
    parser.add_argument("--out", default=None, help="the new checkpoint directory; it must not exist yet")
    parser.add_argument("--resume", default=None, metavar="DIR",
                        help="carry on the run in this directory from its newest step checkpoint")
    parser.add_argument("--save-every", type=int, default=25, metavar="STEPS",
                        help="a step checkpoint every this many optimizer steps, and at every epoch's end")
    parser.add_argument("--keep-checkpoints", type=int, default=2, metavar="N",
                        help="how many step checkpoints a run keeps; the newest is never dropped")
    parser.add_argument("--base", default=None, help="the checkpoint to start from; the hub's multilingual one by default")
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--micro-batch", type=int, default=4)
    parser.add_argument("--effective-batch", type=int, default=64)
    parser.add_argument("--group", type=int, default=4, help="GRPO group size")
    parser.add_argument("--lr-encoder", type=float, default=2.5e-5)
    parser.add_argument("--lr-head", type=float, default=1.0e-4)
    parser.add_argument("--sigma-start", type=float, default=0.4)
    parser.add_argument("--sigma-end", type=float, default=0.1)
    parser.add_argument("--per-gate", type=int, default=None, help="at most this many sequences from each gate")
    parser.add_argument("--balance-ratio", type=float, default=3.0,
                        help="within a gate, no answer more than this many times as common as its rarest; 0 keeps them as they are")
    parser.add_argument("--freeze-embeddings", action="store_true",
                        help="leave the encoder's token embeddings (256k × 768, most of the model) untrained")
    parser.add_argument("--optimizer", choices=("adamw", "adamw8bit"), default="adamw",
                        help="adamw8bit keeps the optimizer state in 8 bits (bitsandbytes, the savings extra)")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    if args.resume and args.out and os.path.abspath(args.out) != os.path.abspath(args.resume):
        sys.exit("finetune: --resume and --out name different directories; a run carries on in its own")
    out = args.resume or args.out
    if not out:
        sys.exit("finetune: --out names the checkpoint directory to write, or --resume the one to carry on")
    carried: Optional[Dict[str, Any]] = None
    carried_from: Optional[str] = None
    if args.resume:
        if resume_state.is_finished(out):
            sys.exit(f"finetune: {out} is finished; a trained checkpoint is not trained again")
        newest = resume_state.latest_step(out)
        if newest is None:
            sys.exit(f"finetune: {out} holds no step checkpoint to carry on from")
        _, carried_from = newest
        carried = resume_state.read_state(carried_from)
        if carried is None:
            sys.exit(f"finetune: {carried_from} carries no trainer state")
        if args.base and os.path.abspath(args.base) != os.path.abspath(carried["run"].get("base", "")):
            sys.exit(f"finetune: {carried_from} was trained from {carried['run'].get('base')} and --base names another")
    elif os.path.exists(out):
        sys.exit(f"finetune: {out} already exists; a checkpoint is never written over")
    if not torch.cuda.is_available():
        sys.exit("finetune: no CUDA device")
    device = torch.device("cuda")
    torch.manual_seed(args.seed)
    accumulate = max(1, args.effective_batch // args.micro_batch)

    # A resumed run reads the checkpoint it started from, so its architecture and its tokenizer are the
    # ones the saved weights belong to rather than whatever the hub holds today.
    source = base_dir(carried["run"]["base"] if carried else args.base)
    _fix_tokenizer_config(source)
    with open(os.path.join(source, "rl_agent_config.json")) as handle:
        cfg = json.load(handle)
    tok = AutoTokenizer.from_pretrained(os.path.join(source, "tokenizer"))
    model = build_model(cfg, encoder_dir=os.path.join(source, "encoder"))
    model.load_state_dict(load_file(os.path.join(source, "model.safetensors")), strict=True)
    try:
        model.encoder.config.reference_compile = False
    except Exception:
        pass
    model.encoder.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.head_checkpointing = True
    model.to(device).train()

    train_path = os.path.join(args.data, "train.jsonl")
    by_gate = read_items(train_path, tok, cfg, args.per_gate, args.balance_ratio or None, args.seed)
    items = [item for group in by_gate.values() for item in group]
    if not items:
        sys.exit("finetune: train.jsonl holds nothing to train on")
    print(f"items: {len(items)} — " + ", ".join(f"{gate} {len(group)}" for gate, group in sorted(by_gate.items())), flush=True)

    # What a resume has to find unchanged. The items are read afresh on every run, so the digest of the
    # file they came from and their count are what say the order is the one the saved step left off in.
    run = {
        **resume_state.run_fields({
            "seed": args.seed, "epochs": args.epochs, "micro_batch": args.micro_batch,
            "effective_batch": args.effective_batch, "accumulate": accumulate, "group": args.group,
            "items": len(items), "data_sha256": resume_state.file_digest(train_path),
            "balance_ratio": args.balance_ratio, "per_gate": args.per_gate,
            "freeze_embeddings": args.freeze_embeddings, "optimizer": args.optimizer,
            "sigma_start": args.sigma_start, "sigma_end": args.sigma_end,
            "lr_encoder": args.lr_encoder, "lr_head": args.lr_head,
        }),
        "base": source,
        "data": os.path.abspath(args.data),
    }
    if carried is not None:
        fault = resume_state.resume_fault(carried, run)
        if fault:
            sys.exit(f"finetune: {carried_from} was trained under other settings and is not this run — {fault}")

    if args.freeze_embeddings:
        model.encoder.get_input_embeddings().weight.requires_grad_(False)
    trained = [(name, param) for name, param in model.named_parameters() if param.requires_grad]
    encoder = [param for name, param in trained if name.startswith("encoder.")]
    head = [param for name, param in trained if not name.startswith("encoder.")]
    groups = [{"params": encoder, "lr": args.lr_encoder}, {"params": head, "lr": args.lr_head}]
    if args.optimizer == "adamw8bit":
        import bitsandbytes

        optimizer = bitsandbytes.optim.AdamW8bit(groups, weight_decay=0.01)
    else:
        optimizer = torch.optim.AdamW(groups, weight_decay=0.01)
    updates = max(1, (len(items) // (args.micro_batch * accumulate)) * args.epochs)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=updates, eta_min=1e-6)

    epochs: List[Dict[str, Any]] = []
    optimizer_steps, start_epoch, start_index = 0, 0, 0
    carried_seconds, resumes, carried_peaks = 0.0, 0, (0, 0)
    if carried is not None:
        # This is the run's own file, written by the save above: the weights in full precision, the
        # optimizer's moments and the schedule's position, none of which the served checkpoint carries.
        tensors = torch.load(os.path.join(carried_from, resume_state.TENSOR_NAME), map_location="cpu", weights_only=False)
        resume_state.apply_tensors(tensors, model, optimizer, scheduler)
        model.to(device).train()
        generators = tensors.get("rng") or {}
        if "torch" in generators:
            torch.set_rng_state(generators["torch"])
        if "cuda" in generators:
            torch.cuda.set_rng_state_all(generators["cuda"])
        optimizer_steps = int(carried["step"])
        start_epoch, start_index = resume_state.next_position(
            int(carried["epoch"]), int(carried["item_index"]), len(items), args.epochs)
        epochs = list(carried.get("epochs", []))
        carried_seconds = float(carried.get("elapsed_seconds", 0.0))
        resumes = int(carried.get("resumes", 0)) + 1
        carried_peaks = (int(carried.get("peak_allocated_bytes", 0)), int(carried.get("peak_reserved_bytes", 0)))
        print(f"resumed: {carried_from} — step {optimizer_steps}, epoch {start_epoch + 1}/{args.epochs}, "
              f"item {start_index}/{len(items)}", flush=True)
    torch.cuda.reset_peak_memory_stats(device)

    started = time.time()

    def trainer_state(epoch: int, item_index: int, loss_sum: float, batches: int, epoch_started: float,
                      meta: Dict[str, Any]) -> Dict[str, Any]:
        """Everything a resume reads: where the run stands, what it has cost so far, and the settings it
        belongs to."""
        return {
            "step": optimizer_steps, "epoch": epoch, "item_index": item_index,
            "epoch_loss_sum": round(loss_sum, 6), "epoch_batches": batches,
            "epoch_seconds": round(time.time() - epoch_started, 1),
            "epochs": epochs, "elapsed_seconds": round(carried_seconds + time.time() - started, 1),
            "resumes": resumes,
            "peak_allocated_bytes": max(carried_peaks[0], torch.cuda.max_memory_allocated(device)),
            "peak_reserved_bytes": max(carried_peaks[1], torch.cuda.max_memory_reserved(device)),
            "run": run, "meta": meta,
        }

    for epoch in range(start_epoch, args.epochs):
        # Each epoch's order stands on its own seed, so the epoch a resume lands in is rebuilt without
        # replaying the ones before it and reads the very items the killed run would have read.
        order = resume_state.epoch_order(len(items), args.seed, epoch)
        sigma = args.sigma_start + (args.sigma_end - args.sigma_start) * (epoch / max(1, args.epochs - 1))
        epoch_started, total_loss, batches, step = time.time(), 0.0, 0, 0
        if epoch == start_epoch and carried is not None:
            total_loss, batches = float(carried.get("epoch_loss_sum", 0.0)), int(carried.get("epoch_batches", 0))
        optimizer.zero_grad(set_to_none=True)
        for start in range(start_index if epoch == start_epoch else 0, len(items), args.micro_batch):
            batch = collate([items[index] for index in order[start:start + args.micro_batch]], tok.pad_token_id)
            with torch.autocast("cuda", dtype=torch.bfloat16):
                logits, act = model(
                    batch["input_ids"].to(device), batch["attention_mask"].to(device), batch["marker_pos"].to(device),
                    batch["marker_mask"].to(device), batch["qtype"].to(device),
                )
            logits = logits.float()
            mask = batch["marker_mask"].to(device)
            k = mask.sum(-1, keepdim=True).float()
            target = batch["target"].to(device)
            # Sample a group of noised logits with a zero-mean projection, score them with the proper
            # reward against the gold distribution, and push towards the better ones.
            noise = torch.randn((args.group,) + logits.shape, device=device) * sigma * mask
            noise = (noise - noise.sum(-1, keepdim=True) / k) * mask
            noised = logits.detach().unsqueeze(0) + noise
            reported = torch.softmax(noised.masked_fill(~mask, -1e4), -1)
            with torch.no_grad():
                reward = proper_reward(reported, target.unsqueeze(0), batch["qtype"].to(device), mask, w_sph=0.75, w_rps=1.0)
                advantage = reward - reward.mean(0, keepdim=True)
                advantage = advantage / (advantage.std() + 1e-6)
            log_prob = -(((noised - logits.unsqueeze(0)) ** 2) * mask).sum(-1) / (2 * sigma ** 2)
            loss_rl = -(advantage * log_prob).mean()
            loss_ce = -(target * torch.log_softmax(logits.masked_fill(~mask, -1e4), -1)).sum(-1).mean()
            loss = (loss_rl + loss_ce) / accumulate + 0.0 * act.sum()
            loss.backward()
            step += 1
            total_loss += loss.item() * accumulate
            batches += 1
            stepped = step % accumulate == 0 or start + args.micro_batch >= len(items)
            if stepped:
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                optimizer.step()
                scheduler.step()
                optimizer.zero_grad(set_to_none=True)
                optimizer_steps += 1
            if batches % 100 == 0:
                print(f"  epoch {epoch + 1}/{args.epochs} step {batches} loss {loss.item() * accumulate:.4f} reward {reward.mean().item():.3f}", flush=True)
            # Saved only where an optimizer step has just landed and the gradients are cleared, so what
            # a resumed run starts on is a whole accumulation window and not the middle of one.
            consumed = start + args.micro_batch
            if stepped and args.save_every > 0 and optimizer_steps % args.save_every == 0 and consumed < len(items):
                written = save_step(model, tok, {**cfg, "fine_tuned": True}, optimizer, scheduler, out, optimizer_steps,
                                    trainer_state(epoch, consumed, total_loss, batches, epoch_started, {"epochs": epochs}),
                                    args.keep_checkpoints)
                print(f"  saved {os.path.basename(written)} — epoch {epoch + 1}/{args.epochs}, item {consumed}/{len(items)}", flush=True)
        seconds = time.time() - epoch_started
        epochs.append({"epoch": epoch + 1, "seconds": round(seconds, 1), "loss": round(total_loss / max(1, batches), 4)})
        print(f"epoch {epoch + 1}/{args.epochs}: {seconds:.1f}s, loss {total_loss / max(1, batches):.4f}", flush=True)
        # A step checkpoint at every epoch's end as well, so a run cut short keeps a whole epoch even
        # where the interval above has not come round.
        save_step(model, tok, {**cfg, "fine_tuned": True}, optimizer, scheduler, out, optimizer_steps,
                  trainer_state(epoch + 1, 0, 0.0, 0, epoch_started, {"epochs": epochs}), args.keep_checkpoints)

    meta = {
        "base": source,
        "items": {gate: len(group) for gate, group in by_gate.items()},
        "epochs": epochs,
        "seconds": round(carried_seconds + time.time() - started, 1),
        "steps": optimizer_steps,
        "resumes": resumes,
        "balance_ratio": args.balance_ratio,
        "micro_batch": args.micro_batch,
        "accumulate": accumulate,
        "precision": "bf16",
        "seed": args.seed,
        "freeze_embeddings": args.freeze_embeddings,
        "optimizer": args.optimizer,
        "trained_parameters": sum(param.numel() for _, param in trained),
        "device": torch.cuda.get_device_name(device),
        "peak_allocated_bytes": max(carried_peaks[0], torch.cuda.max_memory_allocated(device)),
        "peak_reserved_bytes": max(carried_peaks[1], torch.cuda.max_memory_reserved(device)),
    }
    # The temperatures are calibrate.py's to fit on the held-out rows; until then the checkpoint
    # carries the base's, and says it was fine-tuned.
    save_checkpoint(model, tok, {**cfg, "fine_tuned": True, "model_name": "laya-bmo-ko"}, out, meta)
    # The marker goes in last, after the checkpoint it speaks for stands whole: it is what tells a
    # finished run from one that stopped, and a directory holding only step checkpoints has neither.
    resume_state.mark_complete(out, {
        "steps": optimizer_steps, "epochs": args.epochs, "resumes": resumes, "seed": args.seed,
        "finished_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    })
    shutil.rmtree(resume_state.steps_root(out), ignore_errors=True)
    print(json.dumps(meta, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
