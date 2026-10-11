"""Read-only queries for a source-shaped BFS time-series explorer."""

from contextlib import contextmanager
from decimal import Decimal, localcontext
import json
import math
from pathlib import Path
import re
import sqlite3
from urllib.parse import quote

from scripts.bfs_store import identifier


DEFAULT_DATASET = 'px-x-1502040100_105'

# Reviewed source tables: counts, FTE and monetary amounts, not ratios.
ADDITIVE_DATASETS = {
    'px-x-' + prefix + '_' + suffix
    for prefix, suffixes in [
        ('1502040100', ('103', '104', '105', '106', '107', '108', '109', '121', '122', '123', '124')),
        ('1503040100', ('101', '102', '103', '105')),
        ('1504040100', ('101', '102', '103', '104', '105', '106', '107', '108')),
        ('1506030000', ('201', '202')), ('1506030100', ('203', '204')),
    ] for suffix in suffixes
}


def aggregation_options(dataset_id, variables):
    """Explicit policy for reviewed tables; source residual categories are not totals."""
    options = {}
    for variable in variables:
        if variable.get('time'):
            continue
        code = variable['code']
        # These source dictionaries publish university total code 0.
        if (dataset_id in {'px-x-1506030100_' + n for n in ('203', '204', '211')}
                and code == 'Hochschule' and '0' in variable['values']
                and variable['valueTexts'][variable['values'].index('0')] == 'Hochschule - Total'):
            options[code] = {'mode': 'published_total', 'values': ['0']}
        elif dataset_id in ADDITIVE_DATASETS:
            options[code] = {'mode': 'sum', 'values': variable['values']}
    return options


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
                    'aggregation_options': aggregation_options(dataset_id, metadata['variables']),
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
                raise ValueError('Select a category or All for every other dimension')
            options = aggregation_options(dataset_id, variables)
            selections, aggregation = {}, {}
            for code, value in filters.items():
                if value is None:
                    if code not in options:
                        raise ValueError('All is not supported for ' + code)
                    selections[code] = options[code]['values']
                    aggregation[code] = {'mode': options[code]['mode'], 'categories': len(selections[code])}
                elif not isinstance(value, str) or value not in dimensions[code]['values']:
                    raise ValueError('Invalid category for ' + code)
                else:
                    selections[code] = [value]
            universities = request.get('universities')
            if universities is not None:
                university_dimension = dimensions.get('Hochschule')
                if (group_for(dataset_id) not in ('Bachelor entrants', 'Degrees')
                        or comparison not in ('Geschlecht', 'Staatsangehörigkeit (Kategorie)')
                        or university_dimension is None or 'Hochschule' not in filters
                        or options.get('Hochschule', {}).get('mode') != 'sum'):
                    raise ValueError('University batching requires an additive flow pyramid')
                if (not isinstance(universities, list) or not 1 <= len(universities) <= 100
                        or any(not isinstance(u, str) for u in universities)
                        or len(set(universities)) != len(universities)
                        or not set(universities) <= set(university_dimension['values'])):
                    raise ValueError('Select between 1 and 100 valid, distinct universities')
                selections['Hochschule'] = universities
                # Each returned partition is still one university, not a university sum.
                aggregation.pop('Hochschule', None)
            breakdown = request.get('breakdown')
            if breakdown is not None and (breakdown not in ('Fachrichtung', 'Fachbereich')
                    or breakdown not in aggregation or aggregation[breakdown]['mode'] != 'sum'):
                raise ValueError('Subject breakdown requires All subjects in an additive table')
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
            for code, selected in selections.items():
                clauses.append(identifier(code) + ' IN (' + ','.join('?' for _ in selected) + ')')
                arguments.extend(selected)
            clauses.append(identifier(comparison) + ' IN (' + ','.join('?' for _ in values) + ')')
            arguments.extend(values)
            clauses.append(identifier(time['code']) + ' IN (' + ','.join('?' for _ in period_codes) + ')')
            arguments.extend(period_codes)
            selection = ','.join(identifier(code) for code in (time['code'], comparison, measure, *([breakdown] if breakdown else []), *(['Hochschule'] if universities is not None else [])))
            rows = connection.execute(f'SELECT {selection} FROM {identifier(snapshot["table_name"])} WHERE '
                                      + ' AND '.join(clauses), arguments)
            derived = any(a['mode'] == 'sum' for a in aggregation.values())
            expected = math.prod(len(v) for v in selections.values())
            if universities is not None:
                expected //= len(universities)
            raw, subject_raw = {}, {}
            for row in rows:
                university = row[-1] if universities is not None else None
                raw.setdefault((university, row[0], row[1]), []).append(row[2])
                if breakdown:
                    subject_raw.setdefault((university, row[0], row[1], row[3]), []).append(row[2])
            comparison_labels = dict(zip(dimensions[comparison]['values'], dimensions[comparison]['valueTexts']))
            def partition(university):
                series = []
                for value in values:
                    points = []
                    for code, label in zip(period_codes, selected_labels):
                        components = raw.get((university, code, value), [])
                        missing = expected - len(components) + sum(numeric_value(v) is None for v in components)
                        source_value = components[0] if components else None
                        if derived:
                            source_value = None
                            if not missing:
                                # Keep decimal source precision during addition (e.g. 0.1 + 0.2).
                                with localcontext() as context:
                                    context.prec = 400
                                    source_value = format(sum((Decimal(v) for v in components), Decimal(0)), 'f')
                        point = {'period_code': code, 'period': label, 'raw_value': source_value,
                                 'value': numeric_value(source_value)}
                        if derived:
                            point['missing_components'] = missing
                        if breakdown:
                            segments = []
                            count = expected // len(selections[breakdown])
                            for subject, subject_label in zip(dimensions[breakdown]['values'], dimensions[breakdown]['valueTexts']):
                                parts = subject_raw.get((university, code, value, subject), [])
                                absent = count - len(parts) + sum(numeric_value(v) is None for v in parts)
                                total = None
                                if not absent:
                                    with localcontext() as context:
                                        context.prec = 400
                                        total = format(sum((Decimal(v) for v in parts), Decimal(0)), 'f')
                                segments.append({'code': subject, 'label': subject_label, 'value': numeric_value(total),
                                                 'raw_value': total, 'missing_components': absent})
                            point['subject_segments'] = segments
                        points.append(point)
                    series.append({'code': value, 'label': comparison_labels[value], 'points': points})
                return {'dataset': dataset_id, 'snapshot_id': snapshot['id'], 'measure': measure,
                        'compare': comparison, 'filters': {**filters, 'Hochschule': university} if universities is not None else filters, 'periods': selected_labels, 'series': series,
                        'derived': derived, 'aggregation': aggregation, 'breakdown': breakdown}

            if universities is None:
                return partition(None)
            university_labels = dict(zip(university_dimension['values'], university_dimension['valueTexts']))
            return {'university_series': [
                {'code': u, 'label': university_labels[u], 'data': partition(u)} for u in universities]}
