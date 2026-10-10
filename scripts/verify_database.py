#!/usr/bin/env python3
"""Verify published snapshot contents and SQLite integrity without modifying data."""

import argparse
import json
import math
from pathlib import Path
import sqlite3
from urllib.parse import quote

from bfs_store import identifier, row_digest


def verify(path):
    path = Path(path).resolve()
    connection = sqlite3.connect('file:' + quote(str(path), safe='/') + '?mode=ro', uri=True)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute('BEGIN')
        if [r[0] for r in connection.execute('PRAGMA integrity_check')] != ['ok']:
            raise ValueError('SQLite integrity check failed')
        if connection.execute('PRAGMA foreign_key_check').fetchall():
            raise ValueError('foreign key check failed')
        if connection.execute('SELECT COUNT(*) FROM snapshots s JOIN collection_runs r '
                              "ON r.id=s.collection_run_id WHERE r.status!='complete' OR r.mode!='download'").fetchone()[0]:
            raise ValueError('unpublished snapshot data present')
        for run in connection.execute("SELECT * FROM collection_runs WHERE status='complete' AND mode='download'"):
            count = connection.execute('SELECT COUNT(*) FROM snapshots WHERE collection_run_id=?', (run['id'],)).fetchone()[0]
            if count != run['expected_datasets']:
                raise ValueError(f"run {run['id']}: incomplete collection")
        snapshots = connection.execute('SELECT s.*, t.table_name, t.columns_json AS shape_json, '
                                      't.dataset_id AS version_dataset FROM snapshots s '
                                      'JOIN dataset_tables t ON t.id=s.dataset_table_id').fetchall()
        rows_total, cells_total = 0, 0
        for snapshot in snapshots:
            columns = json.loads(snapshot['columns_json'])
            shape = [{'code': c['code'], 'type': c['type']} for c in columns]
            if shape != json.loads(snapshot['shape_json']) or snapshot['version_dataset'] != snapshot['dataset_id']:
                raise ValueError(f"snapshot {snapshot['id']}: wrong structural version")
            table = identifier(snapshot['table_name'])
            names = ', '.join(identifier(c['code']) for c in columns)
            order = ', '.join(identifier(c['code']) for c in columns if c['type'] != 'c')
            expected = math.prod(len(v['values']) for v in json.loads(snapshot['metadata_json'])['variables'])
            actual = connection.execute(f'SELECT COUNT(*) FROM {table} WHERE snapshot_id=?', (snapshot['id'],)).fetchone()[0]
            chunks = connection.execute('SELECT COUNT(*) FROM snapshot_chunks WHERE snapshot_id=?', (snapshot['id'],)).fetchone()[0]
            if actual != expected or actual != snapshot['row_count'] or chunks != snapshot['chunk_count']:
                raise ValueError(f"snapshot {snapshot['id']}: row/chunk count mismatch")
            cells = actual * sum(c['type'] == 'c' for c in columns)
            if cells != snapshot['cell_count']:
                raise ValueError(f"snapshot {snapshot['id']}: cell count mismatch")
            rows = connection.execute(f'SELECT {names} FROM {table} WHERE snapshot_id=? ORDER BY {order}', (snapshot['id'],))
            if row_digest(rows) != snapshot['content_sha256']:
                raise ValueError(f"snapshot {snapshot['id']}: content checksum mismatch")
            rows_total += actual
            cells_total += cells
        return {'integrity': 'ok', 'datasets': connection.execute('SELECT COUNT(*) FROM datasets').fetchone()[0],
                'snapshots': len(snapshots), 'rows': rows_total, 'cells': cells_total,
                'database_bytes': path.stat().st_size}
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path,
                        default=Path(__file__).resolve().parents[1] / 'data/university_stats.sqlite3')
    args = parser.parse_args()
    print(json.dumps(verify(args.database), indent=2))


if __name__ == '__main__':
    main()
