# SQLite snapshot storage

The agreed storage model is implemented in `scripts/schema.sql` and `scripts/bfs_store.py`. The default database is `data/university_stats.sqlite3`. Python's standard-library SQLite driver is the only dependency; `PRAGMA user_version = 1` identifies this schema version.

## Tables

| Table/view | Contents |
| --- | --- |
| `collection_runs` | Check/fetch timestamps, requested scope, source inventory, excluded tables, baseline snapshot IDs, new-data triggers, status and error |
| `datasets` | BFS dataset ID, latest successfully collected title and API URL |
| `dataset_tables` | Dataset-specific physical table name, source column definitions and structural fingerprint |
| `snapshots` | Dataset/run/table-version IDs, source metadata and provenance, original response columns, fetch timestamps, row/cell/chunk counts and content checksum |
| `snapshot_chunks` | Original API selection, source comments and response metadata (including units), plus response checksum for each chunk |
| `bfs_*` | Source-shaped observations: `snapshot_id` plus the original source dimension/value columns |
| `latest_snapshots` | Latest snapshot for each dataset from fully successful download runs |

Source columns are quoted SQL identifiers and retain their names. All source codes and values are `TEXT NOT NULL`, so `01`, `0`, `1.25` and `..` remain distinct strings. Snapshot metadata contains the exact category codes, labels and time flags; codes are local to that snapshot's dataset. No cross-university classification, numeric coercion or derived metrics are stored.

Each observation table has a composite primary key `(snapshot_id, <all dimension columns>)` and uses `WITHOUT ROWID`. This prevents duplicate coordinates and supports snapshot/period filtering without a redundant row ID index. Other indexes can be added when frontend query patterns are known. The database's bookkeeping tables have foreign keys; the importer enables enforcement on every connection.

Adding years/category values reuses the same physical table. Changing source column names, order or dimension/measure roles creates another physical table registered in `dataset_tables`; old snapshots and their metadata remain readable. Physical names are generated from dataset/schema hashes, rather than interpolated source names. A collision with the reserved observation column `snapshot_id`, ambiguous column names or a missing/unrecognized time dimension fails explicitly.

## Collection and publication

The importer persists a `running` collection record and its metadata check before downloading observations. When a new reporting-period label or uncollected table appears, it starts one SQLite transaction for **all requested datasets**. It validates every chunk, imports observations, records source metadata, and checks the final table row counts. Snapshots and the run's `complete` status commit together.

If any table fails, all snapshots, observations, dataset updates and schema versions from that collection roll back. The run becomes `failed` with an error, and the old successful baseline remains. A caught interrupt is recorded as `interrupted`. Following a process crash, SQLite discards the uncommitted transaction; the next locked CLI invocation marks leftover `running` records as interrupted.

WAL mode lets readers keep using the previous committed collection during ingestion. A filesystem lock beside the resolved database path prevents overlapping collectors. The CLI and any future background worker must use this same lock/lifecycle. Existing snapshots are immutable through the importer: it only inserts new snapshot data, and sets counts/checksums before publication.

Skipped/check-only/inventory-only runs record their metadata and outcome but create no snapshots and never advance baselines. A removed period, changed update timestamp, changed observation or new non-time category does not trigger collection. Historical period additions do. A complete snapshot triggered by an addition also includes any intervening revisions.

## Integrity and checksums

`snapshots.content_sha256` hashes source rows in source-column order, sorted lexicographically by all dimension codes using SQLite's default binary collation. Each row is compact UTF-8 JSON with `ensure_ascii=False` followed by one newline. It includes raw values and codes without conversion. Chunk checksums hash the entire parsed source response as compact UTF-8 JSON. Data responses are not also retained as compressed files or duplicated payloads in SQLite: their values live in observation tables and their descriptive metadata lives in `snapshot_chunks`.

Run with:

```bash
python3 scripts/fetch_bfs.py
python3 scripts/fetch_bfs.py --check-only
python3 scripts/fetch_bfs.py --table px-x-1502040100_123 --database /tmp/bfs-test.sqlite3
python3 -m unittest discover -s tests -v
python3 scripts/verify_database.py
```

Find the latest source table and its code dictionaries through `latest_snapshots` and `dataset_tables`:

```sql
SELECT s.id AS snapshot_id, s.dataset_id, t.table_name,
       s.metadata_json, s.columns_json, s.row_count, s.fetched_at
FROM latest_snapshots s
JOIN dataset_tables t ON t.id = s.dataset_table_id;
```

Use the returned table name and quoted source column names to filter its rows by `snapshot_id`. Frontend code must resolve category codes from that snapshot's metadata and handle missing markers before converting values to numbers.

Snapshots and the database are local generated data, excluded from Git. The original `EPFL Stats.xlsx` is preserved. CSV output and the `--output` option have been removed; old file snapshots are not used for database baselines.

The automatic website worker adds an auxiliary `update_schedule` singleton table on activation. It stores the next weekly deadline, retry deadline, last attempt/success/result/error, failure count and running flag. This additive extension does not alter BFS source tables or immutable snapshots and remains compatible with schema version 1/manual collection. Read-only API status also derives the latest check and snapshot timestamps from existing collection records. A separate `.schedule.lock` file prevents duplicate worker processes; `.fetch.lock` remains the collection lock.
