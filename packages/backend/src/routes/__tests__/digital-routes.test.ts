/**
 * The `/digital/*` surface: who may reach each route, what the creator half
 * refuses, and what the buyer half never writes down (#1015, ADR 0010).
 *
 * ## What is real here and what is a double
 *
 * Real: the routers, `loadStore`, `requireStorePermission`, the zod bodies, and
 * both controllers — so the chain under test is the production one. Doubled: the
 * repositories, the download service, the storage port and the actor resolver,
 * because what these cases are about is the SURFACE. Each doubled module has its
 * own suite, and `digital-commerce.realdb.test.ts` drives the constraints a mock
 * cannot have.
 *
 * `loadStore` is deliberately NOT doubled. It is the middleware that decides
 * which store a creator is acting in, so a stub in its place would make every
 * cross-store case below a test of the stub.
 *
 * ## Three properties here would each be a security bug
 *
 *  - a store member without `store:manage` must not be able to publish terms in
 *    the store's name, and a member of one store must not reach another's asset;
 *  - the three facts a file is registered with must come from the asset service
 *    and never from the request, whatever the request says;
 *  - the download token must appear in no log line — and the search that proves
 *    it must be one that can find the token somewhere, or it proves nothing.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { StorePermission, StoreRole } from '@mercaria/shared-types';

const STORE_ID = '1'.repeat(24);
const OTHER_STORE_ID = '2'.repeat(24);
const ASSET_ID = '3'.repeat(24);
const VERSION_ID = '4'.repeat(24);
const PACKAGE_ID = '5'.repeat(24);
const FILE_ID = '6'.repeat(24);
const LICENCE_ID = '7'.repeat(24);
const LICENCE_VERSION_ID = '8'.repeat(24);
const OPTION_ID = '9'.repeat(24);
const VARIANT_ID = 'a'.repeat(24);
const LISTING_ID = 'b'.repeat(24);
const RIGHT_ID = 'c'.repeat(24);
const OWNER_USER = 'oxy-user-digital-owner';
const STORAGE_KEY = 'oxyfile_digital_routes_not_real';
const DIGEST = 'd'.repeat(64);
const GRANT_TOKEN = 'not-a-real-grant-token-0123456789';
const RESOLVED_URL = 'https://api.oxy.test/assets/stream?mt=not-a-real-media-token';

/* ------------------------------- the doubles ------------------------------ */

const findStoreById = vi.fn();
const findDigitalAsset = vi.fn();
const findAssetVersion = vi.fn();
const findAssetPackage = vi.fn();
const findVersionFiles = vi.fn();
const insertDigitalAsset = vi.fn();
const insertAssetVersion = vi.fn();
const insertAssetFile = vi.fn();
const insertAssetPackage = vi.fn();
const addFileToPackage = vi.fn();
const publishAssetVersion = vi.fn();
const withdrawAssetVersion = vi.fn();
const everyFileScannedClean = vi.fn();
const everyFileInspectionAcceptable = vi.fn();
const upsertAssetLicence = vi.fn();
const insertAssetLicenceVersion = vi.fn();
const publishAssetLicenceVersion = vi.fn();
const findAssetLicenceVersion = vi.fn();
const findAssetLicenceOption = vi.fn();
const insertAssetLicenceOption = vi.fn();
const upsertDigitalBinding = vi.fn();
const findVariantById = vi.fn();
const findListingById = vi.fn();
const grantRight = vi.fn();
const listBuyerLibrary = vi.fn();
const mintDownloadGrant = vi.fn();
const redeemDownloadGrant = vi.fn();
const resolveDigitalLines = vi.fn();
const describeAssetObject = vi.fn();
const resolveAuthorizedUrl = vi.fn();
const dbSelect = vi.fn();
const logged = vi.fn();

/** Licence rows the narrow in-controller selects answer with. */
let licenceRows: { id: string; storeId: string | null }[] = [];
let highestLicenceVersion = 0;

/** A thenable drizzle-ish chain, so `await db.select(...)…` resolves to rows. */
function queryResult(rows: unknown[]): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = () => chain;
  chain.orderBy = () => chain;
  chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

vi.mock('../../db/stores/storeRepository.js', () => ({
  findStoreById: (...args: unknown[]) => findStoreById(...args),
}));
vi.mock('../../db/digital/assetRepository.js', () => ({
  findDigitalAsset: (...a: unknown[]) => findDigitalAsset(...a),
  findAssetVersion: (...a: unknown[]) => findAssetVersion(...a),
  findAssetPackage: (...a: unknown[]) => findAssetPackage(...a),
  findVersionFiles: (...a: unknown[]) => findVersionFiles(...a),
  insertDigitalAsset: (...a: unknown[]) => insertDigitalAsset(...a),
  insertAssetVersion: (...a: unknown[]) => insertAssetVersion(...a),
  insertAssetFile: (...a: unknown[]) => insertAssetFile(...a),
  insertAssetPackage: (...a: unknown[]) => insertAssetPackage(...a),
  addFileToPackage: (...a: unknown[]) => addFileToPackage(...a),
  publishAssetVersion: (...a: unknown[]) => publishAssetVersion(...a),
  withdrawAssetVersion: (...a: unknown[]) => withdrawAssetVersion(...a),
  everyFileScannedClean: (...a: unknown[]) => everyFileScannedClean(...a),
  everyFileInspectionAcceptable: (...a: unknown[]) => everyFileInspectionAcceptable(...a),
}));
vi.mock('../../db/digital/licenceRepository.js', () => ({
  upsertAssetLicence: (...a: unknown[]) => upsertAssetLicence(...a),
  insertAssetLicenceVersion: (...a: unknown[]) => insertAssetLicenceVersion(...a),
  publishAssetLicenceVersion: (...a: unknown[]) => publishAssetLicenceVersion(...a),
  findAssetLicenceVersion: (...a: unknown[]) => findAssetLicenceVersion(...a),
  findAssetLicenceOption: (...a: unknown[]) => findAssetLicenceOption(...a),
  insertAssetLicenceOption: (...a: unknown[]) => insertAssetLicenceOption(...a),
}));
vi.mock('../../db/digital/bindingRepository.js', () => ({
  upsertDigitalBinding: (...a: unknown[]) => upsertDigitalBinding(...a),
}));
vi.mock('../../db/digital/rightRepository.js', () => ({
  grantRight: (...a: unknown[]) => grantRight(...a),
}));
vi.mock('../../db/catalog/variantRepository.js', () => ({
  findVariantById: (...a: unknown[]) => findVariantById(...a),
}));
vi.mock('../../db/catalog/listingRepository.js', () => ({
  findListingById: (...a: unknown[]) => findListingById(...a),
}));
vi.mock('../../db/postgres.js', () => ({
  getDb: () => ({ select: (...a: unknown[]) => dbSelect(...a) }),
}));
vi.mock('../../services/digital/right.service.js', () => ({
  listBuyerLibrary: (...a: unknown[]) => listBuyerLibrary(...a),
}));
vi.mock('../../services/digital/download.service.js', () => ({
  mintDownloadGrant: (...a: unknown[]) => mintDownloadGrant(...a),
  redeemDownloadGrant: (...a: unknown[]) => redeemDownloadGrant(...a),
}));
vi.mock('../../services/checkout/digital-lines.js', () => ({
  resolveDigitalLines: (...a: unknown[]) => resolveDigitalLines(...a),
}));
vi.mock('../../services/digital/storage.js', () => ({
  assetStorage: {
    describeAssetObject: (...a: unknown[]) => describeAssetObject(...a),
    resolveAuthorizedUrl: (...a: unknown[]) => resolveAuthorizedUrl(...a),
    putAssetObject: vi.fn(),
    deleteAssetObject: vi.fn(),
  },
  isDigitalStorageError: (error: unknown) =>
    typeof error === 'object' && error !== null && 'reason' in (error as object),
}));
vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.userId = (req.headers['x-test-user'] as string) ?? OWNER_USER;
    next();
  },
  oxyClient: {},
}));
/**
 * Stands in for `resolveCommerceActor`, whose own resolution (Oxy precedence, the
 * guest transports, the CSRF gate) has three suites of its own. What is under
 * test here is that the routes read `req.commerceActor` and refuse an anonymous
 * one — so the double's whole job is to put one of the three kinds on the request.
 */
vi.mock('../../middleware/commerce-actor.js', () => ({
  resolveCommerceActor: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const kind = (req.headers['x-test-actor'] as string) ?? 'anonymous';
    req.commerceActor =
      kind === 'oxy'
        ? { kind: 'oxy', oxyUserId: OWNER_USER }
        : kind === 'guest'
          ? { kind: 'guest', guestSessionId: 'guest-session-1', transport: 'header' }
          : { kind: 'anonymous' };
    next();
  },
}));
vi.mock('../../lib/rate-limit.js', () => ({
  makeRateLimiter:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
  makeActorRateLimiter:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}));
vi.mock('../../lib/logger.js', () => ({
  log: {
    general: {
      info: (...a: unknown[]) => logged('info', ...a),
      warn: (...a: unknown[]) => logged('warn', ...a),
      error: (...a: unknown[]) => logged('error', ...a),
      debug: (...a: unknown[]) => logged('debug', ...a),
    },
    guest: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

/* ------------------------------ the test apps ----------------------------- */

interface TestApp {
  readonly url: string;
  readonly server: Server;
}

const started: Server[] = [];

/**
 * Build a REAL app around the real router, at one configuration.
 *
 * `config/index.ts` reads the environment once at module load and freezes the
 * result, so a second configuration needs a second module registry —
 * `vi.resetModules()` then a fresh dynamic import. The doubles above survive it:
 * their factories close over module-scope `vi.fn()`s rather than creating new
 * ones.
 */
async function buildApp(flags: {
  uploads?: boolean;
  publication?: boolean;
  verticals?: string;
}): Promise<TestApp> {
  process.env.DIGITAL_UPLOADS_ENABLED = flags.uploads ? 'true' : 'false';
  process.env.DIGITAL_PUBLICATION_ENABLED = flags.publication ? 'true' : 'false';
  process.env.DIGITAL_ENABLED_VERTICALS = flags.verticals ?? 'three_d';
  vi.resetModules();
  const router = (await import('../digital.routes.js')).default;

  const app = express();
  app.use(express.json());
  app.use('/digital', router);

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  started.push(server);
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, server };
}

let uploadsOff: TestApp;
let uploadsOn: TestApp;
let publishing: TestApp;

beforeAll(async () => {
  process.env.DATABASE_URL ??= 'postgres://mercaria:mercaria@127.0.0.1:5435/mercaria_dev';
  uploadsOff = await buildApp({ uploads: false });
  uploadsOn = await buildApp({ uploads: true, publication: false });
  publishing = await buildApp({ uploads: true, publication: true });
});

afterAll(async () => {
  await Promise.all(
    started.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

/** A member row shaped the way `loadStore` reads it. */
function member(role: StoreRole, permissions: StorePermission[] = []) {
  return { oxyUserId: OWNER_USER, role, permissions };
}

beforeEach(() => {
  vi.clearAllMocks();
  licenceRows = [{ id: LICENCE_ID, storeId: STORE_ID }];
  highestLicenceVersion = 0;
  dbSelect.mockImplementation((projection: Record<string, unknown>) => {
    const keys = Object.keys(projection ?? {});
    if (keys.includes('highest')) return queryResult([{ highest: highestLicenceVersion }]);
    return queryResult(licenceRows);
  });
  findStoreById.mockImplementation(async (storeId: string) =>
    storeId === STORE_ID ? { id: STORE_ID, members: [member('owner')] } : null,
  );
  findDigitalAsset.mockResolvedValue({ id: ASSET_ID, storeId: STORE_ID, vertical: 'three_d' });
  findAssetVersion.mockResolvedValue({ id: VERSION_ID, assetId: ASSET_ID, state: 'draft' });
  findAssetPackage.mockResolvedValue({ id: PACKAGE_ID, assetId: ASSET_ID });
});

/** A JSON envelope when there is one; `{}` for Express's own HTML 404 page. */
function jsonOrEmpty(text: string): Record<string, unknown> {
  if (!text.trim().startsWith('{')) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

/** POST helper. Returns the status, the parsed body and the response headers. */
async function post(
  app: TestApp,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const response = await fetch(`${app.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  });
  return {
    status: response.status,
    // Express answers an unmounted path with an HTML 404 page, which is exactly
    // the case the mount test measures — so a non-JSON body is a legal answer
    // here rather than a failure to parse one.
    body: jsonOrEmpty(await response.text()),
    headers: response.headers,
  };
}

/** GET helper that does NOT follow redirects, so the 302 itself is observable. */
async function get(
  app: TestApp,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string; headers: Headers }> {
  const response = await fetch(`${app.url}${path}`, { headers, redirect: 'manual' });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

const CREATE_ASSET = { vertical: 'three_d', title: 'A printable thing' };

/* -------------------------------------------------------------------------- */

describe('the creator MOUNT follows DIGITAL_UPLOADS_ENABLED', () => {
  it('404s every creator route with the lever off', async () => {
    const { status } = await post(uploadsOff, `/digital/stores/${STORE_ID}/assets`, CREATE_ASSET);
    // 404 and never 401: an unconfigured surface does not exist, rather than
    // telling an unauthenticated caller that it is here and refusing them.
    expect(status).toBe(404);
    expect(insertDigitalAsset).not.toHaveBeenCalled();
  });

  it('still serves the BUYER half with the lever off', async () => {
    // The control for the case above AND the point of the split mount: a 404 on
    // the creator path has to mean "no creator surface", not "no /digital at
    // all". ADR 0010 D13 — a lever may not strand a prior purchase, and turning
    // creator uploads off is not a reason to take away somebody's library.
    listBuyerLibrary.mockResolvedValue([]);
    const { status } = await get(uploadsOff, '/digital/library', { 'x-test-actor': 'guest' });
    expect(status).toBe(200);
  });

  it('serves the creator route with the lever on', async () => {
    insertDigitalAsset.mockResolvedValue({ id: ASSET_ID });
    const { status } = await post(uploadsOn, `/digital/stores/${STORE_ID}/assets`, CREATE_ASSET);
    expect(status).toBe(201);
  });
});

describe('the creator surface needs `store:manage`', () => {
  it('refuses a staff member, who holds every operational permission', async () => {
    findStoreById.mockResolvedValue({ id: STORE_ID, members: [member('staff')] });
    const { status, body } = await post(
      uploadsOn,
      `/digital/stores/${STORE_ID}/assets`,
      CREATE_ASSET,
    );
    expect(status).toBe(403);
    expect(body.message).toContain('store:manage');
  });

  it('refuses an ADMIN, which is the whole reason this permission was chosen', async () => {
    // `store:manage` is the one permission an `admin` does not hold. Publishing
    // licence terms in the store's name is the owner's decision, like payment
    // onboarding and fee acceptance; `settings:write` would have put it on every
    // admin and `products:write` on every staff member.
    findStoreById.mockResolvedValue({ id: STORE_ID, members: [member('admin')] });
    const { status } = await post(uploadsOn, `/digital/stores/${STORE_ID}/assets`, CREATE_ASSET);
    expect(status).toBe(403);
  });

  it('admits an admin holding an EXPLICIT grant — the control', async () => {
    // Without this the case above would pass for any reason at all, including a
    // permission check that refuses everybody.
    findStoreById.mockResolvedValue({
      id: STORE_ID,
      members: [member('admin', ['store:manage'])],
    });
    insertDigitalAsset.mockResolvedValue({ id: ASSET_ID });
    const { status } = await post(uploadsOn, `/digital/stores/${STORE_ID}/assets`, CREATE_ASSET);
    expect(status).toBe(201);
  });

  it('404s an unknown store and 403s a non-member', async () => {
    const unknown = await post(uploadsOn, `/digital/stores/${OTHER_STORE_ID}/assets`, CREATE_ASSET);
    expect(unknown.status).toBe(404);

    findStoreById.mockResolvedValue({ id: STORE_ID, members: [] });
    const outsider = await post(uploadsOn, `/digital/stores/${STORE_ID}/assets`, CREATE_ASSET);
    expect(outsider.status).toBe(403);
  });
});

describe('a creator reaches only their OWN store’s asset graph', () => {
  it('404s another store’s asset rather than 403ing it', async () => {
    findDigitalAsset.mockResolvedValue({ id: ASSET_ID, storeId: OTHER_STORE_ID });
    const { status } = await post(
      uploadsOn,
      `/digital/stores/${STORE_ID}/assets/${ASSET_ID}/versions`,
      { label: '1.0' },
    );
    // 403 would confirm the id exists, which is the enumeration oracle ADR 0010
    // D5 closes on the buyer side and there is no reason to leave open here.
    expect(status).toBe(404);
    expect(insertAssetVersion).not.toHaveBeenCalled();
  });

  it('404s a version belonging to a DIFFERENT asset of the same store', async () => {
    // The second hop. One "load the asset" middleware would have left this
    // unchecked on exactly the routes that have a second id in the path.
    findAssetVersion.mockResolvedValue({ id: VERSION_ID, assetId: 'another-asset', state: 'draft' });
    const { status } = await post(
      uploadsOn,
      `/digital/stores/${STORE_ID}/assets/${ASSET_ID}/versions/${VERSION_ID}/withdraw`,
      {},
    );
    expect(status).toBe(404);
    expect(withdrawAssetVersion).not.toHaveBeenCalled();
  });

  it('creates the version when both hops belong to the store — the control', async () => {
    insertAssetVersion.mockResolvedValue({ id: VERSION_ID });
    const { status } = await post(
      uploadsOn,
      `/digital/stores/${STORE_ID}/assets/${ASSET_ID}/versions`,
      { label: '2.4.1' },
    );
    expect(status).toBe(201);
    // The major is PARSED from the label and never sent, so a client cannot make
    // the two disagree and decide what `same_major_version` means (ADR 0010 D4).
    expect(insertAssetVersion).toHaveBeenCalledWith(
      expect.objectContaining({ label: '2.4.1', majorVersion: 2 }),
    );
  });
});

describe('registering a file takes the three facts from the asset service', () => {
  const body = {
    storageKey: STORAGE_KEY,
    fileName: 'thing.stl',
    format: 'stl',
    role: 'mesh',
    visibility: 'rightful_download_only',
  };
  const filePath = `/digital/stores/${STORE_ID}/assets/${ASSET_ID}/versions/${VERSION_ID}/files`;

  it('writes the MEASURED size, media type and digest — and ignores a body that lies', async () => {
    describeAssetObject.mockResolvedValue({
      storageKey: STORAGE_KEY,
      byteSize: 4_096,
      mediaType: 'model/stl',
      contentHash: DIGEST,
    });
    insertAssetFile.mockResolvedValue({ id: FILE_ID });

    const { status } = await post(uploadsOn, filePath, {
      ...body,
      // Everything an attacker would want to choose. #1015 W1 requirement 7: a
      // client-supplied digest makes W8's duplicate detector a thing an attacker
      // controls, and a client-supplied size makes the storage accounting
      // fiction. The schema has no field for any of them, so they are dropped.
      contentHash: 'f'.repeat(64),
      byteSize: 1,
      mediaType: 'text/plain',
    });

    expect(status).toBe(201);
    expect(insertAssetFile).toHaveBeenCalledWith(
      expect.objectContaining({
        contentHash: DIGEST,
        byteSize: 4_096,
        mediaType: 'model/stl',
        storageKey: STORAGE_KEY,
      }),
    );
  });

  it('never answers with the storage key', async () => {
    describeAssetObject.mockResolvedValue({
      storageKey: STORAGE_KEY,
      byteSize: 4_096,
      mediaType: 'model/stl',
      contentHash: DIGEST,
    });
    // What `insertAssetFile` really returns: the PUBLIC column set, which has no
    // `storageKey` at the type level either.
    insertAssetFile.mockResolvedValue({ id: FILE_ID, fileName: 'thing.stl', format: 'stl' });
    const { status, body: answered } = await post(uploadsOn, filePath, body);
    expect(status).toBe(201);
    const serialized = JSON.stringify(answered);
    expect(serialized).not.toContain(STORAGE_KEY);
    // Control: the search can find what IS in the response.
    expect(serialized).toContain('thing.stl');
  });

  it('refuses a file the asset service does not hold, with the same answer as a bad id', async () => {
    describeAssetObject.mockResolvedValue(null);
    const { status } = await post(uploadsOn, filePath, body);
    expect(status).toBe(404);
    expect(insertAssetFile).not.toHaveBeenCalled();
  });

  it('answers 503 when the deployment cannot ASK, and never believes the client', async () => {
    describeAssetObject.mockRejectedValue({ reason: 'unconfigured' });
    const { status } = await post(uploadsOn, filePath, body);
    expect(status).toBe(503);
    expect(insertAssetFile).not.toHaveBeenCalled();
  });

  it('refuses a version that is past draft', async () => {
    // `asset_files_immutable_once_published` is the real guard (#1015 W12 threat
    // 8 — a creator swapping bytes after a sale). This is the readable refusal in
    // front of it.
    findAssetVersion.mockResolvedValue({ id: VERSION_ID, assetId: ASSET_ID, state: 'published' });
    const { status } = await post(uploadsOn, filePath, body);
    expect(status).toBe(409);
    expect(describeAssetObject).not.toHaveBeenCalled();
  });

  it('refuses a format outside the registry', async () => {
    const { status } = await post(uploadsOn, filePath, { ...body, format: 'not-a-format' });
    expect(status).toBe(400);
  });
});

describe('publication asks the lever, the scan gate AND the inspection gate', () => {
  const publishPath = `/digital/stores/${STORE_ID}/assets/${ASSET_ID}/versions/${VERSION_ID}/publish`;

  it('refuses with DIGITAL_PUBLICATION_ENABLED off, before reading any verdict', async () => {
    const { status } = await post(uploadsOn, publishPath, {});
    expect(status).toBe(409);
    expect(everyFileScannedClean).not.toHaveBeenCalled();
    expect(everyFileInspectionAcceptable).not.toHaveBeenCalled();
    expect(publishAssetVersion).not.toHaveBeenCalled();
  });

  it('refuses a version whose files are not all clean', async () => {
    everyFileScannedClean.mockResolvedValue(false);
    const { status } = await post(publishing, publishPath, {});
    expect(status).toBe(409);
    expect(publishAssetVersion).not.toHaveBeenCalled();
    // And it short-circuits: a version that failed the scan is not also inspected,
    // so the creator gets the answer about the gate that actually stopped them.
    expect(everyFileInspectionAcceptable).not.toHaveBeenCalled();
  });

  it('refuses a CLEAN version whose inspection is unacceptable', async () => {
    // The escape the scan gate leaves open, and the reason the second gate exists:
    // a `corrupt` file is not malicious, so a scanner calls it clean. Without this
    // the version below would publish.
    everyFileScannedClean.mockResolvedValue(true);
    everyFileInspectionAcceptable.mockResolvedValue(false);
    const { status } = await post(publishing, publishPath, {});
    expect(status).toBe(409);
    expect(publishAssetVersion).not.toHaveBeenCalled();
  });

  it('publishes when the lever is on and BOTH gates pass — the control', async () => {
    everyFileScannedClean.mockResolvedValue(true);
    everyFileInspectionAcceptable.mockResolvedValue(true);
    publishAssetVersion.mockResolvedValue(true);
    findAssetVersion.mockResolvedValue({ id: VERSION_ID, assetId: ASSET_ID, state: 'draft' });
    const { status } = await post(publishing, publishPath, {});
    expect(status).toBe(200);
    expect(publishAssetVersion).toHaveBeenCalledWith(VERSION_ID, expect.any(Date));
  });

  it('reports a conflict rather than a success when the CAS did not move a row', async () => {
    everyFileScannedClean.mockResolvedValue(true);
    everyFileInspectionAcceptable.mockResolvedValue(true);
    publishAssetVersion.mockResolvedValue(false);
    const { status } = await post(publishing, publishPath, {});
    expect(status).toBe(409);
  });
});

describe('a licence version freezes on a SECOND request', () => {
  it('creates a draft and assigns the version number itself', async () => {
    highestLicenceVersion = 3;
    insertAssetLicenceVersion.mockResolvedValue({ id: LICENCE_VERSION_ID, version: 4 });
    const { status } = await post(
      uploadsOn,
      `/digital/stores/${STORE_ID}/licences/${LICENCE_ID}/versions`,
      {
        summary: 'Commercial use, no redistribution.',
        rights: ['personal_use', 'commercial_project_use'],
        attribution: 'optional',
      },
    );
    expect(status).toBe(201);
    expect(insertAssetLicenceVersion).toHaveBeenCalledWith(
      expect.objectContaining({ licenceId: LICENCE_ID, version: 4 }),
    );
  });

  it('refuses rights that depend on one they do not grant', async () => {
    // `derivative_redistribution` without `modification` is not a licence, it is
    // a contradiction. Enforced at write time by the one shared implementation.
    const { status, body } = await post(
      uploadsOn,
      `/digital/stores/${STORE_ID}/licences/${LICENCE_ID}/versions`,
      {
        summary: 'Redistribute what you may not change.',
        rights: ['personal_use', 'derivative_redistribution'],
        attribution: 'required',
      },
    );
    expect(status).toBe(400);
    expect(body.message).toContain('modification');
    expect(insertAssetLicenceVersion).not.toHaveBeenCalled();
  });

  it('404s another store’s licence', async () => {
    licenceRows = [{ id: LICENCE_ID, storeId: OTHER_STORE_ID }];
    const { status } = await post(
      uploadsOn,
      `/digital/stores/${STORE_ID}/licences/${LICENCE_ID}/versions`,
      { summary: 'x', rights: ['personal_use'], attribution: 'optional' },
    );
    expect(status).toBe(404);
  });

  it('404s a PLATFORM reference licence, which no creator may add terms to', async () => {
    // `store_id IS NULL` is Mercaria's own seeded text. A creator publishing a
    // version of it would be publishing terms in the platform's name — and a
    // buyer comparing two "Commercial" licences is relying on being able to tell
    // those apart.
    licenceRows = [{ id: LICENCE_ID, storeId: null }];
    const { status } = await post(
      uploadsOn,
      `/digital/stores/${STORE_ID}/licences/${LICENCE_ID}/versions`,
      { summary: 'x', rights: ['personal_use'], attribution: 'optional' },
    );
    expect(status).toBe(404);
  });
});

describe('an option may not be built on a draft licence version', () => {
  const optionPath = `/digital/stores/${STORE_ID}/assets/${ASSET_ID}/licence-options`;
  const optionBody = {
    packageId: PACKAGE_ID,
    licenceVersionId: LICENCE_VERSION_ID,
    updatePolicy: 'same_major_version',
  };

  it('refuses a draft — otherwise it is a listing nobody can buy and nothing reports', async () => {
    // `resolveDigitalLines` silently drops a binding whose licence version is not
    // `published`, which downstream reads as "this line is physical".
    findAssetLicenceVersion.mockResolvedValue({
      id: LICENCE_VERSION_ID,
      licenceId: LICENCE_ID,
      state: 'draft',
    });
    const { status } = await post(uploadsOn, optionPath, optionBody);
    expect(status).toBe(409);
    expect(insertAssetLicenceOption).not.toHaveBeenCalled();
  });

  it('accepts a published one — the control', async () => {
    findAssetLicenceVersion.mockResolvedValue({
      id: LICENCE_VERSION_ID,
      licenceId: LICENCE_ID,
      state: 'published',
    });
    insertAssetLicenceOption.mockResolvedValue({ id: OPTION_ID });
    const { status } = await post(uploadsOn, optionPath, optionBody);
    expect(status).toBe(201);
  });

  it('accepts a MERCARIA reference licence version, which is what one is for', async () => {
    licenceRows = [{ id: LICENCE_ID, storeId: null }];
    findAssetLicenceVersion.mockResolvedValue({
      id: LICENCE_VERSION_ID,
      licenceId: LICENCE_ID,
      state: 'published',
    });
    insertAssetLicenceOption.mockResolvedValue({ id: OPTION_ID });
    const { status } = await post(uploadsOn, optionPath, optionBody);
    expect(status).toBe(201);
  });

  it('404s another store’s licence version', async () => {
    licenceRows = [{ id: LICENCE_ID, storeId: OTHER_STORE_ID }];
    findAssetLicenceVersion.mockResolvedValue({
      id: LICENCE_VERSION_ID,
      licenceId: LICENCE_ID,
      state: 'published',
    });
    const { status } = await post(uploadsOn, optionPath, optionBody);
    expect(status).toBe(404);
    expect(insertAssetLicenceOption).not.toHaveBeenCalled();
  });
});

describe('binding a variant checks BOTH sides against the store', () => {
  const bindPath = `/digital/stores/${STORE_ID}/variant-bindings`;
  const bindBody = { variantId: VARIANT_ID, licenceOptionId: OPTION_ID };

  beforeEach(() => {
    findAssetLicenceOption.mockResolvedValue({ id: OPTION_ID, assetId: ASSET_ID });
    findVariantById.mockResolvedValue({ id: VARIANT_ID, listingId: LISTING_ID });
    findListingById.mockResolvedValue({
      id: LISTING_ID,
      ownerType: 'store',
      storeId: STORE_ID,
    });
  });

  it('binds when both belong to the store', async () => {
    const { status } = await post(uploadsOn, bindPath, bindBody);
    expect(status).toBe(201);
    expect(upsertDigitalBinding).toHaveBeenCalledWith({
      variantId: VARIANT_ID,
      licenceOptionId: OPTION_ID,
    });
  });

  it('404s a variant on another store’s listing', async () => {
    // `asset_variant_bindings.variant_id` carries no foreign key by design, so
    // nothing in the database would stop this — and a binding is exactly what
    // makes a line digital at checkout.
    findListingById.mockResolvedValue({
      id: LISTING_ID,
      ownerType: 'store',
      storeId: OTHER_STORE_ID,
    });
    const { status } = await post(uploadsOn, bindPath, bindBody);
    expect(status).toBe(404);
    expect(upsertDigitalBinding).not.toHaveBeenCalled();
  });

  it('404s a P2P listing, which belongs to a person rather than to this store', async () => {
    findListingById.mockResolvedValue({ id: LISTING_ID, ownerType: 'user', storeId: null });
    const { status } = await post(uploadsOn, bindPath, bindBody);
    expect(status).toBe(404);
  });

  it('404s an option on another store’s asset', async () => {
    findDigitalAsset.mockResolvedValue({ id: ASSET_ID, storeId: OTHER_STORE_ID });
    const { status } = await post(uploadsOn, bindPath, bindBody);
    expect(status).toBe(404);
    expect(upsertDigitalBinding).not.toHaveBeenCalled();
  });
});

describe('the package membership names a version the files actually belong to', () => {
  const filesPath = `/digital/stores/${STORE_ID}/assets/${ASSET_ID}/packages/${PACKAGE_ID}/files`;

  it('refuses a file that is not in that version', async () => {
    // No CHECK can tie `asset_package_files.version_id` to `asset_files.version_id`
    // across tables, and a membership row pointing at the wrong version makes a
    // file reachable at a version it was never in.
    findVersionFiles.mockResolvedValue([{ id: 'some-other-file' }]);
    const { status } = await post(uploadsOn, filesPath, {
      versionId: VERSION_ID,
      fileIds: [FILE_ID],
    });
    expect(status).toBe(400);
    expect(addFileToPackage).not.toHaveBeenCalled();
  });

  it('adds every named file when they are all in the version — the control', async () => {
    findVersionFiles.mockResolvedValue([{ id: FILE_ID }]);
    const { status } = await post(uploadsOn, filesPath, {
      versionId: VERSION_ID,
      fileIds: [FILE_ID],
    });
    expect(status).toBe(201);
    expect(addFileToPackage).toHaveBeenCalledWith({
      packageId: PACKAGE_ID,
      versionId: VERSION_ID,
      fileId: FILE_ID,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The buyer half                                                              */
/* -------------------------------------------------------------------------- */

describe('the buyer surface needs an ACTOR, and a guest is one', () => {
  it('refuses an anonymous caller on every route', async () => {
    const library = await get(uploadsOn, '/digital/library');
    expect(library.status).toBe(403);

    const mint = await post(uploadsOn, '/digital/downloads', {
      rightId: RIGHT_ID,
      versionId: VERSION_ID,
      fileId: FILE_ID,
    });
    expect(mint.status).toBe(403);
    expect(mintDownloadGrant).not.toHaveBeenCalled();

    const claim = await post(uploadsOn, '/digital/claims', { variantId: VARIANT_ID });
    expect(claim.status).toBe(403);
    expect(grantRight).not.toHaveBeenCalled();
  });

  it('serves a GUEST, keyed on their session', async () => {
    listBuyerLibrary.mockResolvedValue([]);
    const { status } = await get(uploadsOn, '/digital/library', { 'x-test-actor': 'guest' });
    expect(status).toBe(200);
    // `buyerKeyForActor`'s spelling, and the one the right rows carry.
    expect(listBuyerLibrary).toHaveBeenCalledWith('guest:guest-session-1');
  });

  it('serves an Oxy account under the other prefix', async () => {
    listBuyerLibrary.mockResolvedValue([]);
    await get(uploadsOn, '/digital/library', { 'x-test-actor': 'oxy' });
    expect(listBuyerLibrary).toHaveBeenCalledWith(`oxy:${OWNER_USER}`);
  });
});

describe('minting a grant', () => {
  const mintBody = { rightId: RIGHT_ID, versionId: VERSION_ID, fileId: FILE_ID };

  it('hands the token over once, uncacheable', async () => {
    mintDownloadGrant.mockResolvedValue({
      outcome: 'granted',
      grant: {
        grantId: 'grant-1',
        token: GRANT_TOKEN,
        expiresAt: new Date('2026-08-11T10:00:00.000Z'),
        fileName: 'thing.stl',
        byteSize: 4_096,
      },
    });
    const { status, body, headers } = await post(uploadsOn, '/digital/downloads', mintBody, {
      'x-test-actor': 'oxy',
    });
    expect(status).toBe(201);
    expect((body.data as Record<string, unknown>).token).toBe(GRANT_TOKEN);
    expect(headers.get('cache-control')).toBe('no-store');
    // Who is asking comes from the ACTOR and never from the body.
    expect(mintDownloadGrant).toHaveBeenCalledWith(
      expect.objectContaining({ requesterKey: `oxy:${OWNER_USER}` }),
    );
  });

  it('answers 404 for `no_right` — the answer "somebody else’s right" also gets', async () => {
    mintDownloadGrant.mockResolvedValue({ outcome: 'refused', reason: 'no_right' });
    const { status, body } = await post(uploadsOn, '/digital/downloads', mintBody, {
      'x-test-actor': 'oxy',
    });
    expect(status).toBe(404);
    // The message says nothing about which of the two it was, and names no id.
    expect(body.message).not.toContain(RIGHT_ID);
  });

  it('answers 503 for `downloads_disabled`, because nothing the buyer owns changed', async () => {
    mintDownloadGrant.mockResolvedValue({ outcome: 'refused', reason: 'downloads_disabled' });
    const { status, body } = await post(uploadsOn, '/digital/downloads', mintBody, {
      'x-test-actor': 'oxy',
    });
    expect(status).toBe(503);
    expect(body.message).toContain('purchases are unaffected');
  });

  it('maps the remaining refusals to distinct, non-200 statuses', async () => {
    const expected: Record<string, number> = {
      right_not_active: 403,
      version_not_covered: 403,
      version_not_downloadable: 409,
      file_not_in_package: 404,
      file_not_downloadable: 403,
      grant_expired: 410,
      grant_exhausted: 410,
    };
    for (const [reason, status] of Object.entries(expected)) {
      mintDownloadGrant.mockResolvedValue({ outcome: 'refused', reason });
      const response = await post(uploadsOn, '/digital/downloads', mintBody, {
        'x-test-actor': 'oxy',
      });
      expect(response.status, reason).toBe(status);
    }
  });
});

describe('redeeming a grant redirects, and writes the token down nowhere', () => {
  beforeEach(() => {
    redeemDownloadGrant.mockResolvedValue({
      outcome: 'ready',
      storageKey: STORAGE_KEY,
      fileName: 'thing.stl',
      mediaType: 'model/stl',
      byteSize: 4_096,
    });
    resolveAuthorizedUrl.mockResolvedValue(RESOLVED_URL);
  });

  it('302s to the authorized URL with no-store and no-referrer', async () => {
    const { status, headers } = await get(uploadsOn, `/digital/downloads/${GRANT_TOKEN}`, {
      'x-test-actor': 'oxy',
    });
    expect(status).toBe(302);
    expect(headers.get('location')).toBe(RESOLVED_URL);
    expect(headers.get('cache-control')).toBe('no-store');
    // So the next hop is not told the URL this request was made with — which is
    // the grant token.
    expect(headers.get('referrer-policy')).toBe('no-referrer');
    expect(resolveAuthorizedUrl).toHaveBeenCalledWith(STORAGE_KEY);
  });

  it('re-checks the right against THIS requester, not the token alone', async () => {
    // What stops the URL being shareable for five minutes. The token is enough to
    // find the grant and is NOT enough to open it.
    await get(uploadsOn, `/digital/downloads/${GRANT_TOKEN}`, { 'x-test-actor': 'guest' });
    expect(redeemDownloadGrant).toHaveBeenCalledWith(GRANT_TOKEN, 'guest:guest-session-1');
  });

  it('logs neither the token, the storage key nor the resolved URL', async () => {
    await get(uploadsOn, `/digital/downloads/${GRANT_TOKEN}`, { 'x-test-actor': 'oxy' });
    const lines = JSON.stringify(logged.mock.calls);
    expect(lines).not.toContain(GRANT_TOKEN);
    expect(lines).not.toContain(STORAGE_KEY);
    expect(lines).not.toContain(RESOLVED_URL);
  });

  it('… and the search that proved it can find a token when there is one to find', async () => {
    // The control for the case above. `expect(x).not.toContain(token)` over an
    // empty log is a pass that means nothing, so the SAME search is run against a
    // place the token must appear — the mint response, which is the one and only
    // time it is handed over.
    mintDownloadGrant.mockResolvedValue({
      outcome: 'granted',
      grant: {
        grantId: 'grant-1',
        token: GRANT_TOKEN,
        expiresAt: new Date(),
        fileName: 'thing.stl',
        byteSize: 1,
      },
    });
    const response = await post(
      uploadsOn,
      '/digital/downloads',
      { rightId: RIGHT_ID, versionId: VERSION_ID, fileId: FILE_ID },
      { 'x-test-actor': 'oxy' },
    );
    expect(JSON.stringify(response.body)).toContain(GRANT_TOKEN);
  });

  it('answers 410 for an expired grant and never resolves a URL', async () => {
    redeemDownloadGrant.mockResolvedValue({ outcome: 'refused', reason: 'grant_expired' });
    const { status } = await get(uploadsOn, `/digital/downloads/${GRANT_TOKEN}`, {
      'x-test-actor': 'oxy',
    });
    expect(status).toBe(410);
    expect(resolveAuthorizedUrl).not.toHaveBeenCalled();
  });

  it('answers 502 — never a redirect — when the URL cannot be resolved', async () => {
    // A redirect would have to name a destination, and the only one available at
    // that point is the public CDN form, which 404s on a private asset.
    resolveAuthorizedUrl.mockRejectedValue({ reason: 'unresolved' });
    const { status, headers } = await get(uploadsOn, `/digital/downloads/${GRANT_TOKEN}`, {
      'x-test-actor': 'oxy',
    });
    expect(status).toBe(502);
    expect(headers.get('location')).toBeNull();
  });
});

describe('claiming a FREE asset', () => {
  const claimPath = '/digital/claims';
  const line = {
    variantId: VARIANT_ID,
    assetId: ASSET_ID,
    packageId: PACKAGE_ID,
    assetVersionId: VERSION_ID,
    licenceVersionId: LICENCE_VERSION_ID,
    updatePolicy: 'all_future_versions',
    vertical: 'three_d',
  };

  beforeEach(() => {
    resolveDigitalLines.mockResolvedValue(new Map([[VARIANT_ID, line]]));
    findVariantById.mockResolvedValue({
      id: VARIANT_ID,
      listingId: LISTING_ID,
      priceAmount: 0,
      priceCurrency: 'EUR',
    });
    grantRight.mockResolvedValue({
      right: {
        id: RIGHT_ID,
        status: 'active',
        assetId: ASSET_ID,
        packageId: PACKAGE_ID,
        purchasedVersionId: VERSION_ID,
        licenceVersionId: LICENCE_VERSION_ID,
        updatePolicy: 'all_future_versions',
      },
      created: true,
    });
  });

  it('grants a `free_claim` right with no order line behind it', async () => {
    const { status, body } = await post(
      uploadsOn,
      claimPath,
      { variantId: VARIANT_ID },
      { 'x-test-actor': 'guest' },
    );
    expect(status).toBe(201);
    expect((body.data as Record<string, unknown>).created).toBe(true);
    expect(grantRight).toHaveBeenCalledWith(
      expect.objectContaining({
        buyerKey: 'guest:guest-session-1',
        source: 'free_claim',
        orderItemId: null,
        orderId: null,
      }),
      'guest:guest-session-1',
    );
  });

  it('converges on a replay rather than granting a second right', async () => {
    // The partial unique index `(buyer_key, package_id) WHERE order_item_id IS
    // NULL` is what bounds it, and `created: false` is how the difference is
    // observable — only the first caller appends a `granted` event.
    grantRight.mockResolvedValue({
      right: { id: RIGHT_ID, status: 'active', assetId: ASSET_ID, packageId: PACKAGE_ID },
      created: false,
    });
    const { status, body } = await post(
      uploadsOn,
      claimPath,
      { variantId: VARIANT_ID },
      { 'x-test-actor': 'guest' },
    );
    expect(status).toBe(200);
    expect((body.data as Record<string, unknown>).created).toBe(false);
  });

  it('refuses a PRICED variant', async () => {
    findVariantById.mockResolvedValue({
      id: VARIANT_ID,
      listingId: LISTING_ID,
      priceAmount: 600,
      priceCurrency: 'EUR',
    });
    const { status, body } = await post(
      uploadsOn,
      claimPath,
      { variantId: VARIANT_ID },
      { 'x-test-actor': 'guest' },
    );
    expect(status).toBe(409);
    expect(body.message).toContain('not free');
    expect(grantRight).not.toHaveBeenCalled();
  });

  it('refuses an UNPRICED variant too, which is not the same as a free one', async () => {
    // `nativeUnitPrice` refuses to sell a variant with NULL price columns rather
    // than snapshotting a zero. Reading that state as free here would be the one
    // path that hands a deliverable over because nobody set a price.
    findVariantById.mockResolvedValue({
      id: VARIANT_ID,
      listingId: LISTING_ID,
      priceAmount: null,
      priceCurrency: null,
    });
    const { status } = await post(
      uploadsOn,
      claimPath,
      { variantId: VARIANT_ID },
      { 'x-test-actor': 'guest' },
    );
    expect(status).toBe(409);
    expect(grantRight).not.toHaveBeenCalled();
  });

  it('refuses a variant with no digital binding', async () => {
    resolveDigitalLines.mockResolvedValue(new Map());
    const { status } = await post(
      uploadsOn,
      claimPath,
      { variantId: VARIANT_ID },
      { 'x-test-actor': 'guest' },
    );
    expect(status).toBe(404);
    expect(grantRight).not.toHaveBeenCalled();
  });

  it('refuses a vertical this deployment does not sell', async () => {
    // An ALLOW-list, which is why a vertical absent from it refuses rather than
    // being admitted by default the day it is added.
    resolveDigitalLines.mockResolvedValue(
      new Map([[VARIANT_ID, { ...line, vertical: 'audio' }]]),
    );
    const { status } = await post(
      uploadsOn,
      claimPath,
      { variantId: VARIANT_ID },
      { 'x-test-actor': 'guest' },
    );
    expect(status).toBe(409);
    expect(grantRight).not.toHaveBeenCalled();
  });

  it('is reachable with PAID checkout off, which is the reason the levers are separate', async () => {
    // ADR 0010 D13: `DIGITAL_PAID_CHECKOUT_ENABLED` stops buying and *"a free
    // claim still works"*. The apps here are all built with it unset, so this
    // case is the whole of that claim.
    expect(process.env.DIGITAL_PAID_CHECKOUT_ENABLED).toBeUndefined();
    const { status } = await post(
      uploadsOn,
      claimPath,
      { variantId: VARIANT_ID },
      { 'x-test-actor': 'guest' },
    );
    expect(status).toBe(201);
  });
});

describe('the asset create route reads the vertical allow-list', () => {
  it('refuses a vertical this deployment does not sell, before anything is written', async () => {
    const { status } = await post(uploadsOn, `/digital/stores/${STORE_ID}/assets`, {
      vertical: 'audio',
      title: 'A track',
    });
    expect(status).toBe(409);
    expect(insertDigitalAsset).not.toHaveBeenCalled();
  });

  it('admits the enabled one — the control', async () => {
    insertDigitalAsset.mockResolvedValue({ id: ASSET_ID });
    const { status } = await post(uploadsOn, `/digital/stores/${STORE_ID}/assets`, CREATE_ASSET);
    expect(status).toBe(201);
  });
});
