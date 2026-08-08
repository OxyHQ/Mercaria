/**
 * Every request schema that shape-checks an ENTITY ID accepts both id shapes.
 *
 * ## Why this is a regression test and not a validation one
 *
 * A Mercaria primary key is `text` holding a 24-char ObjectId hex for every row
 * that survived the Postgres cutover and a uuid v7 for every row created since —
 * both live, both permanent. `isLiveEntityId` (`@oxyhq/db`) is the one predicate
 * that knows that, and `validate.ts` already routes every path param through it.
 *
 * A hand-written `/^[a-f\d]{24}$/` in a BODY schema looks identical in review and
 * is not: it rejects the uuid v7 half, as a 400 on a resource that exists. Two of
 * them shipped that way — `connectionId` on the channel-key mint and
 * `targetLocationId` on the sync-settings patch — so every id a merchant could
 * have created since the cutover failed validation at the edge, with a message
 * ("Must be a valid connection id") that blames the client.
 *
 * The failure is invisible to a suite whose fixtures are all 24-hex, which is why
 * each case below asserts BOTH shapes: a fixture on only one side of the
 * distinction cannot tell the strict pattern from the correct predicate.
 */

import { describe, it, expect } from 'vitest';
import { uuidv7 } from '@oxyhq/db';
import { generateChannelKeySchema } from '../channels-schemas.js';
import { updateSyncSettingsSchema } from '../schemas.js';

/** A row that survived the cutover keeps its 24-char ObjectId hex forever. */
const OBJECT_ID = '507f1f77bcf86cd799439011';

describe.each([
  [
    'generateChannelKeySchema.connectionId',
    (id: string) => generateChannelKeySchema.safeParse({ label: 'Register', connectionId: id }),
  ],
  [
    'updateSyncSettingsSchema.targetLocationId',
    (id: string) => updateSyncSettingsSchema.safeParse({ targetLocationId: id }),
  ],
])('%s', (_name, parse) => {
  it('accepts a 24-char ObjectId hex — the pre-cutover shape', () => {
    expect(parse(OBJECT_ID).success).toBe(true);
  });

  it('accepts a uuid v7 — the shape every id minted since the cutover has', () => {
    expect(parse(uuidv7()).success).toBe(true);
  });

  it('still refuses a malformed id', () => {
    // The check earns its 400 only if it rejects something: a bare word, a v4
    // (nothing here generates one), and a hex string of the wrong length.
    expect(parse('not-an-id').success).toBe(false);
    expect(parse('f81d4fae-7dec-41d0-a765-00a0c91e6bf6').success).toBe(false);
    expect(parse('507f1f77bcf86cd79943901').success).toBe(false);
  });
});
