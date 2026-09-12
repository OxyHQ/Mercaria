/**
 * The environment this domain's realdb test needs, set BEFORE anything imports
 * `config`.
 *
 * `config/index.ts` reads `process.env` once, at module load, and freezes the
 * result — which is what makes a lever a deployment decision rather than
 * something a request can change. A test that wants procurement ON therefore
 * cannot set the variable in `beforeAll`: by then the config object exists.
 *
 * ES module evaluation is depth-first in import order, so a side-effect module
 * imported FIRST runs before the next import's body. That is the whole mechanism,
 * and it is why this is a separate file rather than three lines at the top of the
 * test: statements at the top of a module run AFTER every one of its imports.
 *
 * The sealing key is a throwaway 32 bytes of a fixed byte, not a secret. Its
 * reference is a path under this domain's own prefix, so the resolver's narrowing
 * check is exercised too.
 */

process.env.DIGITAL_RETAIL_PROCUREMENT_ENABLED = 'true';
process.env.DIGITAL_RETAIL_REVEAL_ENABLED = 'true';
process.env.DIGITAL_RETAIL_SEAL_KEY_REFERENCE = '/oxy/mercaria/digital-retail/seal/test';
process.env.DIGITAL_RETAIL_SEAL_KEY_TEST = Buffer.alloc(32, 11).toString('base64');
