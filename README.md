# Swiss university statistics

Collect historical Swiss university statistics from the Swiss Federal Statistical Office (BFS/OFS/FSO), retain timestamped snapshots in SQLite, and explore them through an interactive website.

[PLAN.md](PLAN.md) is the authoritative project plan. [docs/DATABASE.md](docs/DATABASE.md) describes the implemented schema and transaction behavior.

## Original data

[EPFL Stats.xlsx](EPFL%20Stats.xlsx) is the original, manually collected workbook supplied by the user, preserved unchanged. Superseded exploratory fetchers remain in Git history.

## Current state

The fetcher checks metadata and stores complete snapshots directly in SQLite only when a new reporting period or university table appears. CSV/file-export output has been removed. The frontend and weekly service have not been implemented.

The first file-based measurement covered 28 tables and 3,519,548 rows. See [the volume report](docs/DATA_VOLUME.md) for measurements and scope.

The live SQLite import contains those 28 datasets and 3,519,548 rows, occupying about 79.4 MiB immediately after import. All values and source metadata matched the earlier export before that obsolete directory was removed. An immediate second live run checked all 28 tables and skipped fetching without adding snapshots. SQLite integrity, foreign keys, all stored-content checksums and 23 offline tests passed.

## Collect BFS university data

Requires Python 3.10+ on Linux/macOS; no third-party packages or API credentials.

```bash
python3 scripts/fetch_bfs.py
```

The default database is `data/university_stats.sqlite3`, excluded from Git. The first run downloads all tables in the configured university students/entrants, degrees, staff and finance catalogs that have a university dimension. It includes all years/categories, not just EPFL/ETH, and preserves overlapping source datasets separately.

Subsequent runs compare reporting-period labels and table IDs with the latest fully successful database snapshots. Additions trigger a complete snapshot within the requested scope. With no additions, the run is recorded as `skipped` and issues no observation queries. Existing-value revisions, update timestamps and non-time category changes do not trigger fetching; new snapshots include intervening revisions.

Options:

```bash
# Record the new-data decision, without fetching observations.
python3 scripts/fetch_bfs.py --check-only

# Record the catalog/schema and coverage only.
python3 scripts/fetch_bfs.py --inventory-only

# Collect a selected table into a separate test database.
python3 scripts/fetch_bfs.py --table px-x-1502040100_123 --max-cells 25000 --database /tmp/bfs-test.sqlite3
```

The query cap is 100,000 cells and requests are spaced at least 0.4 seconds apart. Temporary HTTP/network failures are retried. A lock beside the database prevents overlapping collectors.

## Storage guarantees

- One source-shaped observation table per dataset/structural version, with source dimensions and value strings stored as TEXT.
- Timestamped snapshots retain category dictionaries, units, source comments, query selections, provenance, counts and checksums.
- Every requested dataset commits together. A failed/interrupted collection publishes no partial snapshots and leaves the previous successful baseline available.
- WAL mode allows readers to use committed data while collection runs.
- Metadata-only runs never advance collection baselines. After a process crash, the next locked invocation records the abandoned run as interrupted.

Skipped and successful commands exit zero; failures exit nonzero. Unknown time schemas fail explicitly. No universal institution/subject mapping or numeric coercion is imposed in storage.

## Verification

```bash
python3 -m unittest discover -s tests -v
python3 scripts/verify_database.py
```

Tests exercise discovery through a synthetic API, direct SQLite imports, retained snapshots, skipped fetches, complete-collection rollback, concurrent readers, schema changes, process recovery and the CLI. The read-only verifier checks every published snapshot's counts and stored-value checksum, complete collection coverage, SQLite integrity and foreign keys.
