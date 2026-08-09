/**
 * Turn the canonical-WRITE publication lever on, for one test file.
 *
 * `config` is frozen at module initialisation, so an assignment inside a
 * `beforeAll` runs far too late — by then `createGraphWriter` has already read a
 * `false` and every `apply` run in the file would silently take the DRY-RUN
 * writer and assert nothing.
 *
 * Its own module because ESM evaluates a file's imports IN ORDER: a test that
 * lists this first has the variable set before `config/index.ts` is initialised
 * by any later import. That is the mechanism, and it only works from a module —
 * a statement at the top of the test file itself would still run after every
 * import in it was hoisted and evaluated.
 *
 * Setting it here rather than in `vitest.pg.globalSetup.ts` is deliberate: the
 * lever defaulting OFF is a property other tests legitimately depend on (a run
 * opened with it off must produce a complete report and change nothing), and a
 * global that turned it on everywhere would delete that case from the suite.
 */

process.env.CANONICAL_WRITE_PUBLICATION_ENABLED = 'true';
