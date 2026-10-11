#!/usr/bin/env python3
"""Serve the read-only university data explorer. No periodic collection worker."""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sqlite3
from urllib.parse import parse_qs, urlsplit

from explorer import Explorer

ROOT = Path(__file__).resolve().parent


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, explorer, **kwargs):
        self.explorer = explorer
        super().__init__(*args, directory=str(ROOT / 'web'), **kwargs)

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'same-origin')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; "
                         "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
        super().end_headers()

    def send_json(self, value, status=200):
        body = json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlsplit(self.path)
        if not url.path.startswith('/api/'):
            # Serve only known public assets; never expose the database or repository.
            if url.path not in ('/', '/index.html', '/app.js', '/normalize.js', '/pyramid.js', '/subjects.js', '/subject-translations.json', '/style.css', '/favicon.svg'):
                self.send_error(404)
                return
            return super().do_GET()
        try:
            query = parse_qs(url.query)
            if url.path == '/api/datasets':
                result = self.explorer.catalog()
            elif url.path == '/api/dataset':
                dataset = query.get('id', [''])[0]
                snapshot = query.get('snapshot', [None])[0]
                result = self.explorer.details(dataset, int(snapshot) if snapshot else None)
            elif url.path == '/api/series':
                encoded = query.get('query', [''])[0]
                if len(encoded) > 32_000:
                    raise ValueError('Query too large')
                result = self.explorer.series(json.loads(encoded))
            else:
                self.send_json({'error': 'Unknown endpoint'}, 404)
                return
            self.send_json(result)
        except LookupError as error:
            self.send_json({'error': str(error)}, 404)
        except (ValueError, TypeError) as error:
            self.send_json({'error': str(error)}, 400)
        except sqlite3.Error:
            self.send_json({'error': 'Database unavailable; check the service log'}, 503)


def create_server(host, port, database):
    return ThreadingHTTPServer((host, port), partial(Handler, explorer=Explorer(database)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='0.0.0.0')
    parser.add_argument('--port', type=int, default=8768)
    parser.add_argument('--database', type=Path, default=ROOT / 'data/university_stats.sqlite3')
    args = parser.parse_args()
    if not args.database.is_file():
        parser.error('Database is missing. Run python3 scripts/fetch_bfs.py first.')
    server = create_server(args.host, args.port, args.database)
    print(f'University data explorer on http://{args.host}:{server.server_port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
