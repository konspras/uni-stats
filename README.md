# EPFL and ETH Zurich student statistics

This repository automates long-run student headcounts from one first-party source per institution. The manually collected seed workbook is kept as [`EPFL Stats.xlsx`](./EPFL%20Stats.xlsx), but the generated datasets do not depend on it.

## Current datasets

### EPFL: teaching sections, 2009–2025

[`data/epfl_students_by_section.csv`](./data/epfl_students_by_section.csv) contains 17 annual observations for EPFL teaching sections. Its single source is EPFL's self-hosted [Interactive Gender Monitoring Tableau workbook](https://tableau.epfl.ch/views/InteractiveGenderMonitoring/InteractiveGenderMonitoring?:showVizHome=no), which EPFL embeds on its official [Interactive Gender Monitoring page](https://www.epfl.ch/about/equality/fr/donnees-et-rapports/gendermonitoring/intercativemonitoring/).

The workbook publishes the number and exact percentage of women in each section. The fetcher divides the count by the percentage to recover the integer total, then calculates the number of men as the remainder. It validates section sums against the workbook's separate EPFL-wide gender totals. The latest year is 2025: 14,072 students across 18 sections. In 2021, one male student appears in the EPFL total but in no section mark; the CSV preserves that one-person difference as an explicit `source_residual` row.

### ETH Zurich: fields of study, 2011–2025

[`data/eth_students_by_study_program.csv`](./data/eth_students_by_study_program.csv) contains 15 annual observations by Bachelor, Master, and doctoral level. Its single source is ETH Zurich's [public Tableau student table](https://public.tableau.com/views/KennzahlenStudierendePublic/BestandTabelle?:showVizHome=no), embedded on ETH's official [Students facts and figures page](https://ethz.ch/staffnet/en/finance-and-controlling/facts-and-figures/students.html).

ETH publishes student counts by `Studienrichtung` (field of study), not by organizational department. The CSV retains that official dimension as `field_of_study`. It should not be presented as a department series without a separate, documented program-to-department mapping. For 2025, the program rows sum to 25,930 Bachelor, Master, and doctoral students: 11,520 Bachelor, 10,144 Master, and 4,266 doctoral students. MAS/MBA and mobility students are outside this detailed table.

## Reproduce

Create an environment and install the pinned Tableau parser:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Fetch both current time series:

```bash
PYTHONPATH=scripts .venv/bin/python scripts/fetch_epfl_current_students.py
PYTHONPATH=scripts .venv/bin/python scripts/fetch_eth_current_students.py
```

Both scripts discover the years and categories from the live workbooks, validate published totals, and retain the source URL on every output row. [`scripts/tableau_session.py`](./scripts/tableau_session.py) handles the two-stage session protocol used by the institutions' current Tableau servers.

## Historical EPFL annual-report series

[`scripts/fetch_epfl_students.py`](./scripts/fetch_epfl_students.py) and [`data/epfl_students_by_unit.csv`](./data/epfl_students_by_unit.csv) retain the earlier 2010–2017 annual-report extraction for auditing. It is a different publication series with a historical definition, so it is not merged into the current 2009–2025 Tableau series.

EPFL's [education glossary](https://www.epfl.ch/about/data/institutional-data/institutional-statistics/university-glossary/) explains that its current official student count uses enrolment on 1 November, excludes CMS, most incoming mobility students, CAS, and DAS, and applies the post-2021 definition retroactively to the displayed history.
