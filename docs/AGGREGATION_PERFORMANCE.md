# Aggregation performance analysis

Measured locally on 2026-10-11 against the current SQLite snapshot. No performance optimizations or database changes were made. Subject stacking was off for these measurements; timings are backend/HTTP timings, not complete browser paint timings. The test scripts and raw profiles are temporary files under `/tmp/uni-stats-profile*` and `/tmp/uni-stats-pyramid-timing*`.

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

The pyramid currently issues a separate request for each selected university using `Promise.all`. `ThreadingHTTPServer` executes those queries on separate threads. The direct sequential/threaded comparison isolates a large concurrency penalty in the backend. SQLite row retrieval and Python work repeatedly hand control between threads; Python's shared interpreter lock and thread scheduling are the likely explanation. This is an inference supported by the measured penalty, not a low-level lock trace.

The tested all-subject query already uses the primary key with snapshot, year, subject, gender and university constraints. An extra index is therefore not the obvious first fix. It would not eliminate Python aggregation or the concurrency penalty.

Date changes can also start replacement requests. Aborting the browser fetch prevents stale display updates but does not cancel SQL/Python work already executing in the server. This can compound contention during rapid interactions; its additional cost was not measured here.

## Options to consider next

1. **Batch the selected universities into one pyramid API request.** Return both sides and the university/subject components from one query. The existing Explorer comparison timings suggest this is promising, but a complete pyramid implementation still needs benchmarking. This is the preferred structural fix.
2. **As a smaller experiment, limit concurrent requests.** The sequential measurements demonstrate that fewer competing threads could improve latency considerably without changing source data.
3. **Cache derived responses by snapshot and selection.** Snapshots are immutable, so snapshot-specific caching is straightforward and avoids recomputation when revisiting a selection. Bound the cache size and include dataset, measure, categories, period range and breakdown in the key.
4. **Move aggregation closer to SQLite if still necessary.** Preserve missing-marker/completeness checks and decimal precision. Blindly casting source text and applying `SUM` would change correctness because missing markers can become zero and decimal values can lose precision.
5. **Debounce/cancel work more effectively if interactions remain slow.** Avoid running obsolete requests to completion when selections change rapidly.

None of these options has been implemented. The subject-stack feature adds subject components within each existing query rather than issuing additional per-subject requests; it retains the current per-university pyramid request pattern.
