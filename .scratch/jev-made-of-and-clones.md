# What Jev Is Made Of — and Why the Open-Source Clones Aren't Jev (Yet)

*research-claw · 2026-09-21 · Sources: TypeSafe docs, Archer Hume's black-box probe, the clone authors' own READMEs, and one day of measurements on a Mac mini (Apple M4, 16 GB). Every number below carries its source; "we measured" means it ran on that machine on 2026-09-20.*

---

## 0. The one-paragraph version

Jev is a normal pretrained language model that was trained to *stop talking*. Instead of writing words one at a time, it reads your input once and answers every question you attached in a single pass, returning a probability for each option you gave it. That is the whole trick: no text generation, calibrated probabilities, many questions per request, up to 64k tokens of input. Six open-source "clones" appeared within 48 hours of launch. On short texts (one sentence, three options) the best of them give the same answers as Jev, on a laptop, for free. On the tasks people are actually excited about — driving a browser or a phone — every clone we tested failed, and not because our Mac is small.

---

## 1. How Jev is built (what is known, what is inferred, what is secret)

### 1.1 It starts as a language model
TypeSafe's own training diagram says it plainly: *"Pretrained language models branch into RLHF / RLVR / RLCD."* (docs.typesafe.ai/introduction/machine-learning-primer). RLHF turned base models into chatbots; RLVR turned them into reasoners; RLCD — *Reinforcement Learning for Calibrated Decisions* — is TypeSafe's third branch. Jev is not a new species; it is a familiar backbone with a different post-training objective. TypeSafe's cofounder Diogo Almeida co-invented RLHF, so the family resemblance is not an accident.

### 1.2 What the objective changes
A chatbot is rewarded for answers people like. Jev is rewarded for **probabilities that are honest**: across many answers tagged "0.8", about 80% should turn out right. The docs are careful to say calibration is a property of *groups* of answers, not a guarantee about any single one.

### 1.3 The shape of a request (this is where the speed comes from)
One request = one `state` (any text or JSON, up to 64k tokens; 32k for state plus the longest single question) + any number of typed questions:
- **Choice** — pick one of up to 255 options; you get the choice, a probability per option, and a confidence.
- **Score** — rate against ordered levels; you get an expected value and the distribution.
- **Noul** — yes/no; you get P(yes).

The model reads the state once and answers all questions **in parallel, in isolation** (question A cannot see question B). Output tokens are free because there is no output text; you pay $0.042 per million input tokens (jev-1.13.0, docs.typesafe.ai/models). Typical latency in our hands: 0.25–0.45 s per request over the network.

### 1.4 What an outside probe found (Archer Hume, "Jev's Architecture Unmasked")
Nobody outside TypeSafe has the weights, but you can learn a lot by poking the API:
- **Questions really are isolated.** A secret planted inside a sibling question gets 0.00 probability; the same secret in the shared state gets 0.90–0.92.
- **State is encoded once.** 1,500 questions with a short state come back in ~610 ms; token accounting is strictly additive (one question 268 tokens, two 276).
- **Probabilities are read out directly.** Latency is the same for 2 options or 255; the `output_tokens` counter doesn't move with the answer values.
- **Options interact before the decision** (adding an irrelevant option shifts the odds between existing ones), so this is list-wise scoring, not independent per-option logits.
- **Backbone is almost certainly a causal transformer**, because Jev scores 84.6% on MMLU-Pro, which needs frontier-scale pretraining, and RLCD is described as post-training.
- **Calibration checks out on one public set:** ECE 0.031 over 1,200 MMLU items.

Still unknown: the base model (its tokenizer matched none of 192 public tokenizers), dense vs. MoE, the exact loss, and whether RLCD updates the whole network or just the head. TypeSafe's launch FAQ leaves "training algorithm", "training data" and "public benchmarks" blank on purpose.

### 1.5 The honest limits (TypeSafe's own "jaggedness" page)
It reads instructions literally, cannot count or do date arithmetic, degrades when the state is full of irrelevant text, can be steered by adversarial content in the state, and is English-first (CJK "handled but not equally well"). It is not fine-tuned per customer; you shape it through the state and the question wording.

---

## 2. The clones, and what they actually reproduce

All of them copy the *interface* (typed questions in, probabilities out) using the same recipe Hume reverse-engineered: take an open LLM, pack the state and the options into one sequence, put a small head on the last position, and train it with plain cross-entropy on labelled answers.

| Clone | Base | Method | Where it runs | Authors' own quality claim |
|---|---|---|---|---|
| **kev** (jaredpalmer) | Qwen2.5-0.5B / Qwen3-0.6B / 4B / 8B | LoRA + pointer readout head, block-causal packing, TypeSafe-compatible API | Mac (4B needs 32 GB in bf16) | Out-of-domain: kev-4b 0.76, kev-8b 0.77, Jev 0.86 on the same frozen items |
| **Bespoke Nimble** (Bespoke Labs) | Qwen3.5-9B | LoRA on answer tokens only, 2,676 curated examples; reads one answer-token logit per question | Mac / NVIDIA, **unquantized only** | 90.1% vs Jev 93.2% on its own 324 held-out items; "don't expect a lot of generalization" |
| **laya / laya-mlx** | ModernBERT-large (421M) + 2 transformer layers | encoder + PPO; native MLX runtime | any Apple Silicon | 7–14 ms per decision on M3 Max |
| SemIf / OpenJev, DiffusionGemma, Jevlike | Qwen3.5 NLI head, Gemma diffusion, byte-embedding attention | various | – | not measured by us |

Two things they all inherit from their recipe, by construction: **short context** (kev is trained on ~1–2k-token records; Nimble hard-caps input at 2,048 tokens and enums at 26 choices; laya's ModernBERT sees 512 tokens) and **no calibration training** (Nimble states outright that 0.9 does not mean 90% correct).

---

## 3. What we measured (Mac mini, M4, 16 GB, 2026-09-20)

### 3.1 The easy case: one support ticket, three questions
State: *"Shoes arrived two weeks late and in the wrong size. Also I see two charges on my card."* Questions: which team (returns / shipping / billing), escalate? (yes/no), frustration (Calm / Frustrated / Very angry).

| Model | Runs on 16 GB? | Latency | Peak memory | Team | Escalate | Frustration |
|---|---|---|---|---|---|---|
| Jev 1.13 (hosted) | – | 0.30 s | – | returns 0.87 | 0.72 | Frustrated 0.96 |
| kev-0.5b | yes | 0.23 s | 4.6 GB | returns | 0.74 | Frustrated |
| kev-4b (bf16) | yes | ~0.7 s | 8.8 GB | returns | 0.74 | Frustrated |
| Nimble 9B (4-bit, patched) | yes, after fixes | 1.87 s | 5.5 GB | returns 0.92 | 0.96 | Very angry 0.79 |
| laya-mlx | yes | 0.064 s | 0.9 GB | **shipping 0.40** (returns 0.29, billing 0.32) | 0.12 | Frustrated 0.87 |

On this kind of input, kev and Nimble are genuinely Jev-like. laya is the fastest thing we ran and the only one that got the easy question wrong — its three probabilities are almost flat, which is a model saying "I don't know" while still picking an answer.

Nimble did not run out of the box: its 9B bf16 weights are 18 GB and its runner refuses quantized weights. Quantizing to 4-bit on the CPU (the GPU path hit the Metal watchdog) and a 52-line patch to dequantize only the candidate rows of the output head made it fit in 5.5 GB. Patch and steps are in the repo notes.

### 3.2 The hard case: driving a real browser (browser-use/jev-ultrafast)
Same three Wikipedia tasks, three runs each, decision model swapped behind the same API. One request here is ~4,400 tokens of page text and element table with a 54-option "which element" question.

| Decision model | Success | Per-decision latency | What went wrong |
|---|---|---|---|
| Jev (hosted) | 5/9 | 0.25–0.42 s | failures were Jev choosing BLOCKED on the main page |
| kev-4b | 0/9 | >300 s | memory climbed to 15 GB and thrashed; no answer in 5 minutes |
| kev-0.5b | 0/4 | 5–18 s | answers BLOCKED on step 1 |
| laya-mlx | 0/9 | 0.4–1.2 s | answers DONE on step 1 — it can only see the first 512 tokens |

Jev also completed the harder Google Flights search 3/3 (16–19 s end to end, of which the decision model is ~0.3 s per step).

### 3.3 The middle case: driving an iPhone simulator
iOS 27 simulator, accessibility tree read by sim-use, ~20 candidate actions per screen, ~1,200 input tokens. Task: *Settings → General → About*, starting from the home screen.

| Decision model | Reached the goal | Steps | Per-decision latency | Said "done" when finished? |
|---|---|---|---|---|
| Jev | yes | 3–4 | 0.26–0.69 s | yes (confidence 0.77–0.81) |
| kev-0.5b | yes | 3 | 0.8–3.6 s | **no** — keeps tapping the page title |
| Nimble 9B 4-bit | yes | 3 | 7.3 s | **no** — same |
| laya-mlx | no | – | – | says "done" to everything |

With Jev, the same stack then went further: on Uber's mobile site it set the dropoff to SFO, typed a pickup address, and stopped correctly at the login wall rather than inventing a phone number. Per-step time is dominated by the simulator controller (1–2 s to read the screen, ~1 s to tap), not the model.

Phone state sizes we measured, for scale: iOS home screen 18 elements / 1,225 tokens; Safari on amazon.com 38 elements / 2,197 tokens; Safari on Wikipedia 37 / 2,081; desktop browser-use Wikipedia 54 / 4,437. Web pages on a phone already exceed Nimble's 2,048-token cap.

---

## 4. So what is the "problem" with the clones?

1. **They were built for a different job than the one people are excited about.** Every clone's benchmark is short-text classification (Banking77, AG News, emotion, one-sentence policy rules). Browser and phone agents need *long state + many options in one pass*, which is exactly the capability TypeSafe kept: 64k tokens, 255 options, questions answered in parallel. No clone has published a number on that shape of task; the first time we tried it, all of them failed on quality, not just speed.

2. **They are not calibrated, and it shows in the one place it matters most: knowing when to stop.** On the phone task kev and Nimble navigate perfectly and then never say "done", because they have no trained sense of "the goal is already satisfied". Jev stops at 0.77–0.81 confidence. Nimble's README says the quiet part: a 0.9 does not mean 90%.

3. **Hardware explains the speed gap, not the mistakes.** Our M4/16 GB is 3–10× slower than the authors' M5/32 GB or H100 machines, and it is why kev-4b thrashed on a 4k-token request. It is not why laya got the ticket wrong, why kev-0.5b answered BLOCKED before looking, or why nothing local says "done".

4. **What the $40M and the secret data bought.** General zero-shot behaviour across domains, honest probabilities, and long context — three things that come from training data and objective, not from the architecture trick, which the community reproduced in two days.

---

## 5. Practical guidance

- **Fixed labels, short text, you have your own labelled data:** kev-0.5b/4b or Nimble locally is a real option — same answers as Jev, no API bill. Add post-hoc calibration (temperature scaling on a held-out split) before trusting the probabilities.
- **Anything agentic (browser, phone, long documents, 20+ options):** use Jev. Today nothing open gets close.
- **If you build on Jev:** the model is rarely the bottleneck. Our browser loop spent 90% of its time in the DOM reader and the text helper; the phone loop spent 90% in the simulator controller. Optimise those first.
- **The one test nobody has run yet:** calibration on *your* data. Bucket Jev's confidences on a few thousand of your own decisions and check whether the 0.8 bucket is right 80% of the time. That is the claim everything else rests on.

---

*Repro material: ~/jev-lab on the Mac mini — SMOKE.md per repo, runs/bench.jsonl for the browser benchmark, evidence screenshots and videos for the simulator runs, nimble-quantized-head.patch.*
