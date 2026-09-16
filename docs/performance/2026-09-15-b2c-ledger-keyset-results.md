# B2C Ledger keyset-read results

Measured locally on 2026-09-16 against the Supabase Docker stack. No linked or remote command was used.

## Dataset and correctness

The deterministic fixture seeded 980 payments and 95 refunds across an 18-month window. Together with the development seed, the Ledger contained 1,078 records. It included:

- a raw July payment overridden into August;
- a raw August payment overridden into July;
- converted and conversion-pending BHD payments;
- succeeded refunds;
- an open follow-up flag;
- an audited duplicate exclusion; and
- an audited Finance inclusion exception.

Command:

```bash
node scripts/b2c-ledger-performance.mjs --mode=equivalence --runs=5
```

Result: zero differences across 1,078 all-time records and six query shapes (August, all time, source plus search, foreign-currency review, issue, and USD range). The harness compares aggregate totals/counts, period membership, filter metadata, every row value, ordered decision reasons, and reporting decisions. It canonicalizes only PostgREST's legacy `numeric` number representation against the decimal-string database type contract. Keyset traversal also asserts that no identity is repeated.

The override assertion independently confirmed that August includes the raw-July/local-August payment and excludes the raw-August/local-July payment.

The 1,250-payment unit fixture exposed a pre-existing legacy limit: an unbounded PostgREST table read is capped at 1,000 rows locally. The new Work-decision RPC returns one JSON aggregate, and Ledger pagination is keyset-based, so neither path is truncated at that boundary. The measured 980-payment dataset keeps each legacy source table below that cap so the old path remains a valid output oracle.

## Timing method

Each path was warmed once, then timed sequentially five times against the identical already-seeded database. Values below are medians of the five wall-clock samples from the application repository/RPC boundary.

| Request | Legacy median | Keyset median | Speedup | Legacy materialization | New hydration |
|---|---:|---:|---:|---:|---:|
| September 2026 | 78.96 ms | 24.60 ms | 3.21× | Full supporting history | 25 rows |
| All time, first 100 | 163.46 ms | 77.58 ms | 2.11× | 1,078 Ledger rows plus supporting history | 100 rows |
| Selective search, 1 match | 153.55 ms | 49.09 ms | 3.13× | Full supporting history | 1 row |
| All time, next 100 | 173.52 ms | 64.75 ms | 2.68× | Full supporting history | 100 rows |
| One payment's evidence | 194.78 ms | 4.84 ms | 40.24× | 1,078 Ledger rows plus evidence history | 1 JSON object |

Commands:

```bash
node scripts/b2c-ledger-performance.mjs --mode=legacy --runs=5 --reuse-seed
node scripts/b2c-ledger-performance.mjs --mode=keyset --runs=5 --reuse-seed
```

## PostgreSQL execution evidence

`EXPLAIN (ANALYZE, BUFFERS)` was run inside `supabase_db_playbook-fos-local` after setting the local seeded Admin claim.

| Query | Execution time | Shared buffers |
|---|---:|---:|
| All-time keyset identities, limit 101 | 100.335 ms | 13,273 hits |
| Selective metadata/distinct aggregate | 77.528 ms | 12,973 hits |
| September dashboard summary aggregate | 165.201 ms | 13,519 hits |

The Postgres timings are not directly comparable to the warmed HTTP medians: they include `EXPLAIN ANALYZE` overhead and were captured separately. They show that the Ledger response remains a bounded identity page plus a one-row metadata aggregate; only the selected identities are hydrated and sent to the browser.
