"""SQLite storage for source-shaped, immutable BFS collection snapshots."""

import hashlib
import json
from pathlib import Path
import sqlite3


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def identifier(value):
    """Quote source column names as SQL identifiers, never SQL fragments."""
    if not isinstance(value, str) or not value or '\x00' in value:
        raise ValueError('invalid source column identifier')
    return '"' + value.replace('"', '""') + '"'


def row_digest(rows):
    digest = hashlib.sha256()
    for row in rows:
        digest.update((encode(list(row)) + '\n').encode('utf-8'))
    return digest.hexdigest()


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute('PRAGMA foreign_keys = ON')
        self.connection.execute('PRAGMA journal_mode = WAL')
        self.connection.execute('PRAGMA synchronous = FULL')
        version = self.connection.execute('PRAGMA user_version').fetchone()[0]
        if version not in (0, 1):
            self.close()
            raise ValueError(f'unsupported database schema version: {version}')
        self.connection.executescript(Path(__file__).with_name('schema.sql').read_text())
        self.connection.execute('PRAGMA user_version = 1')

    def close(self):
        self.connection.close()

    def recover_runs(self, timestamp):
        # Called only while holding the process lock: any running run is stale.
        self.connection.execute("UPDATE collection_runs SET status='interrupted', finished_at=?, "
                                "error='Previous process stopped before completing collection' "
                                "WHERE status='running'", (timestamp,))

    def start_run(self, timestamp, mode, api, selected):
        return self.connection.execute(
            'INSERT INTO collection_runs (started_at, mode, status, api_url, selected_tables_json) '
            "VALUES (?, ?, 'running', ?, ?)", (timestamp, mode, api, encode(selected))).lastrowid

    def record_check(self, run_id, inventory, excluded, baselines, reasons):
        self.connection.execute('UPDATE collection_runs SET inventory_json=?, excluded_json=?, '
                                'baseline_json=?, trigger_json=?, expected_datasets=? WHERE id=?',
                                (encode(inventory), encode(excluded), encode(baselines), encode(reasons),
                                 len(inventory), run_id))

    def finish_run(self, run_id, status, timestamp, error=None):
        self.connection.execute('UPDATE collection_runs SET status=?, finished_at=?, error=? WHERE id=?',
                                (status, timestamp, error, run_id))

    def baselines(self):
        return {r['dataset_id']: {'metadata': json.loads(r['metadata_json']), 'snapshot': r['id']}
                for r in self.connection.execute('SELECT * FROM latest_snapshots')}

    def begin(self):
        self.connection.execute('BEGIN IMMEDIATE')

    def commit(self):
        self.connection.execute('COMMIT')

    def rollback(self):
        if self.connection.in_transaction:
            self.connection.execute('ROLLBACK')

    def create_snapshot(self, table, columns, run_id, timestamp):
        names = [c['code'] for c in columns]
        dimensions = [c['code'] for c in columns if c['type'] != 'c']
        # SQLite column names are case-insensitive; refuse ambiguous schemas.
        if len({n.casefold() for n in names}) != len(names) or 'snapshot_id' in {n.casefold() for n in names}:
            raise ValueError('duplicate or reserved source column names')
        if not dimensions:
            raise ValueError('source table has no dimensions')
        for name in names:
            identifier(name)
        shape = [{'code': c['code'], 'type': c['type']} for c in columns]
        signature = hashlib.sha256(encode(shape).encode()).hexdigest()
        self.connection.execute('INSERT INTO datasets VALUES (?, ?, ?) ON CONFLICT(id) '
                                'DO UPDATE SET title=excluded.title, api_url=excluded.api_url',
                                (table['table_id'], table['metadata']['title'], table['api_url']))
        version = self.connection.execute('SELECT * FROM dataset_tables WHERE dataset_id=? AND schema_sha256=?',
                                          (table['table_id'], signature)).fetchone()
        if version is None:
            table_name = 'bfs_' + hashlib.sha256(table['table_id'].encode()).hexdigest()[:16] + '_' + signature[:16]
            columns_sql = ', '.join(identifier(n) + ' TEXT NOT NULL' for n in names)
            key_sql = ', '.join(['snapshot_id'] + [identifier(n) for n in dimensions])
            self.connection.execute(f'CREATE TABLE {identifier(table_name)} ('
                                    'snapshot_id INTEGER NOT NULL REFERENCES snapshots(id), '
                                    f'{columns_sql}, PRIMARY KEY ({key_sql})) WITHOUT ROWID')
            version_id = self.connection.execute('INSERT INTO dataset_tables '
                                                 '(dataset_id, table_name, schema_sha256, columns_json) '
                                                 'VALUES (?, ?, ?, ?)',
                                                 (table['table_id'], table_name, signature, encode(shape))).lastrowid
        else:
            table_name, version_id = version['table_name'], version['id']
        snapshot_id = self.connection.execute('INSERT INTO snapshots '
            '(dataset_id, collection_run_id, dataset_table_id, started_at, source_json, metadata_json, columns_json) '
            'VALUES (?, ?, ?, ?, ?, ?, ?)',
            (table['table_id'], run_id, version_id, timestamp,
             encode({k: v for k, v in table.items() if k != 'metadata'}), encode(table['metadata']),
             encode(columns))).lastrowid
        return snapshot_id, table_name

    def insert_chunk(self, snapshot_id, table_name, columns, number, query, response):
        names = [c['code'] for c in columns]
        placeholders = ','.join('?' for _ in range(len(names) + 1))
        # PxWeb keys/values follow their respective dimension/measure order.
        dimensions = [c for c in columns if c['type'] != 'c']
        measures = [c for c in columns if c['type'] == 'c']
        def rows():
            for row in response['data']:
                values = dict(zip([c['code'] for c in dimensions], row['key']))
                values.update(zip([c['code'] for c in measures], row['values']))
                yield (snapshot_id, *(values[name] for name in names))
        self.connection.executemany(f'INSERT INTO {identifier(table_name)} '
            f'(snapshot_id, {", ".join(identifier(n) for n in names)}) VALUES ({placeholders})', rows())
        digest = hashlib.sha256(encode(response).encode()).hexdigest()
        self.connection.execute('INSERT INTO snapshot_chunks VALUES (?, ?, ?, ?, ?, ?)',
                                (snapshot_id, number, encode(query), encode(response.get('comments', [])),
                                 encode(response.get('metadata', [])), digest))

    def finish_snapshot(self, snapshot_id, table_name, columns, expected, timestamp, chunks):
        row_count = self.connection.execute(f'SELECT COUNT(*) FROM {identifier(table_name)} WHERE snapshot_id=?',
                                             (snapshot_id,)).fetchone()[0]
        if row_count != expected:
            raise ValueError(f'incomplete dataset: {row_count} rows, expected {expected}')
        selected = ', '.join(identifier(c['code']) for c in columns)
        ordering = ', '.join(identifier(c['code']) for c in columns if c['type'] != 'c')
        rows = self.connection.execute(f'SELECT {selected} FROM {identifier(table_name)} '
                                        f'WHERE snapshot_id=? ORDER BY {ordering}', (snapshot_id,))
        digest = row_digest(rows)
        cells = row_count * sum(c['type'] == 'c' for c in columns)
        self.connection.execute('UPDATE snapshots SET fetched_at=?, row_count=?, cell_count=?, '
                                'chunk_count=?, content_sha256=? WHERE id=?',
                                (timestamp, row_count, cells, chunks, digest, snapshot_id))
        return {'snapshot_id': snapshot_id, 'rows': row_count, 'cells': cells,
                'chunks': chunks, 'content_sha256': digest}
