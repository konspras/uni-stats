"""Offline integration tests for discovery, checking, and transactional SQLite import."""

import copy
import itertools
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from bfs_store import Store, identifier, row_digest
from fetch_bfs import API, collect, main, selections, validate_response
from verify_database import verify


TABLE = 'px-x-1502040100_test'
METADATA = {'title': 'Example', 'variables': [
    {'code': 'Year', 'values': ['0', '1', '2'], 'valueTexts': ['2023', '2024', '2025'], 'time': True},
    {'code': 'Hochschule', 'values': ['01', '02'], 'valueTexts': ['ETHZ', 'EPFL']},
]}


def response_for(query, measure='Students'):
    return {'columns': [{'code': q['code'], 'type': 'd'} for q in query]
            + [{'code': measure, 'type': 'c'}],
            'data': [{'key': list(key), 'values': ['..' if key[1] == '02' else '0']}
                     for key in itertools.product(*(q['selection']['values'] for q in query))],
            'comments': [{'text': 'Missing value marker preserved'}],
            'metadata': [{'source': 'Example provider', 'unit': 'persons'}]}


class OfflineClient:
    """Exercise real discovery with metadata GETs and synthetic PxWeb POSTs."""
    def __init__(self, tables=None, fail_on=None):
        self.tables = tables if tables is not None else {TABLE: copy.deepcopy(METADATA)}
        self.posts = 0
        self.fail_on = fail_on
        self.updated = '2025-01-01'
        self.measure = 'Students'
        self.on_post = None

    def request(self, url, payload=None):
        if payload is not None:
            self.posts += 1
            if self.on_post:
                self.on_post()
            if self.posts == self.fail_on:
                raise OSError('interrupted connection')
            return response_for(payload['query'], self.measure)
        if url == API:
            return [{'dbid': t} for t in self.tables]
        table_id = url.removeprefix(API).split('/')[0]
        if url.endswith('/'):
            return [{'id': table_id + '.px', 'type': 't', 'text': 'Example', 'updated': self.updated}]
        return copy.deepcopy(self.tables[table_id])


class ValidationTests(unittest.TestCase):
    def test_chunks_cover_every_coordinate_once_and_respect_limit(self):
        coordinates = []
        for query in selections(METADATA, 2):
            chunk = list(itertools.product(*(q['selection']['values'] for q in query)))
            self.assertLessEqual(len(chunk), 2)
            coordinates.extend(chunk)
        expected = set(itertools.product(['0', '1', '2'], ['01', '02']))
        self.assertEqual(set(coordinates), expected)
        self.assertEqual(len(coordinates), len(expected))

    def test_rejects_duplicate_rows_and_incomplete_responses(self):
        query = next(selections(METADATA, 100))
        response = response_for(query)
        response['data'][-1] = response['data'][0]
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            validate_response(response, query)
        response = response_for(query)
        response['data'].pop()
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            validate_response(response, query)

    def test_rejects_unexpected_codes_and_changing_columns(self):
        query = next(selections(METADATA, 100))
        response = response_for(query)
        response['data'][0]['key'][1] = '999'
        with self.assertRaisesRegex(ValueError, 'outside'):
            validate_response(response, query)
        with self.assertRaisesRegex(ValueError, 'columns changed'):
            validate_response(response_for(query), query, [{'code': 'Old'}])


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.store = Store(self.root / 'stats.sqlite3')
        self.client = OfflineClient()

    def tearDown(self):
        self.store.close()
        self.directory.cleanup()

    def query(self, sql, parameters=()):
        return self.store.connection.execute(sql, parameters).fetchall()

    def add_year(self):
        self.client.tables[TABLE]['variables'][0]['values'].append('3')
        self.client.tables[TABLE]['variables'][0]['valueTexts'].append('2026')

    def source_rows(self, snapshot_id):
        snapshot = self.query('SELECT s.*, t.table_name FROM snapshots s '
                              'JOIN dataset_tables t ON t.id=s.dataset_table_id WHERE s.id=?', (snapshot_id,))[0]
        columns = json.loads(snapshot['columns_json'])
        names = ', '.join(identifier(c['code']) for c in columns)
        order = ', '.join(identifier(c['code']) for c in columns if c['type'] != 'c')
        rows = self.query(f'SELECT {names} FROM {identifier(snapshot["table_name"])} '
                          f'WHERE snapshot_id=? ORDER BY {order}', (snapshot_id,))
        return snapshot, [tuple(row) for row in rows]

    def test_initial_collection_preserves_text_metadata_and_checksums_without_csv(self):
        result = collect(self.client, self.store, max_cells=2)
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(result['totals']['rows'], 6)
        snapshot, rows = self.source_rows(result['datasets'][0]['snapshot_id'])
        self.assertEqual({r[1] for r in rows}, {'01', '02'})
        self.assertEqual({r[2] for r in rows}, {'0', '..'})
        self.assertEqual(snapshot['content_sha256'], row_digest(rows))
        self.assertEqual(json.loads(snapshot['metadata_json']), METADATA)
        chunk = self.query('SELECT * FROM snapshot_chunks LIMIT 1')[0]
        self.assertEqual(json.loads(chunk['comments_json'])[0]['text'], 'Missing value marker preserved')
        self.assertEqual(json.loads(chunk['source_metadata_json'])[0]['unit'], 'persons')
        self.assertEqual(json.loads(chunk['query_json'])['response']['format'], 'json')
        self.assertFalse(list(self.root.rglob('*.csv')))
        self.assertEqual(self.query('PRAGMA integrity_check')[0][0], 'ok')
        self.assertEqual(self.query('PRAGMA foreign_key_check'), [])

    def test_verifier_detects_changed_values_and_missing_rows(self):
        collect(self.client, self.store)
        self.assertEqual(verify(self.store.path)['rows'], 6)
        name = identifier(self.query('SELECT table_name FROM dataset_tables')[0][0])
        self.store.connection.execute(f'UPDATE {name} SET Students=? WHERE Year=? AND Hochschule=?', ('999', '0', '01'))
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            verify(self.store.path)
        self.store.connection.execute(f'DELETE FROM {name} WHERE Year=? AND Hochschule=?', ('0', '01'))
        with self.assertRaisesRegex(ValueError, 'row/chunk count mismatch'):
            verify(self.store.path)

    def test_unchanged_revisions_categories_and_code_renumbering_skip(self):
        collect(self.client, self.store)
        posts = self.client.posts
        self.client.updated = '2026-10-10'
        self.client.tables[TABLE]['title'] = 'Revised'
        self.client.tables[TABLE]['variables'][0]['values'] = ['7', '8', '9']
        self.client.tables[TABLE]['variables'][1]['values'].append('03')
        self.client.tables[TABLE]['variables'][1]['valueTexts'].append('New category')
        result = collect(self.client, self.store)
        self.assertEqual(result['status'], 'skipped')
        self.assertEqual(self.client.posts, posts)
        self.assertEqual(len(self.query('SELECT * FROM snapshots')), 1)
        self.assertEqual(self.store.baselines()[TABLE]['snapshot'], 1)

    def test_new_year_retains_old_snapshot_and_fetches_all_years(self):
        first = collect(self.client, self.store)
        old_snapshot, old_rows = self.source_rows(first['datasets'][0]['snapshot_id'])
        self.add_year()
        result = collect(self.client, self.store)
        self.assertEqual(result['totals']['rows'], 8)
        self.assertEqual(len(self.query('SELECT * FROM snapshots')), 2)
        self.assertEqual(self.source_rows(old_snapshot['id'])[1], old_rows)
        self.assertEqual(len(self.query('SELECT * FROM dataset_tables')), 1)
        self.assertEqual(self.store.baselines()[TABLE]['snapshot'], result['datasets'][0]['snapshot_id'])

    def test_new_table_triggers_full_requested_collection(self):
        collect(self.client, self.store)
        self.client.tables[TABLE + '2'] = copy.deepcopy(METADATA)
        result = collect(self.client, self.store)
        self.assertEqual(len(result['datasets']), 2)
        self.assertEqual(len(self.query('SELECT * FROM snapshots')), 3)

    def test_failure_rolls_back_whole_collection_and_next_run_retries(self):
        collect(self.client, self.store)
        self.add_year()
        self.client.tables[TABLE + '2'] = copy.deepcopy(METADATA)
        self.client.fail_on = self.client.posts + 2
        result = collect(self.client, self.store)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['totals']['rows'], 0)
        self.assertEqual(len(self.query('SELECT * FROM snapshots')), 1)
        self.assertEqual(len(self.query('SELECT * FROM datasets')), 1)
        self.assertEqual(len(self.query('SELECT * FROM dataset_tables')), 1)
        self.assertEqual(self.store.baselines()[TABLE]['snapshot'], 1)
        self.assertIn('interrupted connection', self.query('SELECT error FROM collection_runs ORDER BY id DESC')[0][0])
        self.client.fail_on = None
        self.assertEqual(collect(self.client, self.store)['status'], 'complete')

    def test_readers_see_previous_collection_until_commit(self):
        collect(self.client, self.store)
        self.add_year()
        seen = []
        def observe():
            with sqlite3.connect(self.store.path) as reader:
                seen.append(reader.execute('SELECT COUNT(*) FROM snapshots').fetchone()[0])
        self.client.on_post = observe
        self.assertEqual(collect(self.client, self.store, max_cells=2)['status'], 'complete')
        self.assertEqual(set(seen), {1})
        self.assertEqual(len(self.query('SELECT * FROM snapshots')), 2)

    def test_check_inventory_and_failed_runs_do_not_advance_baseline(self):
        collect(self.client, self.store)
        self.add_year()
        posts = self.client.posts
        result = collect(self.client, self.store, check_only=True)
        self.assertTrue(result['new_data'])
        collect(self.client, self.store, inventory_only=True)
        self.assertEqual(self.client.posts, posts)
        self.assertEqual(self.store.baselines()[TABLE]['snapshot'], 1)

    def test_schema_change_creates_version_and_preserves_old_table(self):
        collect(self.client, self.store)
        old_table = self.query('SELECT table_name FROM dataset_tables')[0][0]
        self.add_year()
        self.client.measure = 'Updated measure'
        self.assertEqual(collect(self.client, self.store)['status'], 'complete')
        self.assertEqual(len(self.query('SELECT * FROM dataset_tables')), 2)
        self.assertEqual(len(self.query(f'SELECT * FROM {identifier(old_table)}')), 6)

    def test_quotes_in_source_column_names_are_safe(self):
        self.client.tables[TABLE]['variables'][0]['code'] = 'Year"; DROP TABLE datasets; --'
        self.assertEqual(collect(self.client, self.store)['status'], 'complete')
        self.assertEqual(len(self.query('SELECT * FROM datasets')), 1)
        self.assertEqual(self.source_rows(1)[1][0][0], '0')

    def test_multiple_interleaved_measures_preserve_decimal_and_missing_strings(self):
        request = self.client.request
        def multiple_measures(url, payload=None):
            if payload is None:
                return request(url)
            response = response_for(payload['query'])
            response['columns'] = [response['columns'][0], {'code': 'Decimal', 'type': 'c'},
                                   response['columns'][1], {'code': 'Marker', 'type': 'c'}]
            for row in response['data']:
                row['values'] = ['1.25', '..']
            return response
        with patch.object(self.client, 'request', side_effect=multiple_measures):
            result = collect(self.client, self.store)
        self.assertEqual(result['totals']['cells'], 12)
        self.assertEqual(self.source_rows(1)[1][0], ('0', '1.25', '01', '..'))

    def test_reserved_source_column_fails_without_publishing(self):
        self.client.measure = 'snapshot_id'
        result = collect(self.client, self.store)
        self.assertEqual(result['status'], 'failed')
        self.assertIn('reserved', result['error'])
        self.assertEqual(self.query('SELECT * FROM snapshots'), [])

    def test_schema_change_without_new_year_does_not_trigger(self):
        collect(self.client, self.store)
        self.client.measure = 'Changed measure'
        self.assertEqual(collect(self.client, self.store)['status'], 'skipped')

    def test_missing_or_changed_time_dimension_fails_without_data_queries(self):
        collect(self.client, self.store)
        posts = self.client.posts
        self.client.tables[TABLE]['variables'][0]['code'] = 'Changed time'
        self.assertEqual(collect(self.client, self.store)['status'], 'failed')
        self.client.tables[TABLE]['variables'][0].pop('time')
        self.assertEqual(collect(self.client, self.store)['status'], 'failed')
        self.assertEqual(self.client.posts, posts)

    def test_removed_periods_skip_but_historical_additions_trigger(self):
        collect(self.client, self.store)
        year = self.client.tables[TABLE]['variables'][0]
        year['values'].pop()
        year['valueTexts'].pop()
        self.assertEqual(collect(self.client, self.store)['status'], 'skipped')
        year['values'].append('3')
        year['valueTexts'].append('1980')
        self.assertEqual(collect(self.client, self.store)['new_data'][0]['periods'], ['1980'])

    def test_selected_tables_do_not_advance_other_baselines(self):
        self.client.tables[TABLE + '2'] = copy.deepcopy(METADATA)
        collect(self.client, self.store)
        old = self.store.baselines()[TABLE + '2']['snapshot']
        self.add_year()
        result = collect(self.client, self.store, selected=[TABLE])
        self.assertEqual(len(result['datasets']), 1)
        self.assertEqual(self.store.baselines()[TABLE + '2']['snapshot'], old)

    def test_keyboard_interrupt_rolls_back_and_records_status(self):
        def interrupt():
            raise KeyboardInterrupt()
        self.client.on_post = interrupt
        with self.assertRaises(KeyboardInterrupt):
            collect(self.client, self.store)
        self.assertEqual(self.query('SELECT status FROM collection_runs')[0][0], 'interrupted')
        self.assertEqual(self.query('SELECT * FROM snapshots'), [])

    def test_process_restart_recovers_stale_runs_and_retains_baseline(self):
        collect(self.client, self.store)
        stale = self.store.start_run('2026-01-01', 'download', API, [])
        self.store.close()
        self.store = Store(self.root / 'stats.sqlite3')
        self.store.recover_runs('2026-01-02')
        self.assertEqual(self.query('SELECT status FROM collection_runs WHERE id=?', (stale,))[0][0], 'interrupted')
        self.assertEqual(collect(self.client, self.store)['status'], 'skipped')

    def test_process_death_rolls_back_in_progress_schema_and_observations(self):
        run_id = self.store.start_run('2026-01-01', 'download', API, [])
        self.store.begin()
        table = {'table_id': TABLE, 'metadata': METADATA, 'api_url': 'https://example.test', 'catalog': {}}
        query = next(selections(METADATA, 100))
        response = response_for(query)
        snapshot_id, name = self.store.create_snapshot(table, response['columns'], run_id, '2026-01-01')
        self.store.insert_chunk(snapshot_id, name, response['columns'], 1, query, response)
        # Closing without commit represents SQLite's process-crash rollback.
        self.store.close()
        self.store = Store(self.root / 'stats.sqlite3')
        self.store.recover_runs('2026-01-02')
        self.assertEqual(self.query('SELECT * FROM snapshots'), [])
        self.assertEqual(self.query('SELECT * FROM dataset_tables'), [])
        self.assertEqual(self.query('SELECT status FROM collection_runs')[0][0], 'interrupted')

    def test_cli_populates_database_then_skips_without_any_export_files(self):
        database = self.root / 'cli.sqlite3'
        with patch('fetch_bfs.Client', return_value=self.client), patch.object(sys, 'argv',
                ['fetch_bfs.py', '--database', str(database)]):
            self.assertEqual(main(), 0)
            posts = self.client.posts
            self.assertEqual(main(), 0)
        self.assertEqual(self.client.posts, posts)
        with sqlite3.connect(database) as connection:
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM snapshots').fetchone()[0], 1)
            self.assertEqual(connection.execute('SELECT status FROM collection_runs ORDER BY id DESC').fetchone()[0], 'skipped')
        self.assertFalse(list(self.root.rglob('*.csv')))


if __name__ == '__main__':
    unittest.main()
