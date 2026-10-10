"""Read-only queries for a source-shaped BFS time-series explorer."""

from contextlib import contextmanager
import json
import math
from pathlib import Path
import re
import sqlite3
from urllib.parse import quote

from scripts.bfs_store import identifier


DEFAULT_DATASET = 'px-x-1502040100_105'


def group_for(dataset_id):
    if dataset_id.startswith('px-x-1502040100_12'):
        return 'Bachelor entrants'
    for prefix, group in [('px-x-150204', 'Enrolled students'), ('px-x-150304', 'Degrees'),
                          ('px-x-150404', 'Staff'), ('px-x-150603', 'Finances')]:
        if dataset_id.startswith(prefix):
            return group
    return 'Other datasets'


def numeric_value(raw):
    """Source markers remain nonnumeric; never cast a missing marker to zero."""
    if raw is None or not re.fullmatch(r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?', raw):
        return None
    value = float(raw)
    return value if math.isfinite(value) else None


class Explorer:
    def __init__(self, database):
        self.database = Path(database).resolve()

    @contextmanager
    def connection(self):
        connection = sqlite3.connect('file:' + quote(str(self.database), safe='/') + '?mode=ro', uri=True)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute('PRAGMA query_only = ON')
            connection.execute('BEGIN')
            yield connection
        finally:
            connection.close()

    def catalog(self):
        with self.connection() as connection:
            datasets = []
            for row in connection.execute('SELECT dataset_id, id, metadata_json, fetched_at, row_count '
                                          'FROM latest_snapshots ORDER BY dataset_id'):
                metadata = json.loads(row['metadata_json'])
                datasets.append({'id': row['dataset_id'], 'title': metadata['title'],
                                 'group': group_for(row['dataset_id']), 'snapshot_id': row['id'],
                                 'fetched_at': row['fetched_at'], 'rows': row['row_count'],
                                 'dimensions': [v['code'] for v in metadata['variables'] if not v.get('time')]})
            return {'datasets': datasets, 'default_dataset': DEFAULT_DATASET}

    def snapshot(self, connection, dataset_id, snapshot_id=None):
        if snapshot_id is None:
            row = connection.execute('SELECT s.*, t.table_name FROM latest_snapshots s '
                                     'JOIN dataset_tables t ON t.id=s.dataset_table_id WHERE s.dataset_id=?',
                                     (dataset_id,)).fetchone()
        else:
            row = connection.execute('SELECT s.*, t.table_name FROM snapshots s '
                'JOIN dataset_tables t ON t.id=s.dataset_table_id '
                'JOIN collection_runs r ON r.id=s.collection_run_id '
                "WHERE s.dataset_id=? AND s.id=? AND r.status='complete' AND r.mode='download'",
                (dataset_id, snapshot_id)).fetchone()
        if row is None:
            raise LookupError('Dataset or successful snapshot not found')
        return row

    def details(self, dataset_id, snapshot_id=None):
        with self.connection() as connection:
            row = self.snapshot(connection, dataset_id, snapshot_id)
            metadata, source = json.loads(row['metadata_json']), json.loads(row['source_json'])
            columns = json.loads(row['columns_json'])
            comments, source_metadata = [], []
            for chunk in connection.execute('SELECT comments_json, source_metadata_json FROM snapshot_chunks '
                                             'WHERE snapshot_id=? ORDER BY chunk_number', (row['id'],)):
                for key, target in [('comments_json', comments), ('source_metadata_json', source_metadata)]:
                    for entry in json.loads(chunk[key]):
                        if entry not in target:
                            target.append(entry)
            versions = [dict(s) for s in connection.execute('SELECT s.id, s.fetched_at, s.row_count FROM snapshots s '
                'JOIN collection_runs r ON r.id=s.collection_run_id '
                "WHERE s.dataset_id=? AND r.status='complete' AND r.mode='download' ORDER BY s.id DESC", (dataset_id,))]
            database = source.get('database', dataset_id)
            source_url = ('https://www.pxweb.bfs.admin.ch/pxweb/de/' + quote(database, safe='') + '/-/'
                          + quote(dataset_id, safe='') + '.px/')
            return {'id': dataset_id, 'title': metadata['title'], 'group': group_for(dataset_id),
                    'snapshot_id': row['id'], 'fetched_at': row['fetched_at'], 'rows': row['row_count'],
                    'metadata': metadata, 'columns': columns, 'source': source, 'source_url': source_url,
                    'comments': comments, 'source_metadata': source_metadata, 'snapshots': versions}

    def series(self, request):
        if not isinstance(request, dict):
            raise ValueError('Expected a JSON object')
        dataset_id = request.get('dataset')
        if not isinstance(dataset_id, str):
            raise ValueError('Select a dataset')
        snapshot_id = request.get('snapshot')
        if snapshot_id is not None and (type(snapshot_id) is not int or snapshot_id < 1):
            raise ValueError('Invalid snapshot')
        with self.connection() as connection:
            snapshot = self.snapshot(connection, dataset_id, snapshot_id)
            variables = json.loads(snapshot['metadata_json'])['variables']
            times = [v for v in variables if v.get('time')]
            if len(times) != 1:
                raise ValueError('This explorer requires one time dimension')
            time = times[0]
            dimensions = {v['code']: v for v in variables if not v.get('time')}
            comparison = request.get('compare')
            if comparison not in dimensions:
                raise ValueError('Select a valid comparison dimension')
            values = request.get('values')
            if not isinstance(values, list) or not 1 <= len(values) <= 100 or any(not isinstance(v, str) for v in values):
                raise ValueError('Select between 1 and 100 comparison categories')
            if len(set(values)) != len(values) or not set(values) <= set(dimensions[comparison]['values']):
                raise ValueError('Invalid comparison categories')
            filters = request.get('filters')
            if not isinstance(filters, dict) or set(filters) != set(dimensions) - {comparison}:
                raise ValueError('Select exactly one category for every other dimension')
            for code, value in filters.items():
                if not isinstance(value, str) or value not in dimensions[code]['values']:
                    raise ValueError('Invalid category for ' + code)
            columns = json.loads(snapshot['columns_json'])
            measures = [c for c in columns if c['type'] == 'c']
            measure = request.get('measure', measures[0]['code'])
            if measure not in {c['code'] for c in measures}:
                raise ValueError('Invalid measure')
            codes, labels = time['values'], time['valueTexts']
            first, last = request.get('from', codes[0]), request.get('to', codes[-1])
            if first not in codes or last not in codes or codes.index(first) > codes.index(last):
                raise ValueError('Invalid period range')
            period_codes = codes[codes.index(first):codes.index(last) + 1]
            selected_labels = labels[codes.index(first):codes.index(last) + 1]
            clauses = ['snapshot_id=?']
            arguments = [snapshot['id']]
            for code, value in filters.items():
                clauses.append(identifier(code) + '=?')
                arguments.append(value)
            clauses.append(identifier(comparison) + ' IN (' + ','.join('?' for _ in values) + ')')
            arguments.extend(values)
            clauses.append(identifier(time['code']) + ' IN (' + ','.join('?' for _ in period_codes) + ')')
            arguments.extend(period_codes)
            selection = ','.join(identifier(code) for code in (time['code'], comparison, measure))
            rows = connection.execute(f'SELECT {selection} FROM {identifier(snapshot["table_name"])} WHERE '
                                      + ' AND '.join(clauses), arguments)
            raw = {(r[0], r[1]): r[2] for r in rows}
            comparison_labels = dict(zip(dimensions[comparison]['values'], dimensions[comparison]['valueTexts']))
            series = []
            for value in values:
                points = []
                for code, label in zip(period_codes, selected_labels):
                    source_value = raw.get((code, value))
                    points.append({'period_code': code, 'period': label, 'raw_value': source_value,
                                   'value': numeric_value(source_value)})
                series.append({'code': value, 'label': comparison_labels[value], 'points': points})
            return {'dataset': dataset_id, 'snapshot_id': snapshot['id'], 'measure': measure,
                    'compare': comparison, 'filters': filters, 'periods': selected_labels, 'series': series}
