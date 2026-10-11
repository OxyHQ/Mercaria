#!/usr/bin/env bun

/**
 * Write `packages/contracts/openapi.json` — the OpenAPI 3.1 document for
 * `/public/v1` — from `@mercaria/contracts`' route registry and named schemas.
 *
 *   bun run openapi:generate
 *
 * The document is a pure function of the contract (`mercariaPublicOpenApiDocument`),
 * so this script only renders and writes it. It imports the contract's SOURCE
 * (bun runs TypeScript), so a regeneration never reads a stale `dist/`; the
 * closed value sets it names come from `@mercaria/shared-types`' build, which
 * the `openapi:generate` script rebuilds first.
 *
 * `scripts/check-public-openapi.mjs` fails the build when the committed bytes
 * are not what this renders.
 */

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OPENAPI_DOCUMENT_PATH = resolve(
  repositoryRoot,
  'packages',
  'contracts',
  'openapi.json',
);
export const CONTRACTS_ENTRY = resolve(repositoryRoot, 'packages', 'contracts', 'src', 'index.ts');

/** The committed spelling: two-space JSON and a trailing newline. */
export function renderOpenApi(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

if (import.meta.main) {
  const contracts = await import(CONTRACTS_ENTRY);
  await writeFile(OPENAPI_DOCUMENT_PATH, renderOpenApi(contracts.mercariaPublicOpenApiDocument()));
  console.log(`wrote ${OPENAPI_DOCUMENT_PATH.slice(repositoryRoot.length + 1)}`);
}
