#!/usr/bin/env bun

/**
 * Every named schema of `@mercaria/contracts` converts to JSON Schema, the name
 * list and the schema map agree, and the route registry answers only with
 * names that exist (pattern: `CrowdSource/scripts/check-published-json-schemas.mjs`).
 *
 * `mercariaJsonSchema(name)` calls `z.toJSONSchema` LAZILY, so a schema zod
 * cannot convert — a transform on the output side, a shape it refuses — throws
 * at the moment somebody asks for it: when the OpenAPI document is next
 * generated, or when `/public/v1/openapi.json` is first served. Not at build
 * time, and not in any check that merely imports the package. This forces the
 * conversion for every name.
 *
 * The assertions are deliberately NOT a count literal — a literal is one more
 * place to update when a schema is added, and a merge resolving it to a
 * plausible wrong number is how an omission passes. Instead:
 *
 *   * `CONTRACT_JSON_SCHEMA_NAMES` and the keys of `CONTRACT_SCHEMAS` must be the
 *     same SET, both directions — they are maintained separately;
 *   * every route in `MERCARIA_PUBLIC_ROUTES` must respond with a declared name;
 *   * every name must convert without throwing, to a non-trivial document;
 *   * a floor and a duplicate check, so a broken import returning nothing, or a
 *     duplicate inflating a count while hiding an omission, cannot pass.
 *
 * It imports the contract's SOURCE (bun runs TypeScript), the same module the
 * OpenAPI generator reads. The logic is exported and pure so
 * `test-check-contract-json-schemas.mjs` can mutation-test it.
 */

import { CONTRACTS_ENTRY } from "./generate-public-openapi.mjs";

/**
 * The fewest names the contract has ever published. A floor, not an equality —
 * it never needs updating when a schema is ADDED; dropping below it is worth a
 * deliberate edit.
 */
export const MINIMUM_PUBLISHED_NAMES = 18;

/** Takes the module rather than a path, so a test can hand it a synthetic one. */
export function assertJsonSchemaSurface(contracts) {
  const failures = [];
  const names = contracts.CONTRACT_JSON_SCHEMA_NAMES;
  const schemas = contracts.CONTRACT_SCHEMAS;
  const convert = contracts.mercariaJsonSchema;
  const routes = contracts.MERCARIA_PUBLIC_ROUTES;

  if (!Array.isArray(names)) return ["CONTRACT_JSON_SCHEMA_NAMES is not an array."];
  if (schemas === null || typeof schemas !== "object") return ["CONTRACT_SCHEMAS is not an object."];
  if (typeof convert !== "function") return ["mercariaJsonSchema is not a function."];
  if (!Array.isArray(routes)) return ["MERCARIA_PUBLIC_ROUTES is not an array."];

  if (names.length < MINIMUM_PUBLISHED_NAMES) {
    failures.push(
      `only ${names.length} schema name(s) found, below the floor of ${MINIMUM_PUBLISHED_NAMES}: ` +
        "the import is broken or names were removed.",
    );
  }
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length > 0) failures.push(`duplicate name(s): ${[...new Set(duplicates)].join(", ")}.`);

  const declared = new Set(names);
  const registered = new Set(Object.keys(schemas));
  const missingSchema = [...declared].filter((name) => !registered.has(name));
  const missingName = [...registered].filter((name) => !declared.has(name));
  if (missingSchema.length > 0) {
    failures.push(`named but absent from CONTRACT_SCHEMAS: ${missingSchema.join(", ")}. Asking for one throws.`);
  }
  if (missingName.length > 0) {
    failures.push(
      `in CONTRACT_SCHEMAS but not in CONTRACT_JSON_SCHEMA_NAMES: ${missingName.join(", ")}. ` +
        "It never becomes an OpenAPI component.",
    );
  }

  for (const route of routes) {
    if (!declared.has(route.response)) {
      failures.push(`route ${route.operationId} responds with \`${route.response}\`, which is not a declared name.`);
    }
  }

  for (const name of declared) {
    if (!registered.has(name)) continue;
    let document;
    try {
      document = convert(name);
    } catch (error) {
      failures.push(
        `mercariaJsonSchema('${name}') THREW: ${error instanceof Error ? error.message : String(error)}.`,
      );
      continue;
    }
    const keys = document !== null && typeof document === "object" ? Object.keys(document) : [];
    // `$schema` alone is what an unconstrained `z.unknown()` converts to.
    if (keys.filter((key) => key !== "$schema").length === 0) {
      failures.push(`mercariaJsonSchema('${name}') returned no constraint at all.`);
    }
  }

  return failures;
}

if (import.meta.main) {
  const contracts = await import(CONTRACTS_ENTRY);
  const failures = assertJsonSchemaSurface(contracts);
  if (failures.length > 0) {
    console.error("@mercaria/contracts has an unusable JSON Schema surface:\n");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(
    `All ${contracts.CONTRACT_JSON_SCHEMA_NAMES.length} contract schema name(s) convert to JSON Schema, ` +
      `the name list and schema map agree, and all ${contracts.MERCARIA_PUBLIC_ROUTES.length} route(s) answer with one.`,
  );
}
