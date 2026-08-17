/**
 * `previewDraftUpgrade` and `applyDraftUpgrade` — the ONE mechanism that moves a
 * stored draft from the product-type version it was authored under to a newer one
 * (#367, ADR 0007 D5/D10).
 *
 * ## Why this file exists
 *
 * ADR 0007 D5 requires "a migration mechanism for products/drafts when a newer
 * version is available; never silently rewrite them", and D10 spells the shape
 * out: a newer schema version produces a PREVIEW, and applying it is a separate,
 * explicit request. Both halves are implemented in `draft.service.ts` and both
 * have HTTP callers (`catalog-authoring.controller.ts`).
 *
 * **Neither was referenced by any test in the repository.** The surrounding
 * mechanisms were: the re-pin trigger is asserted by
 * `db/__tests__/catalog-authoring.realdb.test.ts` and the
 * `schema_version_superseded` warning by `authoring-validation.test.ts`. What had
 * no gate at all was the comparison in the middle — which effect a change is
 * classified as, whether `losesAnswers` is set, and whether applying an upgrade
 * leaves the stored answers alone. So every rule in `previewDraftUpgrade` could
 * be deleted or inverted with the whole suite green, and the failure would be
 * silent in the worst direction: an author told "nothing is lost" while an answer
 * is about to become unreadable.
 *
 * ## Why the repositories are mocked, and what that costs
 *
 * Every assertion here is about a CHOICE the service makes over rows it was
 * handed. The constraints those choices sit inside — `mercaria_catalog_authoring_
 * draft_pins_frozen` permitting a re-pin only on an OPEN draft, and the CAS in
 * `repinDraftIfVersion` — are the database's, have no mocked counterpart, and are
 * already asserted against a real server by `catalog-authoring.realdb.test.ts`.
 * Neither test substitutes for the other, and this one deliberately does not add
 * a second claimant to the shared test database to re-assert a trigger somebody
 * else already pinned.
 *
 * ## Each rule is asserted SEPARATELY
 *
 * `losesAnswers` is set by two independent causes — a removed field the draft
 * answered, and an attribute version change on a field the draft answered — so
 * one case going red proves one cause and says nothing about the other. Both are
 * here, each with the ANSWERED and the UNANSWERED variant, because the whole
 * point of the flag is that it distinguishes them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const findDraft = vi.fn();
const listDraftValues = vi.fn();
const repinDraftIfVersion = vi.fn();
const findProductTypeDefinitionById = vi.fn();
const findPublishedVersionForKey = vi.fn();
const listProductTypeFields = vi.fn();
const composeAuthoringSchemaForDefinitionId = vi.fn();

/**
 * The repository modules, stubbed WHOLE.
 *
 * Every export the module under test imports is listed even where this file
 * never drives it: an ESM named import of a member a mock factory omits is a
 * load-time failure, so a partial factory would fail the file rather than the
 * assertion — and the next person to add a case would read it as a broken test
 * instead of a missing stub.
 */
vi.mock('../../../db/catalogAuthoring/draftRepository.js', () => ({
  insertDraft: vi.fn(),
  findDraft: (...args: unknown[]) => findDraft(...args),
  lockDraftForPublish: vi.fn(),
  listDrafts: vi.fn(),
  updateDraftIfVersion: vi.fn(),
  repinDraftIfVersion: (...args: unknown[]) => repinDraftIfVersion(...args),
  markDraftPublished: vi.fn(),
  discardDraft: vi.fn(),
  findDraftByPublishIdempotencyKey: vi.fn(),
  listDraftVariants: vi.fn(async () => []),
  replaceDraftVariants: vi.fn(),
  listDraftValues: (...args: unknown[]) => listDraftValues(...args),
  replaceProductScopeValues: vi.fn(),
  insertVariantScopeValues: vi.fn(),
  listDraftValuesForDrafts: vi.fn(),
}));

vi.mock('../../../db/catalogAuthoring/schemaSourceRepository.js', () => ({
  listAttributeDefinitionsByIds: vi.fn(),
  listAttributeLabelsForDefinitions: vi.fn(),
  listPublishedProductTypesForCategory: vi.fn(),
  productTypeIsScopedToCategory: vi.fn(),
  listSelectableCategories: vi.fn(),
  findCategoryRow: vi.fn(),
  findPublishedVersionForKey: (...args: unknown[]) => findPublishedVersionForKey(...args),
  findProductTypeVersion: vi.fn(),
  listScopedCategoryIds: vi.fn(),
}));

vi.mock('../../../db/productTypes/productTypeFieldRepository.js', () => ({
  listProductTypeFields: (...args: unknown[]) => listProductTypeFields(...args),
}));

vi.mock('../../../db/productTypes/productTypeRepository.js', () => ({
  findProductTypeDefinitionById: (...args: unknown[]) => findProductTypeDefinitionById(...args),
}));

vi.mock('../schema.service.js', () => ({
  composeAuthoringSchema: vi.fn(),
  composeAuthoringSchemaForDefinitionId: (...args: unknown[]) =>
    composeAuthoringSchemaForDefinitionId(...args),
}));

vi.mock('../validation.js', () => ({ validateDraft: vi.fn(() => ({ publishable: true, findings: [], schemaEtag: 'etag' })) }));

vi.mock('../../variant-axes/signature.js', () => ({
  normalizeAxisValue: vi.fn(),
  typedVariantSignature: vi.fn(),
  defaultTypedVariantSignature: vi.fn(),
}));

vi.mock('../../../db/catalogProposals/proposalRepository.js', () => ({
  listOpenProposalsBlockingDraft: vi.fn(async () => []),
}));

vi.mock('../../catalog-proposals/publication-gate.js', () => ({
  decidePendingProposalPublication: vi.fn(),
  pendingProposalFindings: vi.fn(() => []),
  withProposalFindings: vi.fn((result: unknown) => result),
}));

const { applyDraftUpgrade, previewDraftUpgrade } = await import('../draft.service.js');

const db = {} as never;

const PINNED = { id: 'ptd_v1', key: 'smartphone', version: 1 };
const PUBLISHED = { id: 'ptd_v2', key: 'smartphone', version: 2 };

/**
 * The draft's row timestamps — safely in the PAST, and ONE literal that both of
 * them read.
 *
 * Past, because `fixture-date-census.test.ts` refuses a fixture dated today or
 * later: the real clock moves toward it, so it passes on the day it was written,
 * keeps passing, and then breaks CI for whoever pushes on the day it arrives —
 * in a file they did not touch. This fixture was originally pinned to the day the
 * file was written and the census caught it that same day — the only day it was
 * cheap to catch, because a day later the clock walks past and the gate goes quiet
 * for a year.
 *
 * No date in this comment, deliberately: the census scans RAW source and does not
 * strip comments (its own header says why), so a bare date in prose is a counted
 * literal, and somebody "refreshing" it to the day they touched the file would go
 * red having edited nothing but a comment.
 *
 * ONE constant rather than two identical literals, because two drift apart
 * independently and the second one becomes the next census hit. Nothing here
 * compares them — `hydrateDraft` only calls `.toISOString()` on them — so no
 * later instant has to be derived; if one ever did, it would be an offset from
 * what the code under test actually stamped, never a second literal.
 */
const FIXTURE_INSTANT = new Date('2026-01-05T00:00:00.000Z');

const DRAFT = {
  id: 'dr_1',
  storeId: 'st_1',
  status: 'open',
  categoryId: 'cat_1',
  productTypeDefinitionId: PINNED.id,
  flow: 'merchant',
  locale: 'en',
  market: 'ES',
  version: 7,
  schemaHash: 'etag_v1',
  title: 'A phone',
  description: null,
  imageFileIds: [],
  tags: [],
  selectedCanonicalProductId: null,
  publishedListingId: null,
  expiresAt: null,
  createdAt: FIXTURE_INSTANT,
  updatedAt: FIXTURE_INSTANT,
};

function field(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ptf_x',
    productTypeDefinitionId: PINNED.id,
    groupId: null,
    attributeDefinitionId: 'ad_color',
    attributeKey: 'color',
    attributeDefinitionVersion: 3,
    scope: 'variant',
    flow: 'merchant',
    requirement: 'optional',
    valuePolicy: 'controlled_value',
    variantCapable: true,
    position: 0,
    visibilityRule: null,
    ...overrides,
  };
}

/** `listProductTypeFields(db, definitionId, flow)` — keyed on the version asked for. */
function fieldsByVersion(pinned: unknown[], published: unknown[]): void {
  listProductTypeFields.mockImplementation(async (_db: unknown, definitionId: string) =>
    definitionId === PINNED.id ? pinned : published,
  );
}

/** One answered field, as `listDraftValues` returns it. */
function answer(attributeKey: string) {
  return { id: `dv_${attributeKey}`, draftId: DRAFT.id, attributeKey, draftVariantId: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  findDraft.mockResolvedValue(DRAFT);
  findProductTypeDefinitionById.mockResolvedValue(PINNED);
  findPublishedVersionForKey.mockResolvedValue(PUBLISHED);
  listDraftValues.mockResolvedValue([]);
  fieldsByVersion([field()], [field()]);
});

describe('a draft pinned to the current published version is up to date', () => {
  it('reports `up_to_date` when the published version IS the pinned one', async () => {
    findPublishedVersionForKey.mockResolvedValue(PINNED);

    const preview = await previewDraftUpgrade(db, DRAFT.storeId, DRAFT.id);

    expect(preview.outcome).toBe('up_to_date');
    // The `up_to_date` branch carries no target, so a client cannot render an
    // upgrade that does not exist — asserted, because the union's other branch
    // would happily have carried one.
    expect(preview).not.toHaveProperty('targetVersion');
    expect(preview).not.toHaveProperty('changes');
  });

  it('reports `up_to_date` when the product type has NO published version at all', async () => {
    findPublishedVersionForKey.mockResolvedValue(null);

    expect((await previewDraftUpgrade(db, DRAFT.storeId, DRAFT.id)).outcome).toBe('up_to_date');
  });
});

describe('the comparison is per (flow, attribute key) and not per row id', () => {
  it('reports `unchanged` for a field whose ROW ID changed but whose key did not', async () => {
    // The newer version's rows are NEW rows. A comparison keyed on `id` would
    // report this as one removal plus one addition — true, and useless.
    fieldsByVersion(
      [field({ id: 'ptf_old' })],
      [field({ id: 'ptf_new', productTypeDefinitionId: PUBLISHED.id })],
    );

    const preview = await previewDraftUpgrade(db, DRAFT.storeId, DRAFT.id);

    expect(preview.outcome).toBe('upgrade_available');
    if (preview.outcome !== 'upgrade_available') return;
    expect(preview.changes).toEqual([
      { effect: 'unchanged', attributeKey: 'color', path: 'fields.color' },
    ]);
    expect(preview.losesAnswers).toBe(false);
  });

  it('asks the repository only for the DRAFT\'s own flow', async () => {
    await previewDraftUpgrade(db, DRAFT.storeId, DRAFT.id);

    // Both calls name `merchant`. Comparing across flows would report the P2P
    // form's deliberately shorter list as a set of removals.
    expect(listProductTypeFields.mock.calls.map((call) => call[2])).toEqual([
      'merchant',
      'merchant',
    ]);
  });
});

describe('a removed field loses an answer only if the draft gave one', () => {
  it('reports `field_removed` and `losesAnswers` when the draft ANSWERED it', async () => {
    fieldsByVersion([field()], []);
    listDraftValues.mockResolvedValue([answer('color')]);

    const preview = await previewDraftUpgrade(db, DRAFT.storeId, DRAFT.id);

    expect(preview.outcome).toBe('upgrade_available');
    if (preview.outcome !== 'upgrade_available') return;
    expect(preview.changes).toEqual([
      { effect: 'field_removed', attributeKey: 'color', path: 'fields.color' },
    ]);
    expect(preview.losesAnswers).toBe(true);
  });

  it('reports `field_removed` and NOT `losesAnswers` when the draft left it empty', async () => {
    fieldsByVersion([field()], []);
    listDraftValues.mockResolvedValue([]);

    const preview = await previewDraftUpgrade(db, DRAFT.storeId, DRAFT.id);

    expect(preview.outcome).toBe('upgrade_available');
    if (preview.outcome !== 'upgrade_available') return;
    expect(preview.changes.map((change) => change.effect)).toEqual(['field_removed']);
    // The independent half of the flag: a field nobody answered can be removed
    // with nothing lost, and a preview that set the flag here would tell every
    // author their work is at risk.
    expect(preview.losesAnswers).toBe(false);
  });
});

describe('a newer attribute version can narrow a set, so it is reported as a risk', () => {
  it('reports `attribute_version_changed` with both versions, and loses answers when answered', async () => {
    fieldsByVersion([field()], [field({ attributeDefinitionVersion: 4 })]);
    listDraftValues.mockResolvedValue([answer('color')]);

    const preview = await previewDraftUpgrade(db, DRAFT.storeId, DRAFT.id);

    expect(preview.outcome).toBe('upgrade_available');
    if (preview.outcome !== 'upgrade_available') return;
    expect(preview.changes).toEqual([
      {
        effect: 'attribute_version_changed',
        attributeKey: 'color',
        path: 'fields.color',
        fromAttributeVersion: 3,
        toAttributeVersion: 4,
      },
    ]);
    expect(preview.losesAnswers).toBe(true);
  });

  it('does NOT lose answers when the version moved under a field nobody answered', async () => {
    fieldsByVersion([field()], [field({ attributeDefinitionVersion: 4 })]);
    listDraftValues.mockResolvedValue([]);

    const preview = await previewDraftUpgrade(db, DRAFT.storeId, DRAFT.id);

    expect(preview.outcome).toBe('upgrade_available');
    if (preview.outcome !== 'upgrade_available') return;
    expect(preview.losesAnswers).toBe(false);
  });

  it('reports the version change INSTEAD of a requirement change on the same field', async () => {
    // Deliberate precedence, and the honest one: a narrowed attribute is the
    // stronger fact, and reporting both would say a field changed twice.
    fieldsByVersion(
      [field({ requirement: 'optional' })],
      [field({ attributeDefinitionVersion: 4, requirement: 'required' })],
    );

    const preview = await previewDraftUpgrade(db, DRAFT.storeId, DRAFT.id);

    expect(preview.outcome).toBe('upgrade_available');
    if (preview.outcome !== 'upgrade_available') return;
    expect(preview.changes.map((change) => change.effect)).toEqual([
      'attribute_version_changed',
    ]);
  });
});

describe('a requirement move and a new field are reported without claiming a loss', () => {
  it('reports `requirement_changed` with both requirements', async () => {
    fieldsByVersion([field({ requirement: 'optional' })], [field({ requirement: 'required' })]);
    listDraftValues.mockResolvedValue([answer('color')]);

    const preview = await previewDraftUpgrade(db, DRAFT.storeId, DRAFT.id);

    expect(preview.outcome).toBe('upgrade_available');
    if (preview.outcome !== 'upgrade_available') return;
    expect(preview.changes).toEqual([
      {
        effect: 'requirement_changed',
        attributeKey: 'color',
        path: 'fields.color',
        fromRequirement: 'optional',
        toRequirement: 'required',
      },
    ]);
    // Tightening a requirement does not DESTROY an answer, it demands one. The
    // author sees the change and the validation they run afterwards decides.
    expect(preview.losesAnswers).toBe(false);
  });

  it('reports `field_added` for a key only the newer version declares', async () => {
    fieldsByVersion(
      [field()],
      [field(), field({ id: 'ptf_new', attributeDefinitionId: 'ad_storage', attributeKey: 'storage_capacity' })],
    );

    const preview = await previewDraftUpgrade(db, DRAFT.storeId, DRAFT.id);

    expect(preview.outcome).toBe('upgrade_available');
    if (preview.outcome !== 'upgrade_available') return;
    expect(preview.changes).toEqual([
      { effect: 'unchanged', attributeKey: 'color', path: 'fields.color' },
      { effect: 'field_added', attributeKey: 'storage_capacity', path: 'fields.storage_capacity' },
    ]);
    expect(preview.losesAnswers).toBe(false);
  });
});

describe('applying an upgrade re-pins and rewrites NOTHING', () => {
  beforeEach(() => {
    composeAuthoringSchemaForDefinitionId.mockResolvedValue({
      outcome: 'composed',
      schema: {
        productType: { definitionId: PUBLISHED.id, key: PUBLISHED.key, version: PUBLISHED.version },
        etag: 'etag_v2',
      },
    });
    repinDraftIfVersion.mockResolvedValue({ ...DRAFT, productTypeDefinitionId: PUBLISHED.id });
    listDraftValues.mockResolvedValue([]);
  });

  it('re-pins to the TARGET version with the target\'s hash and snapshot', async () => {
    await applyDraftUpgrade(db, {
      storeId: DRAFT.storeId,
      draftId: DRAFT.id,
      expectedVersion: DRAFT.version,
      targetDefinitionId: PUBLISHED.id,
      permissions: {} as never,
    });

    expect(repinDraftIfVersion).toHaveBeenCalledTimes(1);
    const [, storeId, draftId, expectedVersion, patch] = repinDraftIfVersion.mock.calls[0];
    expect([storeId, draftId, expectedVersion]).toEqual([DRAFT.storeId, DRAFT.id, DRAFT.version]);
    expect(patch.productTypeDefinitionId).toBe(PUBLISHED.id);
    expect(patch.schemaHash).toBe('etag_v2');
    expect(patch.schemaSnapshot).toBeDefined();
  });

  it('touches no draft VALUE — the silent rewrite ADR 0007 D10 forbids', async () => {
    const { replaceProductScopeValues, insertVariantScopeValues, replaceDraftVariants } =
      await import('../../../db/catalogAuthoring/draftRepository.js');

    await applyDraftUpgrade(db, {
      storeId: DRAFT.storeId,
      draftId: DRAFT.id,
      expectedVersion: DRAFT.version,
      targetDefinitionId: PUBLISHED.id,
      permissions: {} as never,
    });

    // An answer whose field the newer version removed SURVIVES, as an
    // `unknown_field` finding the author can see and clear. Deleting them here
    // would be the silent rewrite wearing a tidy-up's clothes.
    expect(replaceProductScopeValues).not.toHaveBeenCalled();
    expect(insertVariantScopeValues).not.toHaveBeenCalled();
    expect(replaceDraftVariants).not.toHaveBeenCalled();
  });

  it('refuses when the draft moved under the caller — the CAS answer', async () => {
    repinDraftIfVersion.mockResolvedValue(null);

    await expect(
      applyDraftUpgrade(db, {
        storeId: DRAFT.storeId,
        draftId: DRAFT.id,
        expectedVersion: DRAFT.version,
        targetDefinitionId: PUBLISHED.id,
        permissions: {} as never,
      }),
    ).rejects.toThrow();
  });
});

describe('a draft nobody owns is not previewable', () => {
  it('refuses an unknown draft rather than answering `up_to_date`', async () => {
    findDraft.mockResolvedValue(null);

    await expect(previewDraftUpgrade(db, DRAFT.storeId, 'dr_missing')).rejects.toThrow();
  });

  it('refuses when the pinned version has vanished', async () => {
    findProductTypeDefinitionById.mockResolvedValue(null);

    await expect(previewDraftUpgrade(db, DRAFT.storeId, DRAFT.id)).rejects.toThrow();
  });
});
