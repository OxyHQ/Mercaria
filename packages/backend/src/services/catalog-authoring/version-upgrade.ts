/**
 * What moving a record from one product-type version to a newer one would do
 * (#367 step 5, ADR 0007 D10).
 *
 * PURE. No database, no repository, no clock. It takes the two versions' fields
 * and the keys the record has actually answered, and returns a DESCRIPTION —
 * which is the whole of ADR 0007 D10's rule that a newer schema version produces
 * a preview and never a silent rewrite.
 *
 * ## Why it is a module rather than a loop inside `previewDraftUpgrade`
 *
 * A DRAFT and a published LISTING answer the same question — "what would this
 * newer version change about what I have already recorded" — against the same
 * two `product_type_fields` sets. It was written once, inside
 * `previewDraftUpgrade`, and #587's listing twin needed exactly it; copying the
 * loop would have been two statements of one rule, and the direction they drift
 * in is the flattering one, because a preview that under-reports looks like a
 * safe upgrade.
 *
 * ## The comparison grain is (attribute key), not the field id
 *
 * A `product_type_fields` row is minted per VERSION, so comparing by id reports
 * every field as removed and re-added — true, and useless. The caller supplies
 * the fields for ONE flow, because a field set is genuinely per flow.
 */

import type {
  AuthoringUpgradeChange,
  ProductTypeFieldRequirement,
} from '@mercaria/shared-types';

/** As much of a `product_type_fields` row as the comparison reads. */
export interface UpgradeComparableField {
  readonly attributeKey: string;
  readonly attributeDefinitionVersion: number;
  readonly requirement: ProductTypeFieldRequirement;
}

/** What the comparison found. */
export interface VersionUpgradeComparison {
  readonly changes: readonly AuthoringUpgradeChange[];
  /** Whether any change would drop or invalidate something already recorded. */
  readonly losesAnswers: boolean;
}

/**
 * Compare two versions' fields for one flow.
 *
 * `answeredKeys` is what the record has actually recorded. It is what turns a
 * SHAPE difference into a consequence: a removed field nobody answered changes
 * nothing for this record, and the same removal on a field it did answer is the
 * thing the preview exists to show before anybody presses anything.
 */
export function compareProductTypeVersionFields(
  currentFields: readonly UpgradeComparableField[],
  targetFields: readonly UpgradeComparableField[],
  answeredKeys: ReadonlySet<string>,
): VersionUpgradeComparison {
  const currentByKey = new Map(currentFields.map((field) => [field.attributeKey, field]));
  const targetByKey = new Map(targetFields.map((field) => [field.attributeKey, field]));

  const changes: AuthoringUpgradeChange[] = [];
  let losesAnswers = false;

  for (const [key, field] of currentByKey) {
    const target = targetByKey.get(key);
    const path = `fields.${key}`;
    if (target === undefined) {
      changes.push({ effect: 'field_removed', attributeKey: key, path });
      if (answeredKeys.has(key)) losesAnswers = true;
      continue;
    }
    if (target.attributeDefinitionVersion !== field.attributeDefinitionVersion) {
      changes.push({
        effect: 'attribute_version_changed',
        attributeKey: key,
        path,
        fromAttributeVersion: field.attributeDefinitionVersion,
        toAttributeVersion: target.attributeDefinitionVersion,
      });
      // A newer attribute version can narrow a controlled set or a bound, so an
      // answer given under the old one may no longer be permitted. It is
      // reported as a version change rather than as `value_no_longer_permitted`
      // because deciding the second needs the target's controlled values, and
      // this comparison is about the SHAPE — the validation the record's owner
      // runs afterwards is what checks their actual answers.
      if (answeredKeys.has(key)) losesAnswers = true;
      continue;
    }
    if (target.requirement !== field.requirement) {
      changes.push({
        effect: 'requirement_changed',
        attributeKey: key,
        path,
        fromRequirement: field.requirement,
        toRequirement: target.requirement,
      });
      continue;
    }
    changes.push({ effect: 'unchanged', attributeKey: key, path });
  }

  for (const [key] of targetByKey) {
    if (currentByKey.has(key)) continue;
    changes.push({ effect: 'field_added', attributeKey: key, path: `fields.${key}` });
  }

  return { changes, losesAnswers };
}
