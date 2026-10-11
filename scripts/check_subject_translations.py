#!/usr/bin/env python3
"""Report source subject labels missing from the reviewed display dictionary."""

import argparse
import json
from pathlib import Path
import sqlite3
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
SUBJECT_DIMENSIONS = {'Fachrichtung', 'Fachbereich'}


def subject_labels(database):
    # Include historical completed snapshots: renamed labels still need translations.
    labels = set()
    with sqlite3.connect('file:' + quote(str(Path(database).resolve()), safe='/') + '?mode=ro', uri=True) as connection:
        for (metadata,) in connection.execute(
            "SELECT s.metadata_json FROM snapshots s JOIN collection_runs r ON r.id=s.collection_run_id "
            "WHERE r.status='complete' AND r.mode='download'"):
            for variable in json.loads(metadata)['variables']:
                if variable['code'] in SUBJECT_DIMENSIONS:
                    labels.update(variable['valueTexts'])
    return labels


def translation_gaps(labels, translations):
    return sorted(label for label in labels if not isinstance(translations.get(label), str) or not translations[label].strip())


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate translation key: ' + key)
        result[key] = value
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, default=ROOT / 'data/university_stats.sqlite3')
    parser.add_argument('--translations', type=Path, default=ROOT / 'web/subject-translations.json')
    args = parser.parse_args()
    document = json.loads(args.translations.read_text(), object_pairs_hook=unique_keys)
    if document.get('version') != 1 or not isinstance(document.get('translations'), dict):
        parser.error('Unsupported translation file format')
    translations = document['translations']
    invalid = [key for key, value in translations.items() if not isinstance(value, str) or not value.strip()]
    if invalid:
        parser.error('Empty or invalid English translations: ' + ', '.join(invalid))
    labels = subject_labels(args.database)
    missing = translation_gaps(labels, translations)
    print(json.dumps({'source_labels': len(labels), 'translated_labels': len(labels) - len(missing),
                      'missing': missing, 'unused': sorted(set(translations) - labels)}, ensure_ascii=False, indent=2))
    return 1 if missing else 0


if __name__ == '__main__':
    raise SystemExit(main())
