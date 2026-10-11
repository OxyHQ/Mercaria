#!/usr/bin/env bun

/**
 * Mutation-tests `check-contract-json-schemas.mjs` against synthetic contract
 * modules built from the REAL one: each case breaks exactly one thing and
 * requires the gate to name it. The real module must pass first, or every
 * mutation below would "fail" for the wrong reason.
 */

import { z } from 'zod';
import {
  assertJsonSchemaSurface,
  MINIMUM_PUBLISHED_NAMES,
} from './check-contract-json-schemas.mjs';
import { CONTRACTS_ENTRY } from './generate-public-openapi.mjs';

const real = await import(CONTRACTS_ENTRY);
let failed = 0;

function report(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

/** A copy of the real module's surface, with `change` applied. */
function variant(change) {
  const contracts = {
    CONTRACT_JSON_SCHEMA_NAMES: [...real.CONTRACT_JSON_SCHEMA_NAMES],
    CONTRACT_SCHEMAS: { ...real.CONTRACT_SCHEMAS },
    MERCARIA_PUBLIC_ROUTES: real.MERCARIA_PUBLIC_ROUTES.map((route) => ({ ...route })),
  };
  contracts.mercariaJsonSchema = (name) =>
    z.toJSONSchema(contracts.CONTRACT_SCHEMAS[name], { io: 'input' });
  change(contracts);
  return contracts;
}

function mustFail(name, pattern, change) {
  const failures = assertJsonSchemaSurface(variant(change));
  report(
    name,
    failures.some((failure) => pattern.test(failure)),
    `got: ${failures.join(' | ') || 'none'}`,
  );
}

console.log('check-contract-json-schemas self-test\n');

const realFailures = assertJsonSchemaSurface(real);
report('the real contract passes', realFailures.length === 0, realFailures.join(' | '));
report(
  'and clears the floor on its own',
  real.CONTRACT_JSON_SCHEMA_NAMES.length >= MINIMUM_PUBLISHED_NAMES,
  `${real.CONTRACT_JSON_SCHEMA_NAMES.length} name(s)`,
);

mustFail('a name without a schema', /absent from CONTRACT_SCHEMAS: MercariaStore\b/, (c) => {
  delete c.CONTRACT_SCHEMAS.MercariaStore;
});
mustFail('a schema without a name', /not in CONTRACT_JSON_SCHEMA_NAMES: MercariaCart/, (c) => {
  c.CONTRACT_SCHEMAS.MercariaCart = z.object({ id: z.string() });
});
mustFail('a duplicated name', /duplicate name\(s\): MercariaStore/, (c) => {
  c.CONTRACT_JSON_SCHEMA_NAMES.push('MercariaStore');
});
mustFail(
  'a route answering with an undeclared name',
  /listStoreCollections responds with `MercariaCartPage`/,
  (c) => {
    c.MERCARIA_PUBLIC_ROUTES.find(
      (route) => route.operationId === 'listStoreCollections',
    ).response = 'MercariaCartPage';
  },
);
mustFail('a schema zod cannot convert', /mercariaJsonSchema\('MercariaStore'\) THREW/, (c) => {
  c.CONTRACT_SCHEMAS.MercariaStore = z.object({ at: z.date() }).transform((value) => value.at);
  c.mercariaJsonSchema = (name) => z.toJSONSchema(c.CONTRACT_SCHEMAS[name], { io: 'output' });
});
mustFail(
  'a schema that converts to nothing',
  /mercariaJsonSchema\('MercariaStore'\) returned no constraint/,
  (c) => {
    c.CONTRACT_SCHEMAS.MercariaStore = z.unknown();
  },
);
mustFail('a broken import that finds no names', /below the floor/, (c) => {
  c.CONTRACT_JSON_SCHEMA_NAMES.length = 0;
  c.CONTRACT_SCHEMAS = {};
});

if (failed > 0) {
  console.error(`\n${failed} case(s) failed: check-contract-json-schemas.mjs cannot be trusted.`);
  process.exit(1);
}
console.log(
  '\ncheck-contract-json-schemas.mjs fails on every mutation and passes the real contract.',
);
