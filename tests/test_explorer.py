"""Read-only explorer and real HTTP API tests using a temporary source database."""

import contextlib
import copy
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from explorer import Explorer, numeric_value
from server import create_server
from test_bfs_sqlite import METADATA, TABLE, OfflineClient
from scripts.bfs_store import Store
from scripts.fetch_bfs import collect


class ExplorerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'stats.sqlite3'
        self.store = Store(self.path)
        with contextlib.redirect_stdout(io.StringIO()):
            collect(OfflineClient(), self.store)
        self.explorer = Explorer(self.path)
        self.query = {'dataset': TABLE, 'snapshot': 1, 'compare': 'Hochschule',
                      'values': ['01', '02'], 'filters': {}, 'from': '0', 'to': '2'}

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def test_catalog_details_and_source_comments(self):
        self.assertEqual(len(self.explorer.catalog()['datasets']), 1)
        detail = self.explorer.details(TABLE)
        self.assertEqual(detail['metadata'], METADATA)
        self.assertEqual(detail['source_metadata'][0]['unit'], 'persons')
        self.assertEqual(detail['comments'][0]['text'], 'Missing value marker preserved')
        self.assertEqual(detail['snapshots'][0]['id'], 1)

    def test_exact_series_retains_zero_markers_period_order_and_codes(self):
        data = self.explorer.series(self.query)
        self.assertEqual(data['periods'], ['2023', '2024', '2025'])
        self.assertEqual(data['series'][0]['code'], '01')
        self.assertEqual(data['series'][0]['label'], 'ETHZ')
        self.assertEqual(data['series'][0]['points'][0]['raw_value'], '0')
        self.assertEqual(data['series'][0]['points'][0]['value'], 0)
        self.assertEqual(data['series'][1]['points'][0]['raw_value'], '..')
        self.assertIsNone(data['series'][1]['points'][0]['value'])

    def test_range_and_comparing_another_dimension(self):
        query = dict(self.query, compare='Hochschule', values=['01'], **{'from': '1', 'to': '2'})
        self.assertEqual(len(self.explorer.series(query)['series'][0]['points']), 2)
        # Time is always the horizontal dimension, never summed or compared.
        with self.assertRaises(ValueError):
            self.explorer.series(dict(self.query, compare='Year'))

    def test_invalid_category_filter_measure_and_range_fail(self):
        for change in [{'values': []}, {'values': ['01', '01']}, {'values': ['01 OR 1=1']},
                       {'filters': {'Hochschule': '01'}}, {'measure': 'not a measure'},
                       {'from': '2', 'to': '0'}, {'snapshot': True}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.explorer.series(dict(self.query, **change))

    def test_missing_dataset_is_not_found(self):
        with self.assertRaises(LookupError):
            self.explorer.details('does-not-exist')

    def test_historical_snapshot_uses_its_own_metadata_and_does_not_sum(self):
        metadata = copy.deepcopy(METADATA)
        metadata['variables'].insert(1, {'code': 'Gender', 'values': ['1', '2'], 'valueTexts': ['Male', 'Female']})
        metadata['variables'][0]['values'].append('3')
        metadata['variables'][0]['valueTexts'].append('2026')
        with contextlib.redirect_stdout(io.StringIO()):
            collect(OfflineClient({TABLE: metadata}), self.store)
        self.assertEqual(self.explorer.details(TABLE, 1)['metadata'], METADATA)
        self.assertEqual(len(self.explorer.details(TABLE)['snapshots']), 2)
        query = dict(self.query, snapshot=2, filters={'Gender': '1'})
        self.assertEqual(len(self.explorer.series(query)['series']), 2)
        with self.assertRaises(ValueError):
            self.explorer.series(dict(query, filters={}))
        self.assertEqual(len(self.explorer.series(self.query)['periods']), 3)

    def test_queries_never_modify_database(self):
        before = self.store.connection.total_changes
        self.explorer.catalog(); self.explorer.details(TABLE); self.explorer.series(self.query)
        self.assertEqual(self.store.connection.total_changes, before)
        self.assertEqual(self.store.connection.execute('SELECT COUNT(*) FROM collection_runs').fetchone()[0], 1)
        with self.explorer.connection() as connection, self.assertRaises(sqlite3.OperationalError):
            connection.execute('DELETE FROM snapshots')

    def test_numeric_conversion_preserves_missing_and_decimal_values(self):
        for raw in (None, '..', '-', '', 'NaN', 'Infinity', '1,234', '1e9999'):
            self.assertIsNone(numeric_value(raw))
        self.assertEqual(numeric_value('0'), 0)
        self.assertEqual(numeric_value('-12.50'), -12.5)

    def test_http_api_and_public_assets(self):
        server = create_server('127.0.0.1', 0, self.path)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        base = 'http://127.0.0.1:' + str(server.server_port)
        try:
            with urlopen(base + '/') as response:
                self.assertIn(b'Data explorer', response.read())
                self.assertIn("default-src 'self'", response.headers['Content-Security-Policy'])
            with urlopen(base + '/subject-translations.json') as response:
                self.assertEqual(json.load(response)['translations']['Informatik'], 'Computer Science')
            with urlopen(base + '/api/series?query=' + quote(json.dumps(self.query))) as response:
                self.assertEqual(len(json.load(response)['series']), 2)
            for path, status in [('/data/university_stats.sqlite3', 404), ('/../server.py', 404),
                                 ('/api/dataset?id=missing', 404), ('/api/series?query=bad', 400)]:
                with self.subTest(path=path), self.assertRaises(HTTPError) as caught:
                    urlopen(base + path)
                self.assertEqual(caught.exception.code, status)
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)


if __name__ == '__main__':
    unittest.main()
