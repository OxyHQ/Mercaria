#!/usr/bin/env bun

/**
 * Fail the build when `packages/contracts/openapi.json` — the published
 * description of `/public/v1` — stops describing the API, or stops being what
 * the contract generates.
 *
 * The document is GENERATED from `@mercaria/contracts`' route registry, and the
 * backend router is BUILT from that same registry, so a route served but not
 * documented cannot happen by construction. What can still go wrong, and what
 * each layer below exists for (pattern: `oxy/scripts/check-openapi-fresh.mjs`):
 *
 * Layer 1 — the surface is described, BY NAME, in both directions. A hand list
 * of every operation a consumer's client is generated from, checked against the
 * committed document. Not derived from the registry, because a list derived from
 * the thing under test cannot disagree with it: deleting a registry entry and
 * regenerating in the same commit keeps every other layer green, and only this
 * one sees the route disappear. Adding an operation is an edit here too, which
 * is the point — somebody decides the public surface grew.
 *
 * Layer 2 — every operation DESCRIBES ITS PAYLOADS. A unique `operationId`; a
 * 200 whose schema is a `$ref` to a component that has content; every other
 * status answering with `MercariaErrorBody`; the universal statuses (400, 429,
 * 500) on every operation, 429 with `Retry-After`; every `{param}` in the path
 * declared as a required path parameter. And the error-code enum is EXACTLY the
 * shared Oxy list, because renaming a code is a breaking change.
 *
 * Layer 3 — the document speaks the DIALECT it declares. `openapi: 3.1.0` is
 * JSON Schema 2020-12: no `nullable`, and `exclusiveMinimum`/`exclusiveMaximum`
 * are numbers, never booleans. Checked over the parsed KEYS, never the text, so
 * a description that mentions "nullable" cannot trip it.
 *
 * Layer 4 — the artifact is FRESH: the committed bytes equal what the contract
 * renders now. The only layer that sees a schema or a description change
 * without a regeneration.
 *
 * The assertions are exported and pure so `test-check-public-openapi.mjs` can
 * mutation-test each layer; the CLI half only does the I/O.
 */

import { readFile } from "node:fs/promises";
import { CONTRACTS_ENTRY, OPENAPI_DOCUMENT_PATH, renderOpenApi } from "./generate-public-openapi.mjs";

/** Every operation `/public/v1` publishes, spelled out (method, path, operationId). */
export const EXPECTED_OPERATIONS = [
  ["get", "/products", "searchProducts"],
  ["get", "/products/{id}", "getProduct"],
  ["get", "/stores/lookup", "lookupStore"],
  ["get", "/stores/{id}", "getStore"],
  ["get", "/stores/{id}/products", "listStoreProducts"],
  ["get", "/stores/{id}/collections", "listStoreCollections"],
  ["get", "/stores/{id}/locations", "listStoreLocations"],
  ["get", "/collections/{id}", "getCollection"],
  ["get", "/collections/{id}/products", "listCollectionProducts"],
  ["get", "/locations", "listLocations"],
  ["get", "/locations/{id}", "getLocation"],
  ["get", "/locations/{id}/products", "listLocationProducts"],
  ["get", "/openapi.json", "getOpenApiDocument"],
];

/** The shared Oxy error codes (`~/Oxy/docs/api-conventions.md`), exactly. */
export const EXPECTED_ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "unknown_route",
  "gone",
  "conflict",
  "validation_failed",
  "rate_limited",
  "internal_error",
  "service_unavailable",
];

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const ERROR_BODY_REF = "#/components/schemas/MercariaErrorBody";
const UNIVERSAL_STATUSES = ["400", "429", "500"];

function operationsOf(document) {
  const operations = [];
  for (const [path, item] of Object.entries(document?.paths ?? {})) {
    for (const [method, operation] of Object.entries(item ?? {})) {
      if (HTTP_METHODS.has(method)) operations.push({ method, path, operation: operation ?? {} });
    }
  }
  return operations;
}

/** Every key of every object in `value`, with the path it sits at. */
function walkKeys(value, visit, at = "") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkKeys(entry, visit, `${at}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      visit(key, entry, `${at}/${key}`);
      walkKeys(entry, visit, `${at}/${key}`);
    }
  }
}

function sameSet(a, b) {
  return a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
}

/** Layers 1–3 over a parsed document. Returns the failures; empty means sound. */
export function checkOpenApiDocument(document) {
  const failures = [];
  const operations = operationsOf(document);
  const schemas = document?.components?.schemas ?? {};

  // Layer 1 — by name, both directions.
  const described = operations.map(({ method, path, operation }) => `${method} ${path} ${operation.operationId}`);
  const expected = EXPECTED_OPERATIONS.map(([method, path, id]) => `${method} ${path} ${id}`);
  for (const entry of expected.filter((item) => !described.includes(item))) {
    failures.push(`layer 1: the document does not describe \`${entry}\`.`);
  }
  for (const entry of described.filter((item) => !expected.includes(item))) {
    failures.push(
      `layer 1: the document describes \`${entry}\`, which EXPECTED_OPERATIONS does not name. ` +
        "A new public operation is a decision: add it there.",
    );
  }

  // Layer 2 — payloads.
  const ids = operations.map(({ operation }) => operation.operationId);
  for (const id of ids.filter((value, index) => ids.indexOf(value) !== index)) {
    failures.push(`layer 2: operationId \`${id}\` is not unique.`);
  }
  for (const { method, path, operation } of operations) {
    const where = `${method.toUpperCase()} ${path}`;
    if (typeof operation.operationId !== "string" || operation.operationId === "") {
      failures.push(`layer 2: ${where} has no operationId.`);
    }
    const responses = operation.responses ?? {};
    const success = responses["200"]?.content?.["application/json"]?.schema?.$ref;
    const component = typeof success === "string" ? schemas[success.replace("#/components/schemas/", "")] : undefined;
    if (typeof success !== "string" || !success.startsWith("#/components/schemas/")) {
      failures.push(`layer 2: ${where} has no 200 schema \`$ref\`.`);
    } else if (component === undefined || Object.keys(component).length === 0) {
      failures.push(`layer 2: ${where} answers 200 with \`${success}\`, which is missing or empty.`);
    }
    for (const status of UNIVERSAL_STATUSES) {
      if (responses[status] === undefined) failures.push(`layer 2: ${where} does not describe ${status}.`);
    }
    for (const [status, response] of Object.entries(responses)) {
      if (status.startsWith("2")) continue;
      if (response?.content?.["application/json"]?.schema?.$ref !== ERROR_BODY_REF) {
        failures.push(`layer 2: ${where} answers ${status} with something other than MercariaErrorBody.`);
      }
    }
    if (responses["429"] !== undefined && responses["429"]?.headers?.["Retry-After"] === undefined) {
      failures.push(`layer 2: ${where} describes 429 without a Retry-After header.`);
    }
    const parameters = operation.parameters ?? [];
    for (const [, name] of path.matchAll(/\{([^}]+)\}/g)) {
      if (!parameters.some((parameter) => parameter.in === "path" && parameter.name === name && parameter.required === true)) {
        failures.push(`layer 2: ${where} does not declare the required path parameter \`${name}\`.`);
      }
    }
    for (const parameter of parameters) {
      if (parameter.schema === undefined) failures.push(`layer 2: ${where} parameter \`${parameter.name}\` has no schema.`);
    }
  }
  const codes = schemas.MercariaErrorBody?.properties?.error?.properties?.code?.enum;
  if (!Array.isArray(codes) || !sameSet(codes, EXPECTED_ERROR_CODES)) {
    failures.push(
      `layer 2: MercariaErrorBody's code enum is [${Array.isArray(codes) ? codes.join(", ") : "missing"}], ` +
        `expected exactly [${EXPECTED_ERROR_CODES.join(", ")}]. Renaming a code is a breaking change.`,
    );
  }

  // Layer 3 — dialect.
  if (document?.openapi !== "3.1.0") failures.push(`layer 3: openapi is ${document?.openapi}, expected 3.1.0.`);
  walkKeys(document, (key, value, at) => {
    if (key === "nullable") failures.push(`layer 3: \`nullable\` at ${at} — removed in OpenAPI 3.1.`);
    if ((key === "exclusiveMinimum" || key === "exclusiveMaximum") && typeof value === "boolean") {
      failures.push(`layer 3: boolean \`${key}\` at ${at} — a number in OpenAPI 3.1.`);
    }
  });

  return failures;
}

/** Layer 4 — the committed bytes are what the contract renders. */
export function checkFreshness(committed, generated) {
  if (committed === generated) return [];
  return [
    "layer 4: packages/contracts/openapi.json is not what the contract generates. " +
      "Run `bun run openapi:generate` and commit the result — and read the diff for REMOVED lines.",
  ];
}

if (import.meta.main) {
  const committed = await readFile(OPENAPI_DOCUMENT_PATH, "utf8");
  const contracts = await import(CONTRACTS_ENTRY);
  const failures = [
    ...checkOpenApiDocument(JSON.parse(committed)),
    ...checkFreshness(committed, renderOpenApi(contracts.mercariaPublicOpenApiDocument())),
  ];
  if (failures.length > 0) {
    console.error("packages/contracts/openapi.json fails its gate:\n");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(
    `openapi.json is fresh and describes all ${EXPECTED_OPERATIONS.length} public operation(s) in OpenAPI 3.1.`,
  );
}
