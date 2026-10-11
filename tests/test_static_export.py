"""Exhaustive small-cube parity and publication recovery without network access."""
import contextlib
import copy
from datetime import timedelta
import io
import itertools
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import unittest

from explorer import Explorer
from scripts.bfs_store import Store, identifier
from scripts.export_static import export
from scripts.fetch_bfs import collect
from test_aggregation import NumericClient
import test_update_service
from publication import Publisher, publish_files
from update_service import UpdateWorker

ROOT = Path(__file__).resolve().parents[1]


def parity(output, explorer, requests, fixture):
    cases = [{'request':r, 'expected':explorer.series(r)} for r in requests]
    fixture.write_text(json.dumps({'output':str(output),'cases':cases}))
    completed = subprocess.run(['node', str(ROOT/'tests/static_parity.mjs'), str(fixture)], capture_output=True, text=True)
    if completed.returncode:
        raise AssertionError(completed.stdout + completed.stderr)
    return completed.stdout.strip()


class StaticExportTests(unittest.TestCase):
    def test_every_filter_combination_missing_precision_and_latest_only(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);store=Store(root/'stats.sqlite3');explorer=Explorer(store.path)
            dataset='px-x-1502040100_123'
            metadata={'title':'CSV "round trip",\nsubject', 'variables':[
                {'code':'Year','values':['a','b'],'valueTexts':['2024','2025'],'time':True},
                {'code':'Geschlecht','values':['1','2','99'],'valueTexts':['Men','Women','Unknown']},
                {'code':'Hochschule','values':['01','02'],'valueTexts':['ETHZ','EPFL']},
                {'code':'Studienstufe','values':['b','m'],'valueTexts':['Bachelor','Master']},
                {'code':'Fachrichtung','values':['cs','psy'],'valueTexts':['Informatik','Psychologie']},
            ]}
            with contextlib.redirect_stdout(io.StringIO()):collect(NumericClient({dataset:metadata}),store)
            table=store.connection.execute('SELECT table_name FROM dataset_tables').fetchone()[0]
            store.connection.execute(f"UPDATE {identifier(table)} SET Students='..' WHERE Year='a' AND Hochschule='02' AND Geschlecht='2' AND Fachrichtung='cs'")
            store.connection.execute(f"DELETE FROM {identifier(table)} WHERE Year='b' AND Hochschule='02' AND Geschlecht='1' AND Fachrichtung='psy' AND Studienstufe='m'")
            count=store.connection.execute(f'SELECT COUNT(*) FROM {identifier(table)}').fetchone()[0]
            store.connection.execute('UPDATE snapshots SET row_count=?',(count,));store.connection.commit()
            output=root/'export';result=export(store.path,output);self.assertEqual(result['rows'],count)
            first=(output/'index.json').read_text();requests=[]
            detail=explorer.details(dataset);dims=[v for v in metadata['variables'] if not v.get('time')]
            for comparison in dims:
                others=[v for v in dims if v is not comparison]
                for values in itertools.product(*[[*v['values'],None] for v in others]):
                    request={'dataset':dataset,'compare':comparison['code'],'values':comparison['values'],
                             'filters':dict(zip([v['code'] for v in others],values))}
                    requests.append(request)
                    if request['filters'].get('Fachrichtung','x') is None:
                        requests.append(dict(request,breakdown='Fachrichtung'))
                    if comparison['code']=='Geschlecht':
                        requests.append(dict(request,universities=['02','01']))
                        if request['filters']['Fachrichtung'] is None:
                            requests.append(dict(request,universities=['01','02'],breakdown='Fachrichtung'))
            report=parity(output,explorer,requests,root/'parity.json');self.assertGreater(len(requests),200)
            # Deterministic immutable release; metadata-only reports do not duplicate CSVs.
            again=export(store.path,output);self.assertEqual(again['generation'],result['generation'])
            self.assertEqual(len(list((output/'releases').iterdir())),1)
            # Historical snapshots are excluded after a second successful full collection.
            updated=copy.deepcopy(metadata);updated['variables'][0]['values'].append('c');updated['variables'][0]['valueTexts'].append('2026')
            with contextlib.redirect_stdout(io.StringIO()):collect(NumericClient({dataset:updated}),store)
            latest=export(store.path,output)
            manifest=json.loads((output/'releases'/latest['generation']/'manifest.json').read_text())
            exported=json.loads((output/manifest['datasets'][dataset]).read_text())
            self.assertEqual(len(exported['snapshots']),1);self.assertEqual(exported['snapshot_id'],2)
            self.assertEqual(len(explorer.details(dataset)['snapshots']),2)
            store.close()

    def test_published_total_not_added_to_children(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);store=Store(root/'db');dataset='px-x-1506030100_203'
            metadata={'title':'Finance', 'variables':[
                {'code':'Year','values':['a'],'valueTexts':['2025'],'time':True},
                {'code':'Geschlecht','values':['1','2'],'valueTexts':['Men','Women']},
                {'code':'Hochschule','values':['0','01','02'],'valueTexts':['Hochschule - Total','ETHZ','EPFL']}]}
            with contextlib.redirect_stdout(io.StringIO()):collect(NumericClient({dataset:metadata}),store)
            export(store.path,root/'export')
            parity(root/'export',Explorer(store.path),[{'dataset':dataset,'compare':'Geschlecht','values':['1','2'],'filters':{'Hochschule':None}}],root/'parity.json')
            store.close()


class PublicationTests(unittest.TestCase):
    setUp = test_update_service.ScheduleTests.setUp
    tearDown = test_update_service.ScheduleTests.tearDown
    due = test_update_service.ScheduleTests.due
    # Reuse the real offline collection setup; no credentials or remote network in these tests.
    def test_push_failure_retries_without_collecting_and_survives_restart(self):
        sent=[]
        def sender(*args):
            sent.append(1)
            if len(sent)==1:raise OSError('Push failed')
            return {'commit':'abc'}
        root=Path(self.temp.name)
        publisher=Publisher(self.database,root=root,clock=lambda:self.now,sender=sender)
        self.worker.publisher=publisher
        self.assertTrue(publisher.tick());self.assertEqual(publisher.status()['last_error'],'Push failed')
        self.assertEqual(self.calls,0);self.assertFalse(publisher.tick())
        self.now+=timedelta(hours=1)
        publisher=Publisher(self.database,root=root,clock=lambda:self.now,sender=sender)
        self.assertTrue(publisher.tick());self.assertFalse(publisher.status()['pending']);self.assertEqual(self.calls,0)
        self.worker.publisher=publisher;self.due();self.worker.tick();self.assertTrue(publisher.status()['pending'])
        self.assertTrue(publisher.tick());self.assertEqual(self.calls,1)
        self.assertEqual(self.worker.status()['publication']['last_error'],None)

    def test_git_publisher_isolated_and_pushes_latest_only(self):
        root=Path(self.temp.name)/'source';root.mkdir();(root/'web').mkdir()
        (root/'web/index.html').write_text('committed frontend')
        def run(*args,cwd=root):
            return subprocess.run(['git',*args],cwd=cwd,check=True,capture_output=True,text=True).stdout
        run('init','--initial-branch=main');run('config','user.name','Test');run('config','user.email','test@example.com')
        run('add','web');run('commit','-m','Initial')
        remote=Path(self.temp.name)/'remote.git';run('init','--bare',str(remote));run('remote','add','origin',str(remote))
        (root/'web/index.html').write_text('uncommitted frontend must never be published')
        (root/'secret.txt').write_text('private local file')
        output=root/'web/data';export(self.database,output)
        checkout=root/'data/publishing';result=publish_files(root,output,checkout)
        self.assertTrue(result['commit']);self.assertEqual((checkout/'index.html').read_text(),'committed frontend')
        self.assertFalse((checkout/'secret.txt').exists());self.assertEqual(len(list((checkout/'data/releases').iterdir())),1)
        self.assertIn('M web/index.html',run('status','--short'))
        self.assertTrue(run('ls-remote','origin','gh-pages').strip())
