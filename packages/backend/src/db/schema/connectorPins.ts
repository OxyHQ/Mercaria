/**
 * `listing_pin_releases` — who stopped holding a connector-pinned field, and
 * when (#427).
 *
 * ## Why the release needs a row when the pin itself does not
 *
 * `listings.overridden_fields` is a bare `text[]`, and the presence of a key in
 * it IS the record that a merchant took that field over — implicit, unattributed
 * and good enough, because the fact survives in the column for as long as it is
 * true. A RELEASE has the opposite shape: it removes the key, so it destroys the
 * only evidence that the pin ever existed. Afterwards the platform's next sync
 * overwrites a title somebody wrote by hand, and nothing anywhere connects that
 * to a person pressing a control weeks earlier — the listing looks exactly like
 * one that was never pinned at all.
 *
 * That is the direction this area keeps failing in, so the act that erases the
 * state is the act that gets written down. `staff` holds `products:write`, so
 * the answer to "who let the platform take my product description back" has to
 * be answerable and cannot be inferred from anything else in the schema.
 *
 * ## Append-only, with the DELETE exception `listing_condition_revisions` uses
 *
 * UPDATE is refused outright: a trail that can be edited afterwards is a second
 * mutable copy of the current state, not a trail. DELETE is refused only while
 * the listing still exists, so the `cascade` this table's own foreign key
 * declares keeps working and an operator still cannot remove one row to hide it.
 *
 * ## One row per key ACTUALLY removed
 *
 * Not one per request. A release is idempotent — releasing a key that is no
 * longer held removes nothing — and recording the attempt would make a retry, a
 * double tap or two dashboards converging on one state look like three separate
 * decisions. The writer derives the set from the difference the UPDATE itself
 * returned, so a converging repeat writes nothing at all.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId } from '@oxyhq/db';
import { listings } from './catalog';

export const listingPinReleases = pgTable(
  'listing_pin_releases',
  {
    id: generatedId(),
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    /**
     * The `overridden_fields` key that stopped being held.
     *
     * Plain `text` with no CHECK against `PINNABLE_CONNECTOR_FIELDS`, and that
     * is deliberate rather than an omission: the column it releases from is a
     * bare `text[]` that can hold a key no merchant edit writes, and a release
     * that could not reach one would leave it stuck forever. A CHECK here would
     * make the unreachable case unrecordable too — the audit trail refusing
     * exactly the release that most needs explaining.
     */
    field: text().notNull(),
    /** An Oxy account id — a foreign service's primary key, so no foreign key. */
    releasedByOxyUserId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('listing_pin_releases_field_check', sql`length(btrim(${t.field})) > 0`),
    index('listing_pin_releases_listing_id_created_at_idx').on(t.listingId, t.createdAt.desc()),
  ],
);
