"""Persistent export/Git publishing, independently retryable from BFS collection."""
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import fcntl
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile

from scripts.export_static import export

ROOT = Path(__file__).resolve().parent


def utc_now():
    return datetime.now(timezone.utc)


def git(directory, *args, binary=False):
    environment = dict(os.environ, GIT_TERMINAL_PROMPT='0', GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=20')
    result = subprocess.run(['git', '-C', str(directory), *args], capture_output=True,
                            text=not binary, timeout=180, env=environment)
    if result.returncode:
        error = result.stderr.decode() if binary else result.stderr
        raise RuntimeError(error.strip()[-2000:] or 'Git command failed')
    return result.stdout


def publish_files(root, output, checkout, remote=None):
    """Only committed frontend assets and validated generated data enter gh-pages."""
    root, output, checkout = Path(root), Path(output), Path(checkout)
    remote = remote or git(root, 'remote', 'get-url', 'origin').strip()
    if not (checkout / '.git').is_dir():
        checkout.mkdir(parents=True, exist_ok=True)
        git(checkout, 'init', '--initial-branch=gh-pages')
        git(checkout, 'remote', 'add', 'origin', remote)
    elif git(checkout, 'remote', 'get-url', 'origin').strip() != remote:
        raise RuntimeError('Publishing checkout has a different origin')
    for key in ('user.name', 'user.email'):
        git(checkout, 'config', key, git(root, 'config', key).strip())
    # Never force push. Restore the last remote branch before preparing a new report;
    # this checkout is exclusively owned by the publisher, not the development tree.
    refs = git(checkout, 'ls-remote', '--heads', 'origin', 'gh-pages').strip()
    if refs:
        git(checkout, 'fetch', '--depth=1', 'origin', 'gh-pages')
        git(checkout, 'reset', '--hard', 'FETCH_HEAD')
    # Clear only the dedicated checkout's public files (never .git).
    for path in checkout.iterdir():
        if path.name == '.git': continue
        if path.is_dir(): shutil.rmtree(path)
        else: path.unlink()
    archive = git(root, 'archive', 'HEAD:web', binary=True)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(checkout, filter='data')
    index = json.loads((output / 'index.json').read_text())
    release = index['generation']
    target = checkout / 'data'; target.mkdir(exist_ok=True)
    shutil.copy2(output / 'index.json', target / 'index.json')
    (target / 'releases').mkdir(exist_ok=True)
    shutil.copytree(output / 'releases' / release, target / 'releases' / release)
    (checkout / '.nojekyll').touch()
    git(checkout, 'add', '--all')
    if git(checkout, 'diff', '--cached', '--name-only').strip():
        git(checkout, 'commit', '-m', 'Publish latest BFS university report')
    git(checkout, 'push', 'origin', 'HEAD:refs/heads/gh-pages')
    return {'generation': release, 'commit': git(checkout, 'rev-parse', 'HEAD').strip()}


class Publisher:
    def __init__(self, database, root=ROOT, clock=utc_now, exporter=export, sender=publish_files):
        self.database, self.root = Path(database), Path(root)
        self.clock, self.exporter, self.sender = clock, exporter, sender
        self.output = self.root / 'web/data'
        self.checkout = self.root / 'data/publishing'
        with self.connection() as c:
            c.execute('''CREATE TABLE IF NOT EXISTS publication_state (
                id INTEGER PRIMARY KEY CHECK(id=1), pending INTEGER NOT NULL DEFAULT 1,
                running INTEGER NOT NULL DEFAULT 0, last_attempt TEXT, last_success TEXT,
                last_error TEXT, next_retry TEXT, failures INTEGER NOT NULL DEFAULT 0,
                generation TEXT, commit_sha TEXT)''')
            c.execute('INSERT OR IGNORE INTO publication_state(id) VALUES(1)')

    @contextmanager
    def connection(self):
        c = sqlite3.connect(self.database, timeout=30); c.row_factory = sqlite3.Row
        try:
            with c: yield c
        finally: c.close()

    def request(self):
        with self.connection() as c:
            c.execute('UPDATE publication_state SET pending=1,next_retry=NULL WHERE id=1')

    def status(self):
        with self.connection() as c: return dict(c.execute('SELECT * FROM publication_state WHERE id=1').fetchone())

    def tick(self):
        state = self.status()
        if not state['pending'] or state['next_retry'] and self.clock() < datetime.fromisoformat(state['next_retry']):
            return False
        self.checkout.parent.mkdir(parents=True, exist_ok=True)
        with (self.checkout.parent / '.publishing.lock').open('a') as lock:
            try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: return False
            with self.connection() as c:
                c.execute('UPDATE publication_state SET running=1,last_attempt=? WHERE id=1', (self.clock().isoformat(),))
            try:
                from update_service import read_status
                report = read_status(self.database, enabled=True)
                report.pop('publication', None)  # Public report timestamps describe publication; push health is local.
                exported = self.exporter(self.database, self.output, status=report)
                sent = self.sender(self.root, self.output, self.checkout)
            except Exception as error:
                failures = state['failures'] + 1
                retry = self.clock() + timedelta(hours=min(24, 2 ** min(failures-1,5)))
                with self.connection() as c:
                    c.execute('''UPDATE publication_state SET running=0,pending=1,last_error=?,next_retry=?,failures=? WHERE id=1''',
                              (str(error)[-4000:], retry.isoformat(), failures))
                print('Static publication failed: ' + str(error), flush=True)
            else:
                with self.connection() as c:
                    c.execute('''UPDATE publication_state SET running=0,pending=0,last_success=?,last_error=NULL,
                        next_retry=NULL,failures=0,generation=?,commit_sha=? WHERE id=1''',
                              (self.clock().isoformat(), exported['generation'], sent.get('commit')))
                print('Static publication pushed: ' + exported['generation'], flush=True)
        return True
