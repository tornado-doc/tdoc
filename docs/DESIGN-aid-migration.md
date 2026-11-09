# Design: aid migration for the stampAids parser fix (#24)

> **Status (#973):** the dry run ran on every upload and measured zero drift across docs; it has been removed (its legacy parser was quadratic and outlived its purpose). The legacy parser is kept as a test fixture, `test/fixtures/stampaids-legacy.js`, and `test/stampaids.test.js` still checks the hardened parser gives the same aids on ordinary HTML.

Status: DRAFT — blueprint for a future implementation. No code in this doc.
Relates to: issue #24 (stampAids regex HTML parser), the reverted attempt on
branch `fix/overlay-htmlrewriter` (commit reverted in v0.4.1).

## TL;DR

The `stampAids` HTML parser has real bugs (`>` inside an attribute value;
`</tag>`-like strings inside inline `<script>`/`<style>`). Fixing the parser is
correct, but it **changes the `aid` content-hash** for any element containing
that edge-case content. Because `aid` is the anchor key every existing comment
is stored against, a naive parser fix detaches live comments on the next
republish. This doc specifies a safe path: **measure first, then migrate
old→new aids at publish time while we still hold both, with reconcile as a
fallback** — landed behind a dry-run and an idempotent, append-only,
revertible rollout.

Do NOT ship the parser fix without this. The bug is low-impact (rare input,
fingerprint-fallback-covered per the 2026-06 review), so there is no urgency
that justifies risking stored anchors.

---

## 1. Background: how anchoring works

Every commentable element (`img`, `svg`, `figure`, `section`, `table`, `pre`,
`blockquote`, `details`, `aside`, …) gets an `aid` — a `cyrb53` content hash of
its tag + intrinsics (`viewBox`/`src`/`alt`/…) + normalized innerHTML
(see `aidFor` in `worker/worker.js`). A comment stores
`anchor.aid = <that hash>`. On load, the overlay finds the element by
`data-tdoc-aid` and re-attaches the comment.

**`aid` is the comment's address. If it changes, the comment is orphaned.**

## 2. The bug and why fixing it is breaking

`stampAids` finds elements with regex. Two confirmed mis-parses:

- `<img alt="a > b">` — the `[^>]*>` open-tag regex stops at the `>` inside the
  attribute, truncating the attrs and corrupting the element.
- `<section><script>var s="</section>";</script><p>…</p></section>` — the depth
  scanner treats the `</section>` *inside the script string* as the real close.

A corrected parser computes the element's content correctly, so `aidFor`
returns a **different** hash. Verified:

| HTML | old aid | fixed aid |
|---|---|---|
| `<img src="x" alt="a > b">` | `1rwfd6mtb5c` | `25pjfms3kp2` |
| `<section>…<script>"</section>"…` | `lij7vr3r4u` | `1wmqxm8vwwz` |

The old aid is "wrong" (hashed corrupted content) but it is the aid **stored on
existing comments**. So for an affected doc, the fix is a breaking change to
stored anchors — exactly what the review exists to prevent. (Found by the Codex
review of the reverted attempt; independently reproduced.)

## 3. Key enabling fact

When the parser fix changes an element's `aid`, it does **not** change the
signals `reconcileAnchors` already keys on: `tag` and nearest `heading` are
stable. Verified — for `<h2>Chart</h2><figure><img alt="a > b">`, both old and
fixed parsers report `tag=figure, heading="Chart"` (and `tag=img,
heading="Chart"`); only the `aid` differs.

This means the re-bind machinery **already exists** (`reconcileAnchors` emits an
`anchor_changed` event when a stored aid is missing and a fingerprint match is
found). The migration is about making that re-bind *reliable* for this specific
cause, not building something new.

## 4. Classify the affected comments

Not all affected comments are equal. Three cases, three responses:

| Case | reconcile auto-recovers today? | Action |
|---|---|---|
| **A.** One element of that tag under the heading (the common case) | ✅ unique fingerprint match → auto re-binds | **Nothing needed** — existing reconcile handles it |
| **B.** Multiple same-tag elements under one heading | ❌ ambiguous → marked `lost` | **Needs migration** — disambiguate with a stronger signal |
| **C.** Element genuinely removed from the doc | ❌ (and correctly so) | Marked `lost` — **correct**, leave it |

So the only thing that truly needs a migration is **case B**. A is free; C is
already right. This shrinks "migrate all comments" to "handle the ambiguous
multi-element case" — an order of magnitude smaller.

## 5. The migration mechanism

Build a bridge **at publish time, the one moment we hold both the old world and
the new world.**

### Bridge 1 — deterministic old→new aid map (handles A and B precisely)

At republish, for the same HTML, compute aids with **both** the old parser and
the fixed parser:

```
old parser:  img → 1rwfd6mtb5c   (matches what existing comments stored)
fixed parser: img → 25pjfms3kp2  (what the doc will use going forward)
        ⇒ map { 1rwfd6mtb5c → 25pjfms3kp2 }
```

Then walk existing comments: any anchor on an old aid in the map gets an
appended `anchor_changed` event pointing at the new aid. This is
**deterministic** (same element, same HTML → exact 1:1 old/new correspondence),
so it migrates A and B with zero ambiguity. No guessing.

This is the essence of a migration script: *in the instant you still hold both
the old and new representation, translate old data into the new shape per a
rule.*

Notes:
- Keep the old parser available behind a flag/util purely for computing the old
  side of the map. It can be deleted once all live docs have republished past
  the migration.
- Only emit `anchor_changed` when `oldAid !== newAid` AND the comment actually
  anchors to `oldAid`. No-op otherwise (keeps it idempotent — see §6).

### Bridge 2 — reconcile fallback (handles stragglers)

For any comment Bridge 1 misses (e.g. a doc that hasn't been republished since
the fix landed), strengthen `reconcileAnchors`: when case B is ambiguous on
tag+heading, additionally compare the element content fingerprint (`head`, the
first ~80 chars of innerHTML, already carried in `aids[]`). Three figures under
"Chart" with different content become distinguishable.

Two layers: Bridge 1 (precise) covers the bulk at publish; Bridge 2 (heuristic)
catches the long tail.

## 6. Safe rollout (the part that matters most)

Principle: **never let the migration itself be able to corrupt data.**

1. **Dry-run first (measure before you act).** Ship an observe-only version
   that computes the dual aids at publish and *logs* how many comments would
   change aid, bucketed A/B/C — but mutates nothing. Read real production
   numbers. It is very likely **0** (the edge-case HTML is rare). If it's 0,
   ship the parser fix alone and stop — no migration needed.
2. **Idempotent.** Re-running the migration must not double-append or corrupt.
   A comment already carrying an `anchor_changed` to the new aid is skipped.
3. **Append-only ⇒ revertible.** The migration only *adds* an `anchor_changed`
   event; it never edits or deletes prior anchor events. If the migration logic
   is wrong, the original anchor events still exist and the fold can fall back.
   This is a free safety net from tdoc's event-log model.
4. **Test every case before rollout:**
   - A: after the fix, the comment auto-re-binds (reconcile). ✅
   - B: dual-aid map migrates each of N same-tag elements to its correct new
     aid. ✅
   - C: a genuinely-removed element stays `lost`, never mis-binds. ✅
   - Idempotency: running the migration twice yields identical state. ✅
   - Equivalence sanity: on normal HTML (no edge cases), the fixed parser still
     produces the same aids as before, so the map is empty and nothing moves.

## 7. Rollout order (one-line roadmap)

1. Dry-run / observe build → deploy → read logs (real count of affected
   comments).
   - 0 affected → ship parser fix alone; close #24.
   - >0 affected → continue.
2. Implement Bridge 1 (dual-aid map migration) + Bridge 2 (reconcile content
   fingerprint) + full test matrix from §6.
3. End-to-end on a fixture doc: edge-case HTML + real comments → republish →
   assert no anchor lost.
4. Ship parser fix + migration together.
5. Post-deploy: verify affected docs' comments still anchored.

## 8. What this does NOT do

- Does not switch to HTMLRewriter (a streaming parser whose re-serialization
  isn't guaranteed byte-identical — it would change aids broadly, far worse
  than the targeted parser fix). Hardening the existing regex parser + this
  migration is the safe route.
- Does not touch the fold, auth, or any non-stamping path.

## 9. Lessons captured (for whoever picks this up)

- Changing an ID/hash algorithm is a breaking change for everything keyed on
  that ID; it needs a migration, not just a code fix.
- Measure with a dry-run before migrating — the affected set is often empty.
- Build the bridge in the moment both old and new representations coexist.
- Idempotent + append-only = you can re-run and roll back.
- "More correct" ≠ "ship it": weigh blast radius against the bug's severity.
