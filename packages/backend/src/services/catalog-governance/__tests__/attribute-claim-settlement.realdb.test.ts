/**
 * Settling a native attribute claim, against a REAL Postgres server (#576).
 *
 * Everything here is a property the DATABASE holds or a real trigger refuses,
 * and a mocked repository cannot show any of it: a mocked `update` accepts a
 * statement the server rejects outright, which is the whole class of bug the
 * `0123` clause exists to prevent.
 *
 * ## The five properties, and why each needs a server
 *
 * 1. **The queue names the rows behind the count.** `countQueuedClaims` reported
 *    a number and nothing could name the claims it counted; the page and the
 *    total must come from one definition of "queued" or the desk shows two
 *    backlog sizes.
 * 2. **A cited claim cannot be un-resolved — and the DATABASE is the authority.**
 *    The service refuses first for a readable message, but the guarantee is the
 *    trigger, so there is a case that goes AROUND the service with a direct
 *    `update` and asserts the raise. If only the service were tested, the
 *    guarantee would rest on this file's own caller.
 * 3. **A pre-existing violator stays fully UPDATABLE.** `0104` counted
 *    assignments already citing a non-resolved claim and deliberately repaired
 *    none. The naive state-based guard (`new.value_resolution <> 'resolved'`)
 *    freezes every one of them into "resolve it or never touch it again".
 *
 *    The discriminating pair is `blocked -> refused`, NOT the repair to
 *    `resolved` — the naive form permits that one too, because it tests `new`
 *    alone. Over all sixteen (old, new) pairs on a cited claim the two forms
 *    disagree on nine, every one of them a pair where both are non-resolved.
 *    Written down because the tempting summary is the wrong one, and the first
 *    draft of this file asserted it.
 * 4. **The reverse door stays shut.** An assignment may not be INSERTED citing a
 *    non-resolved claim — `0104`'s own trigger, in the direction `0123` does not
 *    cover. Asserting it here is what makes "the two triggers are a complete
 *    pair" a measurement rather than a claim in a migration header.
 * 5. **The freeze guard survived the `CREATE OR REPLACE`.** `0123` reproduces the
 *    assertion-immutability body by hand in order to add a clause beside it. A
 *    hand-copied trigger body is exactly where a guard goes missing silently, so
 *    the original refusal is re-asserted here.
 *
 * ## Scoping, because this database is SHARED
 *
 * `variant-axes.realdb.test.ts`'s discipline, and for its reasons: every
 * identifier carries a per-run suffix, the attribute definition is created at a
 * run-derived VERSION in a band this file owns, and teardown deletes exactly
 * what it created. The claims and assignments cascade from `listings`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { Request } from 'express';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { listings, productVariants } from '../../../db/schema/catalog.js';
import { attributeDefinitions } from '../../../db/schema/attributeRegistry.js';
import {
  nativeListingVariantAxes,
  nativeVariantAttributeClaims,
  nativeVariantAxisAssignments,
  nativeVariantSignatures,
} from '../../../db/schema/variantAxes.js';
import { typedVariantSignature } from '../../variant-axes/signature.js';
import { catalogGovernanceAuditEvents } from '../../../db/schema/catalogGovernance.js';
import { governanceActor, type CatalogGovernanceActor } from '../actor.js';
import { readAttributeClaimQueue, settleAttributeClaim } from '../attribute-claim.service.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12).replace(/\W/gu, '');
const OPERATOR = `claim-settler-${RUN}`;

/**
 * A version band this file owns.
 *
 * `(key, version)` is the unique on `attribute_definitions`, and the key below
 * is already run-suffixed — but the band is kept DISJOINT from
 * `variant-axes.realdb.test.ts`'s 800_000 and `product-type.realdb.test.ts`'s
 * 900_000 anyway, for the reason the first of those states: two runs deriving
 * one offset inside a shared band is a rare flake that presents as a mystery.
 */
const ATTR_VERSION = 700_000 + (Number.parseInt(RUN.slice(-4), 36) % 90_000);

const createdListingIds: string[] = [];
const createdAttributeIds: string[] = [];

/**
 * `governanceActor` is the only thing that can mint the branded type, and it is
 * used here rather than a cast for that reason — a cast in a test is how the
 * brand stops being a property of the call graph.
 */
function actorWith(...roles: Parameters<typeof governanceActor>[1]): CatalogGovernanceActor {
  return governanceActor({ userId: OPERATOR } as unknown as Request, roles);
}

/**
 * Assert a raise and MATCH ITS MESSAGE.
 *
 * The SQLSTATE lives on `cause`, never `error.code`. Matching the message is
 * what tells a trigger refusing the RIGHT thing from a trigger refusing
 * everything, and from a typo in the fixture.
 */
async function expectRaise(pattern: RegExp, run: () => Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown, 'expected the server to refuse, but the write succeeded').toBeDefined();
  const cause = (thrown as { cause?: { message?: string } }).cause;
  expect(String(cause?.message ?? (thrown as { message?: string }).message ?? thrown)).toMatch(
    pattern,
  );
}

async function makeListing(label: string): Promise<string> {
  const [row] = await db
    .insert(listings)
    .values({
      ownerType: 'user',
      oxyUserId: `claim-seller-${RUN}`,
      storeId: null,
      title: `Claim settlement ${label} ${RUN}`,
      description: 'A fixture listing.',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      status: 'active',
      categorySlugs: [],
      tags: [],
    })
    .returning({ id: listings.id });
  createdListingIds.push(row.id);
  return row.id;
}

interface Fixture {
  listingId: string;
  variantId: string;
  axisId: string;
  claimId: string;
}

/**
 * A listing, a variant, an axis and ONE claim.
 *
 * `resolution` decides the claim's starting state, because the three cases that
 * matter differ only in it: resolved-and-cited, already-violating-and-cited, and
 * plainly queued.
 */
async function makeFixture(
  label: string,
  resolution: 'resolved' | 'blocked',
  attribute: { id: string; key: string; version: number },
): Promise<Fixture> {
  const listingId = await makeListing(label);
  const [variant] = await db
    .insert(productVariants)
    .values({ listingId, title: `Variant ${label}` })
    .returning({ id: productVariants.id });
  const [axis] = await db
    .insert(nativeListingVariantAxes)
    .values({
      listingId,
      attributeDefinitionId: attribute.id,
      attributeKey: attribute.key,
      attributeDefinitionVersion: attribute.version,
    })
    .returning({ id: nativeListingVariantAxes.id });
  const [claim] = await db
    .insert(nativeVariantAttributeClaims)
    .values({
      variantId: variant.id,
      rawName: `Tono ${label}`,
      rawValue: `Negro ${label}`,
      provenance: 'legacy_option_migration',
      assertedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...(resolution === 'resolved'
        ? {
            attributeResolution: 'resolved' as const,
            valueResolution: 'resolved' as const,
            attributeDefinitionId: attribute.id,
            attributeDefinitionVersion: attribute.version,
            normalizedValue: `negro-${label}`,
          }
        : {
            // `blocked` REQUIRES a refusal (`*_refusal_shape_check`) and it may
            // NOT be `operator_refused` — that value is reserved for `refused`
            // by a biconditional in both directions.
            attributeResolution: 'blocked' as const,
            attributeRefusal: 'unmapped' as const,
            valueResolution: 'blocked' as const,
            valueRefusal: 'attribute_unresolved' as const,
          }),
    })
    .returning({ id: nativeVariantAttributeClaims.id });
  return { listingId, variantId: variant.id, axisId: axis.id, claimId: claim.id };
}

/**
 * A typed assignment citing `claimId`. Only legal while the claim is resolved.
 *
 * The signature row goes in the SAME transaction, because
 * `mercaria_native_variant_signature_agrees` is DEFERRABLE INITIALLY DEFERRED
 * and fires at COMMIT: a variant carrying assignments and no signature is
 * refused there, not at the insert. Writing both is what the production writer
 * (`replaceVariantAxisAssignments` plus its signature upsert) does, so the
 * fixture reaches the state the same way production does.
 */
async function citeClaim(
  fixture: Fixture,
  attribute: { id: string; key: string },
  displayValue: string,
): Promise<void> {
  const normalizedValue = displayValue.toLowerCase();
  await db.transaction(async (tx) => {
    await tx.insert(nativeVariantAxisAssignments).values({
      variantId: fixture.variantId,
      axisId: fixture.axisId,
      attributeDefinitionId: attribute.id,
      attributeKey: attribute.key,
      displayValue,
      normalizedValue,
      sourceClaimId: fixture.claimId,
    });
    await tx.insert(nativeVariantSignatures).values({
      variantId: fixture.variantId,
      listingId: fixture.listingId,
      signature: typedVariantSignature([
        { attributeDefinitionId: attribute.id, normalizedValue },
      ]),
      axisCount: 1,
    });
  });
}

/** Withdraw the whole assignment set, signature included — the atomic unit. */
async function clearAssignments(fixture: Fixture): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(nativeVariantAxisAssignments)
      .where(eq(nativeVariantAxisAssignments.variantId, fixture.variantId));
    await tx
      .delete(nativeVariantSignatures)
      .where(eq(nativeVariantSignatures.variantId, fixture.variantId));
  });
}

let colourAttribute: { id: string; key: string; version: number };

beforeAll(async () => {
  db = await connectPostgres();
  const [row] = await db
    .insert(attributeDefinitions)
    .values({
      key: `settle_colour_${RUN}`.toLowerCase(),
      version: ATTR_VERSION,
      lifecycleState: 'draft',
      label: 'Colour',
      valueType: 'string',
      variantDefining: true,
    })
    .returning();
  createdAttributeIds.push(row.id);
  colourAttribute = { id: row.id, key: row.key, version: row.version };
});

afterAll(async () => {
  /**
   * The audit rows are deliberately NOT deleted, and cannot be.
   *
   * `mercaria_catalog_governance_audit_append_only` refuses DELETE outright —
   * "a correction is a new event that names what it corrects" — so a teardown
   * that tried would fail every run. That is the table working as designed, and
   * `publication-impact.realdb.test.ts` leaves its rows for the same reason.
   *
   * Leaving them is safe on the shared database because every row this file
   * writes carries `actorOxyUserId = OPERATOR`, which is run-suffixed: no
   * sibling's assertion can match one, and the scoped read below is what the
   * settlement cases assert against.
   */
  if (createdListingIds.length > 0) {
    await db.delete(listings).where(inArray(listings.id, createdListingIds));
  }
  if (createdAttributeIds.length > 0) {
    await db
      .delete(attributeDefinitions)
      .where(inArray(attributeDefinitions.id, createdAttributeIds));
  }
  await closePostgres();
});

describe('the queue names the rows behind the count', () => {
  it('returns a queued claim, and reports how many assignments cite it', async () => {
    const fixture = await makeFixture('queue', 'blocked', colourAttribute);

    const view = await readAttributeClaimQueue(db, actorWith('view'), { limit: 200 });
    const mine = view.claims.find((claim) => claim.id === fixture.claimId);

    expect(mine, 'the queued claim this test just wrote is not in the queue').toBeDefined();
    expect(mine?.grain).toBe('variant');
    expect(mine?.variantId).toBe(fixture.variantId);
    expect(mine?.citingAssignmentCount).toBe(0);
    // The page and the whole-backlog figure come from one definition of
    // "queued", so the total can never be smaller than what the page shows.
    expect(view.queued).toBeGreaterThanOrEqual(view.claims.length);
    // Every bucket of both vocabularies is present whether or not a row is in
    // it — a cause with nothing in it must not look like a cause the query
    // forgot to ask about.
    expect(view.byAttributeRefusal.length).toBeGreaterThan(0);
    expect(view.byValueRefusal.length).toBeGreaterThan(0);
  });

  it('refuses a reader who holds no role at all', async () => {
    await expect(readAttributeClaimQueue(db, actorWith(), { limit: 10 })).rejects.toThrow(
      /view role/iu,
    );
  });
});

describe('settling a claim', () => {
  it('records the settlement and one audit row naming both states', async () => {
    const fixture = await makeFixture('settle-ok', 'blocked', colourAttribute);

    const settled = await settleAttributeClaim(db, actorWith('review'), {
      claimId: fixture.claimId,
      grain: 'variant',
      attributeResolution: 'resolved',
      valueResolution: 'resolved',
      attributeDefinitionId: colourAttribute.id,
      attributeDefinitionVersion: colourAttribute.version,
      normalizedValue: 'negro-settle-ok',
      reason: 'The definition was published after the claim was written.',
    });

    expect(settled.valueResolution).toBe('resolved');
    expect(settled.normalizedValue).toBe('negro-settle-ok');
    // From the CREDENTIAL and the clock, never from the request body.
    expect(settled.resolvedByOxyUserId).toBe(OPERATOR);
    expect(settled.resolvedAt).not.toBeNull();

    const audits = await db
      .select()
      .from(catalogGovernanceAuditEvents)
      .where(
        and(
          eq(catalogGovernanceAuditEvents.subjectId, fixture.claimId),
          eq(catalogGovernanceAuditEvents.action, 'attribute_claim_settle'),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0].subjectKind).toBe('native_attribute_claim');
    expect(audits[0].actorOxyUserId).toBe(OPERATOR);
    // BOTH states, because "what did this settlement change" is the question
    // the trail is read with.
    expect((audits[0].before as { valueResolution?: string }).valueResolution).toBe('blocked');
    expect((audits[0].after as { valueResolution?: string }).valueResolution).toBe('resolved');
  });

  it('refuses an actor holding only `view`', async () => {
    const fixture = await makeFixture('settle-role', 'blocked', colourAttribute);
    await expect(
      settleAttributeClaim(db, actorWith('view'), {
        claimId: fixture.claimId,
        grain: 'variant',
        attributeResolution: 'resolved',
        valueResolution: 'resolved',
        reason: 'no role',
      }),
    ).rejects.toThrow(/review role/iu);
  });
});

describe('a claim a typed assignment cites may not leave `resolved`', () => {
  it('the SERVICE refuses, naming how many assignments cite it', async () => {
    const fixture = await makeFixture('cited-service', 'resolved', colourAttribute);
    await citeClaim(fixture, colourAttribute, 'Graphite');

    await expect(
      settleAttributeClaim(db, actorWith('review'), {
        claimId: fixture.claimId,
        grain: 'variant',
        attributeResolution: 'refused',
        attributeRefusal: 'operator_refused',
        valueResolution: 'refused',
        valueRefusal: 'operator_refused',
        reason: 'Operator decided the colour claim was wrong.',
      }),
    ).rejects.toThrow(/cited by 1 typed axis assignment/iu);
  });

  it('the DATABASE refuses it too, for a caller that goes around the service', async () => {
    const fixture = await makeFixture('cited-trigger', 'resolved', colourAttribute);
    await citeClaim(fixture, colourAttribute, 'Charcoal');

    // Straight at the table. This is the case that makes the guarantee the
    // trigger's rather than the service's — without it, the invariant would
    // rest on `settleAttributeClaim` remembering to check, which is the shape
    // #576 exists to complain about.
    await expectRaise(/typed axis assignment cites this claim/iu, () =>
      db
        .update(nativeVariantAttributeClaims)
        .set({
          valueResolution: 'refused',
          valueRefusal: 'operator_refused',
          normalizedValue: null,
          resolvedByOxyUserId: OPERATOR,
          resolvedAt: new Date(),
        })
        .where(eq(nativeVariantAttributeClaims.id, fixture.claimId)),
    );
  });

  it('permits the settlement once nothing cites the claim', async () => {
    const fixture = await makeFixture('cited-released', 'resolved', colourAttribute);
    await citeClaim(fixture, colourAttribute, 'Slate');
    await clearAssignments(fixture);

    const settled = await settleAttributeClaim(db, actorWith('review'), {
      claimId: fixture.claimId,
      grain: 'variant',
      attributeResolution: 'refused',
      attributeRefusal: 'operator_refused',
      valueResolution: 'refused',
      valueRefusal: 'operator_refused',
      reason: 'The assignment set was recomputed first.',
    });
    expect(settled.valueResolution).toBe('refused');
  });
});

describe('a pre-existing violator stays repairable', () => {
  /**
   * The fixture reaches the violating state the way `0104` says production did:
   * the assignment is written while the claim is `resolved`, and the claim is
   * then moved with the trigger momentarily disabled — the ONE table this file
   * toggles, inside a transaction, as the shared-database rule requires.
   *
   * NOTE: this case does NOT discriminate the transition guard from the naive
   * one, and it was mutation-tested to find that out — the naive
   * `new.value_resolution <> 'resolved'` form permits the repair too, because
   * `new` IS `resolved` here. The pair that tells them apart is the next case.
   * Kept because "a violator can be repaired" is a real property worth pinning
   * on its own; it is simply not evidence for the shape of the clause.
   */
  it('settles an already-violating cited claim back TO resolved', async () => {
    const fixture = await makeFixture('legacy', 'resolved', colourAttribute);
    await citeClaim(fixture, colourAttribute, 'Legacy');

    await db.transaction(async (tx) => {
      await tx.execute(
        'alter table native_variant_attribute_claims disable trigger mercaria_native_variant_claim_frozen',
      );
      await tx
        .update(nativeVariantAttributeClaims)
        .set({ valueResolution: 'blocked', valueRefusal: 'attribute_unresolved', normalizedValue: null })
        .where(eq(nativeVariantAttributeClaims.id, fixture.claimId));
      await tx.execute(
        'alter table native_variant_attribute_claims enable trigger mercaria_native_variant_claim_frozen',
      );
    });

    // The state `0104` recorded: an assignment carrying a typed value while its
    // own citation resolved to nothing.
    const [before] = await db
      .select()
      .from(nativeVariantAttributeClaims)
      .where(eq(nativeVariantAttributeClaims.id, fixture.claimId));
    expect(before.valueResolution).toBe('blocked');

    const repaired = await settleAttributeClaim(db, actorWith('review'), {
      claimId: fixture.claimId,
      grain: 'variant',
      attributeResolution: 'resolved',
      valueResolution: 'resolved',
      attributeDefinitionId: colourAttribute.id,
      attributeDefinitionVersion: colourAttribute.version,
      normalizedValue: 'legacy-repaired',
      reason: 'Repairing a pre-0104 violator.',
    });

    expect(repaired.valueResolution).toBe('resolved');
    expect(repaired.normalizedValue).toBe('legacy-repaired');
  });

  /**
   * THE case that tells the two spellings apart, and the reason the clause reads
   * `old.value_resolution = 'resolved' and ...` rather than testing `new` alone.
   *
   * Enumerated over all sixteen (old, new) pairs on a cited claim, the two forms
   * disagree on NINE — every pair where both are non-resolved. `blocked ->
   * refused` is one of them: an operator deciding that a claim whose assignment
   * is ALREADY wrong should be recorded as refused. The transition form permits
   * it; the naive form refuses it and freezes the violator into "resolve it or
   * never touch it again".
   *
   * The mutation self-test below proves it discriminates, and it has to run
   * INSIDE this database: the harness gives each suite run its own throwaway,
   * so mutating the developer's `mercaria_dev` measures nothing at all — which
   * is exactly what a first attempt at this did, reporting a survived mutation
   * that had never been applied to the database under test.
   */
  it('settles an already-violating cited claim to `refused` (the discriminating pair)', async () => {
    const fixture = await makeFixture('violator-refuse', 'resolved', colourAttribute);
    await citeClaim(fixture, colourAttribute, 'Violator');

    await db.transaction(async (tx) => {
      await tx.execute(
        'alter table native_variant_attribute_claims disable trigger mercaria_native_variant_claim_frozen',
      );
      await tx
        .update(nativeVariantAttributeClaims)
        .set({
          valueResolution: 'blocked',
          valueRefusal: 'attribute_unresolved',
          normalizedValue: null,
        })
        .where(eq(nativeVariantAttributeClaims.id, fixture.claimId));
      await tx.execute(
        'alter table native_variant_attribute_claims enable trigger mercaria_native_variant_claim_frozen',
      );
    });

    const refused = await settleAttributeClaim(db, actorWith('review'), {
      claimId: fixture.claimId,
      grain: 'variant',
      attributeResolution: 'refused',
      attributeRefusal: 'operator_refused',
      valueResolution: 'refused',
      valueRefusal: 'operator_refused',
      reason: 'The claim was wrong; the assignment set is recomputed separately.',
    });

    expect(refused.valueResolution).toBe('refused');
  });

  /**
   * The self-test: with the NAIVE form installed, this exact pair is refused.
   *
   * DDL is transactional in PostgreSQL, so the function is replaced, the pair is
   * attempted, and the ROLLBACK restores the shipped clause — nothing leaks to a
   * sibling file. `graph-plan-regression.realdb.test.ts` drops an index inside a
   * transaction for the same reason.
   *
   * Without this, "the clause is written as a transition on purpose" is a claim
   * in a comment. With it, the nine disagreeing pairs are one measured example.
   */
  it('MUTATION: the naive state form refuses the pair this one permits', async () => {
    const fixture = await makeFixture('mutant', 'resolved', colourAttribute);
    await citeClaim(fixture, colourAttribute, 'Mutant');
    await db.transaction(async (tx) => {
      await tx.execute(
        'alter table native_variant_attribute_claims disable trigger mercaria_native_variant_claim_frozen',
      );
      await tx
        .update(nativeVariantAttributeClaims)
        .set({
          valueResolution: 'blocked',
          valueRefusal: 'attribute_unresolved',
          normalizedValue: null,
        })
        .where(eq(nativeVariantAttributeClaims.id, fixture.claimId));
      await tx.execute(
        'alter table native_variant_attribute_claims enable trigger mercaria_native_variant_claim_frozen',
      );
    });

    let refusedByMutant = false;
    await db
      .transaction(async (tx) => {
        // The naive form: tests `new` alone, with no reference to `old`.
        await tx.execute(`
          create or replace function mercaria_native_variant_claim_frozen()
          returns trigger language plpgsql as $mutant$
          begin
            if new.value_resolution is distinct from 'resolved'
               and exists (
                 select 1 from native_variant_axis_assignments a
                  where a.source_claim_id = old.id
               )
            then
              raise exception 'mutant refused' using errcode = 'raise_exception';
            end if;
            return new;
          end;
          $mutant$;
        `);
        try {
          await tx
            .update(nativeVariantAttributeClaims)
            .set({
              valueResolution: 'refused',
              valueRefusal: 'operator_refused',
              resolvedByOxyUserId: OPERATOR,
              resolvedAt: new Date(),
            })
            .where(eq(nativeVariantAttributeClaims.id, fixture.claimId));
        } catch (error: unknown) {
          // The MUTANT's own message, not merely "something threw". A bare catch
          // would be satisfied by a fixture typo or a CHECK violation and would
          // report a discrimination that never happened.
          const cause = (error as { cause?: { message?: string } }).cause;
          const message = String(cause?.message ?? (error as Error).message);
          if (!/mutant refused/u.test(message)) throw error;
          refusedByMutant = true;
        }
        // Roll back BOTH the mutant function and anything it let through.
        throw new Error('rollback');
      })
      .catch((error: unknown) => {
        if ((error as Error).message !== 'rollback') throw error;
      });

    expect(
      refusedByMutant,
      'the naive form accepted the pair too, so this case does not discriminate the two spellings',
    ).toBe(true);

    // And the shipped clause is back, unharmed by the rolled-back DDL.
    const [restored] = await db.execute<{ transition: boolean }>(
      `select prosrc like '%old.value_resolution%' as transition
         from pg_proc where proname = 'mercaria_native_variant_claim_frozen'`,
    );
    expect(restored.transition, 'the rollback did not restore the shipped clause').toBe(true);
  });
});

describe('the reverse door: an assignment may not cite a claim that did not resolve', () => {
  /**
   * `0104`'s own trigger, in the direction `0123` does not cover.
   *
   * Asserting it here is what makes "the two triggers are a complete pair" a
   * measurement rather than a claim in a migration header — the assignment side
   * is `BEFORE INSERT OR UPDATE`, so every write on that table is covered and
   * `0123` only has to cover the claim moving underneath it.
   */
  it('refuses an INSERT citing a blocked claim', async () => {
    const fixture = await makeFixture('reverse', 'blocked', colourAttribute);
    await expectRaise(/cannot support a typed value/iu, () =>
      citeClaim(fixture, colourAttribute, 'Unsupported'),
    );
  });
});

describe('the freeze guard survived the CREATE OR REPLACE', () => {
  /**
   * `0123` reproduces the assertion-immutability body by hand in order to add a
   * clause beside it, and a hand-copied trigger body is exactly where a guard
   * goes missing silently — it would still compile, still apply, and refuse
   * nothing.
   */
  it('still refuses a rewrite of what the party asserted', async () => {
    const fixture = await makeFixture('frozen', 'blocked', colourAttribute);
    await expectRaise(/what a party asserted is immutable/iu, () =>
      db
        .update(nativeVariantAttributeClaims)
        .set({ rawValue: 'Rewritten' })
        .where(eq(nativeVariantAttributeClaims.id, fixture.claimId)),
    );
  });
});
