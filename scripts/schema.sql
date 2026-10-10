PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS collection_runs (
    id INTEGER PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    mode TEXT NOT NULL CHECK (mode IN ('download', 'check', 'inventory')),
    status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'skipped', 'failed', 'interrupted')),
    api_url TEXT NOT NULL,
    selected_tables_json TEXT NOT NULL,
    inventory_json TEXT NOT NULL DEFAULT '[]',
    excluded_json TEXT NOT NULL DEFAULT '[]',
    baseline_json TEXT NOT NULL DEFAULT '{}',
    trigger_json TEXT NOT NULL DEFAULT '[]',
    expected_datasets INTEGER NOT NULL DEFAULT 0,
    error TEXT
);

CREATE TABLE IF NOT EXISTS datasets (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    api_url TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dataset_tables (
    id INTEGER PRIMARY KEY,
    dataset_id TEXT NOT NULL REFERENCES datasets(id),
    table_name TEXT NOT NULL UNIQUE,
    schema_sha256 TEXT NOT NULL,
    columns_json TEXT NOT NULL,
    UNIQUE (dataset_id, schema_sha256)
);

CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY,
    dataset_id TEXT NOT NULL REFERENCES datasets(id),
    collection_run_id INTEGER NOT NULL REFERENCES collection_runs(id),
    dataset_table_id INTEGER NOT NULL REFERENCES dataset_tables(id),
    started_at TEXT NOT NULL,
    fetched_at TEXT,
    source_json TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    columns_json TEXT NOT NULL,
    row_count INTEGER NOT NULL DEFAULT 0,
    cell_count INTEGER NOT NULL DEFAULT 0,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    content_sha256 TEXT,
    UNIQUE (collection_run_id, dataset_id)
);

CREATE TABLE IF NOT EXISTS snapshot_chunks (
    snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
    chunk_number INTEGER NOT NULL,
    query_json TEXT NOT NULL,
    comments_json TEXT NOT NULL,
    source_metadata_json TEXT NOT NULL,
    response_sha256 TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, chunk_number)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS snapshots_by_dataset ON snapshots(dataset_id, id DESC);

CREATE VIEW IF NOT EXISTS latest_snapshots AS
SELECT s.* FROM snapshots s
JOIN collection_runs r ON r.id = s.collection_run_id
WHERE r.status = 'complete' AND r.mode = 'download'
AND s.id = (
    SELECT MAX(s2.id) FROM snapshots s2
    JOIN collection_runs r2 ON r2.id = s2.collection_run_id
    WHERE s2.dataset_id = s.dataset_id AND r2.status = 'complete' AND r2.mode = 'download'
);
