"""Offline scheduler, recovery and collector integration checks."""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import contextlib
import io
import tempfile
import unittest

from update_service import UpdateWorker, ZURICH, next_sunday, read_status
from test_bfs_sqlite import OfflineClient, METADATA, TABLE
from scripts.bfs_store import Store
from scripts.fetch_bfs import collect


class ScheduleTests(unittest.TestCase):
    def test_sunday_and_daylight_saving(self):
        for source, expected in [('2026-10-11T12:59:59+00:00', '2026-10-11T13:00:00+00:00'),
                                 ('2026-10-11T13:00:00+00:00', '2026-10-18T13:00:00+00:00'),
                                 ('2026-10-24T13:00:00+00:00', '2026-10-25T14:00:00+00:00'),
                                 ('2027-03-27T14:00:00+00:00', '2027-03-28T13:00:00+00:00')]:
            self.assertEqual(next_sunday(datetime.fromisoformat(source)).isoformat(),expected)

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.database=Path(self.temp.name)/'data.sqlite3'
        with contextlib.redirect_stdout(io.StringIO()):
            store=Store(self.database);collect(OfflineClient(),store);store.close()
        self.now=datetime(2026,10,11,12,tzinfo=timezone.utc)
        self.calls=0
        self.client=OfflineClient()
        def runner(database):
            self.calls+=1
            store=Store(database)
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    result=collect(self.client,store)
                if result['status']=='failed':raise RuntimeError(result['error'])
                return result['status']
            finally:store.close()
        self.worker=UpdateWorker(self.database,clock=lambda:self.now,runner=runner)

    def tearDown(self):
        self.worker.stop();self.temp.cleanup()

    def due(self):
        with self.worker.connection() as connection:
            connection.execute('UPDATE update_schedule SET next_due=? WHERE id=1',(self.now.isoformat(),))

    def test_due_skip_and_persisted_restart(self):
        self.assertFalse(self.worker.tick());self.assertEqual(self.calls,0)
        self.now+=timedelta(hours=1)
        self.assertTrue(self.worker.tick());self.assertEqual(self.calls,1)
        self.assertEqual(self.client.posts,0,'Unchanged source only reads metadata')
        with self.worker.connection() as c:self.assertEqual(c.execute('SELECT COUNT(*) FROM snapshots').fetchone()[0],1)
        self.assertEqual(self.worker.status()['last_result'],'skipped')
        second=UpdateWorker(self.database,clock=lambda:self.now,runner=self.worker.runner)
        self.assertFalse(second.tick(),'Restart does not repeat completed check')
        self.now+=timedelta(days=21)
        self.assertTrue(second.tick(),'One overdue check after downtime')
        self.assertFalse(second.tick(),'Missed weeks do not fabricate extra snapshots')
        self.assertEqual(self.calls,2)

    def test_new_period_creates_full_snapshot(self):
        import copy
        metadata=copy.deepcopy(METADATA)
        metadata['variables'][0]['values'].append('3');metadata['variables'][0]['valueTexts'].append('2026')
        self.client=OfflineClient({TABLE:metadata})
        self.due();self.worker.tick()
        with self.worker.connection() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM snapshots').fetchone()[0],2)
        self.assertEqual(self.worker.status()['last_result'],'complete')
        self.assertGreater(self.client.posts,0)

    def test_failure_retry_recovery_and_previous_snapshots(self):
        def failure(database):raise OSError('Source unavailable')
        success=self.worker.runner;self.worker.runner=failure
        self.due();self.worker.tick()
        status=self.worker.status()
        self.assertEqual(status['last_error'],'Source unavailable')
        self.assertEqual(status['last_result'],'failed')
        self.assertEqual(datetime.fromisoformat(status['next_retry']),self.now+timedelta(hours=1))
        self.assertFalse(self.worker.tick())
        self.now+=timedelta(hours=1);self.worker.tick()
        self.assertEqual(self.worker.status()['failures'],2)
        self.worker.runner=success
        self.now+=timedelta(hours=2);self.worker.tick()
        status=self.worker.status();self.assertIsNone(status['last_error']);self.assertIsNone(status['next_retry'])
        with self.worker.connection() as c:self.assertEqual(c.execute('SELECT COUNT(*) FROM snapshots').fetchone()[0],1)

    def test_worker_lock_and_interrupted_recovery(self):
        with self.worker.connection() as c:c.execute('UPDATE update_schedule SET running=1 WHERE id=1')
        self.worker.start()
        self.assertTrue(self.worker.status()['worker_active'])
        self.assertIn('interrupted',self.worker.status()['last_error'])
        other=UpdateWorker(self.database,clock=lambda:self.now)
        with self.assertRaisesRegex(RuntimeError,'already running'):other.start()
        self.worker.stop()
        self.assertFalse(self.worker.status()['worker_active'])

    def test_http_serves_previous_snapshot_while_collection_is_running(self):
        import copy
        import json
        import threading
        from urllib.request import urlopen
        from server import create_server
        metadata=copy.deepcopy(METADATA)
        metadata['variables'][0]['values'].append('3');metadata['variables'][0]['valueTexts'].append('2026')
        self.client=OfflineClient({TABLE:metadata})
        entered=threading.Event();release=threading.Event()
        self.client.on_post=lambda:(entered.set(),release.wait(5))
        self.due()
        server=create_server('127.0.0.1',0,self.database,self.worker)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.worker.start()
        try:
            self.assertTrue(entered.wait(2))
            base='http://127.0.0.1:'+str(server.server_port)
            with urlopen(base+'/api/update-status',timeout=2) as response:
                status=json.load(response)
            self.assertTrue(status['running']);self.assertTrue(status['worker_active'])
            with urlopen(base+'/api/dataset?id='+TABLE,timeout=2) as response:
                detail=json.load(response)
            self.assertEqual(detail['metadata'],METADATA,'Reader retains previous published snapshot')
            self.assertEqual(len(detail['snapshots']),1)
        finally:
            release.set();self.worker.stop();server.shutdown();server.server_close();thread.join(2)

    def test_manual_status_is_read_only(self):
        status=read_status(self.database)
        self.assertFalse(status['enabled']);self.assertIsNotNone(status['latest_snapshot'])
        self.assertEqual(status['last_result'],'complete')

if __name__=='__main__':unittest.main()
