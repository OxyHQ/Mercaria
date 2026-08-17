/**
 * The `/compatibility` ROUTES, driven over HTTP against a real database
 * (#367 Workstream 14).
 *
 * ## What was unproven, and why it is not what it looks like
 *
 * #543 published eight reads and proved the SERVICES behind them:
 * `compatibility-public-read.realdb.test.ts` drives `answerFitment`,
 * `readCompatibilityRelationPage` and `listPublishedVehiclesForPart` directly,
 * and it never calls a route. The vertical suites and w-e2e's journeys do the
 * same, on purpose — a journey that re-implemented the API's own composition
 * would measure the re-implementation.
 *
 * So the HTTP layer itself had nothing on it: **the four picker rungs, the path
 * parameters they read, and four `.strict()` Zod schemas**. Those are exactly the
 * parts a service test cannot reach. A rung whose `:makeId` was read from the
 * wrong parameter name answers an empty list — which is indistinguishable from a
 * make with no models, and is what a shopper would see as a picker that stops
 * after the first dropdown.
 *
 * ## The vacuity control, and the lesson it comes from
 *
 * `referral-partner-mount.integration.test.ts`'s header records reading a 401 as
 * "this route exists" and being wrong, because router-level auth answers 401 for
 * every path under the prefix including one that does not exist. `/compatibility`
 * has no auth at all, so the mirror of that trap applies: a 200 with an empty
 * list is what a MISSING rung and an EMPTY one both look like. Every case here
 * therefore asserts a row it seeded by name, and the control is a request under
 * the same prefix for a vehicle nobody created.
 *
 * A real ephemeral listener and `fetch`, matching
 * `stripe-webhook.integration.test.ts` — this repository does not depend on
 * supertest.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApp } from '../../app.js';
import { connectPostgres, type Database } from '../../db/postgres.js';
import { nsKey } from '../../scripts/seed-verticals/apply.js';
import { BRAKE_PAD_PACKAGE } from '../../scripts/seed-verticals/brake-pad.js';
import {
  seedVerticalForTest,
  teardownVertical,
  verticalRunToken,
  type SeededVertical,
} from '../../scripts/seed-verticals/__tests__/vertical-fixture.js';

const TOKEN = verticalRunToken('cr');

const db: Database = await connectPostgres();
let server: Server;
let base: string;
let seeded: SeededVertical;

/** One JSON GET against the real app chain, including the rate limiter. */
async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`);
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

/** The `data` envelope every successful read here returns. */
function data(body: Record<string, unknown>): Record<string, unknown> {
  return (body['data'] ?? {}) as Record<string, unknown>;
}

beforeAll(async () => {
  seeded = await seedVerticalForTest(db, BRAKE_PAD_PACKAGE, TOKEN);
  const app = createApp();
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${String(address.port)}`;
}, 180_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await teardownVertical(db, TOKEN);
}, 180_000);

describe('the vehicle picker, one rung at a time', () => {
  it('serves the makes, and says which LEVEL it served', async () => {
    const response = await get('/compatibility/vehicles/makes');
    expect(response.status).toBe(200);
    const body = data(response.body);
    // The level travels in the response, so a client cannot render a list of
    // generations under a heading that says models.
    expect(body['level']).toBe('make');
    const vehicles = body['vehicles'] as { id: string; key: string; name: string }[];
    // Global read, so `toContain` and not an equality — plus a floor, because an
    // empty list satisfies every "does not contain" and is what a broken read
    // returns.
    expect(vehicles.length).toBeGreaterThanOrEqual(3);
    expect(vehicles.map((vehicle) => vehicle.key)).toContain(nsKey(seeded.ns, 'bmw'));
  });

  it('walks makes → models → generations → configurations, each parent in the PATH', async () => {
    const makes = data(await get('/compatibility/vehicles/makes').then((r) => r.body))[
      'vehicles'
    ] as { id: string; key: string }[];
    const bmw = makes.find((make) => make.key === nsKey(seeded.ns, 'bmw'));
    expect(bmw, 'the seeded make is not in the picker').toBeDefined();
    if (bmw === undefined) return;

    const models = data((await get(`/compatibility/vehicles/makes/${bmw.id}/models`)).body);
    expect(models['level']).toBe('model');
    const modelRows = models['vehicles'] as { id: string; name: string }[];
    // Exactly the two this make owns — the rung is scoped by its parent, which is
    // the property a wrongly-read path parameter breaks.
    expect(modelRows.map((row) => row.name).sort()).toEqual(['3 Series', '4 Series']);

    const threeSeries = modelRows.find((row) => row.name === '3 Series');
    if (threeSeries === undefined) return;
    const generations = data(
      (await get(`/compatibility/vehicles/models/${threeSeries.id}/generations`)).body,
    );
    expect(generations['level']).toBe('generation');
    const generationRows = generations['vehicles'] as { id: string; name: string }[];
    expect(generationRows.map((row) => row.name).sort()).toEqual(['F30', 'G20']);

    const g20 = generationRows.find((row) => row.name === 'G20');
    if (g20 === undefined) return;
    const configurations = data(
      (await get(`/compatibility/vehicles/generations/${g20.id}/configurations`)).body,
    );
    expect(configurations['level']).toBe('configuration');
    expect((configurations['vehicles'] as unknown[]).length).toBe(3);
  });

  it('answers an EMPTY list for a parent nobody created — the control', async () => {
    // This is what makes every assertion above a measurement. A missing rung and
    // a childless parent both answer 200 with an empty list, so the cases above
    // name rows they seeded and this one shows the shape of the other outcome.
    const response = await get(`/compatibility/vehicles/makes/${TOKEN}-no-such-make/models`);
    expect(response.status).toBe(200);
    expect(data(response.body)['vehicles']).toEqual([]);
  });

  it('narrows configurations by YEAR through the query, and coerces it', async () => {
    const makes = data((await get('/compatibility/vehicles/makes')).body)['vehicles'] as {
      id: string;
      key: string;
    }[];
    const vw = makes.find((make) => make.key === nsKey(seeded.ns, 'volkswagen'));
    if (vw === undefined) return;
    const models = data((await get(`/compatibility/vehicles/makes/${vw.id}/models`)).body)[
      'vehicles'
    ] as { id: string }[];
    const golf = models[0];
    if (golf === undefined) return;
    const generations = data(
      (await get(`/compatibility/vehicles/models/${golf.id}/generations`)).body,
    )['vehicles'] as { id: string; name: string }[];
    const mk8 = generations.find((row) => row.name === 'Mk8');
    if (mk8 === undefined) return;

    // 2019 is inside the Mk8's window and 2013 is not — the overlapping-generation
    // case, driven through the query parameter rather than the repository.
    const inWindow = data(
      (await get(`/compatibility/vehicles/generations/${mk8.id}/configurations?year=2019`)).body,
    );
    expect((inWindow['vehicles'] as unknown[]).length).toBeGreaterThan(0);
    const outside = data(
      (await get(`/compatibility/vehicles/generations/${mk8.id}/configurations?year=2013`)).body,
    );
    expect(outside['vehicles']).toEqual([]);
  });

  it('refuses a year outside the representable range, and an unknown parameter', async () => {
    const makes = data((await get('/compatibility/vehicles/makes')).body)['vehicles'] as {
      id: string;
      key: string;
    }[];
    const bmw = makes.find((make) => make.key === nsKey(seeded.ns, 'bmw'));
    if (bmw === undefined) return;
    const models = data((await get(`/compatibility/vehicles/makes/${bmw.id}/models`)).body)[
      'vehicles'
    ] as { id: string }[];
    const model = models[0];
    if (model === undefined) return;
    const generations = data(
      (await get(`/compatibility/vehicles/models/${model.id}/generations`)).body,
    )['vehicles'] as { id: string }[];
    const generation = generations[0];
    if (generation === undefined) return;

    // `VEHICLE_MIN_YEAR` is 1885; a Roman chariot is not a vehicle record.
    expect(
      (await get(`/compatibility/vehicles/generations/${generation.id}/configurations?year=1200`))
        .status,
    ).toBe(400);
    // `.strict()`, so a parameter nobody declared is refused rather than ignored
    // — which is what stops a client believing a filter was applied.
    expect(
      (await get(
        `/compatibility/vehicles/generations/${generation.id}/configurations?yr=2019`,
      )).status,
    ).toBe(400);
  });
});

describe('the reverse read and the verdict, over HTTP', () => {
  it('lists what a part fits, with the exclusion in the list', async () => {
    const variantId = seeded.handles.variantIds.get('vp_4410_default');
    expect(variantId).toBeDefined();
    if (variantId === undefined) return;

    const response = await get(`/compatibility/fitments?subjectVariantId=${variantId}`);
    expect(response.status).toBe(200);
    const body = data(response.body);
    const fitments = body['fitments'] as { applicability: string; scope: string }[];
    // The package declares nine statements about this part; the read publishes
    // the ones policy admits, and an exclusion is information rather than a row
    // to hide.
    expect(fitments.length).toBeGreaterThan(0);
    expect(fitments.map((row) => row.applicability)).toContain('does_not_apply');
    expect(body['truncated']).toBe(false);
  });

  it('answers a verdict for a vehicle named in the query', async () => {
    const variantId = seeded.handles.variantIds.get('vp_4410_default');
    const makeId = seeded.handles.vehicleMakeIds.get('bmw');
    const modelId = seeded.handles.vehicleModelIds.get('three_series');
    const generationId = seeded.handles.vehicleGenerationIds.get('g20');
    if (
      variantId === undefined ||
      makeId === undefined ||
      modelId === undefined ||
      generationId === undefined
    ) {
      return;
    }

    const response = await get(
      `/compatibility/fitments/verdict?subjectVariantId=${variantId}` +
        `&makeId=${makeId}&modelId=${modelId}&generationId=${generationId}`,
    );
    expect(response.status).toBe(200);
    const verdict = data(response.body)['verdict'] as Record<string, unknown>;
    expect(verdict['outcome']).toBe('determined');
    expect(verdict['applicability']).toBe('applies');
    expect(verdict['decidedAtScope']).toBe('vehicle_generation');
  });

  it('answers `unknown` for a car this catalogue does not have, not `does_not_apply`', async () => {
    // The three-valued point, over HTTP: Mercaria knowing nothing about a vehicle
    // is not a statement about the part, and a shopper must not be shown one.
    const variantId = seeded.handles.variantIds.get('vp_4410_default');
    if (variantId === undefined) return;
    const response = await get(
      `/compatibility/fitments/verdict?subjectVariantId=${variantId}&makeId=${TOKEN}-nope`,
    );
    expect(response.status).toBe(200);
    expect(data(response.body)['verdict']).toEqual({ outcome: 'unknown' });
  });

  it('requires a vehicle to answer a verdict at all', async () => {
    const variantId = seeded.handles.variantIds.get('vp_4410_default');
    if (variantId === undefined) return;
    // `makeId` is not optional. Without it there is no question, and answering
    // one anyway would mean choosing a car.
    expect((await get(`/compatibility/fitments/verdict?subjectVariantId=${variantId}`)).status).toBe(
      400,
    );
  });

  it('refuses a relations read naming BOTH directions, and one naming NEITHER', async () => {
    const variantId = seeded.handles.variantIds.get('vp_4410_default');
    if (variantId === undefined) return;
    // Exactly one selector. Both is a third question the schema does not answer;
    // neither is every relation in the catalogue.
    expect(
      (await get(
        `/compatibility/relations?subjectVariantId=${variantId}&targetProductId=${variantId}`,
      )).status,
    ).toBe(400);
    expect((await get('/compatibility/relations')).status).toBe(400);
    // The control: one selector alone is served, so the two refusals are about
    // the arity rather than about the route.
    expect((await get(`/compatibility/relations?subjectVariantId=${variantId}`)).status).toBe(200);
  });

  it('cannot be asked to narrow a fitment read to the rows that say yes', async () => {
    const variantId = seeded.handles.variantIds.get('vp_4410_default');
    if (variantId === undefined) return;
    // No schema here carries `applicability`, `verification` or
    // `includeUnpublished`, so a caller cannot hide the exclusions — and
    // `.strict()` is what turns that absence into a refusal rather than a
    // silently ignored parameter.
    expect(
      (await get(`/compatibility/fitments?subjectVariantId=${variantId}&applicability=applies`))
        .status,
    ).toBe(400);
  });
});
