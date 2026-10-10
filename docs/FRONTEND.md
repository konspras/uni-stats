# Data explorer

The first frontend is a single Data explorer tab, served by `server.py` on port **8768**. It reads SQLite directly; there is no collection worker, periodic task or implicit data write. No web framework, build step, charting dependency, external font or CDN is required.

## Interaction model

- All 28 collected datasets appear in a picker grouped into students, Bachelor/historical entrants, degrees, staff and finances.
- Every non-time dimension comes from the selected snapshot's metadata. Known dimension names have English interface labels; category labels remain as published in German. Unknown dimensions use their source names.
- Choose one comparison dimension and one or more categories from it. Every other dimension has exactly one fixed selection. There is no implicit summation, aggregate category or cross-table mapping.
- Select the published time range and any successful historical snapshot. A snapshot's own dictionaries interpret its codes; the latest successful snapshot is selected initially.
- The optional **Normalize to start = 100** toggle divides each series by its own value in the first selected period and multiplies by 100. It applies to the plot, hover values and value table; source values remain available on table-cell hover and unchanged in SQLite. Changing the start period recalculates every baseline. A zero/missing baseline leaves that series unplotted with an explicit notice; it never substitutes a later year. Other valid series remain plotted. Missing subsequent observations stay gaps and subsequent zeros stay zero. The default and Reset view show source values.
- Source markers remain visible in the raw-value table and produce plot gaps. Zero is numeric zero. The chart retains academic/calendar-year labels and the source period ordering.
- Hover over the chart, or focus it and use arrow keys/Home/End, to inspect period values.
- The source panel shows the full BFS title, source link, collection/catalog timestamps, original category dictionaries, source column comments and response metadata. Units are not guessed when the stored metadata does not explicitly supply them.

The initial view uses `px-x-1502040100_105`, detailed subject **Informatik**, study level **Bachelor**, comparing **EPFL** and **ETHZ** over the full published history. These are Bachelor enrolments, not all-level student totals. Other datasets initially select Informatik/Bachelor where present, an exact broad subject where available, and otherwise the first published category; all fixed categories are visible in the controls and plot summary.

At the current snapshot, the default 2025/26 values are EPFL **930** and ETHZ **1428**. The frontend exposes broader source datasets without claiming each contains a detailed CS category.

## Read-only API

| Endpoint | Result |
| --- | --- |
| `GET /api/datasets` | Available datasets, grouping, dimensions and latest snapshot |
| `GET /api/dataset?id=…&snapshot=…` | Source metadata, measures, definitions, provenance and successful snapshot list |
| `GET /api/series?query=…` | Validated exact-category series and original value strings |

`query` is a URL-encoded JSON object containing `dataset`, optional `snapshot`, `compare`, `values`, `filters`, optional `measure`, and optional `from`/`to` source period codes. The API validates dataset/snapshot ownership, dimension/category/measure membership and complete fixed filters before constructing parameterized SQL. Physical tables and source columns are resolved from database metadata and quoted as identifiers. Missing markers are never coerced to zero.

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
```

The Python suite includes HTTP tests that bind an ephemeral local socket. Browser checks use Node 22+ and an isolated Chromium CDP port, with no extra package installation:

```bash
chromium --headless=new --no-sandbox --disable-gpu --user-data-dir=/tmp/uni-stats-browser-profile --remote-debugging-port=9227 --remote-allow-origins=http://127.0.0.1:9227 about:blank
# In another terminal, while the frontend and browser are running:
node tests/browser_smoke.mjs
```

The browser check exercises the actual default values, year range, comparison/filter changes, category search, every collected dataset, mobile width and console errors. It writes desktop/mobile screenshots under `/tmp`. The API has also been checked against all 28 datasets in the populated live database. The website's read-only checks leave collection history and stored observations unchanged.
