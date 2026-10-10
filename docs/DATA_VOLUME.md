# Measured BFS university snapshot size

Measured on 2026-10-10 using `python3 scripts/fetch_bfs.py` against the public BFS PxWeb API. All 28 university-level datasets discovered within the initial student/entrant, degree, staff, and finance catalogs were downloaded successfully. Six national-only tables without a university dimension were inventoried and excluded.

## Actual volume

| Category | Tables | CSV rows | CSV size (MB) | Dataset files including metadata and compressed responses (MB) |
| --- | ---: | ---: | ---: | ---: |
| Enrolled students | 7 | 1,054,816 | 13.65 | 16.98 |
| Bachelor/historical licence-diploma entrants | 4 | 238,620 | 2.88 | 3.68 |
| Degrees | 4 | 1,209,472 | 16.79 | 20.29 |
| Staff | 8 | 397,760 | 6.93 | 8.35 |
| Finances and indicators | 5 | 618,880 | 11.68 | 14.14 |
| **Total** | **28** | **3,519,548** | **51.93** | **63.44** |

MB means 1,000,000 bytes. Exact totals:

- CSV files: 51,930,733 bytes.
- Complete dataset directories: 63,442,072 bytes.
- Entire run, including the top-level inventory and manifest: 63,639,883 bytes, or 63.64 MB.
- Parsed source responses serialized as uncompressed JSON: 165,051,277 bytes. These responses are stored compressed; this is not a measurement of HTTP transfer bytes or an additional on-disk copy.

For scale, keeping 12 full file snapshots would occupy approximately **764 MB (0.76 GB)** at the current volume. The agreed service will check metadata weekly and collect only when new reporting periods or university tables appear, so it will not create a snapshot on every check. New years, categories, or datasets will increase snapshot size. SQLite size depends on the eventual storage representation and indexes; these file measurements do not determine its exact size.

## What was measured

Every published category and period was selected in each included table, covering all source institutions, not just EPFL/ETH. These are complete data cubes, including zeros, missing-value markers, historical categories, and source totals where present. The figures include overlap between separately published tables; they are not counts of distinct people or unique facts across tables.

The CSVs store original category codes and original value strings. Code-to-label dictionaries are retained in each table's metadata. Each dataset also has compressed complete API responses, query selections, provenance, timestamps, source response metadata/comments, and a checksum. There are no database writes or normalized classifications.

Each API query selected at most 100,000 cells. All downloaded response coordinates, chunk sizes, CSV row counts, and CSV checksums were validated. The exported 2025/26 Computer Science entrant counts also agree with the earlier extraction: EPFL 286 and ETHZ 369.

## Files and reproduction

The measured run is stored locally under:

`data/bfs/20261010T193310.288944Z-042835f4/`

Its `manifest.json` contains the full per-table counts, sizes, statuses, and timestamps. `inventory.json` preserves the API schema/catalog entries used in the run. Downloaded snapshots are ignored by Git; the downloader and this report are tracked project files.

To check for new data and download a full snapshot only if needed:

```bash
python3 scripts/fetch_bfs.py
```

The first run in an empty output directory downloads everything. Subsequent runs compare with retained successful snapshots and skip observations if no new reporting periods/tables exist. To repeat the full volume measurement independently, use `--output` with a new empty directory.

To inventory source schemas and expected row counts without downloading observations:

```bash
python3 scripts/fetch_bfs.py --inventory-only
```

The catalog scope is defined by `PREFIXES` and `EXTRA_DATABASES` in `scripts/fetch_bfs.py`. This measurement covers those university catalogs, not every BFS dataset concerning education, universities of applied sciences, teacher-training universities, graduate employment, or related surveys.
