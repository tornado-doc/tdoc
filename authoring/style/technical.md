# technical — the cold engineering-blog style

The register of a precise technical writeup: neutral, dense, mono-inflected,
one sharp accent. Extracted from
`judgmentlabs.ai/blogs/agent-judge-solving-long-context-evaluations` and
adapted to fit the overlay (the source is a full marketing page with sticky
nav and hero bands, none of which come along).

**Same defining rule as the house style: trust the overlay's reading
typography.** Don't set body size, heading scale, or `max-width`. This style
differs from the default only in its component palette and its use of mono.

## What makes it feel technical

- **Mono for the machine-facing bits.** Identifiers, metrics, config keys,
  and short inline values render in mono — the overlay already styles
  `<code>`, so wrap those spans in it liberally. Prose stays in the
  overlay's sans.
- **Neutral greys carry the structure.** Borders and labels are grey, not
  colored. The doc reads calm and instrument-like.
- **One accent, used rarely.** A single warm red-orange (`#ff4b2e`) marks the
  one thing that matters on a screen — a headline number, a critical
  callout. Cold blue (`#2f6fed`) is for links only. Never both loud at once.

## Components

```css
/* a labeled metric or result — mono value, grey frame */
.metric { border:1px solid #e5e5e5; border-radius:6px; padding:12px 14px; margin:14px 0;
  background:#fafafa; }
.metric .k { font-size:12px; letter-spacing:.04em; text-transform:uppercase; color:#737373; }
.metric .v { font:600 22px/1.1 ui-monospace,"SF Mono",Menlo,monospace; color:#171717; margin-top:4px; }

/* the one thing that matters — sparing red-orange left rule */
.callout { border-left:3px solid #ff4b2e; background:#fff5f3; padding:12px 16px; margin:16px 0; }

/* a neutral note / caveat — grey, quieter than a callout */
.note { border-left:3px solid #d4d4d4; background:#fafafa; padding:12px 16px; margin:16px 0; }

/* mono chip for a config key / flag / identifier inline in prose */
.tag { font:12px ui-monospace,"SF Mono",Menlo,monospace; background:#f5f5f5;
  border:1px solid #e5e5e5; border-radius:3px; padding:1px 6px; color:#404040; }

/* wide diagram / metrics grid scrolls instead of overflowing */
.diagram-box { max-width:100%; overflow-x:auto; margin:20px 0; }
```

## Palette

| Role | Value | Use |
|---|---|---|
| Accent | `#ff4b2e` red-orange | the single most important number or warning per view |
| Link | `#2f6fed` blue | links only, never fills |
| Grey scale | `#171717` → `#737373` → `#e5e5e5` → `#fafafa` | text, labels, borders, fills |

The color count isn't fixed — add a hue when a chart or a category genuinely
needs it. But the feel depends on grey doing most of the work and the accent
staying rare.

## Reach for

- **`.metric`** for a number that stands on its own (a latency, a pass rate,
  a token count). Group several in a row inside a `.diagram-box`.
- **`.callout`** for the one claim a reader must not miss — at most one or
  two per doc.
- **`.note`** for caveats and asides that would otherwise clutter the prose.
- **`.tag`** inline, for flags and keys, so `--max-turns` or `RUNTIME=codex`
  reads as machine text, not prose.

## Style is visual only

Governs how the page looks — never section numbering, language, tone, or
structure, which follow the content. Tables stay unstyled and inherit the
overlay's rounded-cell default. Link generously to sources.

## Fits the overlay

Carried by mono, grey frames, and one sparing accent — nothing full-bleed,
sticky, or shadowed. Light mode only; the pale fills assume a white ground.
