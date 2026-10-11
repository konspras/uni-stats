# University statistics frontend

The frontend has a **Pyramid** tab to the left of **Data explorer**, served by `server.py` on port **8768**. It reads SQLite directly; there is no collection worker, periodic task or implicit data write. No web framework, build step, charting dependency, external font or CDN is required. The root URL initially shows Data explorer; `/#pyramid` opens Pyramid directly. Each tab retains its own selection and display mode when switching.

## Pyramid

Only entrant and degree tables containing a university dimension and a gender or nationality breakdown are eligible. **Enrolled students, staff and finances are excluded**, as are flow tables lacking either supported split. The current picker contains six source tables: entrant broad/detailed subject tables `_121`–`_124` and detailed degree tables `1503040100_101`/`_102`.

- A single university dropdown offers one institution or **All (derived sum)**, which produces one pyramid by adding university observations within the selected table. Multiple university pyramids are not supported.
- **Gender / Nationality** buttons select the appropriate source table with the same flow metric and other dimensions. Gender places men on the left and women on the right; nationality places Swiss nationals on the left and foreign nationals on the right. University, subject, qualification and time range are retained where available. Source codes can differ: category labels and period labels identify matching selections. If the target has a shorter history, the range is limited to available periods.
- Oldest source years are at the top; newest at the bottom. Both sides share the same magnitude scale and show positive counts. Entrant rows mean academic entry year, not the number still enrolled. Degree rows mean calendar graduation year, not the graduate's entry cohort. No assumed completion-time shift is applied.
- The shared selection panel retains dataset, measure, subject/qualification filters, snapshot and explicit All options. The chart controls retain the two-handle time slider and optional percentages within each year's total. Start-year normalization is hidden in Pyramid. Reset returns to detailed CS entrants at EPFL, split by gender, over the full source history with raw counts.
- Unknown gender categories remain in the table and percentage denominator without being assigned to men or women. A notice appears when unknown observations are nonzero or missing. Missing markers stay missing; percentage mode requires a complete nonnegative total. No joint gender/nationality distribution is inferred.
- Hover rows, or focus the chart and use Up/Down/Home/End, to inspect values. Longer histories scroll vertically inside the plot. Mobile layouts use the same mirrored scale and period ordering.

## Interaction model

- All 28 collected datasets appear in a picker grouped into students, Bachelor/historical entrants, degrees, staff and finances.
- Every non-time dimension comes from the selected snapshot's metadata. Known dimension names have English interface labels; category labels remain as published in German. Unknown dimensions use their source names.
- Choose one comparison dimension and one or more categories from it. Every other dimension has one fixed selection, including **All (derived sum)** for reviewed additive datasets. Selecting All on several dimensions sums the Cartesian product of their categories. Labels distinguish derived sums from published source totals. The comparison dimension stays as separate lines; no cross-table mapping is applied.
- Finance tables `1506030100_203`, `_204` and `_211` offer **All (published total)** for university, selecting source code `0` rather than adding a total to its components. Finance indicators `_211` are nonadditive: subject and indicator have no All sum. Unreviewed future datasets require an explicit aggregation policy before All is enabled. Staff headcount sums count category assignments, which can include the same person more than once; FTE is preferable for additive staffing comparisons.
- Derived sums include every source category, including unknown/residual categories. If any component has a missing marker or lacks an observation, the entire sum is missing; available components are never presented as a full total. Decimal addition preserves source precision. For example, detailed CS Bachelor entrants in 2025/26 total EPFL **286** and ETHZ **369**, whether summing gender in `_123` or nationality in `_124`.
- The untitled, full-width chart controls panel sits immediately below the plot. Its two-handle slider replaces the sidebar's From/To dropdowns. Handles snap to source periods, retain their academic/calendar labels, and support dragging, track clicks and keyboard navigation. Handles cannot cross; selecting a single period is allowed. A single-period dataset disables both handles. Slider positions map to the snapshot's source codes, not assumed year numbers. Historical snapshot selection remains in the sidebar.
- The optional **Normalize to start = 100** toggle divides each series by its own value in the first selected period and multiplies by 100. It applies to the plot, hover values and value table; source values remain available on table-cell hover and unchanged in SQLite. Changing the start period recalculates every baseline. A zero/missing baseline leaves that series unplotted with an explicit notice; it never substitutes a later year. Other valid series remain plotted. Missing subsequent observations stay gaps and subsequent zeros stay zero. The default and Reset view show source values.
- **Percentage of total** divides each selected series by the sum of the selected series independently in each period. It switches the plot to stacked areas with a fixed 0–100% scale, and the tooltip/table to percentages, retaining original values on hover. This is the selected-series total, not a national total. Missing or negative components, or an all-zero total, leave a gap for every series in that period with a notice. Zero-valued components of a positive total remain 0%. Aggregation runs before percentages. The two display checkboxes are mutually exclusive: checking one disables the other until it is unchecked. Reset clears both modes.
- Source markers remain visible in the raw-value table and produce plot gaps. Zero is numeric zero. The chart retains academic/calendar-year labels and the source period ordering.
- Hover over the chart, or focus it and use arrow keys/Home/End, to inspect period values.
- The source panel shows the full BFS title, source link, collection/catalog timestamps, original category dictionaries, source column comments and response metadata. Units are not guessed when the stored metadata does not explicitly supply them.

The initial view uses `px-x-1502040100_105`, detailed subject **Informatik**, study level **Bachelor**, comparing **EPFL** and **ETHZ** over the full published history. These are Bachelor enrolments, not all-level student totals. Other datasets initially select Informatik/Bachelor where present, an exact broad subject where available, and otherwise the first published category; all fixed categories are visible in the controls and plot summary.

At the current snapshot, the default 2025/26 values are EPFL **930** and ETHZ **1428**. The frontend exposes broader source datasets without claiming each contains a detailed CS category.

## Read-only API

| Endpoint | Result |
| --- | --- |
| `GET /api/datasets` | Available datasets, grouping, dimensions and latest snapshot |
| `GET /api/dataset?id=…&snapshot=…` | Source metadata, measures, definitions, provenance, successful snapshot list and aggregation options |
| `GET /api/series?query=…` | Validated category series or explicitly derived sums |

`query` is a URL-encoded JSON object containing `dataset`, optional `snapshot`, `compare`, `values`, `filters`, optional `measure`, and optional `from`/`to` source period codes. The API validates dataset/snapshot ownership, dimension/category/measure membership and complete fixed filters before constructing parameterized SQL. Physical tables and source columns are resolved from database metadata and quoted as identifiers. Missing markers are never coerced to zero.

Each fixed filter is either a source code string or JSON `null` for All. The details endpoint's `aggregation_options` maps eligible dimensions to `mode` (`sum` or `published_total`) and the source codes to select. Series responses include `derived` and an `aggregation` map recording each All dimension's method and category count. Exact points retain original `raw_value` strings; derived points use the computed decimal string and include `missing_components`. Normalization consumes the result afterward, so every university is indexed against its own aggregate baseline. No totals are written to SQLite.

Every request opens SQLite in read-only/query-only mode and uses a consistent read transaction. Only successful published snapshots are queryable. Static serving is limited to the public assets in `web/`; repository and database files are not HTTP-downloadable.

## Running service

The OS-managed user service is defined in `deploy/uni-stats.service`, installed as `~/.config/systemd/user/uni-stats.service` and enabled under the user's default target. Existing user lingering is enabled, so the service starts at boot without requiring an interactive login. It restarts on failure and binds to `0.0.0.0:8768`, like the neighbouring day-to-day application.

```bash
systemctl --user status uni-stats.service
systemctl --user restart uni-stats.service
journalctl --user -u uni-stats.service -n 50 --no-pager
```

To run manually on another port:

```bash
python3 server.py --host 127.0.0.1 --port 8769
```

To install on this machine after a fresh checkout:

```bash
mkdir -p ~/.config/systemd/user
ln -s /home/konstantinos/Code/uni-stats/deploy/uni-stats.service ~/.config/systemd/user/uni-stats.service
systemctl --user daemon-reload
systemctl --user enable --now uni-stats.service
```

The unit uses this machine's repository path; adjust it if relocating. Collect data explicitly with `python3 scripts/fetch_bfs.py` before serving a new checkout. Weekly checks remain a separate pending step.

## Verification

```bash
python3 -m unittest discover -s tests -v
node --check web/app.js
node tests/test_normalize.mjs
node tests/test_percentage.mjs
node tests/test_pyramid.mjs
```

The Python suite includes HTTP tests that bind an ephemeral local socket. Browser checks use Node 22+ and an isolated Chromium CDP port, with no extra package installation:

```bash
chromium --headless=new --no-sandbox --disable-gpu --user-data-dir=/tmp/uni-stats-browser-profile --remote-debugging-port=9227 --remote-allow-origins=http://127.0.0.1:9227 about:blank
# In another terminal, while the frontend and browser are running:
node tests/browser_smoke.mjs
```

The browser check covers the explorer controls and all 28 datasets, then all six Pyramid datasets, both splits, one/All universities, period mapping across differing histories, degrees/unknown gender, percentage mode, independent tab selections, rejection of enrolled data, direct URLs, keyboard inspection and mobile layout. Node tests cover Pyramid eligibility/counterparts/side labels and percentage/normalization calculations. Python tests cover source aggregation and the HTTP API. Screenshots are written under `/tmp`. These read-only website checks leave stored observations unchanged.
