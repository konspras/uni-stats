# Authoritative project plan

Agreed with the user on 2026-10-10. This file is the authoritative reference for project scope, decisions, and implementation sequence. Update it when the user changes the plan; README.md summarizes it.

## Objective and scope

Collect university statistics published by the Swiss Federal Statistical Office (BFS/OFS/FSO), preserve their original structure in SQLite, retain timestamped snapshots, and provide an interactive website for exploration and comparison.

The initial focus is student numbers and new Bachelor entrants, particularly Computer Science at EPFL and ETH Zurich. Collection scope includes other Swiss universities and the relevant BFS university datasets for students, entrants, degrees, staff, and finances. Inventory the available datasets before importing them; the source table list below is not exhaustive.

## Agreed decisions

- Use SQLite, with no separate database server initially.
- Use the public BFS PxWeb API.
- Preserve each dataset's original dimensions, category codes and labels, units, source metadata, values, and missing-value markers. A missing value must remain distinct from zero.
- Check metadata weekly. Fetch the complete published contents of every selected dataset only when a new reporting period or previously uncollected university table is available. Retain each successful fetch as a new timestamped snapshot.
- Do not implement revision detection or missing-year-only incremental fetching. Complete snapshots supersede the earlier incremental-update proposal and preserve pre-revision data naturally.
- Make interpretation, mappings, derived metrics, and comparison assumptions explicit in the frontend when needed. Do not impose a shared classification in storage.
- Design the frontend together with the user.
- Run the website continuously as an OS-started service, with weekly metadata checks performed by a background worker in that service, following ../day-to-day.
- Ignore revisions to existing values, changed update timestamps, and non-time category additions when deciding whether to download. A newly triggered complete snapshot includes intervening revisions. Historical reporting-period additions count as new data; compare period labels rather than unstable numeric category positions.

## 1. Clean up the repository — complete

- Preserve EPFL Stats.xlsx unchanged. This XLSX was the original tracked user input; the exploratory CSVs were generated outputs, not original user inputs.
- Remove the exploratory EPFL/ETH Tableau fetchers, annual-report PDF fetcher, their generated CSVs, and the tableauscraper dependency.
- Retain .gitignore, replace the obsolete README, and retain useful BFS references in this plan. Removed work remains available in Git history.

Completion check: the original workbook is byte-for-byte unchanged, superseded code and generated data are absent, and documentation does not advertise removed code as runnable.

## 2. Discuss the minimal schema, then create SQLite — pending

Briefly discuss the exact schema with the user before implementation. SQLite and source-structure preservation are agreed; the physical representation is not yet decided.

The user subsequently requested the file-export part of step 3 first, so we can measure real dataset sizes before deciding the schema. Complete that work and report its measurements before starting database implementation.

The database must represent:

- Dataset identity and source location.
- Immutable snapshots with UTC fetch timestamps and the source metadata/category definitions valid at fetch time.
- Original dimension combinations and values, without assuming identical columns across datasets.
- Collection-run status, failures, and last successful collection time.

A small dataset/snapshot/run model with source-shaped data is the starting point for discussion. Rows, JSON payloads, or a combination remain options. Do not introduce a universal university mapping layer or a broad normalized analytical schema without discussing the need.

Before the first full import, inventory the selected tables, count their possible cells, and measure an actual sample snapshot. The earlier estimate of hundreds of thousands to a few million observations and tens to hundreds of MB per complete snapshot was a rough estimate, not a measured size or storage commitment.

Completion check: the agreed schema can round-trip source dimensions, labels, values, and missing markers, and retain multiple snapshots containing the same historical periods.

## 3. Build the complete-snapshot fetcher — file export implemented; database integration pending

Execution order revised by the user: implement and run the downloader before step 2. `scripts/fetch_bfs.py` now exports complete source tables to timestamped CSV/JSON snapshots without database writes. It discovers the university student/entrant, degree, staff, and finance catalogs, excludes tables without a university dimension, and downloads all categories/periods in the remaining tables. The initial live inventory contains 28 included and 6 excluded tables.

File snapshots preserve source metadata and compressed raw responses, report row counts and byte sizes, and publish each complete table only after validation. Failed partial downloads are explicitly marked; earlier snapshots remain unchanged. This provides measured input for the SQLite discussion, not an already-decided database schema.

The file fetcher now performs the new-data check before any data query. It uses the latest fully successful download baseline for each table; skipped, failed, interrupted, and metadata-only runs never advance that baseline. A new year/table triggers a complete snapshot within the requested scope; no additions means a metadata-only skipped run. `--check-only` reports the decision without downloading. An unknown time schema fails explicitly. The output remains CSV/JSON, with no database writes.

The first full download completed on 2026-10-10: 28 tables, 3,519,548 rows, 51.93 MB CSV, and 63.64 MB for the full run including metadata and compressed responses. At this volume, monthly file snapshots would consume about 0.76 GB per year. See [docs/DATA_VOLUME.md](docs/DATA_VOLUME.md) for exact measurements, scope, and reproducibility. SQLite volume remains dependent on the schema decision.

- Maintain an explicit inventory of relevant BFS university datasets. Collect all published categories and periods for each selected dataset, rather than only EPFL/ETH or Computer Science.
- Read API metadata before querying; discover current categories and years rather than hard-coding positions or limits. Compare reporting periods/tables against successful snapshots before issuing any data queries.
- Fetch complete datasets, splitting requests if required by API limits.
- Save metadata and observations as immutable timestamped snapshots with source provenance.
- Commit each dataset snapshot atomically only after all parts are successfully fetched and validated. Partial downloads must not become the latest usable snapshot.
- Record failures, retry temporary errors appropriately, preserve previous successful data, and prevent overlapping collection runs.
- Provide a manual command using the same collection logic as the scheduled worker.

Completion check: unchanged metadata causes no data queries; a new published year triggers a complete snapshot without fetcher edits; an interrupted/failed fetch leaves the previous successful baseline usable and the next check retries the addition.

## 4. Design and build the frontend together — pending

- Browse source datasets as published, using their original dimensions and labels.
- Allow dataset/metric, subject, university, study level, and period selection where those dimensions exist.
- Default to the latest successful snapshot for each dataset and allow older snapshots to be selected. Display fetch time and source publication/update metadata when available.
- Design university comparisons, plots, and derived metrics with the user. Keep mappings and interpretation in the presentation layer and explain them when relevant.
- Respect different filters, classifications, and period meanings across datasets. Statistical subjects are not necessarily organizational departments.

Completion check: the agreed interface explores CS student counts and Bachelor entrants at EPFL and ETH from SQLite, compares universities, and switches between retained snapshots.

## 5. Run the website and weekly metadata-check service — pending

- Follow ../day-to-day's systemd deployment and background-worker pattern: start with the OS, restart after failures, and serve continuously.
- Run weekly metadata checks in the website service's background worker. Download a full snapshot only when the fetcher detects new reporting periods or tables. Configure the exact weekly timing during deployment.
- Persist scheduling state in SQLite. After downtime, perform one overdue check without fabricating snapshots for missed weeks.
- Keep the website responsive and the last successful data available during collection or failures.
- Reuse the manual fetcher's logic, enforce a single active collection, and expose collection status and logs.

Completion check: an OS restart brings the service back, an overdue collection runs once after startup, and failed collection neither interrupts the website nor replaces good data with partial data.

## Source references and verified constraints

Tested API requests require no account or API key. GET returns metadata; POST selects data. Example metadata endpoint:

https://www.pxweb.bfs.admin.ch/api/v1/de/px-x-1502040100_123/px-x-1502040100_123.px

Verified starting tables; this is an initial inventory, not the complete collection scope:

| Dataset | BFS table ID | Periods observed |
| --- | --- | --- |
| Students by subject, study level, university | px-x-1502040100_105 | 1980/81–2025/26 |
| Bachelor/historical licence-diploma entrants by subject, gender, university | px-x-1502040100_123 | 1980/81–2025/26 |
| Degrees by qualification level, subject, gender, university | px-x-1503040100_101 | 1980–2025 |
| Staff FTE by broad field, staff category, university | px-x-1504040100_101 | 1980–2025 |
| Expenditure by broad field, expenditure type, funding type, university | px-x-1506030000_201 | 1995–2025 |
| Costs by broad field, activity, cost type, university | px-x-1506030100_203 | 2006–2024 |

Evidence to preserve from exploration:

- The tested enrolment, entrant, and degree tables share 77 subject codes and labels, but numeric university codes differ across tables. Codes are local to a dataset and dimension, not universal identifiers.
- Table coverage, dimensions, and periods differ. Student counts use academic years; degrees and financial/staff tables can use calendar years. Fetch the metadata's actual period meaning.
- Staff and finance tables can use broader subject groupings than student tables. Do not assume CS-specific finance or staffing exists.
- The tested entrant table covers Bachelor and historical licence/diploma entry. Equivalent Master/doctoral entrant tables have not been verified.
- BFS may revise historical data; complete snapshots preserve the publication state at each fetch. BFS definitions may differ from institution-published statistics.
- BFS already provides filters, charts, and downloads. This project's added value is the agreed interface, combined exploration, retained snapshots, and automated local collection.

References:

- [Student counts](https://www.pxweb.bfs.admin.ch/pxweb/de/px-x-1502040100_105/-/px-x-1502040100_105.px/)
- [Bachelor entrants](https://www.pxweb.bfs.admin.ch/pxweb/de/px-x-1502040100_123/-/px-x-1502040100_123.px/)
- [Degrees awarded](https://www.pxweb.bfs.admin.ch/pxweb/de/px-x-1503040100_101/-/px-x-1503040100_101.px/)
- [BFS institution list](https://www.swissstats.bfs.admin.ch/data/webviewer/appId/ch.admin.bfs.swissstat/article/issue241517992200-09/package)
- [STAT-TAB instructions](https://dam-api.bfs.admin.ch/hub/api/dam/assets/33227158/master)

## Next action

The file downloader, first full-download volume measurement, and new-data gating are implemented. Discuss the minimal SQLite snapshot schema with the user next. No database injection, frontend, or scheduled service is part of the current file-downloader task.
