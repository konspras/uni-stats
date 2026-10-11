# Aggregation performance analysis

Initial measurements were made locally on 2026-10-11 against the current SQLite snapshot, before the batching change described below. No database changes were made. Subject stacking was off for these measurements; timings are backend/HTTP timings, not complete browser paint timings. The test scripts and raw profiles are temporary files under `/tmp/uni-stats-profile*` and `/tmp/uni-stats-pyramid-timing*`.

## Measurements

Full source history, one gender and the bachelor level where applicable; three runs per selection:

| Dataset | CS, ETH + EPFL | All detailed subjects, ETH + EPFL | All detailed subjects, all universities |
| --- | --- | --- | --- |
| Bachelor entrants (`123`) | ~0.001 s | 0.017–0.018 s | 0.110–0.113 s |
| Enrolled students (`105`) | ~0.001 s | 0.019–0.020 s | 0.129–0.132 s |
| Degrees (`101`) | ~0.001 s | 0.019–0.021 s | 0.125–0.137 s |

For the entrants pyramid, full history, both gender categories and all subjects, the frontend's 15 university queries cost:

| Execution | Three measurements |
| --- | --- |
| Same queries called sequentially | 0.268, 0.265, 0.270 s |
| Same queries in 15 Python threads | 11.263, 13.135, 13.416 s |
| Same queries concurrently through the running HTTP service | 10.281, 13.132, 12.095 s |

An earlier threaded run took 4.745 s; contention varies substantially, but concurrent execution was consistently much slower than sequential execution. These runs measure identical source selections without subject breakdowns. Browser rendering adds further work and was not separately profiled.

## Why it slows down

`Explorer.series()` retrieves individual source rows, retains their text values in Python lists, checks numeric validity and completeness, then adds values with `Decimal`. Summing all subjects multiplies the number of components compared with a single subject. The all-university entrants query for one gender consumed 53,130 source rows. Its instrumented profile took 0.197 s (profiling itself adds overhead), with numeric validation accounting for about 0.076 s and SQL iteration/list construction included in the main function's own time.

Before the batching change, the pyramid issued a separate request for each selected university using `Promise.all`. `ThreadingHTTPServer` executes those queries on separate threads. The direct sequential/threaded comparison isolates a large concurrency penalty in the backend. SQLite row retrieval and Python work repeatedly hand control between threads; Python's shared interpreter lock and thread scheduling are the likely explanation. This is an inference supported by the measured penalty, not a low-level lock trace.

The tested all-subject query already uses the primary key with snapshot, year, subject, gender and university constraints. An extra index is therefore not the obvious first fix. It would not eliminate Python aggregation or the concurrency penalty.

Date changes can also start replacement requests. Aborting the browser fetch prevents stale display updates but does not cancel SQL/Python work already executing in the server. This can compound contention during rapid interactions; its additional cost was not measured here.

## Options to consider next

1. **Batch the selected universities into one pyramid API request.** Return both sides and the university/subject components from one query. The existing Explorer comparison timings suggest this is promising, but a complete pyramid implementation still needs benchmarking. This is the preferred structural fix.
2. **As a smaller experiment, limit concurrent requests.** The sequential measurements demonstrate that fewer competing threads could improve latency considerably without changing source data.
3. **Cache derived responses by snapshot and selection.** Snapshots are immutable, so snapshot-specific caching is straightforward and avoids recomputation when revisiting a selection. Bound the cache size and include dataset, measure, categories, period range and breakdown in the key.
4. **Move aggregation closer to SQLite if still necessary.** Preserve missing-marker/completeness checks and decimal precision. Blindly casting source text and applying `SUM` would change correctness because missing markers can become zero and decimal values can lose precision.
5. **Debounce/cancel work more effectively if interactions remain slow.** Avoid running obsolete requests to completion when selections change rapidly.

The initial analysis above did not apply any optimizations. University batching was subsequently authorized and implemented as described below; the other options remain unimplemented.

## Implemented batching and verification

The Pyramid now sends one request containing the selected university codes. The backend performs one SQL read, groups the rows into university partitions and returns the same per-university series consumed by the existing display aggregation. Subject components are returned in that same request when required. Explorer requests are unchanged. There is no new index, cache, dependency or database migration.

Live HTTP measurements after the change used the full history of detailed bachelor entrants (`123`), both genders, all subjects and all 15 universities. The old request shape remains supported, allowing a comparison against the same running server and database:

| Request pattern | Three runs (seconds) | Median |
| --- | --- | --- |
| Old: 15 concurrent university requests | 11.971, 14.080, 12.985 | 12.985 s |
| New: one batched request | 0.241, 0.270, 0.333 | 0.270 s |
| New: one batched request including subject breakdowns | 0.965, 0.953, 0.905 | 0.953 s |

The comparable no-breakdown case is approximately **48× faster**. Subject breakdowns return substantially more JSON (about 12.3 MB using Python's JSON serialization in the benchmark, versus 159 kB without breakdowns); that timing includes HTTP transfer and JSON parsing. These timings do not imply every dataset or selection will be equally fast.

Exact batch-versus-individual equality was checked against the stored source data for all six eligible tables (`121`, `122`, `123`, `124`, degrees `101`, `102`), across their full histories and all available categories. Direct batch timings for these deliberately broad selections ranged from 0.05 to 1.55 seconds, with degrees aggregating all exam levels being the largest. Fixture tests also verify decimal precision, missing markers, absent coordinates, invalid requests, a single university and exactly one SQL observation read. Browser checks verify one API request for All universities and for subject stacking, together with ranking, percentages, tab state and both pyramid splits.

Reproduction scripts and raw measurements for this update are `/tmp/benchmark-batch.py` and `/tmp/benchmark-batch-results.txt`. Benchmark requests are read-only and do not modify stored observations.

Complete browser updates were also measured in desktop Chromium, from starting `updatePlot()` through its API request, chart construction and two animation frames. Using the same detailed entrants table, all 15 universities and all 46 source years:

| Display | Three runs (seconds) |
| --- | --- |
| Aggregated totals (92 bars) | 0.261, 0.258, 0.260 |
| Subject stacks (7,084 bars) | 1.165, 1.150, 1.143 |

These are single-user local measurements, with percentage mode off. The browser timing script is `/tmp/benchmark-batch-browser.mjs`. The full source and HTTP benchmarks used the same snapshot throughout; stored observations were not changed.
