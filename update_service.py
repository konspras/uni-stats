"""Weekly BFS collection worker and persistent website status (Europe/Zurich)."""

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import fcntl
from pathlib import Path
import sqlite3
import subprocess
import sys
import threading
from zoneinfo import ZoneInfo

ZURICH = ZoneInfo('Europe/Zurich')
ROOT = Path(__file__).resolve().parent


def now_utc():
    return datetime.now(timezone.utc)


def next_sunday(now):
    local = now.astimezone(ZURICH)
    day = local.date() + timedelta(days=(6 - local.weekday()) % 7)
    candidate = datetime(day.year, day.month, day.day, 15, tzinfo=ZURICH)
    if candidate <= local:
        day += timedelta(days=7)
        candidate = datetime(day.year, day.month, day.day, 15, tzinfo=ZURICH)
    return candidate.astimezone(timezone.utc)


def run_fetch(database):
    # The existing fetcher owns the collection lock, transactions and recovery.
    with sqlite3.connect(database) as connection:
        before = connection.execute('SELECT COALESCE(MAX(id),0) FROM collection_runs').fetchone()[0]
    result = subprocess.run([sys.executable, str(ROOT / 'scripts/fetch_bfs.py'),
                             '--database', str(database)], stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, timeout=6 * 60 * 60)
    print(result.stdout, end='', flush=True)
    with sqlite3.connect(database) as connection:
        connection.row_factory = sqlite3.Row
        run = connection.execute('SELECT * FROM collection_runs WHERE id>? ORDER BY id DESC LIMIT 1',
                                 (before,)).fetchone()
    if result.returncode or run is None or run['status'] not in ('complete', 'skipped'):
        raise RuntimeError((run['error'] if run is not None else None) or
                           result.stdout[-2000:] or 'Collector did not complete successfully')
    return run['status']


class UpdateWorker:
    def __init__(self, database, clock=now_utc, runner=run_fetch):
        self.database = Path(database).resolve()
        self.clock, self.runner = clock, runner
        self.stop_event = threading.Event()
        self.thread = None
        self.lock = None
        self.runtime_error = None
        with self.connection() as connection:
            connection.execute('''CREATE TABLE IF NOT EXISTS update_schedule (
                id INTEGER PRIMARY KEY CHECK(id=1), next_due TEXT NOT NULL,
                retry_due TEXT, last_attempt TEXT, last_success TEXT,
                last_result TEXT, last_error TEXT, failures INTEGER NOT NULL DEFAULT 0,
                running INTEGER NOT NULL DEFAULT 0)''')
            connection.execute('INSERT OR IGNORE INTO update_schedule(id,next_due) VALUES(1,?)',
                               (next_sunday(self.clock()).isoformat(),))

    @contextmanager
    def connection(self):
        connection = sqlite3.connect(self.database, timeout=30)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def start(self):
        self.lock = self.database.with_name(self.database.name + '.schedule.lock').open('a')
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.lock.close(); self.lock = None
            raise RuntimeError('Another automatic-update worker is already running')
        # With the worker lock held, a persisted running flag belongs to a stopped worker.
        with self.connection() as connection:
            state = connection.execute('SELECT * FROM update_schedule WHERE id=1').fetchone()
        if state['running']:
            self.record_failure('Previous automatic check was interrupted')
        self.thread = threading.Thread(target=self.loop, name='bfs-weekly-updates', daemon=True)
        self.thread.start()
        print('Automatic BFS updates enabled: Sundays 15:00 Europe/Zurich; next check '
              + self.status()['next_check'], flush=True)

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=2)
        # Do not release ownership while a collector thread is still active.
        if self.lock and not (self.thread and self.thread.is_alive()):
            self.lock.close(); self.lock = None

    def loop(self):
        while not self.stop_event.is_set():
            try:
                self.tick()
                self.runtime_error = None
            except Exception as error:
                self.runtime_error = str(error)
                print('Automatic update worker error: ' + str(error), flush=True)
            self.stop_event.wait(30)

    def tick(self):
        with self.connection() as connection:
            state = connection.execute('SELECT * FROM update_schedule WHERE id=1').fetchone()
        deadlines = [datetime.fromisoformat(state['next_due'])]
        if state['retry_due']:
            deadlines.append(datetime.fromisoformat(state['retry_due']))
        if self.clock() < min(deadlines):
            return False
        with self.connection() as connection:
            connection.execute('UPDATE update_schedule SET running=1,last_attempt=? WHERE id=1',
                               (self.clock().isoformat(),))
        print('Starting scheduled BFS metadata check', flush=True)
        try:
            result = self.runner(self.database)
            if result not in ('complete', 'skipped'):
                raise RuntimeError('Collector returned unsuccessful status: ' + str(result))
        except Exception as error:
            self.record_failure(str(error))
            print('Scheduled BFS check failed: ' + str(error), flush=True)
        else:
            finished = self.clock()
            with self.connection() as connection:
                connection.execute('''UPDATE update_schedule SET running=0,next_due=?,retry_due=NULL,
                    last_success=?,last_result=?,last_error=NULL,failures=0 WHERE id=1''',
                    (next_sunday(finished).isoformat(), finished.isoformat(), result))
            print('Scheduled BFS check ' + result, flush=True)
        return True

    def record_failure(self, error):
        finished = self.clock()
        with self.connection() as connection:
            failures = connection.execute('SELECT failures FROM update_schedule WHERE id=1').fetchone()[0] + 1
            retry = finished + timedelta(hours=2 ** min(failures - 1, 5) if failures < 6 else 24)
            connection.execute('''UPDATE update_schedule SET running=0,next_due=?,retry_due=?,
                last_result='failed',last_error=?,failures=? WHERE id=1''',
                (next_sunday(finished).isoformat(), retry.isoformat(), error[:4000], failures))

    def status(self):
        status = read_status(self.database, enabled=True)
        status['worker_active'] = bool(self.thread and self.thread.is_alive())
        if self.runtime_error:
            status['last_error'] = self.runtime_error
        return status


def read_status(database, enabled=False):
    # The API remains read-only, including when automatic collection is disabled.
    from explorer import Explorer
    with Explorer(database).connection() as connection:
        has_schedule = connection.execute("SELECT 1 FROM sqlite_master WHERE name='update_schedule'").fetchone()
        schedule_row = connection.execute('SELECT * FROM update_schedule WHERE id=1').fetchone() if has_schedule else None
        state = dict(schedule_row) if schedule_row else {}
        attempt = connection.execute("SELECT * FROM collection_runs WHERE mode IN ('download','check') ORDER BY id DESC LIMIT 1").fetchone()
        success = connection.execute("SELECT finished_at FROM collection_runs WHERE mode IN ('download','check') AND status IN ('complete','skipped') ORDER BY id DESC LIMIT 1").fetchone()
        snapshot = connection.execute('SELECT MAX(fetched_at) FROM latest_snapshots').fetchone()[0]
    next_check = min(filter(None, [state.get('next_due'), state.get('retry_due')]), default=None)
    error = state.get('last_error')
    if attempt and attempt['status'] in ('failed', 'interrupted'):
        error = error or attempt['error']
    attempts = [v for v in [state.get('last_attempt'), attempt['started_at'] if attempt else None] if v]
    successes = [v for v in [state.get('last_success'), success['finished_at'] if success else None] if v]
    last_result = 'running' if state.get('running') else 'failed' if state.get('last_error') else attempt['status'] if attempt else state.get('last_result')
    return {'enabled': enabled, 'worker_active': False, 'schedule': 'Sundays at 15:00',
            'timezone': 'Europe/Zurich', 'next_check': next_check,
            'next_scheduled_check': state.get('next_due'), 'next_retry': state.get('retry_due'),
            'last_check': max(attempts, key=datetime.fromisoformat) if attempts else None,
            'last_success': max(successes, key=datetime.fromisoformat) if successes else None,
            'latest_snapshot': snapshot, 'last_result': last_result,
            'last_error': error, 'failures': state.get('failures', 0), 'running': bool(state.get('running'))}
