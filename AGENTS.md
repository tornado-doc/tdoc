Remote storage is source of truth. Local HTML is disposable. Local skill is authoring/scaffold.
Published reader invariants are provider-enforced in overlay/worker code and tests, not left only to author HTML or prompts.

The UI is a component system, not a canvas. Base UI (`@base-ui/react`) is wrapped once, in `shell/src/ui/` (AppDialog, AppMenu / AppMenuItem / AppSubmenu / AppMenuSeparator, SegmentedControl, AppSwitch, CommentIcon); colour comes from the `--td-*` tokens in `shell/src/docs-hub.css`, and the published design tokens live at tdoc.dev/d/tdoc-design-tokens. Do not invent a new component shape, colour, or control when one of these already exists — extend the existing one.
Before building anything, look for what is already there to reuse: `grep` the shell for the facade, the token, the helper. Reuse is the default; a new thing needs a reason the existing one cannot carry.
