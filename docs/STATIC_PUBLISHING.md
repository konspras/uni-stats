# Static CSV publishing

Implemented on 2026-10-11. SQLite remains the authoritative archive. The default frontend reads the **latest successful report only** from static CSV/JSON files. The local service advertises its backend through `backend.json`; a data-source selector beside the header status enables the existing database API and historical snapshot picker. A selection persists within the browser tab; new tabs default to CSV. GitHub Pages never probes localhost or requires a backend.

## Data layout and query behavior

```text
web/data/index.json                              # atomic release pointer + timestamped status
web/data/releases/v1-<snapshot-set-hash>/manifest.json
web/data/releases/v1-<snapshot-set-hash>/<dataset>/metadata.json
web/data/releases/v1-<snapshot-set-hash>/<dataset>/<university-index>.csv
web/data/releases/v1-<snapshot-set-hash>/<dataset>/<university-index>.csv.gz
web/data/releases/v1-<snapshot-set-hash>/<dataset>/<university-index>-totals.csv[.gz]
```

CSV headers, original category codes, measure strings and missing markers round-trip unchanged. Metadata contains original source definitions, comments, dictionaries and reviewed aggregation policies. Filenames use indexes; dataset-local university codes are mapped explicitly in metadata, never assumed universal. Raw files include **every source observation**, so all existing selectors/comparisons/stacks remain available. The public metadata exposes only the exported latest snapshot; SQLite retains history.

For reviewed additive subject tables, additional per-university files precompute All-subject totals for each remaining coordinate. Their weight and per-measure missing-component columns preserve incomplete sums. Queries use these files only for All-subject filters without subject comparison/breakdown; detailed queries use the original rows. No other source classifications are changed.

`web/data-provider.js` supplies the existing response shapes. `web/static-worker.js` fetches at most four university shards concurrently, explicitly decompresses `.csv.gz` with `DecompressionStream`, parses CSV and aggregates away from the main UI thread. Browsers without gzip streaming load raw CSV. Length and SHA-256 checks protect responses; SHA verification requires a secure context (HTTPS or localhost). Parsed-file LRU cache is limited to 8 MiB of source text; JS object memory is larger. Only the selected dataset/universities are loaded. Decimal sums use integer decimal arithmetic before conversion to plotting numbers, and missing components remain gaps.

All URLs are relative to the site base, including `/uni-stats/`. `web/backend.json` declares no backend in the static build; the local Python service overrides that response. The database itself is never exposed as an HTTP file. The service's public-file whitelist allows only frontend assets and confined exported-data paths.

## Export, publication and schedule

```bash
python3 scripts/export_static.py
python3 scripts/verify_static.py
# Queue an immediate export/push in the active service, without fetching BFS:
python3 publication.py --queue
python3 publication.py --status
```

The exporter pins dataset snapshot IDs from a consistent catalog, validates every CSV cell's round trip and source row count, writes an immutable release, then atomically replaces the index. Unchanged snapshot exports reuse and verify existing files; a metadata-only status export took **0.22 seconds** locally. Change the export format version whenever immutable output logic changes. Failed export leaves the prior index usable. Local old releases may remain so already-open pages can finish requests; only the current release enters each publication.

The installed `uni-stats.service` uses `--scheduled-updates --publish-static`:

1. Sunday 15:00 Europe/Zurich: the existing collector checks metadata. New tables/reporting periods trigger a complete SQLite snapshot; otherwise no observation download occurs.
2. Successful, skipped and failed checks queue a timestamped public report, using the last successful data where necessary.
3. The publisher exports from SQLite and pushes the frontend/report to `gh-pages` in a dedicated, ignored `data/publishing/` checkout. It includes only **committed frontend assets** and validated generated data, with no SQLite files or unrelated working-tree edits. It never force-pushes. The development branch remains separate.
4. Failed export/push remains pending and retries after 1, 2, 4, 8, 16 and at most 24 hours. Publication retries run independently of the Sunday collection schedule and do not fetch BFS again. Pending/error state survives service restarts in `publication_state`. The worker polls deadlines every 30 seconds.

The local status dropdown reads live worker and push status even while charts use CSVs: last successful push, pending/running, retry time and actual errors. The public site shows the **report timestamp**, last check and exported snapshot; it never claims a live worker is active. If pushing or Pages deployment fails, the public site retains its older report. No email notifications are configured. A Git push success does not itself verify GitHub's deployment job; GitHub Actions reports deployment outcomes.

## GitHub Pages activation

The generated `gh-pages` branch contains the entire ready-to-serve site at its root, plus `.nojekyll`. In [repository Pages settings](https://github.com/konspras/uni-stats/settings/pages), choose **Deploy from a branch → gh-pages → /(root)** and Save. Subsequent worker pushes update that publishing branch automatically. GitHub documents this branch-publishing flow in [its configuration instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

Git pushes use existing non-interactive SSH credentials (`BatchMode=yes`) with interactive prompting disabled. Publication errors appear on the local site if those credentials stop working. Repository Pages settings require administrator access through a browser or an authenticated API; an SSH Git key alone cannot change those settings.

## Validation and measured responsiveness

On the current collection:

| Measurement | Result |
| --- | --- |
| Source datasets / rows | 28 / 3,519,548 |
| Source university shards | 452 |
| Files including precomputed totals | 775 raw CSVs + gzip copies |
| All raw CSVs including totals | 55,043,793 bytes |
| All gzip files including totals | 9,683,719 bytes |
| Largest individual compressed CSV | 101,311 bytes (583,899 bytes raw) |
| Largest dataset selection | 16 files / 1,477,705 bytes gzip / 9,562,836 bytes raw |
| Entrants, all universities, detailed subjects | 275,197 bytes gzip |
| Entrants, all universities, All-subject totals | 8,956 bytes gzip |

Largest individual raw CSV is 625,994 bytes; it differs from the file with the largest compressed size. Sizes above exclude small JSON/frontend requests. The largest dataset selection is degrees by qualification level, detailed subject, gender and university. The browser loads the 16 constituent shards; there is no single full-collection download.

`verify_static.py` independently compared every exported source cell against SQLite and ran **339 real-data parity queries** touching all 775 files. The exhaustive small-cube tests add **204 combinations**, with missing observations, nonnumeric markers, unknown gender, exact decimals, all filters, subject stacks, batched universities and a second snapshot. A separate test checks published totals. Tests also simulate push failure/restart/retry with no recollection and a real push to a temporary bare Git repository, proving checkout isolation and latest-release-only publication.

`tests/browser_static.mjs` runs against a plain HTTP file server under `/uni-stats/`, without any API, and opens all 28 datasets. Headless Chromium on this machine, cold worker/file loads:

| Browser operation | Elapsed |
| --- | --- |
| Initial CS entrants pyramid | ~0.10 s |
| Entrants All-subject totals, all universities | ~0.06 s |
| Entrants subject stacks, all universities | ~0.64 s |
| Largest degrees subject-stack selection | ~0.86 s |

These are local-loopback timings, not simulated internet/mobile measurements. Network download time must be added for remote hosting. The query engine's heaviest measured real-data query was ~0.98 seconds in Node; browser aggregation remains in a worker so controls can respond during computation.

```bash
python3 -m unittest discover -s tests -v
python3 scripts/verify_static.py
# Isolated Chromium with CDP enabled, plus a plain server serving web/ at /uni-stats/:
node tests/browser_static.mjs
# Local scheduled service, with an available database:
node tests/browser_smoke.mjs
```

## Activation result

On 2026-10-11 the permanent service successfully pushed its initial `gh-pages` report using its own environment, with collection counts unchanged at 2 runs / 28 snapshots. The next source check remains Sunday 18 October at 15:00 Zurich. All 51 Python tests, pure-JS chart tests, static-only browser checks and the permanent-service browser suite (including CSV/database parity, snapshot enablement, selection preservation and mobile layout) passed. A fully cold largest-selection download fetched exactly 16 gzip files totaling 1,477,705 bytes in the browser.

GitHub Pages returned HTTP 404 after the branch push. Pages activation remains a one-time repository setting described above; the available Git SSH access can push branches but cannot change repository Pages settings. The public site is not yet confirmed live.
