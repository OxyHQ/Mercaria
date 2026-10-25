# Commerce browser boundary gate

Run from the repository root after installing the existing Playwright Chromium:

```sh
TEST_DATABASE_URL=postgres://test_role@localhost:5435/postgres bun run test:commerce-backend-browser
```

`TEST_DATABASE_URL` is required and must name a test server on which the harness
may create and drop a throwaway database. There is no fallback to a developer
or production `DATABASE_URL`. The normal repository test-database helper applies
all migrations. Its guarded cleanup drops only that generated test database;
the browser and HTTP listeners also close in `finally`.

This runs Chromium against the actual `createApp()` middleware chain with local
synthetic fixtures. It verifies trusted-origin credentialed preflight, referral
exchange and persistence-before-ACK; original carrier bytes across retries;
header precedence; the ordinary cookie-free lane; the general rate limiter;
foreign-origin preflight refusal; and referral feature activation remaining off.
The guest flag is on only in this isolated process to exercise ordinary old-web
refusal. Test-only signing keys never leave the local process/browser.

The local allowed origin uses the existing `WEB_URL` setting and test-mode cookie
name. The browser's CORS and HttpOnly cookie behavior is real; this is not a
production-host or live-customer canary. Old credentialed bundles cannot read the
HTTP 426 body because ordinary responses intentionally omit credentialed CORS;
the browser receives a network/CORS error. The gate asserts that distinction.

Results in `test-results/commerce-backend/receipt.json` contain check names,
status/header metadata, browser version, commit and SHA-256 of the reviewed
source files. They contain no credential values. A source change during the run
fails rather than attaching the result to different code. Backend unit/real-DB
tests separately cover signature, cutoff/deadline, expiry, revocation, tenant
ownership and operation authorization. Frontend storage tests separately cover
failed persistence and concurrent tabs; this gate is not a substitute for either.
