/**
 * Turn the natural-language MODEL lever on, for one test file (#95).
 *
 * `config` is frozen at module initialisation, so an assignment inside a
 * `beforeAll` runs far too late — by then `decideEnablement` would already read
 * a `false` and every case in the file would report `parser_disabled`, which is
 * the FIRST gate and therefore hides every gate behind it.
 *
 * Its own module because ESM evaluates a file's imports IN ORDER: a test that
 * lists this first has the variable set before `config/index.ts` is initialised
 * by any later import. The `enable-canonical-writes.ts` mechanism, and it only
 * works from a module — a statement at the top of the test file itself would
 * still run after every import in it was hoisted and evaluated.
 *
 * What it buys is the interesting seam rather than the default one: with the
 * lever ON and no parser registered, the fallback reason is
 * `provider_unconfigured` — the fail-closed default that proves nothing in this
 * repository registers a provider. `parser_disabled` stays reachable in the
 * same file through `deterministicOnly`, so turning the lever on does not
 * delete a case from the suite.
 */

process.env.NL_INTENT_ENABLED = 'true';
