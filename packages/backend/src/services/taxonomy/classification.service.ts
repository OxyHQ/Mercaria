/**
 * Secondary category classification — the service (#367 Workstream 1).
 *
 * Thin on purpose. Every rule this domain has is held by the database
 * (`drizzle/0134_red_silver_fox.sql`), for two reasons that both matter:
 *
 *  - each one is a fact about a row the writing statement is NOT writing — the
 *    category's lifecycle and selectability, the subject's own primary — so a
 *    service check is check-then-act on a shared server and two concurrent
 *    requests defeat it;
 *  - a rule stated twice is a rule that can disagree with itself, and the half
 *    that loses is always the one further from the data.
 *
 * What is left for a service is the part a constraint cannot do: turn a
 * refusal into a SENTENCE a caller can act on. `translateRefusal` is that and
 * nothing else — it adds no rule, and if it stopped running the writes would
 * still be refused, just with a 500.
 *
 * ## Why the refusal text is matched, and what makes that safe here
 *
 * Constraint names are truncated by Postgres at 63 characters, so
 * `canonical_product_secondary_categories_justification_present_check` is
 * STORED as `..._justification_present_ch`. Keying on a full name would match
 * nothing, silently, and produce the generic 500 this function exists to
 * prevent — so the match is on a PREFIX of the stored name.
 *
 * The trigger refusals are matched on SQLSTATE plus a substring of the message
 * the trigger itself raises. That is weaker than a constraint name and it is
 * the only handle a `RAISE EXCEPTION` gives.
 *
 * ## Which branches a CLIENT can actually reach, stated rather than implied
 *
 * Not all of them, and an earlier version of this comment claimed a real-server
 * test drove "every constraint", which was not true and would have read as
 * coverage. Through `/internal/taxonomy/*` the reachable refusals are: the
 * unique index (a repeat filing), the foreign key (an unknown category), and
 * every `restrict_violation` — selectability, kinship, assignable lifecycle,
 * and a subject with no primary. Each of those IS driven over HTTP by
 * `routes/__tests__/taxonomy-classification.realdb.test.ts`, so a reworded
 * trigger or a rotted prefix fails the suite.
 *
 * The four CHECK branches are NOT reachable through the route, because the
 * request schema and `recordSecondaryClassification`'s own scheme/reason test
 * refuse those bodies first. They are kept as defence in depth for a caller
 * that is not the route — a script, a future service, a repair — and they are
 * proved to FIRE by direct-SQL cases that bypass this function entirely. What
 * is not proved is the sentence each returns, and that is the honest state.
 */

import { constraintNameOf, sqlStateOf } from '@oxyhq/db';
import type {
  ClassificationSubjectKind,
  ProductClassification,
  SecondaryClassification,
} from '@mercaria/shared-types';
import {
  SECONDARY_CLASSIFICATION_ASSIGNABLE_LIFECYCLES,
  secondaryClassificationRequiresScheme,
} from '@mercaria/shared-types';
import {
  countSecondaryClassificationsByCategory,
  deleteSecondaryClassification,
  findProductClassification,
  insertSecondaryClassification,
  type NewSecondaryClassification,
} from '../../db/taxonomy/classificationRepository.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';

/** SQLSTATE `23514` — a CHECK refused the row. */
const CHECK_VIOLATION = '23514';
/** SQLSTATE `23505` — a unique index refused the row. */
const UNIQUE_VIOLATION = '23505';
/** SQLSTATE `23503` — a foreign key refused the row. */
const FOREIGN_KEY_VIOLATION = '23503';
/**
 * SQLSTATE `23001`, which is what `USING ERRCODE = 'restrict_violation'`
 * actually produces — every guard in `0134` raises it, as does the pre-existing
 * `mercaria_category_assignment_selectable`.
 *
 * The NUMBER and not the condition NAME. `RAISE … USING ERRCODE` accepts either
 * spelling and Postgres reports the five-character code, so matching on
 * `'restrict_violation'` compiles, reads correctly, and matches nothing — every
 * trigger refusal then falls through to a 500. Measured: five cases in
 * `taxonomy-classification.realdb.test.ts` went 500 on exactly that, which is
 * why they assert the STATUS and not just "it was refused".
 */
const RESTRICT_VIOLATION = '23001';

/** How far down a `cause` chain to look. `@oxyhq/db`'s own depth, for its reason. */
const MAX_CAUSE_DEPTH = 8;

/**
 * Every message in the error's `cause` chain, joined.
 *
 * NOT `error.message`. Drizzle wraps a driver failure and its own message is
 * `Failed query: insert into "listing_secondary_categories" …` — the STATEMENT,
 * never the server's text. A trigger's `RAISE EXCEPTION` text lives on the
 * postgres.js error underneath, exactly where `sqlStateOf` and
 * `constraintNameOf` already look for their fields.
 *
 * This was a live defect: matching `error.message` compiled, read correctly,
 * and matched nothing, so all five trigger refusals fell through to a 500 while
 * the CHECK and unique refusals — which key on `constraintNameOf`, and therefore
 * already read through the chain — passed. The half that worked is what made it
 * look like the mechanism was fine.
 */
function driverMessage(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < MAX_CAUSE_DEPTH; depth += 1) {
    parts.push(current.message);
    current = Reflect.get(current, 'cause');
  }
  return parts.join('\n');
}

/**
 * Turn a database refusal into a domain error.
 *
 * Rethrows anything it does not recognise, deliberately: swallowing an
 * unrecognised failure into a plausible 409 is how a real fault — a dropped
 * connection, an exhausted pool — gets reported to a caller as their own
 * mistake, and then never investigated.
 */
function translateRefusal(error: unknown, subjectKind: ClassificationSubjectKind): never {
  const state = sqlStateOf(error);
  const constraint = constraintNameOf(error) ?? '';
  const message = driverMessage(error);

  if (state === UNIQUE_VIOLATION) {
    throw conflict(
      `This ${subjectLabel(subjectKind)} already carries a secondary classification under that category. ` +
        'Withdraw the existing one to replace it, so the justification on the record is the one somebody decided.',
    );
  }

  if (state === FOREIGN_KEY_VIOLATION) {
    throw notFound('The category or the subject does not exist.');
  }

  if (state === CHECK_VIOLATION) {
    // Prefixes, because Postgres truncates a constraint name at 63 characters
    // and two of these are longer than that.
    if (constraint.startsWith('listing_secondary_categories_justification_present')) {
      throw validationError('A justification is required and may not be blank.');
    }
    if (constraint.startsWith('canonical_product_secondary_categories_justification_present')) {
      throw validationError('A justification is required and may not be blank.');
    }
    if (constraint.includes('justified_by_present')) {
      throw validationError('A secondary classification must name the account that filed it.');
    }
    if (constraint.includes('scheme_ref_check')) {
      throw validationError(
        'A scheme reference is required for exactly these reasons, and forbidden for the others: ' +
          'a scheme has a name and a judgement does not.',
      );
    }
    if (constraint.includes('reason_check')) {
      throw validationError('That is not a reason a secondary classification may cite.');
    }
  }

  if (state === RESTRICT_VIOLATION) {
    if (message.includes('is not selectable')) {
      throw validationError(
        'That category is a structural node and no product may be filed under it (ADR 0007 D2).',
      );
    }
    if (message.includes('has no primary category')) {
      throw conflict(
        `This ${subjectLabel(subjectKind)} has no primary category, so there is nothing for a secondary ` +
          'classification to be secondary to. Set the primary category first.',
      );
    }
    if (message.includes('which the tree already implies')) {
      throw validationError(
        'That category is the primary category, or its ancestor or descendant. The hierarchy already ' +
          'implies it, so filing it again would claim a decision nobody had to make.',
      );
    }
    if (message.includes('its lifecycle is')) {
      throw validationError(
        'That category may no longer take new classifications. Assignable lifecycles are: ' +
          `${SECONDARY_CLASSIFICATION_ASSIGNABLE_LIFECYCLES.join(', ')}.`,
      );
    }
    if (message.includes('cannot clear its primary category')) {
      throw conflict(
        'This subject carries secondary classifications, so its primary category cannot be cleared. ' +
          'Withdraw them first.',
      );
    }
    if (message.includes('Remove the secondary first')) {
      throw conflict(
        'The requested primary category collides with one of this subject’s secondary ' +
          'classifications. Withdraw the secondary first.',
      );
    }
  }

  throw error;
}

/** How a subject is named in a message a person reads. */
function subjectLabel(subjectKind: ClassificationSubjectKind): string {
  return subjectKind === 'listing' ? 'listing' : 'canonical product';
}

/**
 * Record one secondary classification.
 *
 * The ONE thing checked before the write is the scheme/reason pairing, and it
 * is checked here as well as at the row because the two answer different
 * questions: the CHECK guarantees no such row can EXIST, while this gives the
 * caller a message naming which half is wrong before a round trip. The
 * database remains the authority — a real-server test writes the forbidden
 * pairing directly, past this function, and asserts the CHECK refuses it.
 */
export async function recordSecondaryClassification(
  input: NewSecondaryClassification,
): Promise<SecondaryClassification> {
  const needsScheme = secondaryClassificationRequiresScheme(input.reason);
  const hasScheme = typeof input.schemeRef === 'string' && input.schemeRef.trim().length > 0;

  if (needsScheme && !hasScheme) {
    throw validationError(
      `A ${input.reason} classification must cite the scheme it relies on, in schemeRef.`,
    );
  }
  if (!needsScheme && hasScheme) {
    throw validationError(
      `A ${input.reason} classification is Mercaria’s own judgement and cites no external scheme, ` +
        'so schemeRef must be omitted.',
    );
  }

  try {
    return await insertSecondaryClassification(input);
  } catch (error) {
    translateRefusal(error, input.subjectKind);
  }
}

/** Withdraw one. A subject or category that carries none is a 404. */
export async function withdrawSecondaryClassification(
  subjectKind: ClassificationSubjectKind,
  subjectId: string,
  categoryId: string,
): Promise<void> {
  const removed = await deleteSecondaryClassification(subjectKind, subjectId, categoryId);
  if (!removed) {
    throw notFound('No secondary classification under that category for this subject.');
  }
}

/** Everything filed about one subject. A subject that does not exist is a 404. */
export async function readProductClassification(
  subjectKind: ClassificationSubjectKind,
  subjectId: string,
): Promise<ProductClassification> {
  const classification = await findProductClassification(subjectKind, subjectId);
  if (!classification) {
    throw notFound(`No such ${subjectLabel(subjectKind)}.`);
  }
  return classification;
}

/** How many subjects name this category as a SECONDARY, by subject kind. */
export async function readCategoryClassificationUsage(
  categoryId: string,
): Promise<{ readonly listings: number; readonly canonicalProducts: number }> {
  return countSecondaryClassificationsByCategory(categoryId);
}
