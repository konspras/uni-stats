#!/usr/bin/env python3
"""Fetch ETH Zurich headcounts by the official field-of-study dimension."""

from __future__ import annotations

import argparse
import csv
import re
import sys
import unicodedata
from pathlib import Path

from tableau_session import load_tableau_workbook


SOURCE_URL = (
    "https://public.tableau.com/views/KennzahlenStudierendePublic/"
    "BestandTabelle?:showVizHome=no"
)
SOURCE_PAGE = (
    "https://ethz.ch/staffnet/en/finance-and-controlling/"
    "facts-and-figures/students.html"
)
WORKSHEET = "BSc MSc Dok Bestand Detail"
LEVELS = {
    "BSc": "bachelor",
    "MSc": "master",
    "Dok": "doctoral",
}


def slug(value: str) -> str:
    value = "".join(
        character
        for character in unicodedata.normalize("NFKD", value)
        if not unicodedata.combining(character)
    ).casefold()
    return re.sub(r"[^a-z0-9]+", "-", value).strip("-")


def matching_column(columns, predicate, description: str):
    matches = [column for column in columns if predicate(str(column))]
    if len(matches) != 1:
        raise ValueError(f"expected one {description} column, found {matches}")
    return matches[0]


def expected_totals(workbook) -> dict[tuple[int, str], int]:
    frame = workbook.getWorksheet("Bestand").data
    year_col = matching_column(frame.columns, lambda c: c == "Jahr-alias", "year")
    level_col = matching_column(
        frame.columns,
        lambda c: c == "Studienkategorie     -alias",
        "level",
    )
    count_col = matching_column(frame.columns, lambda c: c == "SUM(Person Hs)-alias", "count")
    return {
        (int(row[year_col]), str(row[level_col])): int(row[count_col])
        for _, row in frame.iterrows()
        if str(row[level_col]) in LEVELS
    }


def expected_detail_totals(worksheet) -> dict[tuple[int, str], int]:
    frame = worksheet.data
    group_col = matching_column(
        frame.columns,
        lambda c: c == "Studienrichtung gruppiert-alias",
        "subject group",
    )
    year_col = matching_column(frame.columns, lambda c: c == "Jahr-alias", "year")
    level_col = matching_column(
        frame.columns,
        lambda c: c == "Studienkategorie -alias",
        "level",
    )
    count_col = matching_column(frame.columns, lambda c: c == "SUM(Person Hs)-alias", "count")
    return {
        (int(row[year_col]), str(row[level_col])): int(row[count_col])
        for _, row in frame.iterrows()
        if str(row[group_col]) == "All" and str(row[level_col]) in LEVELS
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("data/eth_students_by_study_program.csv"),
    )
    args = parser.parse_args()

    try:
        _, workbook = load_tableau_workbook(SOURCE_URL)
        published_totals = expected_totals(workbook)
        worksheet = workbook.getWorksheet(WORKSHEET)
        year_filter = next(item for item in worksheet.getFilters() if item["column"] == "Jahr")
        workbook = worksheet.setFilter("Jahr", year_filter["values"])
        worksheet = workbook.getWorksheet(WORKSHEET)
        expected = expected_detail_totals(worksheet)
        for key, count in published_totals.items():
            if expected.get(key) != count:
                raise ValueError(
                    f"{key}: detailed ETH total {expected.get(key)} does not match published total {count}"
                )
        program_filter = next(
            item for item in worksheet.getFilters() if item["column"] == "Studienrichtung"
        )
        programs = [str(value) for value in program_filter["values"]]
        rows_by_key: dict[tuple[int, str], dict[str, object]] = {}

        for program in programs:
            workbook = workbook.getWorksheet(WORKSHEET).setFilter("Studienrichtung", program)
            worksheet = workbook.getWorksheet(WORKSHEET)
            frame = worksheet.data
            group_col = matching_column(
                frame.columns,
                lambda c: c == "Studienrichtung gruppiert-alias",
                "subject group",
            )
            year_col = matching_column(frame.columns, lambda c: c == "Jahr-alias", "year")
            level_col = matching_column(
                frame.columns,
                lambda c: c == "Studienkategorie -alias",
                "level",
            )
            count_col = matching_column(
                frame.columns,
                lambda c: c == "SUM(Person Hs)-alias",
                "count",
            )
            subject_group = next(
                str(item["values"][0])
                for item in worksheet.getFilters()
                if item["column"] == "Studienrichtung gruppiert" and len(item["values"]) == 1
            )
            for _, source_row in frame.iterrows():
                level = str(source_row[level_col])
                if (
                    str(source_row[group_col]) != "All"
                    or level not in LEVELS
                    or str(source_row[year_col]) in {"%null%", "nan", "None"}
                    or str(source_row[count_col]) in {"%null%", "nan", "None"}
                ):
                    continue
                year = int(source_row[year_col])
                key = (year, program)
                row = rows_by_key.setdefault(
                    key,
                    {
                        "institution": "ETH Zurich",
                        "year": year,
                        "unit_code": slug(program),
                        "unit_name": program,
                        "unit_type": "field_of_study",
                        "parent_code": slug(subject_group),
                        "bachelor": 0,
                        "master": 0,
                        "doctoral": 0,
                        "total": 0,
                        "source_url": SOURCE_URL,
                    },
                )
                count = int(source_row[count_col])
                row[LEVELS[level]] = count
                row["total"] = int(row["total"]) + count

        rows = sorted(rows_by_key.values(), key=lambda row: (int(row["year"]), str(row["unit_name"])))
        actual: dict[tuple[int, str], int] = {}
        for row in rows:
            for level, column in LEVELS.items():
                key = (int(row["year"]), level)
                actual[key] = actual.get(key, 0) + int(row[column])
        for key, expected_count in expected.items():
            if key in actual and actual[key] != expected_count:
                raise ValueError(
                    f"{key}: program total {actual[key]} does not match ETH total {expected_count}"
                )
    except (KeyError, OSError, RuntimeError, StopIteration, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    args.output.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "institution",
        "year",
        "unit_code",
        "unit_name",
        "unit_type",
        "parent_code",
        "bachelor",
        "master",
        "doctoral",
        "total",
        "source_url",
    ]
    with args.output.open("w", newline="", encoding="utf-8") as output:
        writer = csv.DictWriter(output, fieldnames=fieldnames, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    latest_year = max(int(row["year"]) for row in rows)
    latest_total = sum(int(row["total"]) for row in rows if int(row["year"]) == latest_year)
    print(
        f"wrote {len(rows)} ETH field-of-study rows "
        f"({min(int(row['year']) for row in rows)}-{latest_year}; "
        f"latest BSc/MSc/doctoral total {latest_total:,}) to {args.output}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
