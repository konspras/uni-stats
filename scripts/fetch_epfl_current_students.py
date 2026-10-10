#!/usr/bin/env python3
"""Fetch current EPFL student headcounts by teaching section.

The official Interactive Gender Monitoring workbook publishes women counts
and exact women shares for each section.  Their ratio yields the integer total;
men is the remainder.  The workbook's overall gender series validates the
section sums for every overlapping year.
"""

from __future__ import annotations

import argparse
import csv
import math
import sys
from pathlib import Path

from tableau_session import load_tableau_workbook


SOURCE_URL = (
    "https://tableau.epfl.ch/views/InteractiveGenderMonitoring/"
    "InteractiveGenderMonitoring?:showVizHome=no"
)
SOURCE_PAGE = (
    "https://www.epfl.ch/about/equality/fr/donnees-et-rapports/"
    "gendermonitoring/intercativemonitoring/"
)
SECTION_NAMES = {
    "DH": "Digital Humanities",
    "IF": "Financial Engineering",
    "MTE": "Management, Technology and Entrepreneurship",
    "EME": "Energy Management and Sustainability",
    "AR": "Architecture",
    "GC": "Civil Engineering",
    "SIE": "Environmental Sciences and Engineering",
    "IN": "Computer Science",
    "SC": "Communication Systems",
    "NX": "Neuro-X",
    "SIQ": "Quantum Science and Engineering",
    "CGC": "Chemistry and Chemical Engineering",
    "MA": "Mathematics",
    "PH": "Physics",
    "EL": "Electrical and Electronic Engineering",
    "GM": "Mechanical Engineering",
    "MT": "Microengineering",
    "MX": "Materials Science and Engineering",
    "SV": "Life Sciences Engineering",
}


def matching_column(columns, predicate, description: str):
    matches = [column for column in columns if predicate(str(column))]
    if len(matches) != 1:
        raise ValueError(f"expected one {description} column, found {matches}")
    return matches[0]


def extract_rows(crosstab) -> list[dict[str, object]]:
    columns = list(crosstab.columns)
    faculty_col = matching_column(columns, lambda c: c == "Faculté sigle", "faculty")
    section_col = matching_column(columns, lambda c: c == "Section sigle", "section")
    year_col = matching_column(columns, lambda c: c == "Year of Année", "year")
    percent_col = matching_column(columns, lambda c: c.startswith("% of Total"), "percentage")
    count_col = matching_column(columns, lambda c: c == "Nb Etudiants", "count")

    rows: list[dict[str, object]] = []
    keys = [faculty_col, section_col, year_col]
    for (faculty, section, year), group in crosstab.groupby(keys, dropna=False):
        counts = group[count_col].dropna().tolist()
        percentages = group[percent_col].dropna().tolist()
        if len(counts) != 1 or len(percentages) != 1:
            raise ValueError(
                f"unexpected EPFL crosstab cells for {section} {year}: "
                f"counts={counts}, percentages={percentages}"
            )
        women = int(counts[0])
        women_share = float(str(percentages[0]).rstrip("%")) / 100
        total = round(women / women_share)
        if not math.isclose(women / total, women_share, abs_tol=5e-10):
            raise ValueError(f"percentage does not resolve to an integer for {section} {year}")
        rows.append(
            {
                "institution": "EPFL",
                "year": int(year),
                "unit_code": str(section),
                "unit_name": SECTION_NAMES.get(str(section), str(section)),
                "unit_type": "teaching_section",
                "parent_code": str(faculty),
                "women": women,
                "men": total - women,
                "total": total,
                "source_url": SOURCE_URL,
            }
        )
    return sorted(rows, key=lambda row: (int(row["year"]), str(row["parent_code"]), str(row["unit_code"])))


def overall_totals(workbook) -> dict[int, dict[str, int]]:
    frame = workbook.getWorksheet("Students#%_IGM").data
    year_col = matching_column(frame.columns, lambda c: c == "YEAR(Année)-alias", "overall year")
    count_col = matching_column(
        frame.columns,
        lambda c: c == "AGG(Nb Etudiants)-alias",
        "overall count",
    )
    sex_col = matching_column(frame.columns, lambda c: c == "EGA_H-F-alias", "overall sex")
    totals: dict[int, dict[str, int]] = {}
    for year, group in frame.groupby(year_col):
        by_sex = {
            str(row[sex_col]): int(row[count_col])
            for _, row in group.iterrows()
        }
        totals[int(year)] = {
            "women": by_sex.get("F", 0),
            "men": by_sex.get("H", 0),
            "total": sum(by_sex.values()),
        }
    return totals


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("data/epfl_students_by_section.csv"),
    )
    args = parser.parse_args()

    try:
        _, workbook = load_tableau_workbook(SOURCE_URL)
        story_points = workbook.getStoryPoints()["storyPoints"]
        student_point = next(
            point
            for group in story_points
            for point in group
            if point["storyPointCaption"] == "Etudiantes et Etudiants"
        )
        workbook = workbook.goToStoryPoint(student_point["storyPointId"])
        section_worksheet = workbook.getWorksheet("Students_%F_IGM")
        year_filter = next(
            item for item in section_worksheet.getFilters() if item["column"] == "YEAR(Année)"
        )
        workbook = section_worksheet.setFilter("YEAR(Année)", year_filter["values"])
        expected = overall_totals(workbook)
        crosstab = workbook.getCrossTabData("Students_%F_IGM")
        if crosstab is None:
            raise RuntimeError("EPFL section crosstab export returned no data")
        rows = extract_rows(crosstab)

        actual_by_sex: dict[int, dict[str, int]] = {}
        for row in rows:
            year = int(row["year"])
            totals = actual_by_sex.setdefault(year, {"women": 0, "men": 0, "total": 0})
            for column in ("women", "men", "total"):
                totals[column] += int(row[column])
        for year in sorted(set(actual_by_sex) & set(expected)):
            residual = {
                column: expected[year][column] - actual_by_sex[year][column]
                for column in ("women", "men", "total")
            }
            if any(value < 0 for value in residual.values()):
                raise ValueError(
                    f"{year}: section sums exceed EPFL totals: "
                    f"sections={actual_by_sex[year]}, EPFL={expected[year]}"
                )
            if residual["total"] != residual["women"] + residual["men"]:
                raise ValueError(f"{year}: inconsistent residual {residual}")
            if residual["total"]:
                rows.append(
                    {
                        "institution": "EPFL",
                        "year": year,
                        "unit_code": "NO_SECTION",
                        "unit_name": "No section shown in source chart",
                        "unit_type": "source_residual",
                        "parent_code": "",
                        "women": residual["women"],
                        "men": residual["men"],
                        "total": residual["total"],
                        "source_url": SOURCE_URL,
                    }
                )
                actual_by_sex[year] = expected[year].copy()
        rows.sort(key=lambda row: (int(row["year"]), str(row["parent_code"]), str(row["unit_code"])))
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
        "women",
        "men",
        "total",
        "source_url",
    ]
    with args.output.open("w", newline="", encoding="utf-8") as output:
        writer = csv.DictWriter(output, fieldnames=fieldnames, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    actual = {year: totals["total"] for year, totals in actual_by_sex.items()}
    years = sorted(actual)
    print(
        f"wrote {len(rows)} EPFL section rows ({years[0]}-{years[-1]}, "
        f"{len(years)} years; latest total {actual[years[-1]]:,}) to {args.output}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
