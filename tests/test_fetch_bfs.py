"""Verify exhaustive chunking and incomplete-snapshot handling offline."""

import csv
import copy
import itertools
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from fetch_bfs import (collect, download_table, new_data_reasons, selections,
                       successful_baselines, validate_response)


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


class NewDataTests(unittest.TestCase):
    def setUp(self):
        self.metadata = copy.deepcopy(METADATA)
        self.metadata["variables"][0]["time"] = True
        self.metadata["variables"][1]["code"] = "Hochschule"
        self.table = {"table_id": "test", "metadata": self.metadata,
                      "api_url": "https://example.test", "catalog": {"updated": "2025-01-01"}}
        self.baselines = {"test": {"metadata": copy.deepcopy(self.metadata), "snapshot": "previous"}}

    def save_baseline(self, root, name="20250101", status="complete", mode="download", metadata=None):
        directory = root / name
        directory.mkdir()
        (directory / "manifest.json").write_text(json.dumps({
            "mode": mode, "status": status, "datasets": [{"table_id": "test", "status": status}]}))
        table = dict(self.table, metadata=metadata or self.metadata)
        (directory / "inventory.json").write_text(json.dumps([table]))

    def run_collection(self, root, check_only=False):
        run = root / "20261010"
        run.mkdir()
        metadata = self.metadata

        class MetadataClient(FakeClient):
            def request(self, url, payload=None):
                if payload is None:
                    return metadata
                return super().request(url, payload)

        client = MetadataClient()
        with patch("fetch_bfs.discover", return_value=[copy.deepcopy(self.table)]):
            manifest = collect(client, run, [], 100, False, check_only)
        return manifest, client.calls, run

    def test_revisions_categories_and_code_renumbering_do_not_trigger(self):
        self.table["catalog"]["updated"] = "2026-10-10"
        self.metadata["title"] = "Updated title"
        self.metadata["variables"][0]["values"] = ["7", "8", "9"]
        self.metadata["variables"][1]["values"].append("03")
        self.metadata["variables"][1]["valueTexts"].append("New university category")
        self.assertEqual(new_data_reasons([self.table], self.baselines), [])

    def test_added_year_historical_period_and_table_trigger(self):
        self.metadata["variables"][0]["valueTexts"].append("2026")
        self.metadata["variables"][0]["values"].append("3")
        reasons = new_data_reasons([self.table], self.baselines)
        self.assertEqual(reasons[0]["periods"], ["2026"])
        self.metadata["variables"][0]["valueTexts"][-1] = "1980"
        self.assertEqual(new_data_reasons([self.table], self.baselines)[0]["periods"], ["1980"])
        self.assertEqual(new_data_reasons([dict(self.table, table_id="new")], self.baselines)[0]["reason"],
                         "new_table_or_initial_download")

    def test_removed_periods_do_not_trigger(self):
        for field in ("values", "valueTexts"):
            self.metadata["variables"][0][field].pop()
        self.assertEqual(new_data_reasons([self.table], self.baselines), [])

    def test_unrecognizable_time_schema_fails_instead_of_downloading(self):
        self.metadata["variables"][0]["code"] = "Changed"
        with self.assertRaisesRegex(ValueError, "time dimensions changed"):
            new_data_reasons([self.table], self.baselines)
        self.metadata["variables"][0].pop("time")
        with self.assertRaisesRegex(ValueError, "no time dimension"):
            new_data_reasons([self.table], self.baselines)

    def test_skip_issues_no_data_requests_or_csv_and_keeps_baseline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.save_baseline(root)
            manifest, posts, run = self.run_collection(root)
            self.assertEqual(manifest["status"], "skipped")
            self.assertEqual(posts, 0)
            self.assertFalse(list(run.rglob("*.csv")))
            self.assertEqual(manifest["totals"]["rows"], 0)
            self.assertEqual(successful_baselines(root)["test"]["snapshot"], "20250101")

    def test_initial_run_downloads_and_publishes_csv(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest, posts, run = self.run_collection(Path(directory))
            self.assertEqual(manifest["status"], "complete")
            self.assertGreater(posts, 0)
            self.assertTrue((run / "test/data.csv").exists())

    def test_new_year_downloads_complete_table_not_only_new_year(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.save_baseline(root)
            self.metadata["variables"][0]["values"].append("3")
            self.metadata["variables"][0]["valueTexts"].append("2026")
            manifest, posts, run = self.run_collection(root)
            self.assertEqual(manifest["status"], "complete")
            self.assertGreater(posts, 0)
            with (run / "test/data.csv").open() as source:
                self.assertEqual(len(list(csv.DictReader(source))), 8)

    def test_check_only_and_failed_runs_never_advance_baseline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.save_baseline(root)
            self.metadata["variables"][0]["values"].append("3")
            self.metadata["variables"][0]["valueTexts"].append("2026")
            self.save_baseline(root, "20260101", status="failed")
            self.save_baseline(root, "20260102", mode="inventory")
            manifest, posts, run = self.run_collection(root, check_only=True)
            self.assertEqual(manifest["status"], "complete")
            self.assertTrue(manifest["new_data"])
            self.assertEqual(posts, 0)
            self.assertFalse(list(run.rglob("*.csv")))
            self.assertEqual(successful_baselines(root)["test"]["snapshot"], "20250101")


if __name__ == "__main__":
    unittest.main()
