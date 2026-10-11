# Static data publishing for GitHub Pages: exploration

Assessment on 2026-10-11. This document proposes a migration; the current service, collection schedule and database remain unchanged. GitHub Pages serves static HTML/CSS/JavaScript, so the Python `/api/*` endpoints must be replaced for the public site. [GitHub Pages documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages).

## Recommended architecture

```text
BFS → Sunday collector → SQLite snapshots → validated CSV/JSON export
    → Git push → GitHub Actions Pages deployment → browser data loader/aggregator
```

SQLite stays the authoritative local store and snapshot archive. The export is reproducible from successful database snapshots and never requires fetching BFS again. The frontend reads the same static files locally and publicly; the local service continues to own the collection/publishing schedule. Export source rows, rather than every possible filtered/aggregated chart, because the latter grows combinatorially.

Use CSV for observation rows and JSON for the dataset catalog, metadata, snapshot index, aggregation policies, source notes and publication/check status. CSV preserves original dimension codes, column order and raw measure strings, including missing markers. English translations remain a separate versioned dictionary. CSV alone cannot describe the source classifications or allowed summations.

## Measured size and loading strategy

The current database contains 28 successful dataset snapshots and 3,519,548 rows. A read-only measurement serialized every source row as UTF-8 CSV, splitting by dataset and university. It used LF record endings and gzip level 6. The measurement did not modify the database or export data into Git.

| Quantity | Measured size |
| --- | --- |
| All CSV observation files | 51,974,295 bytes (51.97 MB / 49.57 MiB) |
| Same files gzip-compressed | 9,262,077 bytes (9.26 MB / 8.83 MiB) |
| Number of dataset/university files | 452 |
| Largest individual raw CSV | 625,994 bytes |
| Detailed entrants: all universities | 1,291,245 bytes raw / 275,197 bytes gzip |
| Detailed entrants: EPFL | 90,799 bytes raw / 18,281 bytes gzip |
| Detailed entrants: ETH Zurich | 91,563 bytes raw / 19,276 bytes gzip |
| Detailed entrants: Lausanne | 84,297 bytes raw / 19,678 bytes gzip |

These sizes exclude JSON metadata, frontend assets and additional future snapshots. The experiment took approximately 6 seconds, including reading, CSV serialization and gzip compression, but was a sizing experiment rather than a production exporter benchmark. Reproduction script: `/tmp/measure-static-export.py`; results: `/tmp/uni-stats-static-size.json`.

Recommended file layout:

```text
public-data/index.json
public-data/status.json
public-data/snapshots/<snapshot-id>/metadata.json
public-data/snapshots/<snapshot-id>/universities/<university-code>.csv
public-data/snapshots/<snapshot-id>/universities/<university-code>.csv.gz  # optional
```

A metadata manifest maps source codes to file paths; filenames are encoded safely rather than assuming future codes are filename-safe. Load only the selected dataset, snapshot and university shards. All-university selections fetch every shard for that dataset, not all 28 datasets. Retain parsed shards in a bounded cache and perform parsing/aggregation in a Web Worker so the controls remain responsive. Initial browser memory consumption must be measured: CSV transfer size is not equivalent to parsed JavaScript memory use.

Raw CSV is sufficient to start, given the small per-university files. Gzip is an optional improvement; if shipping `.csv.gz`, explicitly decompress it in JavaScript and feature-detect support, rather than assuming Pages sets a Content-Encoding header for that filename. The [Compression Standard](https://compression.spec.whatwg.org/) defines gzip `DecompressionStream`; a raw CSV fallback avoids requiring it.

GitHub documents a 1 GB published-site limit and a soft 100 GB/month bandwidth limit. The current export fits comfortably, but preserving many full snapshots publicly will grow the site. [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits). Preserve all successful snapshots in SQLite; initially export all snapshots needed by the existing public snapshot selector. If publication size later becomes an issue, agree a retention/archive policy explicitly rather than silently dropping older choices.

## Preserving frontend behavior

Introduce a data-provider module with catalog, dataset-details, series and update-status methods. Replace `api()` calls with that provider. Its static implementation fetches metadata/CSV and produces the same result structures currently supplied by `Explorer`, including university and subject components. Keeping those structures lets the existing chart, tooltip, sorting, normalization and percentage code remain largely intact.

The work is primarily migrating the Python query/aggregation logic into a browser worker. It must preserve:

- All source datasets, dimensions, categories and measure columns.
- Reviewed additive/published-total policies; totals must not be added to their component categories.
- Exact raw strings and decimal addition before converting to plotting numbers.
- Missing markers and absent coordinates: incomplete sums remain gaps, not partial counts.
- Unknown gender/nationality categories and existing percentage denominators.
- Snapshot-specific metadata, source references, comments and historical snapshot selection.
- University/subject stacks and the current latest-displayed-year ranking.

Resolve every asset/data URL relative to the deployed site base. The current leading-slash asset and API paths will break at the project-site path `/uni-stats/` unless adapted. Test both `/` and `/uni-stats/` using a plain static HTTP server with no Python API.

Do not promise a speed improvement from this migration without browser benchmarks. Lazy loading/caching should make common selections modest, but All selections and first loads must be measured on a slower device too. Existing Python queries provide a useful correctness reference during the migration.

## Collection, publishing and failures

After a successful collection, export into a staging directory using one consistent read transaction. Validate row counts, checksums, metadata references and manifest completeness, then publish the completed export together. Give immutable snapshot files stable paths and deterministic contents/order; only the small index/status files need to change on a metadata-only check. No partial export should become the public dataset.

The weekly service should track collection and publication separately. If SQLite collection succeeds but exporting, pushing or Pages deployment fails, retain the successful snapshot and retry publication from it. A later source check that skips downloads must not cause pending publication to be forgotten. The service needs non-interactive GitHub credentials for publishing; an interactive SSH agent is not a reliable boot-service dependency.

A public static site cannot query the local worker's current health. Publish a small status JSON after every check, including failures and unchanged-data skips. Display its report timestamp, last successful check, latest published snapshot and expected next check. If reports stop arriving beyond a grace period, show an overdue-status warning in the browser. Do not present an exported `worker_active` flag as live health. If pushing itself fails, the public site may only learn that something is wrong through that overdue warning; local service logs/status remain the immediate diagnosis.

Keep a Pages workflow triggered by pushes that include the public export/assets. It uploads and deploys one validated static site artifact. [GitHub Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages). Publishing status-only updates is lightweight. Automated data pushes should be isolated from unrelated working-tree edits, for example through a dedicated publishing checkout/branch, and never commit arbitrary local files.

## Suggested implementation sequence

1. Build a deterministic exporter and verify every exported observation and metadata dictionary against SQLite.
2. Implement the static data provider/worker, preserving current query output structures; test it against Python results for all 28 datasets and key aggregation/missing-value cases.
3. Serve the frontend entirely from files locally, at both root and project subpaths; benchmark typical selections and All-subject/university stacks.
4. Add a Pages build/deploy workflow and an initial static publication.
5. Connect validated exports and publication retries to the Sunday worker; publish timestamped status even when no observations change.

This is a moderate migration, not just replacing an endpoint with a CSV URL. The source data volume is manageable; correctness of client-side aggregation, publication recovery and static status semantics are the main implementation concerns.
