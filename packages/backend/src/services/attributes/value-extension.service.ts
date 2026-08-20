/**
 * Adding one controlled value to an attribute the registry already owns (#568).
 *
 * This is the ATTRIBUTES domain's seam for a caller that has approved a value
 * and needs it to land somewhere legal. It exists because a published version is
 * immutable — `mercaria_attribute_enum_frozen` raises `restrict_violation` for
 * any parent whose `lifecycle_state <> 'draft'`, and its own message names the
 * remedy: "publish a new version instead".
 *
 * ## Why this is a function HERE and not four calls at the call site
 *
 * The caller that needs it is `catalog-proposals/review.service.ts`, and
 * `catalog-proposal-isolation.test.ts` holds that domain to writing exactly one
 * catalogue table. Drafting a version means inserting an `attribute_definitions`
 * row, which is a write that domain may not perform — so it asks the domain that
 * owns the table to perform it, rather than an exception being carved into the
 * wall. The wall stays absolute and nobody has to keep an exemption true.
 *
 * ## What makes a NEW attribute unrepresentable here
 *
 * {@link addControlledValueToAttribute} takes an existing definition's **id**
 * and there is no `key` parameter anywhere in its signature. The key it operates
 * on is read from the stored row, so a caller cannot conjure an attribute that
 * did not exist — not by passing a name, not by passing a fabricated row, and
 * not by getting an argument order wrong. That is #568's narrowing stated as a
 * shape: a merchant proposal may extend a vocabulary an operator published, and
 * may not invent one.
 *
 * ## Where the value lands, in one rule
 *
 * **Into the key's LATEST version when that version is still `draft`; otherwise
 * into a new version drafted from the ACTIVE one.**
 *
 * The second half is #568's requirement. The first half is what stops the second
 * from losing data, and it is not an edge case — a review queue's normal shape is
 * several approvals before anybody publishes. Drafting from the ACTIVE version
 * every time gives version N+1 carrying the first value and N+2 carrying only the
 * second, because both were built from N; publishing N+2 then silently discards
 * an approval somebody made. There is no partial unique forbidding two drafts of
 * one key, so nothing in the database would have caught it.
 */

import type { DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findAttributeDefinitionById,
  insertAttributeEnumValue,
  insertAttributeValueAlias,
  listAttributeDefinitionVersions,
  listAttributeEnumValues,
} from '../../db/attributes/definitionRepository.js';
import { conflict, validationError } from '../../lib/errors/error-codes.js';
import { normalizeOptionValue } from '../canonical/variant-signature.js';
import { draftAttributeDefinition, resolveActiveDefinition } from './definition-registry.service.js';
import { buildNextVersionInput } from './version-carry-forward.js';

/** One controlled value being added, as the deciding operator settled it. */
export interface ControlledValueAddition {
  /** The OPERATOR's machine key. Normalized here, so one spelling reaches storage. */
  readonly value: string;
  readonly label: string;
  /** Spellings that should resolve to it — the submitter's own, typically. */
  readonly aliases?: readonly string[];
}

/**
 * WHERE the value landed, which is the whole of what this function answers.
 *
 * It deliberately does NOT report whether the value is live. That is the
 * version's `lifecycle_state`, it moves later and in another domain, and a copy
 * returned here would be a second representation of it — already capable of
 * being stale by the time a caller renders it. Readers derive it instead;
 * `catalog-proposals/publication.ts` does exactly that, per read.
 */
export interface ControlledValuePlacement {
  readonly enumValueId: string;
  /** The `attribute_definitions` row it went into — a VERSION, not the key. */
  readonly definitionId: string;
  readonly version: number;
}

/**
 * Add `addition` to the attribute `existingDefinitionId` belongs to.
 *
 * `existingDefinitionId` names any version of the attribute — typically the one
 * a proposal cited, which may since have been superseded. What is extended is
 * the KEY, resolved from that row, never the version that was named: carrying a
 * superseded version forward would discard everything published since.
 *
 * Runs entirely on the handle it is given, so it composes into a caller's
 * transaction. Opening its own would be the #59 merge-runner deadlock — a second
 * connection writing rows the caller's transaction holds locks on, which presents
 * as a hang with no error.
 */
export async function addControlledValueToAttribute(
  db: DatabaseOrTransaction,
  existingDefinitionId: string,
  addition: ControlledValueAddition,
  actorOxyUserId: string,
): Promise<ControlledValuePlacement> {
  const cited = await findAttributeDefinitionById(db, existingDefinitionId);
  if (cited === undefined) {
    throw validationError('That attribute definition no longer exists.');
  }

  const value = normalizeOptionValue(addition.value);
  const label = addition.label.trim();
  if (value.length === 0) throw validationError('A controlled value needs a key.');
  if (label.length === 0) throw validationError('A controlled value needs a label.');

  // Newest first, so `[0]` is the latest version whatever its lifecycle.
  const versions = await listAttributeDefinitionVersions(db, cited.key);
  const latest = versions[0];
  if (latest === undefined) {
    throw validationError('That attribute definition no longer exists.');
  }

  if (latest.lifecycleState === 'draft') {
    return placeInDraft(db, latest, value, label, addition.aliases ?? []);
  }

  const active = await resolveActiveDefinition(db, cited.key);
  if (active === undefined) {
    // Every version is deprecated or retired. Extending one would produce a
    // version of an attribute nobody is reading values under, and reviving it is
    // a registry decision rather than a consequence of approving a value.
    throw conflict(
      `“${cited.key}” has no active version to extend. Publish one, then approve this.`,
    );
  }
  if (active.enumValues.some((existing) => existing.value === value)) {
    throw conflict(
      `“${value}” is already a value of “${cited.key}”. Merge this proposal into it instead.`,
    );
  }

  // Carried forward WITHOUT the addition, which is then inserted by the one path
  // below. Passing it here as well would insert it through
  // `draftAttributeDefinition`, whose enum insert swallows a conflict silently
  // (`if (!stored) continue`) — so a collision would produce a new version, no
  // value, and no error.
  const drafted = await draftAttributeDefinition(
    buildNextVersionInput(active, [], actorOxyUserId),
    db,
  );
  const draftedRow = await findAttributeDefinitionById(db, drafted.id);
  if (draftedRow === undefined) {
    throw new Error(`Drafted ${cited.key} v${drafted.version} and could not read it back.`);
  }
  return placeInDraft(db, draftedRow, value, label, addition.aliases ?? []);
}

/** The ONE insert path, so both cases place a value and its aliases identically. */
async function placeInDraft(
  db: DatabaseOrTransaction,
  target: { readonly id: string; readonly key: string; readonly version: number },
  value: string,
  label: string,
  aliases: readonly string[],
): Promise<ControlledValuePlacement> {
  const existing = await listAttributeEnumValues(db, [target.id]);
  if (existing.some((row) => row.value === value)) {
    throw conflict(
      `“${value}” is already a value of “${target.key}”. Merge this proposal into it instead.`,
    );
  }

  // Appended, never interleaved: a position is what a merchant's form renders by,
  // and reordering would move every option under somebody who asked to add one.
  const position = existing.reduce((highest, row) => Math.max(highest, row.position), -1) + 1;
  const inserted = await insertAttributeEnumValue(db, target.id, value, label, position);
  if (inserted === undefined) {
    // `ON CONFLICT DO NOTHING` fired despite the read above, so another
    // transaction inserted the same value between the two. Converging on it
    // would report success for somebody else's write.
    throw conflict(`“${value}” was added to “${target.key}” concurrently. Re-read and decide.`);
  }

  for (const alias of aliases) {
    // Best-effort by shape: `ON CONFLICT DO NOTHING`, because an alias already
    // pointing at ANOTHER value is a fact this must not overwrite.
    await insertAttributeValueAlias(db, {
      attributeDefinitionId: target.id,
      enumValueId: inserted.id,
      alias,
    });
  }

  return { enumValueId: inserted.id, definitionId: target.id, version: target.version };
}
