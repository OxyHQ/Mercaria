#!/usr/bin/env bun

/**
 * Mutation-tests `check-public-openapi.mjs`.
 *
 * Every case starts from the COMMITTED document, breaks exactly one thing, and
 * requires the gate to fail naming the layer that owns it. The committed
 * document must pass first — a gate that fails everything would pass every
 * mutation below — and the negative controls must pass too: prose that merely
 * MENTIONS `nullable` is not a 3.0 schema, and a gate that fired on it would be
 * disabled by whoever hit it first.
 */

import { readFile } from "node:fs/promises";
import { checkFreshness, checkOpenApiDocument } from "./check-public-openapi.mjs";
import { OPENAPI_DOCUMENT_PATH } from "./generate-public-openapi.mjs";

const committed = await readFile(OPENAPI_DOCUMENT_PATH, "utf8");
const pristine = JSON.parse(committed);
let failed = 0;

function report(name, ok, detail = "") {
  if (ok) {
    console.log(`  ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
}

/** Apply `mutate` to a fresh copy and require a failure mentioning `layer`. */
function mustFail(name, layer, mutate) {
  const document = structuredClone(pristine);
  mutate(document);
  const failures = checkOpenApiDocument(document);
  report(
    name,
    failures.some((failure) => failure.startsWith(`${layer}:`)),
    `expected a ${layer} failure, got: ${failures.join(" | ") || "none"}`,
  );
}

function mustPass(name, mutate) {
  const document = structuredClone(pristine);
  mutate(document);
  const failures = checkOpenApiDocument(document);
  report(name, failures.length === 0, failures.join(" | "));
}

console.log("check-public-openapi self-test\n");

// Positive control: the committed document is sound, and it is not trivially so.
mustPass("the committed document passes", () => {});
report(
  "the committed document describes more than a handful of operations",
  Object.keys(pristine.paths ?? {}).length >= 9,
  `only ${Object.keys(pristine.paths ?? {}).length} path(s)`,
);

// Layer 1 — by name, both directions.
mustFail("a removed path", "layer 1", (d) => {
  delete d.paths["/stores/lookup"];
});
mustFail("an undeclared extra operation", "layer 1", (d) => {
  d.paths["/carts"] = { get: structuredClone(d.paths["/products"].get) };
  d.paths["/carts"].get.operationId = "listCarts";
});
mustFail("a renamed operationId", "layer 1", (d) => {
  d.paths["/products/{id}"].get.operationId = "readProduct";
});

// Layer 2 — payloads.
mustFail("a duplicated operationId", "layer 2", (d) => {
  d.paths["/stores/{id}"].get.operationId = "getProduct";
});
mustFail("a 200 pointing at a missing component", "layer 2", (d) => {
  d.paths["/products"].get.responses["200"].content["application/json"].schema = {
    $ref: "#/components/schemas/Nowhere",
  };
});
mustFail("a 200 described as `{}`", "layer 2", (d) => {
  d.paths["/products"].get.responses["200"].content["application/json"].schema = {};
});
mustFail("an emptied component", "layer 2", (d) => {
  d.components.schemas.MercariaStore = {};
});
mustFail("a missing 429", "layer 2", (d) => {
  delete d.paths["/collections/{id}"].get.responses["429"];
});
mustFail("a 429 without Retry-After", "layer 2", (d) => {
  delete d.paths["/collections/{id}"].get.responses["429"].headers;
});
mustFail("an error status not answered with MercariaErrorBody", "layer 2", (d) => {
  d.paths["/products/{id}"].get.responses["410"].content["application/json"].schema = {
    $ref: "#/components/schemas/MercariaProduct",
  };
});
mustFail("an undeclared path parameter", "layer 2", (d) => {
  d.paths["/products/{id}"].get.parameters = [];
});
mustFail("a renamed error code", "layer 2", (d) => {
  const codes = d.components.schemas.MercariaErrorBody.properties.error.properties.code.enum;
  codes[codes.indexOf("not_found")] = "NOT_FOUND";
});

// Layer 3 — dialect.
mustFail("an OpenAPI 3.0 `nullable`", "layer 3", (d) => {
  d.components.schemas.MercariaStore.properties.description = { type: "string", nullable: true };
});
mustFail("a boolean exclusiveMinimum", "layer 3", (d) => {
  d.components.schemas.MercariaMoney.properties.amount.exclusiveMinimum = true;
});
mustFail("a 3.0 version string", "layer 3", (d) => {
  d.openapi = "3.0.3";
});
mustPass("NEGATIVE CONTROL: prose that mentions nullable", (d) => {
  d.info.description += " Fields are never nullable in the 3.0 sense.";
});
mustPass("NEGATIVE CONTROL: a numeric exclusiveMinimum", (d) => {
  d.components.schemas.MercariaMoney.properties.amount.exclusiveMinimum = -1;
});

// Layer 4 — freshness.
report("identical bytes are fresh", checkFreshness(committed, committed).length === 0);
report(
  "one changed byte is stale",
  checkFreshness(committed, committed.replace("Mercaria public API", "Mercaria public APl")).some((failure) =>
    failure.startsWith("layer 4:"),
  ),
);
report("a missing trailing newline is stale", checkFreshness(committed, committed.trimEnd()).length === 1);

if (failed > 0) {
  console.error(`\n${failed} case(s) failed: check-public-openapi.mjs cannot be trusted.`);
  process.exit(1);
}
console.log("\ncheck-public-openapi.mjs fails on every mutation and passes the controls.");
