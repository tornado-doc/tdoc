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
