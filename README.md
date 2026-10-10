# Swiss university statistics

Collect historical Swiss university statistics from the Swiss Federal Statistical Office (BFS/OFS/FSO), retain timestamped snapshots in SQLite, and explore them through an interactive website.

[PLAN.md](PLAN.md) is the authoritative project plan: scope, agreed decisions, implementation stages, and source references.

## Original data

[EPFL Stats.xlsx](EPFL%20Stats.xlsx) is the original, manually collected workbook supplied by the user. It is preserved unchanged as reference material.

## Current state

The exploratory Tableau and annual-report fetchers, their generated CSVs, and their obsolete dependency have been removed. Their previous versions remain in Git history.

The BFS downloader exports full snapshots to files. Database storage, the website, and the service have not been implemented.

The first full download contains **28 tables and 3,519,548 rows**, occupying **51.93 MB of CSVs** and **63.64 MB for the complete snapshot directory**. See [the measured volume report](docs/DATA_VOLUME.md) for scope and category breakdown.

## Download BFS university data

Requires Python 3.10+ on Linux/macOS; no third-party packages or API credentials.

```bash
python3 scripts/fetch_bfs.py
```

By default, the script discovers tables in the BFS university students/entrants, degrees, staff, and finance catalogs, and includes those with a university dimension. It downloads all categories and years, including source totals and historical institutions where published. It does not filter to EPFL/ETH or deduplicate observations between overlapping tables.

Each run creates a unique UTC timestamped directory under `data/bfs/`, which is excluded from Git. Options:

```bash
# Metadata and expected row counts only.
python3 scripts/fetch_bfs.py --inventory-only

# One table, with smaller API queries, to a chosen output directory.
python3 scripts/fetch_bfs.py --table px-x-1502040100_123 --max-cells 25000 --output /tmp/bfs-snapshots
```

The default query cap is 100,000 cells and requests are spaced at least 0.4 seconds apart. Temporary failures are retried. A filesystem lock prevents simultaneous runs using the same output directory.

## Snapshot files

Each run contains `inventory.json` and `manifest.json`. The manifest records per-table success/failure, row counts, timestamps, source catalog update dates, CSV size, uncompressed response JSON size, and actual dataset file size.

Each successfully downloaded table has its own directory:

- `data.csv`: source dimension codes and source value strings, with source column names. Codes, leading zeroes, zero values, decimal values, and missing-value markers are preserved. CSV readers should treat categories as strings.
- `metadata.json`: the full source schema and code-to-label dictionaries. Use these to interpret codes; university codes differ across tables.
- `source.json`: API location and catalog entry, including the catalog title/update timestamp.
- `response_metadata.json`: response columns, source metadata, and comments from every chunk.
- `responses/*.query.json` and `responses/*.json.gz`: exact selections and the complete parsed source responses, stored as compressed JSON.
- `snapshot.json`: per-table timestamps, counts, sizes, and CSV SHA-256.

Rows represent all published category combinations, including zeroes and missing values, rather than only nonzero observations. Size estimates sum overlapping tables as separate source datasets.

The script publishes a table directory only after all chunks are validated. Failed tables remain under `.partial` directories and are listed as failed in the run manifest; the command exits nonzero if any collection fails. A run may therefore contain both complete tables and failed partial tables. Previous runs are never overwritten. This is a file exporter, with no database writes, scheduler, or revision detection.

## Verification

```bash
python3 -m unittest discover -s tests -v
```
