"""Derived totals use complete source partitions, with no storage changes."""
import contextlib
import io
from pathlib import Path
import tempfile
import unittest

from explorer import Explorer
from scripts.bfs_store import Store, identifier
from test_bfs_sqlite import OfflineClient
from scripts.fetch_bfs import collect


class NumericClient(OfflineClient):
    def request(self, url, payload=None):
        result = super().request(url, payload)
        if payload:
            codes = [q['code'] for q in payload['query']]
            for row in result['data']:
                key = dict(zip(codes, row['key']))
                row['values'] = ['0.1' if key.get('Geschlecht') == '1' else '0.2']
                if key.get('Hochschule') == '0':
                    row['values'] = ['100']
        return result


class AggregationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name) / 'data.sqlite3')
        self.explorer = Explorer(self.store.path)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def load(self, dataset='px-x-1502040100_123', total=False, unknown=False):
        self.dataset = dataset
        variables = [
            {'code': 'Year', 'values': ['a', 'b'], 'valueTexts': ['2024', '2025'], 'time': True},
            {'code': 'Geschlecht', 'values': ['1', '2'], 'valueTexts': ['Male', 'Female']},
            {'code': 'Studienstufe', 'values': ['b', 'm'], 'valueTexts': ['Bachelor', 'Master']},
            {'code': 'Hochschule', 'values': ['01', '02'], 'valueTexts': ['ETHZ', 'EPFL']},
        ]
        if unknown:
            variables[1]['values'].append('99')
            variables[1]['valueTexts'].append('Unknown')
        if total:
            variables[-1]['values'].insert(0, '0')
            variables[-1]['valueTexts'].insert(0, 'Hochschule - Total')
        with contextlib.redirect_stdout(io.StringIO()):
            collect(NumericClient({dataset: {'title': 'Test', 'variables': variables}}), self.store)
        self.query = {'dataset': dataset, 'compare': 'Hochschule', 'values': ['01', '02'],
                      'filters': {'Geschlecht': None, 'Studienstufe': 'b'}}
        self.table = self.store.connection.execute('SELECT table_name FROM dataset_tables').fetchone()[0]

    def test_gender_total_decimal_precision_and_multiple_dimensions(self):
        self.load()
        data = self.explorer.series(self.query)
        self.assertTrue(data['derived'])
        self.assertEqual(data['aggregation']['Geschlecht'], {'mode': 'sum', 'categories': 2})
        self.assertEqual([s['points'][0]['raw_value'] for s in data['series']], ['0.3', '0.3'])
        data = self.explorer.series(dict(self.query, filters={'Geschlecht': None, 'Studienstufe': None}))
        self.assertEqual([s['points'][0]['value'] for s in data['series']], [0.6, 0.6])
        # The comparison dimension still gives separate lines, not a combined total.
        self.assertEqual(len(data['series']), 2)

    def test_unknown_gender_is_included_and_zero_is_valid(self):
        self.load(unknown=True)
        self.assertEqual(self.explorer.series(self.query)['series'][0]['points'][0]['value'], 0.5)
        self.store.connection.execute(f'UPDATE {identifier(self.table)} SET Students=\'0\'')
        self.assertEqual(self.explorer.series(self.query)['series'][0]['points'][0]['value'], 0)
        self.assertEqual(self.explorer.details(self.dataset)['aggregation_options']['Geschlecht']['values'], ['1', '2', '99'])

    def test_markers_and_absent_coordinates_do_not_become_partial_totals(self):
        self.load()
        self.store.connection.execute(f'UPDATE {identifier(self.table)} SET Students=\'..\' '
                                      'WHERE Year=\'a\' AND Geschlecht=\'2\' AND Hochschule=\'02\'')
        self.store.connection.execute(f'DELETE FROM {identifier(self.table)} '
                                      'WHERE Year=\'b\' AND Geschlecht=\'2\' AND Hochschule=\'02\'')
        data = self.explorer.series(self.query)
        self.assertTrue(all(p['value'] == 0.3 for p in data['series'][0]['points']))
        for point in data['series'][1]['points']:
            self.assertIsNone(point['value'])
            self.assertIsNone(point['raw_value'])
            self.assertEqual(point['missing_components'], 1)

    def test_published_total_is_selected_once_not_added_to_children(self):
        self.load('px-x-1506030100_203', total=True)
        query = dict(self.query, compare='Geschlecht', values=['1'],
                     filters={'Studienstufe': 'b', 'Hochschule': None})
        data = self.explorer.series(query)
        self.assertFalse(data['derived'])
        self.assertEqual(data['series'][0]['points'][0]['value'], 100)
        self.assertEqual(data['aggregation']['Hochschule']['mode'], 'published_total')

    def test_ratios_and_unreviewed_tables_reject_sums(self):
        for dataset in ('px-x-1506030100_211', 'px-x-1502040100_999'):
            with self.subTest(dataset=dataset):
                # Each test source can coexist with previous tables.
                self.load(dataset, total=True)
                with self.assertRaisesRegex(ValueError, 'All is not supported'):
                    self.explorer.series(self.query)
                options = self.explorer.details(dataset)['aggregation_options']
                self.assertNotIn('Geschlecht', options)
                self.assertEqual('Hochschule' in options, dataset.endswith('_211'))


if __name__ == '__main__':
    unittest.main()
