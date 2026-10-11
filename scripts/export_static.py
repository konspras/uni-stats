#!/usr/bin/env python3
"""Export latest successful snapshots as validated university CSV shards."""
import argparse
import csv
from decimal import Decimal, localcontext
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from explorer import Explorer, numeric_value
from scripts.bfs_store import identifier
from update_service import read_status

FORMAT = 1
ALL_SUBJECTS = '__all_subjects__'


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')) + '\n', encoding='utf-8')


def csv_bytes(header, rows):
    stream = io.StringIO(newline='')
    writer = csv.writer(stream, lineterminator='\n')
    writer.writerow(header)
    writer.writerows(rows)
    return stream.getvalue().encode('utf-8')


def write_csv(directory, name, header, rows):
    body = csv_bytes(header, rows)
    # Independently parse the file representation: every cell must survive CSV round trips.
    parsed = list(csv.reader(io.StringIO(body.decode('utf-8'), newline='')))
    if parsed != [header, *[list(row) for row in rows]]:
        raise ValueError('CSV round-trip validation failed: ' + name)
    compressed = gzip.compress(body, compresslevel=6, mtime=0)
    (directory / name).write_bytes(body)
    (directory / (name + '.gz')).write_bytes(compressed)
    return {'path': name, 'bytes': len(body), 'gzip_bytes': len(compressed),
            'sha256': hashlib.sha256(body).hexdigest(), 'rows': len(rows)}


def subject_totals(detail, header, rows, subject):
    position = header.index(subject)
    measures = [c['code'] for c in detail['columns'] if c['type'] == 'c']
    dimension_positions = [header.index(v['code']) for v in detail['metadata']['variables'] if v['code'] != subject]
    grouped = {}
    for row in rows:
        key = tuple(row[i] for i in dimension_positions)
        grouped.setdefault(key, []).append(row)
    expected = len(detail['aggregation_options'][subject]['values'])
    output = []
    with localcontext() as context:
        context.prec = 400
        for parts in grouped.values():
            row = list(parts[0]); row[position] = ALL_SUBJECTS
            missing = []
            for measure in measures:
                i = header.index(measure)
                absent = expected - len(parts) + sum(numeric_value(p[i]) is None for p in parts)
                missing.append(str(absent))
                row[i] = '' if absent else format(sum((Decimal(p[i]) for p in parts), Decimal(0)), 'f')
            output.append(row + [str(expected)] + missing)
    return header + ['__weight'] + ['__missing_' + m for m in measures], output


def export(database, output, status=None):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    explorer = Explorer(database)
    stage = Path(tempfile.mkdtemp(prefix='.export-', dir=output))
    try:
        catalog = explorer.catalog()
        # Explicit snapshot IDs pin all datasets to a single catalog even if collection commits meanwhile.
        signature = hashlib.sha256(json.dumps([(d['id'], d['snapshot_id']) for d in catalog['datasets']]).encode()).hexdigest()[:20]
        generation = 'v' + str(FORMAT) + '-' + signature
        destination = output / 'releases' / generation
        if destination.is_dir():
            stored = json.loads((destination / 'manifest.json').read_text())
            if stored['catalog'] != catalog:
                raise ValueError('Immutable export metadata mismatch')
            # Reuse unchanged snapshots; validate files without rerunning database aggregations.
            files = 0
            for metadata_path in stored['datasets'].values():
                path = output / metadata_path
                detail = json.loads(path.read_text())
                for versions in detail['static_files'].values():
                    for file in versions.values():
                        body = (path.parent / file['path']).read_bytes()
                        if hashlib.sha256(body).hexdigest() != file['sha256']:
                            raise ValueError('Export checksum mismatch')
                        if gzip.decompress((path.parent / (file['path'] + '.gz')).read_bytes()) != body:
                            raise ValueError('Compressed export mismatch')
                        files += 1
            report = dict(status if status is not None else read_status(database))
            report.update(kind='published', reported_at=datetime.now(timezone.utc).isoformat(),
                          latest_snapshot=max((d['fetched_at'] for d in catalog['datasets']), default=None))
            write_json(stage / 'index.json', {'format': FORMAT, 'generation': generation,
                       'manifest': 'releases/' + generation + '/manifest.json', 'status': report})
            os.replace(stage / 'index.json', output / 'index.json')
            return {'generation': generation, 'datasets': len(catalog['datasets']),
                    'rows': sum(d['rows'] for d in catalog['datasets']), 'files': files, 'output': str(output)}
        release = stage / generation; release.mkdir()
        manifest = {'format': FORMAT, 'generation': generation, 'catalog': catalog, 'datasets': {}}
        total_rows = 0
        for dataset in catalog['datasets']:
            detail = explorer.details(dataset['id'], dataset['snapshot_id'])
            detail['snapshots'] = [s for s in detail['snapshots'] if s['id'] == detail['snapshot_id']]
            directory = release / dataset['id']; directory.mkdir()
            header = [c['code'] for c in detail['columns']]
            variables = detail['metadata']['variables']
            university = next((v for v in variables if v['code'] == 'Hochschule'), None)
            subject = next((v['code'] for v in variables if v['code'] in ('Fachrichtung', 'Fachbereich')
                            and detail['aggregation_options'].get(v['code'], {}).get('mode') == 'sum'), None)
            by_university = {}
            with explorer.connection() as connection:
                snapshot = explorer.snapshot(connection, detail['id'], detail['snapshot_id'])
                columns = ','.join(identifier(c) for c in header)
                order = ','.join(identifier(v['code']) for v in variables)
                for source_row in connection.execute('SELECT ' + columns + ' FROM ' + identifier(snapshot['table_name'])
                                                    + ' WHERE snapshot_id=? ORDER BY ' + order, (detail['snapshot_id'],)):
                    row = list(source_row)
                    key = row[header.index('Hochschule')] if university else '*'
                    by_university.setdefault(key, []).append(row)
            if sum(map(len, by_university.values())) != detail['rows']:
                raise ValueError('Incomplete snapshot export: ' + detail['id'])
            files = {}
            for index, (code, rows) in enumerate(by_university.items()):
                files[code] = {'raw': write_csv(directory, str(index) + '.csv', header, rows)}
                if subject:
                    total_header, totals = subject_totals(detail, header, rows, subject)
                    files[code]['subject_totals'] = write_csv(directory, str(index) + '-totals.csv', total_header, totals)
            detail['static_files'] = files
            detail['precomputed_subject'] = subject
            write_json(directory / 'metadata.json', detail)
            manifest['datasets'][detail['id']] = 'releases/' + generation + '/' + detail['id'] + '/metadata.json'
            total_rows += detail['rows']
        write_json(release / 'manifest.json', manifest)
        destination = output / 'releases' / generation
        destination.parent.mkdir(exist_ok=True)
        if destination.exists():
            # The same snapshots must produce identical bytes. Changed metadata/export logic requires FORMAT bump.
            for path in release.rglob('*'):
                if path.is_file() and (not (destination / path.relative_to(release)).is_file()
                                       or path.read_bytes() != (destination / path.relative_to(release)).read_bytes()):
                    raise ValueError('Export generation changed without a format bump: ' + str(path))
        else:
            os.replace(release, destination)
        report = dict(status if status is not None else read_status(database))
        report.update(kind='published', reported_at=datetime.now(timezone.utc).isoformat(),
                          latest_snapshot=max((d['fetched_at'] for d in catalog['datasets']), default=None))
        # Embed status in the atomic index: no mixed-generation catalog/status pair.
        index = {'format': FORMAT, 'generation': generation,
                 'manifest': 'releases/' + generation + '/manifest.json', 'status': report}
        write_json(stage / 'index.json', index)
        os.replace(stage / 'index.json', output / 'index.json')
        return {'generation': generation, 'datasets': len(catalog['datasets']), 'rows': total_rows,
                'files': sum(1 for p in destination.rglob('*.csv')), 'output': str(output)}
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, default=ROOT / 'data/university_stats.sqlite3')
    parser.add_argument('--output', type=Path, default=ROOT / 'web/data')
    args = parser.parse_args()
    print(json.dumps(export(args.database, args.output)))


if __name__ == '__main__':
    main()
