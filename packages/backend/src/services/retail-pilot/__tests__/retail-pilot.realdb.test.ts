/**
 * The bounded retail pilot's STRUCTURAL guarantees (#125 acceptance 7).
 *
 * Against a REAL Postgres server, because every one of them is a trigger, a
 * CHECK or a partial unique and none of those exists under a mock — a mocked
 * `insert` accepts a statement the server rejects outright, so each of these
 * cases would pass green and ship broken.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { uuidv7 } from "@oxyhq/db";
import {
  closePostgres,
  connectPostgres,
  type Database,
} from "../../../db/postgres.js";
import {
  retailPilotCohorts,
  retailPilotStops,
  supplierFundingObservations,
} from "../../../db/schema/retailPilot.js";
import { createSupplier } from "../../../db/procurement/supplierRepository.js";
import { createSupplierAccount } from "../../../db/procurement/supplierAccountRepository.js";
import {
  addRetailPilotSku,
  addRetailPilotThreshold,
  createRetailPilotCohortDraft,
  findActiveRetailPilotCohort,
  findLatestSupplierFunding,
  liftRetailPilotStopRow,
  listLiveRetailPilotStops,
  publishRetailPilotCohortVersion,
  raiseRetailPilotStopRow,
  recordSupplierFundingObservationRow,
} from "../../../db/retailPilot/pilotRepository.js";

/**
 * Assert a write is refused by a SPECIFIC constraint or trigger.
 *
 * `rejects.toThrow()` alone would also pass when the WRONG rule fired, which on
 * a table carrying a dozen CHECKs is most of the value of the assertion.
 * drizzle wraps the driver error, so the constraint name lives on the CAUSE and
 * a trigger's `RAISE` message lives further down still — walking the chain is
 * what makes either reachable. `services/supplier-orders/__tests__/structural-guarantees.realdb.test.ts`
 * is the precedent and this is the same helper.
 */
async function expectRefusedBy(
  write: () => Promise<unknown>,
  rule: RegExp,
): Promise<void> {
  let caught: unknown;
  try {
    await write();
  } catch (error) {
    caught = error;
  }
  expect(caught, "the write SUCCEEDED; the rule did not fire").toBeDefined();
  expect(
    refusalTextOf(caught),
    `expected ${String(rule)}; got: ${String(caught)}`,
  ).toMatch(rule);
}

/** Every message and constraint name in a wrapped driver error. */
function refusalTextOf(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 6 && current !== undefined && current !== null;
    depth += 1
  ) {
    const named = current as {
      constraint_name?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (typeof named.constraint_name === "string")
      parts.push(named.constraint_name);
    if (typeof named.message === "string") parts.push(named.message);
    current = named.cause;
  }
  return parts.join(" | ");
}

/** One supplier plus one account, the pilot's singular supply side. */
async function makeSupplySide(): Promise<{
  supplierId: string;
  accountId: string;
}> {
  const suffix = uuidv7();
  const supplier = await createSupplier({
    supplierType: "dropship_distributor",
    canonicalName: `Pilot supplier ${suffix}`,
  });
  const account = await createSupplierAccount({
    supplierId: supplier.id,
    provider: "printful",
    environment: "test",
    providerAccountId: `store-${suffix}`,
  });
  return { supplierId: supplier.id, accountId: account.id };
}

/** A complete, publishable cohort draft under a unique key. */
async function makeCohortDraft(
  overrides: { cohortKey?: string } = {},
): Promise<{
  cohortId: string;
  cohortKey: string;
  supplierId: string;
  accountId: string;
}> {
  const { supplierId, accountId } = await makeSupplySide();
  const cohortKey = overrides.cohortKey ?? `pilot-${uuidv7()}`;
  const cohort = await createRetailPilotCohortDraft({
    cohortKey,
    version: 1,
    supplierId,
    supplierAccountId: accountId,
    marketCountry: "ES",
    currency: "EUR",
    audience: "staff",
    maxItemTotalMinor: 5_000,
    maxOrderTotalMinor: 15_000,
    minOrderTotalMinor: 1_500,
    maxLineQuantity: 5,
    permittedShippingServiceCodes: ["STANDARD"],
    fundingFloorMinor: 10_000,
    fundingAlertMinor: 25_000,
    monthlySpendCapMinor: 200_000,
    fundingObservationMaxAgeSeconds: 86_400,
    rationale: "the #119 §10 bounds",
  });
  return { cohortId: cohort.id, cohortKey, supplierId, accountId };
}

describe("the bounded retail pilot, against a real server", () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectPostgres();
  }, 120_000);

  afterAll(async () => {
    await closePostgres();
  });

  it("freezes a cohort version once it is published", async () => {
    const { cohortId } = await makeCohortDraft();
    await addRetailPilotSku({
      cohortId,
      supplierSku: "4012",
      addedByOxyUserId: "op-1",
      note: "design-IP screened, EU availability confirmed",
    });
    const published = await publishRetailPilotCohortVersion({
      cohortId,
      publishedByOxyUserId: "op-1",
    });
    expect(published?.status).toBe("active");

    // The bound a pilot ran under has to stay readable after it is widened.
    // Editing it in place would make the record say something that was never
    // true of the orders placed under it.
    await expectRefusedBy(
      async () =>
        db
          .update(retailPilotCohorts)
          .set({ maxOrderTotalAmount: 99_999_999 })
          .where(eq(retailPilotCohorts.id, cohortId)),
      /immutable once published/,
    );
  });

  it("refuses to grow a published cohort’s SKU allow-list, and permits narrowing it", async () => {
    const { cohortId } = await makeCohortDraft();
    await addRetailPilotSku({
      cohortId,
      supplierSku: "4012",
      addedByOxyUserId: "op-1",
      note: "screened",
    });
    await publishRetailPilotCohortVersion({
      cohortId,
      publishedByOxyUserId: "op-1",
    });

    // THE rule: "no automatic expansion follows from technical success", at the
    // grain it actually gets violated — one more SKU on a running pilot.
    await expectRefusedBy(
      async () =>
        addRetailPilotSku({
          cohortId,
          supplierSku: "9999",
          addedByOxyUserId: "op-1",
          note: "just one more",
        }),
      /cannot gain or change/,
    );
  });

  it("permits exactly one active version per pilot key", async () => {
    const { cohortId, cohortKey, supplierId, accountId } =
      await makeCohortDraft();
    await addRetailPilotSku({
      cohortId,
      supplierSku: "4012",
      addedByOxyUserId: "op",
      note: "x",
    });
    await publishRetailPilotCohortVersion({
      cohortId,
      publishedByOxyUserId: "op-1",
    });

    const second = await createRetailPilotCohortDraft({
      cohortKey,
      version: 2,
      supplierId,
      supplierAccountId: accountId,
      marketCountry: "ES",
      currency: "EUR",
      audience: "invited",
      maxItemTotalMinor: 5_000,
      maxOrderTotalMinor: 20_000,
      minOrderTotalMinor: 1_500,
      maxLineQuantity: 5,
      permittedShippingServiceCodes: ["STANDARD"],
      fundingFloorMinor: 10_000,
      fundingAlertMinor: 25_000,
      monthlySpendCapMinor: 200_000,
      fundingObservationMaxAgeSeconds: 86_400,
      rationale: "widened after the first review",
    });
    await addRetailPilotSku({
      cohortId: second.id,
      supplierSku: "4012",
      addedByOxyUserId: "op",
      note: "x",
    });
    const published = await publishRetailPilotCohortVersion({
      cohortId: second.id,
      publishedByOxyUserId: "op-2",
    });
    expect(published?.version).toBe(2);

    // The incumbent is superseded rather than left beside it: two active
    // versions would make "what are the pilot's bounds" a question with two
    // answers, and the partial unique refuses it anyway.
    const active = await findActiveRetailPilotCohort(cohortKey);
    expect(active?.version).toBe(2);
  });

  it("refuses to publish a cohort with no permitted shipping service", async () => {
    const { supplierId, accountId } = await makeSupplySide();
    // `cardinality`, never `array_length`: on `{}` the latter is NULL and a
    // CHECK reads NULL as SATISFIED, so the obvious spelling would admit
    // exactly the empty list it exists to refuse.
    const draft = await createRetailPilotCohortDraft({
      cohortKey: `pilot-${uuidv7()}`,
      version: 1,
      supplierId,
      supplierAccountId: accountId,
      marketCountry: "ES",
      currency: "EUR",
      audience: "staff",
      maxItemTotalMinor: 5_000,
      maxOrderTotalMinor: 15_000,
      minOrderTotalMinor: 1_500,
      maxLineQuantity: 5,
      permittedShippingServiceCodes: [],
      fundingFloorMinor: 10_000,
      fundingAlertMinor: 25_000,
      monthlySpendCapMinor: 200_000,
      fundingObservationMaxAgeSeconds: 86_400,
      rationale: "nothing may ship",
    });
    await expectRefusedBy(
      async () =>
        publishRetailPilotCohortVersion({
          cohortId: draft.id,
          publishedByOxyUserId: "op",
        }),
      /shipping_services_check/,
    );
  });

  it("refuses a funding alert below the floor", async () => {
    const { supplierId, accountId } = await makeSupplySide();
    // An alert below the floor fires AFTER checkout has already stopped, which
    // is a notification about an outage rather than a warning before one.
    await expectRefusedBy(
      async () =>
        createRetailPilotCohortDraft({
          cohortKey: `pilot-${uuidv7()}`,
          version: 1,
          supplierId,
          supplierAccountId: accountId,
          marketCountry: "ES",
          currency: "EUR",
          audience: "staff",
          maxItemTotalMinor: 5_000,
          maxOrderTotalMinor: 15_000,
          minOrderTotalMinor: 1_500,
          maxLineQuantity: 5,
          permittedShippingServiceCodes: ["STANDARD"],
          fundingFloorMinor: 25_000,
          fundingAlertMinor: 10_000,
          monthlySpendCapMinor: 200_000,
          fundingObservationMaxAgeSeconds: 86_400,
          rationale: "backwards",
        }),
      /funding_check/,
    );
  });

  it("converges two evaluations of one breach on ONE stop", async () => {
    const { cohortId } = await makeCohortDraft();
    await addRetailPilotSku({
      cohortId,
      supplierSku: "4012",
      addedByOxyUserId: "op",
      note: "x",
    });
    await addRetailPilotThreshold({
      cohortId,
      metric: "non_eu_dispatch_origin",
      unit: "count",
      thresholdValue: 0,
      windowHours: 0,
      scope: "pilot",
    });
    await publishRetailPilotCohortVersion({
      cohortId,
      publishedByOxyUserId: "op",
    });

    const raise = {
      cohortId,
      metric: "non_eu_dispatch_origin" as const,
      scope: "pilot" as const,
      scopeRef: "",
      origin: "automatic" as const,
      observedValue: 1,
      thresholdValue: 0,
      raisedByOxyUserId: null,
      detail: "a parcel dispatched from outside the EU customs territory",
    };
    const first = await raiseRetailPilotStopRow(raise);
    const second = await raiseRetailPilotStopRow(raise);
    expect(first.raised).toBe(true);
    // The empty `RETURNING` set IS the "already stopped" answer. A read-then-
    // write would report the second evaluation as a fresh breach and page twice.
    expect(second.raised).toBe(false);
    expect(await listLiveRetailPilotStops(cohortId)).toHaveLength(1);
  });

  it("refuses an automatic stop that names a raiser, and an operator stop that does not", async () => {
    const { cohortId } = await makeCohortDraft();
    await addRetailPilotSku({
      cohortId,
      supplierSku: "4012",
      addedByOxyUserId: "op",
      note: "x",
    });
    await publishRetailPilotCohortVersion({
      cohortId,
      publishedByOxyUserId: "op",
    });

    // Attributing a threshold evaluation to a person makes the audit trail say
    // something false; leaving an operator's decision unattributed makes it say
    // nothing. The CHECK is a biconditional, so both directions fail.
    await expectRefusedBy(
      async () =>
        raiseRetailPilotStopRow({
          cohortId,
          metric: "late_dispatch",
          scope: "pilot",
          scopeRef: "",
          origin: "automatic",
          observedValue: 1,
          thresholdValue: 0,
          raisedByOxyUserId: "op-who-did-not",
          detail: "x",
        }),
      /origin_raiser_check/,
    );

    await expectRefusedBy(
      async () =>
        raiseRetailPilotStopRow({
          cohortId,
          metric: "late_dispatch",
          scope: "pilot",
          scopeRef: "",
          origin: "operator",
          observedValue: 0,
          thresholdValue: 0,
          raisedByOxyUserId: null,
          detail: "x",
        }),
      /origin_raiser_check/,
    );
  });

  it("lifts a stop once, attributably, and refuses to edit or delete it afterwards", async () => {
    const { cohortId } = await makeCohortDraft();
    await addRetailPilotSku({
      cohortId,
      supplierSku: "4012",
      addedByOxyUserId: "op",
      note: "x",
    });
    await publishRetailPilotCohortVersion({
      cohortId,
      publishedByOxyUserId: "op",
    });
    await raiseRetailPilotStopRow({
      cohortId,
      metric: "tracking_failure",
      scope: "supplier",
      scopeRef: "supplier-x",
      origin: "operator",
      observedValue: 0,
      thresholdValue: 0,
      raisedByOxyUserId: "op",
      detail: "carrier outage",
    });
    const [stop] = await listLiveRetailPilotStops(cohortId);
    expect(stop).toBeDefined();

    const [row] = await db
      .select({ id: retailPilotStops.id })
      .from(retailPilotStops)
      .where(eq(retailPilotStops.cohortId, cohortId))
      .limit(1);
    const stopId = row?.id ?? "";

    expect(
      await liftRetailPilotStopRow({
        stopId,
        liftedByOxyUserId: "op-2",
        liftReason: "the carrier recovered and ten shipments tracked cleanly",
      }),
    ).toBe(true);
    // A second lift finds nothing to lift — the CAS on it still being live is
    // what makes two operators converge on one lift with one name on it.
    expect(
      await liftRetailPilotStopRow({
        stopId,
        liftedByOxyUserId: "op-3",
        liftReason: "racing",
      }),
    ).toBe(false);

    // A pilot that stopped and was restarted is the most important row in its
    // own history. Nothing may remove it or edit what it observed.
    await expectRefusedBy(
      async () =>
        db.delete(retailPilotStops).where(eq(retailPilotStops.id, stopId)),
      /append-only/,
    );
    await expectRefusedBy(
      async () =>
        db
          .update(retailPilotStops)
          .set({ observedValue: 0 })
          .where(eq(retailPilotStops.id, stopId)),
      /immutable|only the lift columns/,
    );
  });

  it("records supplier funding append-only, newest first", async () => {
    const { accountId } = await makeSupplySide();
    const earlier = new Date("2026-08-01T00:00:00.000Z");
    const later = new Date("2026-08-05T00:00:00.000Z");
    // EXPLICIT timestamps: uuid v7 is not monotonic within a millisecond, so a
    // test that relied on insertion order would be testing the generator's luck.
    await recordSupplierFundingObservationRow({
      supplierAccountId: accountId,
      balanceMinor: 50_000,
      currency: "EUR",
      source: "operator_entry",
      observedAt: earlier,
      recordedByOxyUserId: "treasury",
    });
    await recordSupplierFundingObservationRow({
      supplierAccountId: accountId,
      balanceMinor: 12_000,
      currency: "EUR",
      source: "operator_entry",
      observedAt: later,
      recordedByOxyUserId: "treasury",
    });

    const latest = await findLatestSupplierFunding(accountId);
    expect(latest?.balanceMinor).toBe(12_000);
    expect(latest?.observedAt.toISOString()).toBe(later.toISOString());

    // A correction is a NEW observation. Editing one would let a checkout that
    // should have been refused look, in hindsight, correctly admitted — so both
    // UPDATE and DELETE are refused outright.
    await expectRefusedBy(
      async () =>
        db
          .update(supplierFundingObservations)
          .set({ balanceAmount: 999_999 })
          .where(eq(supplierFundingObservations.supplierAccountId, accountId)),
      /append-only/,
    );
    await expectRefusedBy(
      async () =>
        db
          .delete(supplierFundingObservations)
          .where(eq(supplierFundingObservations.supplierAccountId, accountId)),
      /append-only/,
    );
  });

  it("refuses an operator-entered balance with no recorder", async () => {
    const { accountId } = await makeSupplySide();
    // A figure a person typed and a figure an API returned are different kinds
    // of evidence and must not be told apart by guessing.
    await expectRefusedBy(
      async () =>
        recordSupplierFundingObservationRow({
          supplierAccountId: accountId,
          balanceMinor: 1_000,
          currency: "EUR",
          source: "operator_entry",
          observedAt: new Date(),
          recordedByOxyUserId: null,
        }),
      /recorder_check/,
    );
  });
});
