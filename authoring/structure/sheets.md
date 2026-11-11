# Sheets

Read this when the doc is a spreadsheet: a list of records with columns
someone will search, filter or sort (a tracker, an inventory, a budget, a
contact list, survey results). A sheet is an ordinary tdoc HTML document. Its
tables carry `data-tdoc-sheet`, and the reader shows them as a spreadsheet
grid with tabs, search, per-column filters, multi-column sort, a frozen header
and first column. Without the viewer (an export, a feed reader) the same
markup is a readable table. You edit a sheet the way you edit any doc: change
the HTML and publish a new version.

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
- An embed shows only if **both** the page's author (whoever published its
  latest version) and the reader can read the sheet. Otherwise the reader
  sees "You don't have access to this sheet" and nothing of it, not even its
  title. Share the sheet with the same people as the page, and embed only
  sheets you can read yourself.
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
