/**
 * The pin-release route is MOUNTED, behind the permission it claims (#427).
 *
 * `connector-pin-release.realdb.test.ts` proves what the service does to the
 * database, and every one of its cases calls that service directly. None of them
 * would notice a route that was never registered, wired to the wrong permission,
 * or missing its body validation — "registered, tested, zero callers" is a thing
 * this repository has shipped more than once.
 *
 * So this drives the REAL router with a real Express app. Two modules are
 * mocked, and which two is the point: `store-authz` so the permission each route
 * demands becomes observable, and the controller so no database is needed.
 * `validate.js` is REAL, so the schema under test is the shipped one.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { StorePermission } from '@mercaria/shared-types';

vi.mock('../../../middleware/store-authz.js', () => ({
  // Records what each route ASKED for, rather than deciding anything. A stub
  // that merely called `next()` would let this file pass against a route behind
  // `store:manage`, or behind nothing at all.
  requireStorePermission:
    (permission: StorePermission) => (_req: Request, res: Response, next: NextFunction) => {
      res.setHeader('x-required-permission', permission);
      next();
    },
}));

vi.mock('../../../controllers/admin/products-admin.controller.js', () => {
  const echo = (req: Request, res: Response): void => {
    res.status(200).json({ success: true, data: req.body });
  };
  return {
    listProducts: echo,
    createProduct: echo,
    getProduct: echo,
    patchProduct: echo,
    deleteProduct: echo,
    releaseProductPins: echo,
    createVariant: echo,
    patchVariant: echo,
    deleteVariant: echo,
    setVariantInventory: echo,
    listVariantLevels: echo,
    setVariantLevelInventory: echo,
    previewProductTypeUpgrade: echo,
    applyProductTypeUpgrade: echo,
    // Not a handler: `products.ts` hands this to
    // `makeListingLocalizationRouter` as its OWNER RESOLVER at module scope
    // (#814), so a mock omitting it passes `undefined` into the factory and
    // every case in this file dies at import with a stack pointing at a route
    // it never exercises. It resolves the listing rather than answering a
    // request, so it is a `ListingRecord` promise and not `echo`.
    // The id is spelled out rather than read from `PRODUCT_ID` below: `vi.mock`
    // is hoisted above every `const` in this file, so a reference to one is a
    // temporal-dead-zone error waiting for whoever moves this line.
    loadStoreProduct: () => Promise.resolve({ id: 'a'.repeat(24) }),
  };
});

import productsRouter from '../products.js';

/** A 24-character hex id, which is what `validateId` accepts for a live entity. */
const PRODUCT_ID = 'a'.repeat(24);
const RELEASE_PATH = `/${PRODUCT_ID}/pins/release`;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/', productsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

/**
 * The return type is INFERRED from `fetch` on purpose: `Response` is imported
 * from express at the top of this file, so annotating it would name the wrong
 * type and hide `headers` behind express's `header`.
 */
async function post(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /:id/pins/release', () => {
  it('is mounted, and reaches the handler', async () => {
    // The reachability assertion. Without the route this is a 404 from Express
    // and nothing else in CI says a word — the service, its realdb suite and
    // every typecheck are all perfectly happy with a handler nobody can call.
    const res = await post(RELEASE_PATH, { fields: ['title'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { fields: ['title'] } });
  });

  it('demands `products:write` — the permission an ordinary edit already needs', async () => {
    // A pin is created by editing the field, so the way out is gated exactly
    // like the way in. `channels:write` would put the narrow release behind a
    // higher bar than the connection-wide switch's own blast radius justifies,
    // and would let `staff` accumulate pins only an admin could clear.
    const res = await post(RELEASE_PATH, { fields: ['title'] });
    expect(res.headers.get('x-required-permission')).toBe('products:write');
  });

  it('refuses a body with no fields, an empty list, or an extra property', async () => {
    // The schema is `.strict()` and `min(1)`. The extra-property case is the one
    // worth having: the only thing another property could be is an attempt to
    // PIN from here, and this endpoint is subtractive by construction.
    expect((await post(RELEASE_PATH, {})).status).toBe(400);
    expect((await post(RELEASE_PATH, { fields: [] })).status).toBe(400);
    expect((await post(RELEASE_PATH, { fields: ['title'], pin: ['status'] })).status).toBe(400);
    expect((await post(RELEASE_PATH, { fields: ['title', ''] })).status).toBe(400);
  });

  it('accepts a key the surface cannot NAME, because the column can hold one', async () => {
    // Not `z.enum(PINNABLE_CONNECTOR_FIELDS)`: `overridden_fields` is a bare
    // `text[]` the merge honours whatever is in it, and a release that could
    // only reach the seven named keys would leave the rest stuck forever.
    const res = await post(RELEASE_PATH, { fields: ['price', 'something_a_later_issue_added'] });
    expect(res.status).toBe(200);
  });

  it('refuses a malformed product id before anything else', async () => {
    expect((await post('/not-an-id/pins/release', { fields: ['title'] })).status).toBe(400);
  });
});
