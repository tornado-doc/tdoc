# Your first tdoc

> **For agents (Claude Code, Codex, Cursor, Gemini, Grok):** read this file
> end-to-end, then do it. It is written for you, not the human. The human
> pasted one line to get you here and is not expecting to answer questions.

## Step 1 — install tdoc

Follow [ONBOARDING.md](ONBOARDING.md) end-to-end first. Do not skip it and do
not ask the human which runtime they use; that file tells you how to install
yourself and how to authenticate.

Publishing is hosted by default and needs no Cloudflare account, no card, and
nothing to click in a dashboard. If the CLI asks the human to sign in with
GitHub, print the code and the URL and wait for them. Do not ask them for a
token; there is nothing for them to paste. Do not ask for a token, and do not
print one.

Do not install wrangler, and do not send them to the Cloudflare dashboard. If
`bin/tdoc-doctor` is asking for either, read its `.target` field first — on the
hosted default it never should.

<details>
<summary><b>Only if the human said to publish to their own Cloudflare</b> — the
line they pasted will say so</summary>

Do that instead, and do not sign them into the hosted service. The self-hosting
appendix at the end of ONBOARDING.md covers it: install wrangler, run
`wrangler login`, then two things only they can click in a browser (claim a workers.dev
subdomain, enable R2). Print each URL, say what to click, and wait for them to
confirm before re-probing with `bin/tdoc-doctor --platform cloudflare`. About
five minutes the first time, and free — their account, their bill, no card.
</details>

## Step 2 — the doc is **What does AI know about me?**

The first doc is about the human, built from the traces the AI tools on their
machine have already left. It is the one document no other tool could write:
every other product sees only its own history. You can see all of them.

Say this in one line **before** you start scanning, then scan:

> I'm going to look at the traces your AI tools have left on this machine —
> file names and timestamps only. I won't open any of your conversations.

That line is not optional. Enumerating someone's Cursor and Codex folders
without warning, on first run, is the single fastest way to lose them.

### What to read, and the budget

**Total budget: about 15 seconds and under 3k tokens of sampled history.**
Onboarding speed matters more than completeness. Almost all of the punch comes
from the cheapest layer.

| Layer | Read | Cost | Gives you |
|---|---|---|---|
| **1. Timestamps** | file names + mtimes, every vendor | ~2s | volume, rhythm, which tools, the shift between them |
| **2. Project paths** | first `"cwd"` in each Claude session (`head -c 65536`, parallel) | ~8s | the project timeline |
| **3. Now** | the ~20 most recent sessions, heads only | ~1s | what they are working on this week |

Layer 1 is free and carries the whole skeleton. Do not go deeper than layer 3.

**Never copy conversation text into the page.** Transcripts contain pasted API
keys, client names, and private material. Everything on the page must be
derived from counts, paths, and timestamps — never quoted.

Where the traces live (skip any that are missing):

- Claude Code — `~/.claude/projects/**/*.jsonl`
- Codex — `~/.codex/sessions/`
- Grok — `~/.grok/sessions/**/*.jsonl`
- Gemini — `~/.gemini/`
- Cursor — `~/Library/Application Support/Cursor/User/globalStorage`

**Count conversation records only.** Raw file counts lie: `.log`, `.lock`,
`.tmp`, caches and extension code outnumber real sessions several times over in
some vendors' folders. A chart built on raw counts will confidently tell the
human something false.

### Clean the project list before you draw it

Working directories are not a project list. Filter, or the page shows the human
gibberish and inflates the count:

- **Drop** scratch and machine-made directories: worktrees (`*-wt-*`, `*-wt`),
  `*_workspaces`, `*-rebase`, review-request folders with a hash in the name,
  anything starting with `.`
- **Merge** worktrees and variants into their parent project
- **Drop** anything that lived one day and was opened twice or less
- **Drop** the home directory itself — sessions launched from `~` span
  everything and say nothing
- Count what is left. That is the real number of projects.

## Step 3 — every section opens with a claim

Each section starts with one flat, unhedged sentence that states a conclusion
about this person, and the visual under it is the evidence. Not a topic, not a
question, not a tease — a claim you are willing to be wrong about.

| Don't | Do |
|---|---|
| "Who you worked with" | "You replaced your main assistant in a month." |
| "When you work" | "You do your best work while most people are asleep." |
| "Where the time went" | "You don't finish projects. You leave them at full speed." |

Rules for the claim:

- **Name a trait, then prove it.** People read a page about themselves the way
they read a personality test: they are looking for *who am I*, not *what did I
do*. A section that opens with an activity reading — "Friday is your busiest
day" — has told them a fact about a calendar. A section that opens with a
trait — "your week has one spine and everything leans on it" — has told them
something about themselves, and the chart underneath turns it from a horoscope
into evidence.

Every section, including the first and the last. The opening line says what
kind of worker this person is; the closing line says what all of it adds up to.
Between them each claim names a disposition — how they commit, how they
abandon, when they are sharp, what they are loyal to — and the figure proves
it. The behaviour is the evidence, never the headline.

The line stays honest: a trait must be the *shortest true description* of what
the chart shows, not a flattering label pasted on top. "You are a sprinter" is
a trait; "you are a visionary" is a fortune cookie.

**It must be provable by the visual directly beneath it.** If the chart does
  not settle it, the claim is decoration and does not belong.
- **State it, don't build up to it.** No "here's the interesting part", no
  colon reveal, no "what most people miss".
- **Be specific enough to be wrong.** "You work a lot" is safe and worthless.
  "You worked 79 of the last 91 days" can be argued with, which is the point.
- **Judge the work, never the person.** "You abandon projects fast" is about
  the work. Anything about their character, mood, or life is out.
- **Reach a verdict, don't just report.** The reader came to hear what an AI
  that watched them thinks, not to read their own numbers back. A claim that
  only restates the chart is wasted: "Friday is your busiest day" is a
  reading; "Friday is the only day you finish things" is a verdict. Commit to
  the second kind, and let them argue.

## Step 3b — the page is an argument, not an inventory

Sections ordered by where the data came from — all the time charts together,
all the project charts together — read as a list. Order them so each one
reframes the one before it, and the reader arrives somewhere.

**Put their name in the title.** "What does AI know about Serena?" lands
differently from "What does AI know about you?" — it is the first signal that
this page is about them and not a template. Resolve the name in this order and
stop at the first hit: `git config user.name`, the GitHub login on the tdoc
account, the operating system's full name (`id -F` on macOS). If a name has
both parts, use the first. **Never invent one, and never guess from a folder
path** — if nothing resolves, address them as "you" and move on. Getting
someone's name wrong on the first line costs more than not using it.

**Open with a verdict, not with the title.** The first line under the heading
is an assessment of this person's working life, compressed to one sentence and
built from the numbers below it. A reader who stops after that line should
still have been told something about themselves.

**Then earn the right to judge.** The first section is the one nobody can
argue with — sheer volume, days shown up. Establish that this is worth taking
seriously before making any claim that could offend.

**Then substance, then shape, then conditions.** What they worked on; how the
work was distributed; when and under what rhythm. Each answers a question the
previous section raises.

**Close on the most surprising thing, not the biggest.** The last section
should be the one they did not know about themselves — a change they did not
notice making, a pattern only visible from outside. The biggest number belongs
at the top; the sharpest observation belongs at the end.

**End with a verdict too**, and make it the one the whole page was building
toward. If the closing line could have been the opening line, the page has no
arc.

## Step 4 — what the page says, in two parts

**Part 1 — What it knows.** Facts from timestamps and paths. No hedging, no
interpretation needed: how many times they sat down with an AI, over how many
days, which tools, when in the day they work, which projects and for how long.

**Part 2 — What it thinks.** The section claims from Step 3 are this part.
Each one is followed by its evidence and closes with a question back to them —
one line, not a paragraph. A guess invites a correction; a statement about
someone that is wrong just annoys them.

There is no third part. Do not write a "what it cannot know" section — a list
of things the page does not do is not content, and it ends the doc on a
shrug. The privacy line at the top of the page already covers what was read.

Close with **three to five questions addressed to the human**, each anchored to
something on the page. Answering one is a comment, and a comment is what
produces the next version of the page — say so in one line, so the reader knows
what their reply will do. Do not write a tutorial section telling them to practise
commenting — these questions are the tutorial. They will comment because they
want to answer.

## Step 4b — the reader may not write code

The traces come from coding CLIs, so it is easy to write the page as though
every reader ships software. Many do not: people use these tools to draft
reports, do research, plan, analyse spreadsheets, write. Their working
directories are folders, not repositories, and some of them work entirely from
one place and have no projects at all.

- **Never assume the work is code.** No repo, commit, branch, build, deploy,
  ship, or codebase anywhere on the page. Say *projects*, *what you were
  working on*, *pieces of work*.
- **Let the directories describe themselves.** A folder named `q3-report` is a
  report; do not narrate it as a build. If the names do not say what the work
  is, say nothing about what it is — the timing and the shape are still true.
- **Degrade when there are no projects.** A reader who works from one place
  has no project chart, and that must not leave a hole. The rhythm, the volume,
  the assistants and the switch between them all still hold, and they are
  enough for a full page. Drop the project sections rather than shipping a
  chart with one bar in it.
- **Do not treat "no projects" as a smaller story.** Someone who uses one
  assistant, from one folder, every night for three months has a strong
  portrait. It is a different portrait, not a thinner one.

## Step 5 — the page is visuals, not writing

Read `authoring/visuals.md` and go past it here. On this page prose is a
caption layer, not a body. A reader should be able to scroll it with the text
blurred out and still learn most of what it says.

**The budget:**

- **A visual every screenful, minimum.** Aim for eight or more distinct
  figures on a full history. Fewer than five means you left information on the
  floor.
- **No explanatory paragraphs.** The only prose allowed is the section claim,
  a one-line caption above each figure, and the closing questions. If you are
  writing a paragraph to describe what a chart shows, delete the paragraph —
  the chart already showed it, or the chart is wrong.
- **Never repeat a number in prose that is already in a figure.** Say it once,
  in the picture.
- **Vary the type.** Repeating one chart eight times is not eight figures.

**Say durations in units a person feels.** Nobody holds "98 days" in their
head. Three months, fourteen weeks, "since May" — those land; a raw day count
reads as a number the page made up. Convert every span before printing it, and
keep the exact figure only where the precision does work (a streak, a gap).
The same goes for the denominator in a ratio: "78 of the last 98 days" is
arithmetic; "you worked five days a week for three months" is a fact about a
person.

**A number without its unit is not a fact.** Every figure on the page names
what it counts, in the same breath, every time — a stat tile, an axis, a
callout, a bar label. "8,488" is nothing; "8,488 conversations" is something.
Never rely on a heading three lines up to supply the unit, and never make the
reader infer it from a neighbouring tile.

**The opening verdict is an interpretation, not a summary.** Reciting the
statistics that follow is not a TL;DR — the reader has not seen them yet, so
the recital means nothing. Say what the numbers add up to about how this
person works, in language that would still make sense if every chart were
removed.

**Every label must stand on its own.** A stat tile is read in isolation, in
any order, at a glance. A label that only makes sense next to its neighbour is
broken:

| Broken | Fixed |
|---|---|
| `107` — "on a typical one" | `107` — "conversations on an average working day" |
| `1,178` — "on August 21, the busiest" | `1,178` — "the busiest single day, August 21" |

Name the unit in every label. Never make the reader look at the tile to the
left to find out what the number counts.

**Lay tiles out so the row divides evenly.** Four tiles that wrap to three plus
one leave a broken grid and a hole. Use a count that fits the row, or give the
odd tile the full width deliberately.

**The data supports far more than three charts. Draw as many as hold up:**

| Question | Visual |
|---|---|
| how much, overall | stat tiles |
| which assistant, over time | stacked composition bars |
| daily activity per project | small multiples, one row per project |
| when in the day | 24-hour bar chart |
| which days of the week | 7-bar chart |
| does the assistant change the hours | small multiples, one row per assistant |
| how many things at once | count of active projects per week |
| total accumulation | cumulative line |
| streaks and silences | a strip of the calendar, day by day |
| how concentrated the work is | share held by the top few projects |
| intensity against duration | a **scatter**: days worked on one axis, volume on the other |
| when one thing replaced another | a **share-over-time area or line**, bucketed fine |

**Comparing a few series: overlay them, don't stack rows.** Small multiples
answer "what is each one's shape". A reader comparing two or three things
needs them on **one pair of axes**, drawn as lines, so the differences are
read directly instead of by eye-jumping between rows. Normalise to each
series' own total when their volumes differ by a lot, or the largest one
flattens the rest.

**Black is for structure; the accent is for data.** The style says the accent
lives in the figures and the frames are thin black rectangles — that is the
right way round, and it is easy to invert by accident. Filling every bar, mark
and band with ink and then using the accent only to highlight one of them
produces a page that is almost entirely black, which reads as heavy and
undifferentiated no matter how correct each chart is. Fill the data with the
figure's accent. Keep black for frames, axis rules, tick labels and series
names. Grey carries "nothing here" and de-emphasised items.

**A figure with N series needs N distinguishable colours.** The one-accent
rule exists to stop decoration, not to starve a real comparison. When a chart
encodes three assistants, three colours is the correct answer and forcing two
of them into the same hue — separated only by a texture — makes the two series
the reader most needs to tell apart the hardest to tell apart. That is worse
than the decoration the rule was written to prevent.

Separate series by **hue**, not by lightness or texture. Two tints of the same
blue read as "this one is disabled", not as "these are different things". The
default style ships a warm accent and a cool one; a third series needs a third
hue, roughly a third of the wheel away from both. Texture then becomes a
secondary cue on top of an already-distinct colour, which is what the style
intends by calling it a *variant*.

If a figure genuinely needs more colours than the style ships, extend it — and
keep every swatch in the legend exactly the fill it labels.

**Which accent: the cool one carries the data, the warm one marks a subset.**
The default style ships two — a blue (`#dde7f9` fill, `#a9c0ee` stroke,
`#26407a` text) and a pink (`#f7d7d1` / `#e0a99e` / `#b3503c`). Fill the
ordinary data with the **blue**: it is the quieter of the two and a page of it
does not shout. Reserve the **pink** for the handful of things a claim is
actually about — the top three of twelve, the busiest days, the one project
that behaves differently. A page where everything is warm has the same problem
as a page where everything is black.

This does not license decoration. It is the same rule as below, pointed the
other way: one accent per figure, applied to the thing the figure is about.

**Colour must encode data, or not be there.** The most common way these pages
go wrong is decorative highlighting: bars recoloured to mark the range the
claim is about, when the bar heights already said it. The reader then spends
their attention asking what the second colour means. If a range needs calling
out, **annotate it** — a bracket, a label, a rule — and leave every bar one
colour. Two colours are earned only when they carry two different things.

**Show a change at the resolution it happened in.** A switch that took two
weeks disappears inside monthly buckets: four bars cannot show a handover.
Bucket by week when the period is a few months, by day when it is a few weeks.
The point of the figure is *when* it turned, so the axis has to be fine enough
to hold the answer.

**Cut any figure that does not change what the reader thinks.** A chart whose
values barely move, or whose axis you could not label usefully, is filler and
costs more attention than it returns. Eight strong figures beat twelve where
four are noise. If you cannot write a verdict over a chart, that is the signal
to drop the chart.

Pick what the person's own data actually supports. A machine with two weeks of
history cannot fill ten figures and should not fake it.

Charts are inline SVG and CSS. The host document runs no author JavaScript, so
there is no chart library — and a static SVG is a commentable artifact, which
is the point. If a figure genuinely needs to compute, it goes in a
widget island (`vN/widgets/<name>.html`) as a sandboxed iframe; a `<script>`
in the host is inert under the reader CSP and renders an empty panel. Put each figure in `<div class="diagram-box" data-tdoc-artifact>`
so it scrolls on a phone and can be commented on as a unit.

**Use the selected style's diagram vocabulary. All of it.** Read the style file
and apply what it specifies: its container frames, its label treatment, and
above all **one solid accent per figure** with the textured variant where the
style offers one. A page of identical black bars is not the style being
minimal — it is the style not being applied, and it reads as ugly. Do not set
your own sizes for `h2` or body text either; the style names what it controls,
and the reader template owns the rest.

## Step 5b — the failures cold readers actually catch

Every rule below came from handing a single figure, with its heading removed,
to a reader who had never seen the document and asking what it said. Each one
was a real defect that looked fine to the person who drew it.

**A fill that touches the page ground must be readable against the ground.**
Check the contrast against white, not against the fill's own outline. A style's
pale accents are designed for shapes that carry a stroke; used as a bare area
band against a white page they disappear. A reader who cannot see a band will
report the chart as if that series does not exist — and they will be right.

**A normalised share chart needs its base alongside it.** At 100% height every
week looks equally important, so a week with almost no activity reads as loud
as the busiest one, and a collapse in share cannot be told apart from a
collapse in volume. Put the weekly total on the same figure, or do not
normalise.

**Do not cut a cycle in the middle of your own conclusion.** Hours of the day
wrap. A linear midnight-to-23:00 axis splits the night in half and throws the
two halves to opposite edges, which then needs two brackets, two labels and an
explanation. Start the axis so the block you are claiming about is contiguous.

**An annotation must sit on the data it describes.** Callouts drift to wherever
there is white space and then read as labelling whatever they hover over. And
never route a leader line through a number: a line drawn across a value makes
that value unreadable, and it is always the value the annotation exists to
highlight.

**Give a proportion its baseline.** Seven hours out of twenty-four is 29% by
chance alone, so "41% happens at night" is a 1.4× lift, not the 2–3× the
sentence implies. State the comparison or state the multiple; a bare percentage
of a subset overclaims.

**Never build a concentration argument on a residual bucket.** "The other N"
is not a category, and when it is the largest block on the chart the reader
sees dispersion — the opposite of the point. Show every item on a common
baseline, sorted, and let the top of the ranking make the argument.

**Put labels outside the shapes they describe.** Text dropped inside a bar or
segment collides with its neighbours and lands on whatever fill happens to be
under it. Outside the shape, in the ink colour, nothing collides and nothing
becomes invisible.

**Rounded parts must sum to the rounded whole.** If the segments print 22, 18
and 15 and the callout prints 54, a reader who adds them gets 55 and stops
trusting the page. Carry a decimal, or derive the total from the same rounded
values you printed.

**Two axis labels on one chart get the same treatment.** Same size, same
weight, same colour, each along its own axis. A y-label in a lighter style,
floating outside the plot frame, does not get read.

**Nothing may be clipped by its own frame.** A point plotted near zero is drawn
half outside the axis; a legend sized to the text overflows a viewBox measured
without the group transform. Both look like rendering noise to a reader and
both destroy the value they were carrying.

**Every number on the page comes from one pass over the data.** Counting twice
with slightly different inclusion rules produces two answers, and they diverge
exactly where it shows: a tile says 79 days while the calendar beside it shades
78. Compute the dataset once, then draw everything from it.

**A numerator has to live inside its denominator.** "79 of the last 98 days"
requires all 79 to fall inside those 98. Check it; a single stray record dated
months before everything else will break the arithmetic of the opening claim
while looking like nothing on the chart.

**Drop lone records far outside the main distribution.** One file from three
months before the rest is not history, it is noise, and it stretches every
span, average, and streak computed against it. Establish the main period first,
then ignore what sits outside it — and say the period explicitly, because a
document that quotes three different totals without naming their windows reads
as though the numbers were invented.

**A component built on `<a>` must out-specify the style's link rule.** The
house style sets `.wrap a { color: … }`, which is a class plus an element and
therefore beats a bare `.cta`. A button styled only as `.cta` silently loses
its text colour to the link rule and gains a border it never asked for — the
CTA on this page rendered as near-black text on a near-black fill, 1.00:1,
completely unreadable, and it looked deliberate enough that nobody questioned
it. Scope such a component as `.wrap a.cta` so it wins, and reset what the
link rule imposes (`border-bottom: 0`).

**Check the contrast of anything you invent, against its own background.** Not
the page background — the fill the text actually sits on. One computed-style
read catches this class of failure completely.

**One implementation trap worth knowing:** a `text-anchor` declared in a CSS
class overrides the `text-anchor` attribute on the element. Presentation
attributes lose to stylesheet declarations, silently. If a label is centred
when you told it to start, this is why.

## Step 6 — write it for someone with no technical background

The human may show this page to a friend, a partner, a manager. Nothing on it
may require knowing what a repository or a session file is.

- "3,942 sessions across 42 project directories" → **"You sat down to work with
  an AI 3,942 times"**
- "cwd distribution" → **"Where your time went"**
- "mtime histogram" → **"When you actually work"**
- Never print: file, directory, path, token, branch, JSON, `.jsonl`, cwd

Project names are the one place technical noise leaks through. If a name is
unreadable to an outsider, that project was filtered out at step 2.

## Step 6b — the page ends by handing them the product

The last thing on the page is not another question. Close the arc, then tell
them what they just used and where to go next.

- **One line naming what happened.** They watched an AI read their machine and
  write them a page about themselves. Say that, in their words, not in feature
  language.
- **A single link, styled as a button, to `https://tdoc.dev`.** One. Not a
  list of links, not a footer of options.
- **No pitch paragraph.** The page they just read is the argument. A paragraph
  of positioning after it subtracts from what the charts already earned.

The tone is a welcome, not a sale: this is how documents work now — you
comment, your AI rewrites them. Keep it to two sentences and a button.

## Step 6c — name the hub only if they have a hosted account

If — and only if — the doc went to hosted tdoc (`tdoc.dev`), close by telling
them everything they publish is listed at **https://tdoc.dev/me**, their hub.

Omit it entirely when they published to their own Cloudflare. On a worker they
own, `/me` is the operator catalog — which is them — but it is reached at their
own domain, not at tdoc.dev. Naming tdoc.dev there
walks them into a sign-in wall on somebody else's site.

## Step 7 — show it before you publish

**Do not publish this one automatically.** Every other tdoc is published as a
matter of course; this one is about them, and the default visibility means the
link is the credential.

Build it, open it locally, and ask. If they say yes, publish and give them the
URL on its own line. If they say no, leave it on their machine and tell them
the command to publish it later.

## If there is no history

A brand-new machine has nothing to scan. Do not produce an empty page and do
not pad it. Tell them the truth, because it is a real answer to the question:

> Almost nothing. You're clean.

Then make the appointment: use it for a week and ask again. That gives the
first doc something a static tutorial never has — a reason to come back.

## Do not

- Do not ask which AI they use. You are the AI they use.
- Do not open, quote, or summarise the contents of any conversation.
- Do not comment on the person's life, mood, or circumstances. The subject is
  the work, not them.
- Do not publish without asking.
- Do not build a fixture, a template, or a starter repo. This page is written
  fresh each time, by you, from this file.
