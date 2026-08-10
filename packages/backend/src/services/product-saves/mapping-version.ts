/**
 * The #80 favorite→product-save mapping version.
 *
 * A CODE constant and deliberately not a table — the #60 backfill's
 * `CATALOG_BACKFILL_MAPPING_VERSION` decision, for its reason: the mapping is a
 * PROCEDURE (which listing favorites are read, how a listing resolves to a
 * canonical product, what "confident" means), so a version somebody could
 * publish from an operator surface would name rules nobody had shipped.
 *
 * It appears in two places and they are the same value on purpose:
 * `product_saves.migration_version` on every save the migration created, and
 * `product_save_sources.migration_version` on the record of the favorite it was
 * read from. `UNIQUE(favorite_id, migration_version)` is what lets a genuinely
 * NEW mapping re-examine a favorite an old one skipped, without a replay of the
 * old one ever writing twice.
 *
 * Bump it when the RULES change — a different confidence threshold, a different
 * source of the canonical attachment, a decision to migrate pins. Do not bump it
 * for a bug fix that leaves the rules the same: that would re-run the whole
 * catalogue and re-record every favorite for no change in outcome.
 */
import { NATIVE_LISTING_LINK_METHODS, type NativeListingLinkMethod } from '@mercaria/shared-types';

export const PRODUCT_SAVE_MIGRATION_VERSION = '2026-08-10.1';

/**
 * The link methods a migration may read as a CONFIDENT canonical mapping (#80
 * migration rule 1).
 *
 * Named as a set rather than tested inline, because "confident" is the whole of
 * migration rules 1 and 3 — a listing whose attachment is not in this set stays
 * a listing save and is NEVER given a product save (#80 acceptance 3), and the
 * rule that decides which is which has to be readable in one place.
 *
 * `matcher` is deliberately EXCLUDED even at high confidence. #58 routes a
 * heuristic attachment to #59's review queue precisely because nobody has agreed
 * it yet, and a save silently created from an unreviewed guess is a false merge
 * with a person's intent attached — the failure mode #58's own header describes,
 * one layer up. A `matcher` link an operator later confirms arrives here as
 * `operator`, and the buyer's favorite is still there waiting for it.
 *
 * ## `seller_declared` (#91) is CONFIDENT, and that is a decision rather than an
 * omission
 *
 * #91 added a sixth method, so this exclusion list had to be re-read rather than
 * left alone — which is exactly what the subtraction below exists to force. The
 * answer is that it stays out of this list, for a reason that does not apply to
 * `matcher`: an attachment written by the "Sell yours" flow is a NAMED person
 * asserting, about their own item, on a surface that showed them the product,
 * with `services/sell-yours/match-gate.ts` having refused to write it if a valid
 * identifier, the brand, the pack count, the category, a bundle relation or an
 * operator's own rejection disagreed. Somebody HAS agreed it, which is the whole
 * of what `matcher` lacks. `sell-yours/__tests__/link-method-confidence.test.ts`
 * pins the classification so it cannot quietly flip either way.
 */
export const UNCONFIDENT_LINK_METHODS: readonly NativeListingLinkMethod[] = ['matcher'];

/**
 * Derived from `NATIVE_LISTING_LINK_METHODS` by SUBTRACTION rather than listed
 * out, so a method #58 adds later is confident-by-omission never — it lands in
 * this set only if somebody also removes it from the exclusion above, and the
 * exhaustive union means `tsc` names it either way.
 */
export const CONFIDENT_LINK_METHODS: readonly NativeListingLinkMethod[] =
  NATIVE_LISTING_LINK_METHODS.filter((method) => !UNCONFIDENT_LINK_METHODS.includes(method));
