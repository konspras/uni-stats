# Measured BFS university snapshot and database sizes

The initial CSV exporter was measured on 2026-10-10 using `python3 scripts/fetch_bfs.py` against the public BFS PxWeb API, before that command was changed to write SQLite. All 28 university-level datasets discovered within the initial student/entrant, degree, staff, and finance catalogs were downloaded successfully. Six national-only tables without a university dimension were inventoried and excluded.

## Historical file-export volume

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

For scale, keeping 12 full file snapshots would occupy approximately **764 MB (0.76 GB)** at the current volume. The agreed service will check metadata weekly and collect only when new reporting periods or university tables appear, so it will not create a snapshot on every check. New years, categories, or datasets will increase snapshot size. The subsequent SQLite implementation was measured separately below.

## What was measured

Every published category and period was selected in each included table, covering all source institutions, not just EPFL/ETH. These are complete data cubes, including zeros, missing-value markers, historical categories, and source totals where present. The figures include overlap between separately published tables; they are not counts of distinct people or unique facts across tables.

The CSVs stored original category codes and original value strings. Code-to-label dictionaries are retained in each table's metadata. Each dataset also had compressed complete API responses, query selections, provenance, timestamps, source response metadata/comments, and a checksum. That exporter had no database writes or normalized classifications.

Each API query selected at most 100,000 cells. All downloaded response coordinates, chunk sizes, CSV row counts, and CSV checksums were validated. The exported 2025/26 Computer Science entrant counts also agree with the earlier extraction: EPFL 286 and ETHZ 369.

## SQLite import measurement

The replacement importer fetched all 28 datasets directly from BFS into SQLite, storing **3,519,548 source rows** in 28 source-shaped observation tables. Immediately after the first complete import, the database occupied **83,202,048 bytes (83.20 MB / 79.35 MiB)**, including its metadata, provenance, query records and primary-key indexes. This is a live measurement, not an estimate from the CSV size.

All source-row checksums and snapshot metadata matched the earlier exports across every dataset. The read-only verifier passed SQLite integrity/foreign-key checks, collection completeness, source row/cell/chunk counts and every stored-content checksum.

Subsequent metadata checks add run history but do not duplicate observations unless an addition triggers a new snapshot. Additional snapshots, metadata-check records and future frontend indexes will increase the database size. WAL files can temporarily occupy additional disk space while collection is active.

## Files and reproduction

The historical export was under `data/bfs/20261010T193310.288944Z-042835f4/`. After the live SQLite import was fully compared against it, the obsolete `data/bfs/` directory was removed at the user's request. The original workbook remains unchanged.

Current generated data live in `data/university_stats.sqlite3`, excluded from Git. The default command checks the database baseline and collects only when new periods/tables appear; an empty database performs a full initial import:

```bash
python3 scripts/fetch_bfs.py
python3 scripts/verify_database.py
```

To repeat the full import measurement independently, pass `--database` pointing to a new database. Use `--inventory-only` for metadata-only catalog coverage or `--check-only` for the collection decision without observation downloads.

The catalog scope is defined by `PREFIXES` and `EXTRA_DATABASES` in `scripts/fetch_bfs.py`. This measurement covers those university catalogs, not every BFS dataset concerning education, universities of applied sciences, teacher-training universities, graduate employment, or related surveys.
