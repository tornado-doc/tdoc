# Jev — the short version (v6 spec for tdoc-claw-opus)

Target length: one screen per section, three sections, three visuals. Cut everything else from v5 (the System One primer, the long "how to build with it" craft section, the Vegas-style practical guidance). Keep tone ELI5, English.

---

## 1. How is Jev actually built? (community reconstruction)

**One-line answer:** a normal pretrained LLM that reads your input once and, instead of writing words, scores the options you gave it — trained so the scores are honest probabilities.

**Visual 1 — four architecture diagrams side by side, same layout each** (boxes: input packing → backbone → readout → output). Render as SVG tiles:

| | Jev (inferred) | kev (Palmer) | Bespoke Nimble | laya |
|---|---|---|---|---|
| Input packing | state once + every question as an isolated branch (block-causal mask, proven by API probe) | state + questions in ONE sequence, block-causal mask so branches can't see each other | one full prompt per question (state re-read per field) | state + question as one 512-token encoder input |
| Backbone | causal transformer, frontier-scale (84.6% MMLU-Pro), base model unknown, possibly MoE | Qwen2.5-0.5B / Qwen3-4B/8B + LoRA r=16 | Qwen3.5-9B + LoRA on answer tokens | ModernBERT-large 421M + 2 extra layers |
| Readout | one decision position scores all options list-wise (adding an option shifts the others) → softmax | pointer head: `<decide>` token vs each option's end token → softmax | logits of one-token answer codes (A/B/C…) → softmax | classification head + PPO |
| Trained for | RLCD: calibrated probabilities (undisclosed data & loss) | cross-entropy on labelled answers, public datasets | cross-entropy, 2,676 curated examples | RL (PPO), entropy-based confidence |
| Output | probabilities + confidence, zero output tokens | same shape, same API | probabilities (uncalibrated) | probabilities (uncalibrated) |

**What the probe proved vs. what stays secret** (two short columns under the diagram):
- Proved by poking the API (Archer Hume): questions isolated (secret in sibling question → 0.00), state encoded once (1,500 questions in 610 ms), direct probability readout (same latency for 2 or 255 options), options interact list-wise, calibrated on MMLU (ECE 0.031).
- Still secret: base model (tokenizer matches none of 192 public ones), dense vs MoE, the RLCD loss, training data. TypeSafe's FAQ leaves these blank on purpose.

**Why it matters:** the *architecture trick* was reproduced by the community in 48 hours. What was not reproduced: long context (64k), 255-option scoring, and calibration — those come from data + objective, not the diagram.

---

## 2. Are they actually good? (benchmarks)

**Visual 2 — one grouped bar/matrix: 4 models × 3 task shapes, cell = pass rate + latency.** Data:

| | Short text (1 sentence, 3 questions) | Phone screen (~1.2k tokens, ~20 options) | Browser page (~4.4k tokens, 54 options) |
|---|---|---|---|
| **Jev 1.13** | correct · 0.30 s | reaches goal, says "done" (0.77–0.81) · 0.3–0.7 s/step | 5/9 Wikipedia, 3/3 Flights · 0.25–0.45 s/step |
| **kev-0.5b / 4b** | correct · 0.23 s / 0.7 s | reaches goal, never says "done" · 0.8–3.6 s/step | 0/4 (BLOCKED at step 1) / 0/9 (15 GB thrash, no answer in 5 min) |
| **Nimble 9B (4-bit)** | correct · 1.9 s | reaches goal, never says "done" · 7.3 s/step | cannot run: 2,048-token / 26-option hard caps |
| **laya-mlx** | wrong (shipping 0.40 vs returns) · 0.06 s | says "done" to everything | 0/9 (512-token limit; DONE at step 1) |

All rows measured on one Mac mini (M4, 16 GB) on 2026-09-20; Jev over the network. Authors' own numbers agree in direction: kev-4b 0.76 vs Jev 0.86 out-of-domain; Nimble 90.1% vs Jev 93.2% on Nimble's own set; community median speed-up for Jev vs chat models was 7× (not the advertised 194×).

**Three-sentence read:** On short text the good clones match Jev locally for free. On agent-shaped inputs (long state, many options) every clone fails on quality, not just speed. The one thing none of them has is the calibrated "I'm done" judgment — which is exactly what a loop needs to stop.

---

## 3. What are people using it for?

**Visual 3 — a 2×3 tile grid, one tile per pattern, each with the headline number** (community-reported unless marked "we measured"):

1. **Bulk classification / triage** — 20,700 YouTube comments in 2 min 27 s; 1,018 papers sorted for $0.08; 100 emails fraud-checked in 1.42 s. classifier.dev (244★) is a public API on top of Jev.
2. **Browser agents** — browser-use/jev-ultrafast (9.7k★): Jev picks the operation and the element, a tiny LLM only writes text. Google Flights search in 7.1 s upstream; we measured 16–19 s with a slower text helper.
3. **Phone / computer use** — Jev + sim-use drove an iOS 27 simulator: Settings tasks in 3–4 steps, Uber web up to the login wall (we measured; video).
4. **Context pruning for agents** — score each old step "still relevant?" and drop the rest (2.1M-view thread; Theo's objection: value can show up later).
5. **SEO internal linking** — 566 pages, 8,460 link decisions, 5.95 s, $0.27 (jev-linkmap; author-reported).
6. **Gating / routing inside code** — confidence-gated escalation, PR review at $0.00007 each, voice browsing at 300 ms per decision.

Common shape across all six: code builds a small list of candidates; Jev picks or scores; code acts. Jev never writes anything.

---

*Footer: repro data ~/jev-lab (SMOKE.md per repo, runs/bench.jsonl, videos). Sources: docs.typesafe.ai, archerhume.com/posts/jevs-architecture-unmasked, github.com/jaredpalmer/kev, github.com/bespokelabsai/nimble, github.com/mizorewww/laya-mlx, github.com/browser-use/jev-ultrafast, github.com/stas4000/jev-linkmap, latent.space "6 clones of Jev in 2 days".*
