# Sheets

Read this when the doc is a spreadsheet: a list of records with columns
someone will search, filter or sort (a tracker, an inventory, a budget, a
contact list, survey results). A sheet is an ordinary tdoc HTML document. Its
tables carry `data-tdoc-sheet`, and the reader shows them as a spreadsheet
grid with tabs, search, per-column filters, multi-column sort, a frozen header
and first column. Without the viewer (an export, a feed reader) the same
markup is a readable table. You edit a sheet the way you edit any doc: change
the HTML and publish a new version.

## Sheet or table

A small reference table in a prose doc is a plain `<table>`: five suppliers
and their status, a plan of eight steps, three options compared. The reader
takes it in at a glance, and a spreadsheet's tabs and search box add nothing.

- **Plain `<table>`**: up to about 20 rows and 5 columns of short cells,
  inside a report, plan or note.
- **`data-tdoc-sheet` in the doc**: data the reader will search, filter or
  sort (usually more than about 20 rows), and a wider table (more than 5
  columns) or one with long cell text, where search and sort help.
- **A sheet doc of its own**: the deliverable itself is a list of records (a
  CRM, an inventory, a tracker). Publish it as its own doc and link to it from
  the prose doc in one line.

Columns are not something to avoid. In a prose doc the reader fits a plain
table, and a sheet of 20 rows or fewer, to the page: columns share the width
and text wraps, a table the reading column cramps takes the page width beside
it, and on a phone more than three columns read as one card per row. A sheet
of 20 rows or fewer shows a small search icon instead of a toolbar; full
screen still gives the whole grid. `data-tdoc-table="fixed"` on the table
keeps your own layout, and `data-tdoc-wide` asks for the page width.

Publish warns about a sheet of 20 rows or fewer, 5 columns or fewer and short
cells in a prose doc: "Small table in a doc: use a plain <table>; keep sheets
for data people filter or sort, and for wide tables or long cell text."

Before, a status update with three columns of five suppliers as a sheet:

```html
<p>EGI and Potato are the two suppliers we are pricing first.</p>
<div class="tdoc-table-scroll">
<table data-tdoc-sheet data-name="Suppliers">
  <thead><tr><th data-key="c1">Supplier</th><th data-key="c2" data-type="tags">Status</th><th data-key="c3">Next action</th></tr></thead>
  <tbody><tr data-row="r1"><td>EGI</td><td><span data-tag>Active</span></td><td>Confirm SKU prices and MOQ</td></tr> …</tbody>
</table>
</div>
```

After, a plain table, with the 21-item inventory as its own sheet doc:

```html
<p>EGI and Potato are the two suppliers we are pricing first.</p>
<div class="tdoc-table-scroll">
<table>
  <thead><tr><th>Supplier</th><th>Status</th><th>Next action</th></tr></thead>
  <tbody><tr><td>EGI</td><td>Active</td><td>Confirm SKU prices and MOQ</td></tr> …</tbody>
</table>
</div>
<p>EGI's stock list: <a href="https://tdoc.dev/d/egi-inventory">EGI inventory (21 items)</a>.</p>
```

The rest of this guide is the sheet itself.

## The markup

One `<table data-tdoc-sheet>` per tab. `data-name` is the tab's name. The
header row is the last row of `<thead>`; each `<th>` declares its column type.

```html
<div class="tdoc-table-scroll">
<table data-tdoc-sheet data-name="Tasks">
  <thead><tr>
    <th data-key="c1" data-type="text">Task</th>
    <th data-key="c2" data-type="number">Points</th>
    <th data-key="c3" data-type="date">Due</th>
    <th data-key="c4" data-type="tags" data-palette="blocked:red, done:green">Status</th>
    <th data-key="c5" data-type="checkbox">Shipped</th>
    <th data-key="c6" data-type="url">Link</th>
  </tr></thead>
  <tbody>
    <tr data-row="r1"><td>Billing export</td><td>5</td><td>2026-03-01</td><td><span data-tag>blocked</span> <span data-tag>q1</span></td><td>✓</td><td><a href="https://example.com/1">example.com/1</a></td></tr>
    <tr data-row="r2"><td>Search</td><td>3</td><td>2026-03-14</td><td><span data-tag>done</span></td><td></td><td></td></tr>
  </tbody>
</table>
</div>
```

| `data-type` | Write the cell as | Filter |
|---|---|---|
| `text` (default) | plain text | by value |
| `number` | `1200`, `1,200.50`, `$12`, `-3` | by range |
| `date` | ISO: `2026-03-01` (or `2026-03-01 14:30`) | by range |
| `tags` | `<span data-tag>a</span> <span data-tag>b</span>` | by tag (any of) |
| `checkbox` | `✓` for checked, empty for not | checked / not |
| `url` | `<a href="https://…">label</a>` | by value |

## Rows, tags, tabs

- **Row ids and column keys.** Give every body row a `data-row` id (`r1`,
  `r2`, …) and every header a `data-key` (`c1`, `c2`, …), and keep both when
  you edit: a comment on a cell anchors to its row id and column key, so it
  survives sorting, filtering, and rows or columns added or removed
  elsewhere. A new row or column takes the next unused number; renaming or
  retyping a column keeps its key; a deleted id is never reused. Never
  renumber.
- **Tag colours.** `data-palette` on the `<th>` names a colour per tag:
  `gray`, `red`, `orange`, `yellow`, `green`, `teal`, `blue`, `purple`, `pink`.
  A tag the palette does not name gets a stable colour of its own.
- **Tabs.** Several sheet tables in one doc are tabs of one grid, shown where
  the first table is. Give each a distinct `data-name`. With more than one,
  add `<caption>Name</caption>` so the plain page still names each table.
- Plain text in cells: no nested tables, no `rowspan`/`colspan`, no markup
  except `<a>` in a `url` column and `<span data-tag>` in a `tags` column.
- **Conditional formatting and dropdowns.** Rules live on the `<table>` as
  JSON, never as CSS. `data-format-rules` fills cells by value (the first
  rule that matches wins); `data-validation` gives a column a dropdown of
  values, shown as chips (a value outside the list is marked while editing).
  Columns are named by `data-key`; a fill is a palette name, drawn as its
  soft tint.

  ```html
  <table data-tdoc-sheet data-name="Tasks"
    data-format-rules='[{"cols":["c2"],"when":"gt","value":"10","fill":"red"},
                        {"cols":["c4"],"when":"textContains","value":"blocked","fill":"orange"}]'
    data-validation='[{"cols":["c4"],"kind":"list","values":["open","done","blocked"]}]'>
  ```

  `when` is `gt`, `lt`, `eq` (a number, or a date in a date column),
  `textContains` or `empty`. Anything else is ignored.
- Write prose around the sheet as usual: a heading, a line on what the sheet
  is and where it came from. Filters, sort and search are the reader's view
  and are never written into the doc.

## Size

A doc whose bulk is sheet tables may be up to 8 MB of HTML (10,000 rows of
20 columns is about 3-6 MB); everything outside the sheet tables still has
to fit the ordinary 2 MB. Only cell text and cell markup count towards the
larger limit: a sheet table holding an image, a script, a style, an HTML
comment or a `data:` URL gets no allowance. The grid stays smooth at 10,000
rows. Beyond that,
split the data into several docs or summarise it.

## From a file

`tdoc-new --slug <slug> --from-csv data.csv` (or `--from-tsv`, `--from-xlsx`,
one tab per worksheet) writes this markup with column types inferred. To
change a published sheet, edit its HTML: add `<tr>` rows with new ids, change
a `<td>`, or change a `<th data-type>` and rewrite that column's cells.

## Embedding a sheet in a page

A standalone sheet can be shown inside any other tdoc page **by reference**:
the page holds a link, the sheet stays the one place the data lives. Readers
of the page see a compact live view of the sheet's latest version (its title,
the header and first rows, the open comment count, and Open), so editing the
sheet updates every page that embeds it.

```html
<figure data-tdoc-embed="sheet" data-src="/d/q3-pipeline" data-tab="Deals" data-rows="10">
  <a href="/d/q3-pipeline">Q3 pipeline</a>
</figure>
```

| Attribute | Value |
|---|---|
| `data-src` | the sheet's address: `/d/<slug>` (a bare slug or a full link to this tdoc also works). Never another site. |
| `data-tab` | the tab's `data-name`; without it, the first tab |
| `data-view` | optional: a saved filter, sort or search, the value after `#sheet=` in the sheet's address once a reader has set one up |
| `data-rows` | rows shown, 1-50 (default 10) |
| `data-columns` | optional: which columns, by header name or `data-key`, comma separated (at most 12) |

- Always keep the `<a>` inside the figure, with the sheet's name as its text:
  it is what an export, a feed reader or an old version shows instead.
- Use the slug of the sheet you published (its address is
  `https://tdoc.dev/d/<slug>`). Publish the sheet first, then the page.
- An embed shows only if **both** every account that has written the page
  (each version's publisher or editor) and the reader can read the sheet.
  Otherwise the reader sees "You don't have access to this sheet" and
  nothing of it, not even its title. Share the sheet with the same people as
  the page, and embed only sheets you can read yourself.
- Only the page's latest version shows the live view; an old version shows
  the link. A page with a version that names no writer (saved before
  writers were recorded, Nov 2026) shows the link; its owner can turn the
  embeds on with ⋯ › "Allow sheet embeds on this page", which vouches for
  those versions as the owner's own (it lists those versions' writers and
  the embedded sheets first). A duplicate keeps every writer of the page it
  was copied from; a copy of a page with unnamed versions shows links and
  cannot be allowed (publish the content as a new page instead).
- Comments on the data go on the sheet; the embed shows their count and
  links there.
- Markdown and Word downloads of the page show the embed as its link. The
  page's version history shows a change to the reference, never the sheet's
  rows.

### Embed, or a table in the page?

- **Plain `<table>`**: a small, settled table that is part of this page's
  argument (a comparison, a handful of figures). It changes when the page does.
- **A sheet table in the page** (`<table data-tdoc-sheet>` among the prose):
  records only this page uses that readers will search, filter or sort.
- **A standalone sheet, embedded**: the data outlives the page or is used by
  several pages (a tracker, a pipeline, an inventory), is kept up to date by
  someone other than the page's author, has comments of its own, or is too big
  to read inline. Make it its own sheet doc, embed it where it is discussed,
  and point `data-view` at the rows the page is about.
