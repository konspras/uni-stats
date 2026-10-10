#!/usr/bin/env python3
"""Collect complete BFS university snapshots in SQLite when new periods/tables appear."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import fcntl
import json
import math
from pathlib import Path
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen
import sqlite3

from bfs_store import Store


API = "https://www.pxweb.bfs.admin.ch/api/v1/de/"
# University students/entrants, degrees, staff, and financial reporting.
# FH/PH tables and national-only tables without an institution dimension
# are outside this initial university inventory.
PREFIXES = (
    "px-x-1502040100_", "px-x-1503040100_", "px-x-1504040100_",
    "px-x-1506030100_",
)
EXTRA_DATABASES = {"px-x-1506030000_201", "px-x-1506030000_202"}


def utc_now():
    return datetime.now(timezone.utc).isoformat()


class Client:
    def __init__(self, interval=0.4, timeout=90, attempts=4):
        self.interval, self.timeout, self.attempts = interval, timeout, attempts
        self.last_request = 0.0

    def request(self, url, payload=None):
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        for attempt in range(self.attempts):
            time.sleep(max(0, self.interval - (time.monotonic() - self.last_request)))
            self.last_request = time.monotonic()
            request = Request(url, data=body, headers={
                "Content-Type": "application/json", "Accept": "application/json",
                "User-Agent": "uni-stats-bfs-downloader/1.0",
            })
            try:
                with urlopen(request, timeout=self.timeout) as response:
                    return json.load(response)
            except HTTPError as error:
                if error.code not in (429, 500, 502, 503, 504) or attempt + 1 == self.attempts:
                    raise
                retry_after = error.headers.get("Retry-After", "")
                delay = float(retry_after) if retry_after.isdigit() else 2 ** (attempt + 1)
            except (URLError, TimeoutError, ConnectionError):
                if attempt + 1 == self.attempts:
                    raise
                delay = 2 ** (attempt + 1)
            time.sleep(delay)
        raise RuntimeError("request attempts exhausted")


def discover(client, selected=()):
    root = client.request(API)
    databases = [item["dbid"] for item in root if
                 item["dbid"].startswith(PREFIXES) or item["dbid"] in EXTRA_DATABASES]
    tables = []
    for database in sorted(databases):
        for entry in client.request(API + quote(database) + "/"):
            if entry.get("type") == "t":
                table_id = entry["id"].removesuffix(".px")
                if not selected or table_id in selected:
                    tables.append({"database": database, "table_id": table_id,
                                   "catalog": entry,
                                   "api_url": API + quote(database) + "/" + quote(entry["id"])})
    unknown = set(selected) - {item["table_id"] for item in tables}
    if unknown:
        raise ValueError(f"tables outside the discovered university inventory: {sorted(unknown)}")
    return tables


def selections(metadata, max_cells):
    """Partition the full Cartesian selection into disjoint bounded requests."""
    initial = [(v["code"], list(v["values"])) for v in metadata["variables"]]
    if not initial or any(not values for _, values in initial):
        raise ValueError("empty source dimensions")

    def split(parts):
        if math.prod(len(values) for _, values in parts) <= max_cells:
            yield [{"code": code, "selection": {"filter": "item", "values": values}}
                   for code, values in parts]
            return
        index = max(range(len(parts)), key=lambda i: len(parts[i][1]))
        code, values = parts[index]
        middle = len(values) // 2
        for subset in (values[:middle], values[middle:]):
            yield from split(parts[:index] + [(code, subset)] + parts[index + 1:])

    yield from split(initial)


def validate_response(response, query, previous_columns=None):
    columns = response["columns"]
    dimension_columns = [c["code"] for c in columns if c["type"] != "c"]
    measure_columns = [c["code"] for c in columns if c["type"] == "c"]
    requested = {item["code"]: set(item["selection"]["values"]) for item in query}
    if set(dimension_columns) != set(requested) or not measure_columns:
        raise ValueError("unexpected response dimensions or missing measure")
    if previous_columns is not None and columns != previous_columns:
        raise ValueError("response columns changed between chunks")
    expected_rows = math.prod(len(values) for values in requested.values())
    if len(response["data"]) != expected_rows:
        raise ValueError(f"incomplete response: {len(response['data'])} rows, expected {expected_rows}")
    seen = set()
    for row in response["data"]:
        key = tuple(row["key"])
        if len(key) != len(dimension_columns) or len(row["values"]) != len(measure_columns):
            raise ValueError("row width differs from source columns")
        if key in seen:
            raise ValueError("duplicate source coordinate")
        seen.add(key)
        if any(value not in requested[code] for code, value in zip(dimension_columns, key)):
            raise ValueError("source coordinate outside requested selection")
        if any(not isinstance(v, str) for v in row["values"]):
            raise ValueError("non-string value: preserve source markers rather than coerce them")
    return columns


def download_table(client, table, store, run_id, max_cells):
    """Stream validated API chunks into the current collection transaction."""
    columns, snapshot_id, table_name, chunks = None, None, None, 0
    started_at = utc_now()
    for chunks, query in enumerate(selections(table["metadata"], max_cells), start=1):
        payload = {"query": query, "response": {"format": "json"}}
        response = client.request(table["api_url"], payload)
        new_columns = validate_response(response, query, columns)
        if columns is None:
            columns = new_columns
            snapshot_id, table_name = store.create_snapshot(table, columns, run_id, started_at)
        store.insert_chunk(snapshot_id, table_name, columns, chunks, payload, response)
    expected = math.prod(len(v["values"]) for v in table["metadata"]["variables"])
    result = store.finish_snapshot(snapshot_id, table_name, columns, expected, utc_now(), chunks)
    return {"table_id": table["table_id"], "status": "complete", **result}


def reporting_periods(metadata):
    periods = {}
    for variable in metadata["variables"]:
        if variable.get("time"):
            if len(variable["values"]) != len(variable["valueTexts"]):
                raise ValueError("time category codes and labels differ in length")
            # Numeric codes can be renumbered. Compare published period labels.
            periods[variable["code"]] = set(variable["valueTexts"])
    if not periods:
        raise ValueError("no time dimension; cannot check for new reporting periods")
    return periods


def new_data_reasons(inventory, baselines):
    reasons = []
    for table in inventory:
        table_id = table["table_id"]
        current = reporting_periods(table["metadata"])
        if table_id not in baselines:
            reasons.append({"table_id": table_id, "reason": "new_table_or_initial_download"})
            continue
        previous = reporting_periods(baselines[table_id]["metadata"])
        if current.keys() != previous.keys():
            raise ValueError(f"{table_id}: time dimensions changed; inspect metadata before collecting")
        for code, labels in current.items():
            added = sorted(labels - previous[code])
            if added:
                reasons.append({"table_id": table_id, "reason": "new_reporting_periods",
                                "dimension": code, "periods": added})
    return reasons


def collect(client, store, selected=(), max_cells=100_000, inventory_only=False, check_only=False):
    mode = "inventory" if inventory_only else "check" if check_only else "download"
    run_id = store.start_run(utc_now(), mode, API, selected)
    result = {"run_id": run_id, "status": "running", "datasets": [], "new_data": [],
              "totals": {"rows": 0, "cells": 0}}
    try:
        inventory, excluded = [], []
        for table in discover(client, selected):
            metadata = client.request(table["api_url"])
            if not any(v["code"] == "Hochschule" for v in metadata["variables"]):
                excluded.append({"table_id": table["table_id"], "reason": "no university dimension"})
                continue
            table["metadata"] = metadata
            inventory.append(table)
        if not inventory:
            raise ValueError("no university tables found; refusing to treat an empty catalog as success")
        baselines = store.baselines()
        reasons = [] if inventory_only else new_data_reasons(inventory, baselines)
        baseline_ids = {t["table_id"]: baselines[t["table_id"]]["snapshot"]
                        for t in inventory if t["table_id"] in baselines}
        store.record_check(run_id, inventory, excluded, baseline_ids, reasons)
        result["new_data"] = reasons
        print(f"Run {run_id}: found {len(inventory)} university tables; excluded {len(excluded)} national-only tables.", flush=True)
        if inventory_only:
            result["status"] = "complete"
            print("Inventory only: no observations downloaded.", flush=True)
        elif not reasons:
            result["status"] = "skipped"
            print("No new reporting periods or tables. Skipping data download (metadata only).", flush=True)
        elif check_only:
            result["status"] = "complete"
            print(f"New data detected ({len(reasons)} additions). Check only: a full snapshot would be downloaded.", flush=True)
        else:
            print(f"New data detected: {len(reasons)} table/period additions.", flush=True)
            # All datasets, schema changes, and the complete status publish together.
            # Until commit, readers see only the previous complete collection.
            store.begin()
            for table in inventory:
                expected = math.prod(len(v["values"]) for v in table["metadata"]["variables"])
                print(f"Downloading {table['table_id']}: {expected:,} rows", flush=True)
                snapshot = download_table(client, table, store, run_id, max_cells)
                result["datasets"].append(snapshot)
                print(f"  {snapshot['rows']:,} rows stored in SQLite", flush=True)
            result["status"] = "complete"
        store.finish_run(run_id, result["status"], utc_now())
        if store.connection.in_transaction:
            store.commit()
        result["totals"] = {key: sum(s[key] for s in result["datasets"]) for key in ("rows", "cells")}
    except BaseException as error:
        store.rollback()
        result["status"] = "interrupted" if isinstance(error, (KeyboardInterrupt, SystemExit)) else "failed"
        result["error"] = str(error) or type(error).__name__
        # No snapshots from a failed collection are retained or become baselines.
        result["datasets"] = []
        store.finish_run(run_id, result["status"], utc_now(), result["error"])
        if not isinstance(error, (OSError, ValueError, KeyError, RuntimeError, sqlite3.Error)):
            raise
        print(f"Collection failed: {error}", file=sys.stderr, flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path,
                        default=Path(__file__).resolve().parents[1] / "data/university_stats.sqlite3")
    parser.add_argument("--table", action="append", default=[], help="Limit to a table ID (repeatable).")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--inventory-only", action="store_true", help="Record source metadata only.")
    group.add_argument("--check-only", action="store_true", help="Check additions without fetching observations.")
    parser.add_argument("--max-cells", type=int, default=100_000, help="Maximum source cells per API query.")
    parser.add_argument("--request-interval", type=float, default=0.4, help="Minimum seconds between requests.")
    args = parser.parse_args()
    if args.max_cells < 1 or args.request_interval < 0:
        parser.error("max-cells must be positive and request-interval must be nonnegative")
    database = args.database.resolve()
    database.parent.mkdir(parents=True, exist_ok=True)
    with database.with_name(database.name + ".fetch.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("Another collector is using this database.", file=sys.stderr)
            return 1
        store = Store(database)
        try:
            store.recover_runs(utc_now())
            print(f"Database: {database}", flush=True)
            result = collect(Client(interval=args.request_interval), store, args.table,
                             args.max_cells, args.inventory_only, args.check_only)
            print(f"{result['status']}: {result['totals']['rows']:,} rows stored", flush=True)
            return 0 if result["status"] in ("complete", "skipped") else 1
        finally:
            store.close()


if __name__ == "__main__":
    raise SystemExit(main())
