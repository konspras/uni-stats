"""Verify exhaustive chunking and incomplete-snapshot handling offline."""

import csv
import itertools
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from fetch_bfs import download_table, selections, validate_response


METADATA = {"title": "Example", "variables": [
    {"code": "Year", "values": ["0", "1", "2"], "valueTexts": ["2023", "2024", "2025"]},
    {"code": "University", "values": ["01", "02"], "valueTexts": ["ETHZ", "EPFL"]},
]}


def response_for(query):
    return {"columns": [{"code": q["code"], "type": "d"} for q in query]
            + [{"code": "Students", "type": "c"}],
            "data": [{"key": list(key), "values": [".." if key[1] == "02" else "0"]}
                     for key in itertools.product(*(q["selection"]["values"] for q in query))],
            "comments": [{"text": "Missing value marker preserved"}],
            "metadata": [{"source": "Example provider"}]}


class FakeClient:
    def __init__(self, fail_on=None):
        self.calls = 0
        self.fail_on = fail_on

    def request(self, url, payload):
        self.calls += 1
        if self.calls == self.fail_on:
            raise OSError("interrupted connection")
        return response_for(payload["query"])


class FetchTests(unittest.TestCase):
    def test_chunks_cover_every_coordinate_once_and_respect_limit(self):
        coordinates = []
        for query in selections(METADATA, 2):
            chunk = list(itertools.product(*(q["selection"]["values"] for q in query)))
            self.assertLessEqual(len(chunk), 2)
            coordinates.extend(chunk)
        expected = set(itertools.product(["0", "1", "2"], ["01", "02"]))
        self.assertEqual(set(coordinates), expected)
        self.assertEqual(len(coordinates), len(expected))

    def test_rejects_duplicate_rows_and_incomplete_responses(self):
        query = next(selections(METADATA, 100))
        response = response_for(query)
        response["data"][-1] = response["data"][0]
        with self.assertRaisesRegex(ValueError, "duplicate"):
            validate_response(response, query)
        response = response_for(query)
        response["data"].pop()
        with self.assertRaisesRegex(ValueError, "incomplete"):
            validate_response(response, query)

    def test_rejects_unexpected_codes_and_changing_columns(self):
        query = next(selections(METADATA, 100))
        response = response_for(query)
        response["data"][0]["key"][1] = "999"
        with self.assertRaisesRegex(ValueError, "outside"):
            validate_response(response, query)
        with self.assertRaisesRegex(ValueError, "columns changed"):
            validate_response(response_for(query), query, [{"code": "Old"}])

    def test_snapshot_retains_source_codes_missing_markers_and_metadata(self):
        table = {"table_id": "test", "metadata": METADATA,
                 "api_url": "https://example.test", "catalog": {"updated": "2026-10-10"}}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = download_table(FakeClient(), table, root, 2)
            with (root / "test/data.csv").open() as source:
                rows = list(csv.DictReader(source))
            self.assertEqual(result["rows"], 6)
            self.assertEqual({r["University"] for r in rows}, {"01", "02"})
            self.assertEqual({r["Students"] for r in rows}, {"0", ".."})
            self.assertEqual(json.loads((root / "test/metadata.json").read_text()), METADATA)
            self.assertTrue(list((root / "test/responses").glob("*.json.gz")))
            self.assertFalse((root / "test.partial").exists())

    def test_interrupted_download_does_not_publish_or_touch_previous_snapshot(self):
        table = {"table_id": "test", "metadata": METADATA,
                 "api_url": "https://example.test", "catalog": {}}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            previous = root / "previous"
            previous.mkdir()
            download_table(FakeClient(), table, previous, 2)
            original = (previous / "test/data.csv").read_bytes()
            current = root / "current"
            current.mkdir()
            with self.assertRaises(OSError):
                download_table(FakeClient(fail_on=2), table, current, 2)
            self.assertFalse((current / "test").exists())
            self.assertTrue((current / "test.partial").exists())
            self.assertEqual((previous / "test/data.csv").read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
