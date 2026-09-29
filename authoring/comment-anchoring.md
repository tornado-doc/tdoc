# Comment anchoring

s are persisted with one of two anchor shapes:

```json
// text anchor
{ "id": "c_<ts>", "version": 1, "text": "what the user wrote",
  "status": "open", "created": "<iso>",
  "anchor": { "kind": "text", "text": "exact highlighted text",
              "context_before": "...", "context_after": "..." } }

// element (artifact) anchor — IDENTITY-BASED
{ "id": "c_<ts>", "version": 1, "text": "what the user wrote",
  "status": "open", "created": "<iso>",
  "anchor": { "kind": "element",
              "aid": "<content-hash>",        // ← primary key: the worker-stamped
                                              //   data-tdoc-aid on the artifact.
                                              //   Same artifact across versions = same aid.
              "selector": "[data-tdoc-aid=\"...\"]",  // mirror of aid; legacy
                                                       // comments may still have
                                                       // a positional selector.
              "label": "svg",                 // tag hint
              "fingerprint": { ... },         // legacy content fingerprint
              "fallback": { "ratio": ..., "nearestHeading": ... } } }

// lost-anchor — the Worker's publish-time reconciliation marks an element
// comment lost when its aid disappears or can't be resolved unambiguously.
// Renders as "unanchored" in the margin; never silently re-attached.
{ ..., "anchor": { "kind": "lost", "reason": "aid not found in version" } }
```

**Text anchors:** find the anchor text in the current HTML and apply the
change. If the text no longer exists, apply as a general directive.

**Element anchors:** identity is the **`aid`** — the Worker auto-stamps
`data-tdoc-aid="<content-hash>"` on every commentable artifact at publish
time, and reconciles existing anchors against the new artifact set on every
upload. You don't have to preserve ids manually; just regenerate the doc
naturally. Comments on unchanged artifacts stay anchored; comments on
artifacts you genuinely replaced go `kind: "lost"` automatically.
