#!/usr/bin/env python3
"""Download complete BFS university tables as timestamped file snapshots.

Standard library only. No database, category mapping, or revision detection.
"""

from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import fcntl
import gzip
import hashlib
import json
import math
from pathlib import Path
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen
from uuid import uuid4


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


def save_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


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


def download_table(client, table, directory, max_cells):
    metadata = table["metadata"]
    partial = directory / (table["table_id"] + ".partial")
    partial.mkdir()
    save_json(partial / "metadata.json", metadata)
    save_json(partial / "source.json", {k: v for k, v in table.items() if k != "metadata"})
    raw_dir = partial / "responses"
    raw_dir.mkdir()
    started_at, rows, cells, raw_bytes, chunks, columns = utc_now(), 0, 0, 0, 0, None
    comments = []
    with (partial / "data.csv").open("w", newline="", encoding="utf-8") as output:
        writer = csv.writer(output, lineterminator="\n")
        for chunks, query in enumerate(selections(metadata, max_cells), start=1):
            payload = {"query": query, "response": {"format": "json"}}
            response = client.request(table["api_url"], payload)
            new_columns = validate_response(response, query, columns)
            if columns is None:
                columns = new_columns
                writer.writerow(c["code"] for c in columns)
            save_json(raw_dir / f"{chunks:04d}.query.json", payload)
            raw = json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            raw_bytes += len(raw)
            with gzip.open(raw_dir / f"{chunks:04d}.json.gz", "wb") as compressed:
                compressed.write(raw)
            for row in response["data"]:
                writer.writerow(row["key"] + row["values"])
                rows += 1
                cells += len(row["values"])
            comments.append({"chunk": chunks, "comments": response.get("comments", []),
                             "metadata": response.get("metadata", [])})
    expected = math.prod(len(v["values"]) for v in metadata["variables"])
    if rows != expected:
        raise ValueError(f"incomplete dataset: {rows} rows, expected {expected}")
    save_json(partial / "response_metadata.json", {"columns": columns, "chunks": comments})
    csv_path = partial / "data.csv"
    result = {"table_id": table["table_id"], "title": metadata["title"],
              "status": "complete", "started_at": started_at, "completed_at": utc_now(),
              "rows": rows, "cells": cells, "chunks": chunks,
              "csv_bytes": csv_path.stat().st_size, "response_json_bytes": raw_bytes,
              "csv_sha256": hashlib.sha256(csv_path.read_bytes()).hexdigest(),
              "source_catalog_updated": table["catalog"].get("updated"),
              "dimensions": [{"code": v["code"], "categories": len(v["values"])}
                             for v in metadata["variables"]]}
    save_json(partial / "snapshot.json", result)
    result["disk_bytes"] = sum(p.stat().st_size for p in partial.rglob("*") if p.is_file())
    partial.rename(directory / table["table_id"])
    return result


def collect(client, run_dir, selected, max_cells, inventory_only):
    manifest = {"started_at": utc_now(), "api": API, "mode": "inventory" if inventory_only else "download",
                "status": "running", "datasets": [], "excluded": []}
    try:
        tables = discover(client, selected)
        inventory = []
        for table in tables:
            metadata = client.request(table["api_url"])
            variables = metadata["variables"]
            if not any(v["code"] == "Hochschule" for v in variables):
                manifest["excluded"].append({"table_id": table["table_id"],
                                             "reason": "no university dimension"})
                continue
            table["metadata"] = metadata
            inventory.append(table)
        save_json(run_dir / "inventory.json", inventory)
        manifest["expected_datasets"] = len(inventory)
        print(f"Found {len(inventory)} university tables; excluded {len(manifest['excluded'])} national-only tables.", flush=True)
        for table in inventory:
            expected = math.prod(len(v["values"]) for v in table["metadata"]["variables"])
            if inventory_only:
                result = {"table_id": table["table_id"], "title": table["metadata"]["title"],
                          "status": "inventoried", "expected_rows": expected}
            else:
                try:
                    print(f"Downloading {table['table_id']}: {expected:,} rows", flush=True)
                    result = download_table(client, table, run_dir, max_cells)
                    print(f"  {result['rows']:,} rows, {result['csv_bytes'] / 1_000_000:.2f} MB CSV", flush=True)
                except (OSError, ValueError, KeyError, RuntimeError) as error:
                    result = {"table_id": table["table_id"], "status": "failed", "error": str(error)}
                    print(f"  FAILED: {error}", file=sys.stderr, flush=True)
            manifest["datasets"].append(result)
            save_json(run_dir / "manifest.json", manifest)
        manifest["status"] = "failed" if any(r["status"] == "failed" for r in manifest["datasets"]) else "complete"
    except KeyboardInterrupt:
        manifest["status"], manifest["error"] = "interrupted", "Collection interrupted by the user"
        raise
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        manifest["status"], manifest["error"] = "failed", str(error)
        print(f"Collection failed: {error}", file=sys.stderr)
    finally:
        manifest["finished_at"] = utc_now()
        complete = [r for r in manifest["datasets"] if r["status"] == "complete"]
        manifest["totals"] = {key: sum(r.get(key, 0) for r in complete)
                              for key in ("rows", "cells", "csv_bytes", "response_json_bytes", "disk_bytes")}
        save_json(run_dir / "manifest.json", manifest)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "data/bfs")
    parser.add_argument("--table", action="append", default=[], help="Limit to a table ID (repeatable).")
    parser.add_argument("--inventory-only", action="store_true", help="Fetch metadata and count rows, without data queries.")
    parser.add_argument("--max-cells", type=int, default=100_000, help="Maximum source cells per API query.")
    parser.add_argument("--request-interval", type=float, default=0.4, help="Minimum seconds between requests.")
    args = parser.parse_args()
    if args.max_cells < 1 or args.request_interval < 0:
        parser.error("max-cells must be positive and request-interval must be nonnegative")
    args.output.mkdir(parents=True, exist_ok=True)
    with (args.output / ".fetch.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("Another downloader is using this output directory.", file=sys.stderr)
            return 1
        name = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ") + "-" + uuid4().hex[:8]
        run_dir = args.output / name
        run_dir.mkdir()
        print(f"Snapshot directory: {run_dir}", flush=True)
        manifest = collect(Client(interval=args.request_interval), run_dir, args.table,
                           args.max_cells, args.inventory_only)
        totals = manifest["totals"]
        print(f"{manifest['status']}: {totals['rows']:,} rows, "
              f"{totals['csv_bytes'] / 1_000_000:.2f} MB CSV, "
              f"{totals['disk_bytes'] / 1_000_000:.2f} MB dataset files", flush=True)
        return 0 if manifest["status"] == "complete" else 1


if __name__ == "__main__":
    raise SystemExit(main())
