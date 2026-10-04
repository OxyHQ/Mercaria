# Explicit cohort with general Stripe disabled

Source `c515a45f9e3da040a3e7cf16eff5163a37e556d2` derives from production source `464ef1e29022036afba5c8342480a8c9e18ef3e0`. The cohort is
parsed and the explicit Peable credential pair is checked before reads even when
`STRIPE_ENABLED` is off. A new bounded Stripe reader exposes only account and
exact-subscription GETs. The existing general client and direct legacy mutations
retain their gate. New actions still use `MERCHANT_BILLING_ENABLED`; no config,
catalogue, prices, schema, dependencies or lockfile changed.

The identical registration fixture produces 5 failures/7 passes with baseline
register.ts and 12 passes with the final registration. The final run passes
6 suites/64 tests: registration12, readonly SDK reader9, legacy Stripe5, real SQL
adapter16, real app CORS1 and signed webhook21. The reader fixture uses the real
installed Stripe SDK with its documented synthetic fetch transport, verifying
only GET requests; it also checks wrong/missing key, account/mode/namespace,
half Peable credentials and disabled legacy mutation paths. Authority responses
are explicit fixtures. No real provider request or production write occurred.

The first expanded run passed42 billing cases but failed app imports with
`ENOSPC` because shared `/tmp` was full;22 webhook/CORS cases did not execute.
Both failure and teardown logs are retained. The final run uses an owned
workspace TMPDIR and an owned fresh PG17/PostGIS cluster, normal test migrations
and verified shutdown. Typecheck and scoped ESLint (`--max-warnings=0`) ran after
restoring stable final source; backend build also passed. The earlier overlapping
typecheck is excluded from this proof.

[proof.json](proof.json) binds source, records and compiled outputs. Logs include
only local fixture IDs and local PostgreSQL metadata. This proves the local
source behavior; live registration still requires review, a new image and root's
configuration/readback of the existing credential references and exact cohort.
No broad Stripe enablement or new commercial offer is authorized by this change.
