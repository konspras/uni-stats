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

## 2. Discuss the minimal schema, then create SQLite — implemented

The user approved the source-shaped schema after the file-export volume measurement. The implementation uses shared collection/dataset/snapshot tables and one observation table per BFS dataset and structural version. Full details are in [docs/DATABASE.md](docs/DATABASE.md); executable DDL is in `scripts/schema.sql`.

- `datasets`: BFS identity and source location.
- `collection_runs`: check/collection timestamps, requested scope, inventory, trigger reasons, outcome and errors.
- `dataset_tables`: structural versions and physical source-table names.
- `snapshots`: immutable published dataset snapshots, original source schema/provenance, row counts and checksums.
- `snapshot_chunks`: query selections, comments, units/source metadata and response checksums.
- Source-shaped `bfs_*` observation tables: `snapshot_id`, original dimension columns and original value columns, all source fields stored as TEXT.
- `latest_snapshots`: latest snapshot per dataset from fully successful collections.

New years/categories reuse existing observation tables. Source column/role changes create new physical versions while preserving old tables. No universal university mapping, numeric coercion or derived analytical schema is imposed. Extra frontend-specific indexes are deferred until actual query patterns are known.

Completion check: source codes/labels/values/missing markers round-trip; old snapshots are unchanged; structural changes retain their old table versions.

## 3. Build the complete-snapshot fetcher — SQLite integration implemented

The file exporter was implemented first to measure volume. The user then approved the schema and requested replacing the CSV path with database ingestion. `scripts/fetch_bfs.py` now streams validated API chunks directly into `data/university_stats.sqlite3`; CSV output, file-based baselines and the `--output` option are removed.

The fetcher discovers university student/entrant, degree, staff and finance catalogs and excludes tables without a university dimension. The first live inventory contained 28 included and 6 excluded tables. The first file download measured 3,519,548 rows, 51.93 MB CSV and 63.64 MB including metadata and compressed responses; [docs/DATA_VOLUME.md](docs/DATA_VOLUME.md) retains that historical measurement.

Each invocation records a metadata check. It compares period labels and table IDs with the latest fully successful database snapshots; skipped, failed, interrupted and metadata-only runs never advance baselines. A new reporting period (including a historical addition) or uncollected table triggers a complete snapshot within the requested scope. Otherwise it skips observation queries. `--check-only` reports the decision without importing observations.

- Collect all published categories/periods rather than only EPFL/ETH or CS.
- Discover categories/years from metadata, not hard-coded numeric positions.
- Split complete selections to respect API query limits and validate every response coordinate.
- Preserve original values and snapshot-specific metadata, query selections, provenance and units.
- Import every requested dataset and mark the run complete in one transaction. Any failure rolls back all observations, snapshots and structural changes from that collection.
- Record failures outside the rolled-back data transaction; keep old baselines and retry outstanding additions on the next check.
- Use WAL mode for committed-data readers, prevent overlapping collectors with a database-adjacent lock, and recover abandoned run records after process death.
- Keep the manual CLI and eventual background worker on the same collection/storage path.

Completion check: a live initial collection populates SQLite; an immediate repeat skips fetching; source values/checksums and database integrity validate; failures do not publish partial collections.

Live import on 2026-10-10 stored all 28 datasets and 3,519,548 rows in an initial 83.20 MB database. Every stored-value checksum and full source metadata dictionary matched the previous file export; SQLite integrity and foreign-key checks passed. The obsolete `data/bfs/` output directory was then removed. An immediate second live run checked all 28 tables and skipped observation downloads, retaining exactly 28 snapshots. The original workbook's checksum is unchanged. All 23 offline tests passed, covering failed-collection rollback, reader visibility, schema versions, process recovery and new-data decisions.

## 4. Design and build the frontend together — first Data explorer implemented

The user approved starting with one generic Data explorer tab rather than specialized dashboards. It is implemented in `server.py`, `explorer.py` and `web/`, with a read-only SQLite API, source-metadata-driven controls, exact-category time series, raw-value table, definitions/provenance and successful snapshot selection. Every collected dataset is accessible through a grouped picker. Known dimension names are translated only for interface labels; original categories and metadata remain visible.

One comparison dimension allows multiple selected categories; every other dimension has a fixed category or an explicit **All** selection. **All (derived sum)** adds the reviewed table's source categories across selected dimensions. **All (published total)** selects the existing total without adding its children. Nonadditive ratios and mixed indicators have no sum option. Missing components or absent observations make derived totals gaps; zeros remain numeric. Calculations occur in the read-only query layer, preserve stored source data, and precede optional normalization. The initial view shows Informatik/Bachelor at EPFL and ETHZ using student table `px-x-1502040100_105`, with all years available.

The explorer now includes optional per-series indexing to the selected start period (start = 100), recalculated when the interval changes. Plot, tooltip and table switch together; stored source values are unchanged. Series with zero/missing baselines are excluded with a notice rather than rebased to a later year. Promotional interface copy has been removed at the user's request.

Chart controls occupy an untitled panel directly below the plot, matching its width. A two-handle slider replaces the sidebar's date dropdowns. The panel contains **Normalize to start = 100** and **Percentage of total**; checking one disables the other until unchecked. Percentages use the sum of the selected series independently in each period and display a 100% stacked area chart, percentage tooltips and a percentage values table. Missing/negative components or zero totals create whole-period gaps. Both modes derive from the selected source/aggregate values without altering SQLite; Reset clears them.

The **Pyramid** tab is implemented to the left of **Data explorer**. It is restricted to entrant and degree flow tables with gender or nationality breakdowns; enrolled stocks, staff and finances are not permitted. University checkboxes select one or more institutions (including Select all), summed per year into one pyramid. Optional Stack by university divides each bar into shaded university segments with a legend, using the same yearly totals in counts and percentages. One descending university ranking uses the combined count across both populations in the latest selected year and applies to all rows, both sides and tooltip breakdowns; fully opaque shading spans a wide dark-to-light range for nonzero universities, with thin segment boundaries; outside labels show each year’s nonzero count on both sides, including in stacked and percentage modes; year labels include elapsed years in parentheses (academic periods use their starting year), and tooltip population sections have bold totals and a divider. It shows the combined pyramid, with men/Swiss nationals left and women/foreign nationals right. Source years run oldest at the top, newest at the bottom: entry academic year for entrants, graduation calendar year for degrees. The shared sidebar retains appropriate filters, measure and snapshot; split buttons switch paired source tables while retaining matching selections. The shared date slider and per-year percentage option remain available; start-year normalization is hidden. Unknown gender stays in the table and percentage denominator without being reassigned. No joint gender/nationality distribution or graduate entry cohort is inferred. Subjects retain German names with English translations in parentheses, maintained in a shared version-controlled dictionary; a read-only checker flags missing translations after collection. Detailed subjects sort by German names. Each tab retains its own state. Both checkbox lists provide Select all and Clear all; an empty selection shows a prompt without fetching series data and is retained across tab switches.

Pyramids always fit their fixed-height plot container without internal scrolling. Vertical bar thickness/spacing adapt to the selected period count; year text is capped in size and labels thin out on dense histories to avoid overlap. All bars remain present and hover/keyboard inspection includes unlabeled years. Horizontal bar lengths retain their count/percentage meaning.

The website opens Pyramid by default; Data explorer remains directly accessible at `/#explorer`. The Pyramid plot height is 884px on desktop and 816px on mobile, 70% larger than the previous container. The scaling and year-label selection algorithm remains unchanged.

The first version passed Python/HTTP tests and real-browser checks of the default values, filter/comparison changes, all 28 datasets and mobile layout. It is available at `http://localhost:8768`. Continue refining and expanding the interface together as the user learns the data. See [docs/FRONTEND.md](docs/FRONTEND.md).

- Browse source datasets as published, using their original dimensions and labels.
- Allow dataset/metric, subject, university, study level, and period selection where those dimensions exist.
- Default to the latest successful snapshot for each dataset and allow older snapshots to be selected. Display fetch time and source publication/update metadata when available.
- Design university comparisons, plots, and derived metrics with the user. Keep mappings and interpretation in the presentation layer and explain them when relevant.
- Respect different filters, classifications, and period meanings across datasets. Statistical subjects are not necessarily organizational departments.

Completion check: the agreed interface explores CS student counts and Bachelor entrants at EPFL and ETH from SQLite, compares universities, and switches between retained snapshots.

## 5. Run the website and weekly metadata-check service — implemented and active

At the user's request, the website is already installed as the OS-started `uni-stats.service` user service on port 8768, which was verified unused before installation. The unit is tracked under `deploy/uni-stats.service`; existing user lingering is enabled. It serves SQLite read-only and restarts on failure. The installed service now enables a background worker for Sunday 15:00 Europe/Zurich checks, with persisted scheduling, retries and header status. First activation schedules the next Sunday; subsequent startups run one overdue check if needed.

- Follow ../day-to-day's systemd deployment and background-worker pattern: start with the OS, restart after failures, and serve continuously.
- Run weekly metadata checks in the website service's background worker. Download a full snapshot only when the fetcher detects new reporting periods or tables. The agreed timing is Sunday at 15:00 Europe/Zurich, following daylight saving changes.
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

SQLite storage, direct database collection and the first Data explorer are implemented and tested. The website service is running on port 8768. Weekly metadata checks are now enabled in the installed service, as subsequently requested by the user.

### Weekly service activation (2026-10-11)

`uni-stats.service` is enabled, active and covered by existing user lingering. Its background worker reports active through `/api/update-status`, with the first scheduled check on 2026-10-18 at 15:00 Europe/Zurich (13:00 UTC). No unscheduled observation download was triggered by activation. Tests exercise the real collector offline for unchanged-source skips and new-data snapshots, as well as persisted catch-up, retry/recovery, single-worker ownership and DST. The website header exposes check status and errors without email notifications.

Activation verification: all 47 Python tests and browser checks passed. A live service restart retained the same Sunday deadline and kept collection counts at 2 runs / 28 snapshots. The status dropdown reports Worker: Active, Next scheduled check: 18 October 2026 at 15:00 Zurich, Next retry: None, and no error. No live source probe was forced; the unchanged-data skip and new-data collection paths were exercised with offline source fixtures.

### Static publishing (2026-10-11)

The user approved adding a static publication layer: SQLite remains authoritative, the frontend defaults to lazily fetched CSVs, and public exports contain only each dataset's latest successful snapshot. The local service offers a switch beside the header status to the existing database API, unlocking historical snapshots. All source rows/categories remain available; reviewed All-subject totals are duplicated to reduce browser aggregation.

`scripts/export_static.py` produces validated, atomic latest-release CSV/JSON exports; `web/data-provider.js` and a worker implement static queries. `publication.py` owns an isolated `gh-pages` checkout and durable push retries, independently of collection. Sunday checks now queue a report even when observations are unchanged. Public status is timestamped; the local site shows actual export/push errors and retries. Failed pushes preserve both SQLite snapshots and the previously published public report.

Validation: all 3,519,548 source rows compare cell-for-cell with SQLite, 339 real-data parity queries and 204 exhaustive small-cube combinations agree, and a static-only browser opens every dataset under `/uni-stats/`. Largest compressed file is 101 KB; largest full selection is 1.48 MB across 16 files. Full implementation, operation and timings are in [docs/STATIC_PUBLISHING.md](docs/STATIC_PUBLISHING.md). Configure GitHub Pages once to serve the `gh-pages` branch root; subsequent worker pushes publish updated reports.

Activation: the permanent service successfully pushed the initial report to `gh-pages` using its own credentials without adding collection runs or snapshots. All 51 Python tests and both static-only and permanent-service browser suites passed. GitHub Pages still returned 404; the one-time repository publishing-source setting remains to be enabled by the repository administrator.
