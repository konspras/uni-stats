#!/usr/bin/env python3
"""Fetch EPFL annual reports and extract student headcounts by academic unit.

The reports for 2010--2017 contain a consistently structured table titled
"Etudiants par domaine et niveau d'etudes".  This script downloads the
official PDFs, converts them to positioned text with pdftotext, validates the
table arithmetic, and writes a tidy CSV.
"""

from __future__ import annotations

import argparse
import csv
import re
import shutil
import subprocess
import sys
import unicodedata
import urllib.request
from dataclasses import dataclass
from pathlib import Path


SOURCES = {
    2010: "https://www.epfl.ch/about/overview/wp-content/uploads/2022/07/EPFL-rapport-annuel-2010.pdf",
    2011: "https://www.epfl.ch/about/overview/wp-content/uploads/2022/07/EPFL-rapport-annuel-2011.pdf",
    2012: "https://www.epfl.ch/about/overview/wp-content/uploads/2022/07/EPFL-rapport-annuel-2012.pdf",
    2013: "https://www.epfl.ch/about/overview/wp-content/uploads/2022/07/EPFL-rapport-annuel-2013.pdf",
    2014: "https://www.epfl.ch/about/overview/wp-content/uploads/2022/07/EPFL-rapport-annuel-2014.pdf",
    2015: "https://www.epfl.ch/about/overview/wp-content/uploads/2018/11/EPFL-rapport-annuel-2015.pdf",
    2016: "https://www.epfl.ch/about/overview/wp-content/uploads/2018/11/EPFL-rapport-annuel-2016.pdf",
    2017: "https://www.epfl.ch/about/overview/wp-content/uploads/2018/11/EPFL_RA_PANORAMA_2017_FR.pdf",
}


@dataclass(frozen=True)
class Unit:
    name: str
    code: str
    unit_type: str
    parent_code: str = ""
    no_bachelor: bool = False


UNITS = (
    Unit("Faculté des sciences de base", "SB", "faculty"),
    Unit("Mathématiques", "MATH", "department", "SB"),
    Unit("Physique", "PHYS", "department", "SB"),
    Unit("Chimie et génie chimique", "CGC", "department", "SB"),
    Unit("Faculté des sciences de la vie", "SV", "faculty"),
    Unit("Faculté des sciences et techniques de l’ingénieur", "STI", "faculty"),
    Unit("Science et génie des matériaux", "MX", "department", "STI"),
    Unit("Génie mécanique", "GM", "department", "STI"),
    Unit("Microtechnique", "MT", "department", "STI"),
    Unit("Génie électrique et électronique", "EL", "department", "STI"),
    Unit("Faculté informatique et communications", "IC", "faculty"),
    Unit("Systèmes de communication", "SC", "department", "IC"),
    Unit("Informatique", "IN", "department", "IC"),
    Unit("Faculté d’environnement naturel, architectural et construit", "ENAC", "faculty"),
    Unit("Sciences et ingénierie de l’environnement", "SIE", "department", "ENAC"),
    Unit("Génie civil", "GC", "department", "ENAC"),
    Unit("Architecture", "AR", "department", "ENAC"),
    Unit("Collège du management de la technologie", "CDM", "college", no_bachelor=True),
    Unit("Management de la technologie", "MTE", "department", "CDM", True),
    Unit("Ingénierie financière", "IF", "department", "CDM", True),
    Unit("Humanités digitales", "CDH", "college", no_bachelor=True),
    Unit("Gestion de l’énergie et construction durable", "EME-MES", "program", no_bachelor=True),
    Unit("Total", "EPFL", "total"),
)

EXPECTED_CODES = {
    year: {
        "SB", "MATH", "PHYS", "CGC", "SV", "STI", "MX", "GM", "MT", "EL",
        "IC", "SC", "IN", "ENAC", "SIE", "GC", "AR", "CDM", "MTE", "IF",
        "EPFL",
    }
    | ({"EME-MES"} if year >= 2011 else set())
    | ({"CDH"} if year >= 2017 else set())
    for year in SOURCES
}


def normalized(value: str) -> str:
    value = value.casefold().replace("’", "'")
    value = "".join(
        char for char in unicodedata.normalize("NFKD", value)
        if not unicodedata.combining(char)
    )
    value = re.sub(r"\([^)]*\)", " ", value)
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return " ".join(value.split())


NORMALIZED_UNITS = {normalized(unit.name): unit for unit in UNITS}


def download(url: str, destination: Path, refresh: bool) -> None:
    if destination.exists() and not refresh:
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "uni-stats/0.1 (+https://www.epfl.ch/)"},
    )
    temporary = destination.with_suffix(".download")
    try:
        with urllib.request.urlopen(request, timeout=60) as response, temporary.open("wb") as output:
            shutil.copyfileobj(response, output)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def pdf_to_text(pdf_path: Path) -> str:
    if shutil.which("pdftotext") is None:
        raise RuntimeError("pdftotext is required (install the Poppler utilities)")
    result = subprocess.run(
        ["pdftotext", "-layout", str(pdf_path), "-"],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return result.stdout.decode("utf-8", errors="replace")


def numeric_tail(line: str) -> tuple[str, list[int]] | None:
    match = re.match(r"^(.*?\S)\s{2,}((?:[-–—]|\d[\d'’]*)?(?:\s+(?:[-–—]|\d[\d'’]*))+)[ \t]*$", line)
    if not match:
        return None
    tokens = re.findall(r"[-–—]|\d[\d'’]*", match.group(2))
    if not tokens:
        return None
    values = [0 if token in {"-", "–", "—"} else int(token.replace("'", "").replace("’", "")) for token in tokens]
    return match.group(1).strip(), values


def identify_unit(label: str) -> Unit | None:
    label_normalized = normalized(label)
    matches = [
        (len(name), unit)
        for name, unit in NORMALIZED_UNITS.items()
        if label_normalized == name or label_normalized.endswith(" " + name)
    ]
    return max(matches, default=(0, None))[1]


def map_values(unit: Unit, values: list[int]) -> tuple[int, int, int, int, int]:
    if len(values) == 5:
        bachelor, master, doctoral, continuing, total = values
    elif len(values) == 4 and unit.no_bachelor:
        bachelor = 0
        master, doctoral, continuing, total = values
    elif len(values) == 4:
        bachelor, master, doctoral, total = values
        continuing = 0
    elif len(values) == 3 and unit.no_bachelor:
        bachelor = continuing = 0
        master, doctoral, total = values
    elif len(values) == 2 and unit.no_bachelor:
        bachelor = doctoral = continuing = 0
        master, total = values
    else:
        raise ValueError(f"unexpected cells for {unit.code}: {values}")
    if total != bachelor + master + doctoral + continuing:
        raise ValueError(
            f"row total does not add up for {unit.code}: "
            f"{bachelor} + {master} + {doctoral} + {continuing} != {total}"
        )
    return bachelor, master, doctoral, continuing, total


def extract_rows(year: int, text: str) -> list[dict[str, object]]:
    lines = text.splitlines()
    marker = next(
        (index for index, line in enumerate(lines) if "etudiants par domaine" in normalized(line)),
        None,
    )
    if marker is None:
        raise ValueError(f"{year}: student table heading not found")
    header = next(
        (
            index for index in range(marker, min(marker + 40, len(lines)))
            if "bachelor" in normalized(lines[index]) and "master" in normalized(lines[index])
        ),
        None,
    )
    if header is None:
        raise ValueError(f"{year}: student table column headings not found")

    rows: list[dict[str, object]] = []
    pending: list[str] = []
    for line in lines[header + 1 : header + 100]:
        parsed = numeric_tail(line)
        if parsed is None:
            if line.strip():
                pending.append(line.strip())
                pending = pending[-3:]
            continue

        label, values = parsed
        unit = identify_unit(" ".join([*pending, label])) or identify_unit(label)
        pending.clear()
        if unit is None:
            continue
        bachelor, master, doctoral, continuing, total = map_values(unit, values)
        rows.append(
            {
                "year": year,
                "unit_code": unit.code,
                "unit_name": unit.name,
                "unit_type": unit.unit_type,
                "parent_code": unit.parent_code,
                "bachelor": bachelor,
                "master": master,
                "doctoral": doctoral,
                "continuing_education": continuing,
                "total": total,
                "source_url": SOURCES[year],
            }
        )
        if unit.code == "EPFL":
            break

    found = {str(row["unit_code"]) for row in rows}
    if found != EXPECTED_CODES[year]:
        missing = sorted(EXPECTED_CODES[year] - found)
        unexpected = sorted(found - EXPECTED_CODES[year])
        raise ValueError(f"{year}: unit mismatch; missing={missing}, unexpected={unexpected}")
    return rows


def validate_aggregates(year: int, rows: list[dict[str, object]]) -> None:
    by_code = {str(row["unit_code"]): row for row in rows}
    for parent in ("SB", "STI", "IC", "ENAC"):
        children = [row for row in rows if row["parent_code"] == parent]
        if sum(int(row["total"]) for row in children) != int(by_code[parent]["total"]):
            raise ValueError(f"{year}: child totals do not add up for {parent}")
    top_level = [
        row for row in rows
        if row["unit_type"] != "total" and not row["parent_code"]
    ]
    if sum(int(row["total"]) for row in top_level) != int(by_code["EPFL"]["total"]):
        raise ValueError(f"{year}: top-level totals do not add up to EPFL")


def parse_years(value: str) -> list[int]:
    years = []
    for part in value.split(","):
        if "-" in part:
            start, end = (int(item) for item in part.split("-", 1))
            years.extend(range(start, end + 1))
        else:
            years.append(int(part))
    unknown = sorted(set(years) - SOURCES.keys())
    if unknown:
        raise argparse.ArgumentTypeError(f"unsupported years: {unknown}")
    return sorted(set(years))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--years", type=parse_years, default=sorted(SOURCES), help="e.g. 2010-2017 or 2014,2017")
    parser.add_argument("--cache-dir", type=Path, default=Path(".cache/epfl"))
    parser.add_argument("--output", type=Path, default=Path("data/epfl_students_by_unit.csv"))
    parser.add_argument("--refresh", action="store_true", help="download PDFs again")
    args = parser.parse_args()

    all_rows: list[dict[str, object]] = []
    try:
        for year in args.years:
            pdf_path = args.cache_dir / f"epfl-{year}.pdf"
            download(SOURCES[year], pdf_path, args.refresh)
            rows = extract_rows(year, pdf_to_text(pdf_path))
            validate_aggregates(year, rows)
            all_rows.extend(rows)
    except (OSError, subprocess.CalledProcessError, ValueError, RuntimeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    args.output.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "year", "unit_code", "unit_name", "unit_type", "parent_code",
        "bachelor", "master", "doctoral", "continuing_education", "total", "source_url",
    ]
    with args.output.open("w", newline="", encoding="utf-8") as output:
        writer = csv.DictWriter(output, fieldnames=fieldnames, lineterminator="\n")
        writer.writeheader()
        writer.writerows(all_rows)
    print(f"wrote {len(all_rows)} rows for {len(args.years)} years to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
