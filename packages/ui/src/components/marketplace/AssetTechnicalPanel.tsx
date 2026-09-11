import { View } from "react-native";
import type { AssetInspectionVerdict } from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { useSharedUiLocale, useSharedUiTranslation } from "../../i18n/ui-translation";
import { formatDate } from "../../lib/date";
import {
  ASSET_FACTS_CLAIMED_BADGE_KEY,
  ASSET_FACTS_CLAIMED_NOTE_KEY,
  ASSET_FACTS_CLAIMED_TITLE_KEY,
  ASSET_FACTS_MEASURED_BADGE_KEY,
  ASSET_FACTS_MEASURED_BY_KEY,
  ASSET_FACTS_MEASURED_NOTE_KEY,
  ASSET_FACTS_MEASURED_TITLE_KEY,
  ASSET_FACTS_NOT_MEASURED_KEY,
  ASSET_INSPECTION_VERDICT_KEYS,
} from "../../lib/digital-asset-labels";

/**
 * A digital work's technical metadata, WITH ITS PROVENANCE (ADR 0010 D12,
 * #1015 Workstream 4 / Workstream 5).
 *
 * ## The one thing this component exists to prevent
 *
 * > "42,180 triangles" is Mercaria's measurement; "optimized for Unreal" is the
 * > seller's word. A product page that presents them identically is the failure
 * > this separation exists to prevent.
 *
 * ADR 0010 D12 keeps the two in different TABLES —
 * `asset_file_inspections` carries what the pipeline measured together with the
 * processor name and version that produced it, and a creator's claim is a
 * product-type attribute value #367 already owns — because *"one table with a
 * provenance flag would let a write path set the flag wrongly; two tables cannot
 * be confused by one"*. This component is the rendering half of that decision,
 * and it holds it the same way: **two props of two different types**. There is no
 * `facts: Fact[]` with a `provenance` field, so a mapping that mixed the two has
 * nowhere to put the result, and a screen cannot render a claim in the measured
 * block by passing the wrong array.
 *
 * ## Distinct by WORDS first, never by colour
 *
 * Each block carries its own heading, its own attribution sentence, and a
 * per-row badge — `Measured` / `Seller's description`. The badge is on the row
 * rather than only the block, because a reader who skips headings (or whose
 * screen reader reads the rows) would otherwise get two identical-looking
 * tables. The surfaces also differ, but that is the *second* signal: #147's
 * accessibility rule 2 and the house convention both refuse a meaning that
 * lives in a colour.
 *
 * ## An unmeasured value is not a zero, and a verdict is not a grade
 *
 * Every geometry column in `asset_file_inspections` is nullable and NULL means
 * NOT MEASURED, so a row with no value renders
 * {@link ASSET_FACTS_NOT_MEASURED_KEY} and never `0` — *"a `0` triangle count and
 * an unmeasured one are different facts"*. And `verdict` is stated beside the
 * figures rather than used to hide them: `unsupported` is the honest result for a
 * `.blend` (measuring it needs Blender in the worker — W12 threat 7), not a
 * failure, and `pending` means the pipeline has not finished. #1015 W4's *"do not
 * overclaim machine-generated validation"* is unholdable if "we measured zero"
 * and "we did not measure" share a rendering.
 *
 * Nothing here says a model is printable, safe or engine-ready. A measurement is
 * a number with a provenance; a fitness judgement is the seller's claim, and it
 * renders in the seller's block with the seller's name on it.
 */

/**
 * One figure Mercaria measured.
 *
 * `label` and `displayValue` arrive COMPOSED, exactly as
 * `SpecificationTable`'s entries do: which properties exist, what they are
 * called and how a unit is spelled are the attribute registry's answers (#94),
 * and re-deciding any of them here would be the per-category field list #367
 * deletes. `value` being absent is the NULL case — not measured.
 */
export interface AssetMeasuredFactRow {
  /** The registry key, for a stable React key. Never branched on. */
  readonly key: string;
  readonly label: string;
  /** The rendered value, or absent when the column was NULL. */
  readonly displayValue?: string;
}

/**
 * What one inspection concluded, and who concluded it.
 *
 * The processor name and version are REQUIRED, because a measurement without
 * them is an assertion: ADR 0010 D12 stores them for exactly this sentence, and
 * a panel that could render figures with no attribution would be free to render
 * a seller's claim as one.
 */
export interface AssetMeasuredFacts {
  readonly verdict: AssetInspectionVerdict;
  readonly processorName: string;
  readonly processorVersion: string;
  /** ISO 8601. Spelled with the app's locale, never the device's (#488). */
  readonly measuredAt: string;
  readonly rows: readonly AssetMeasuredFactRow[];
}

/**
 * One thing the SELLER says.
 *
 * A different type from {@link AssetMeasuredFactRow} with no field in common
 * beyond the two a row needs, so the two arrays are not interchangeable at the
 * call site. There is no verdict, no processor and no date: a claim has no
 * measurement provenance, and giving it fields shaped like one is how the two
 * start looking alike again.
 */
export interface AssetSellerClaimRow {
  readonly key: string;
  readonly label: string;
  readonly displayValue: string;
}

export interface AssetTechnicalPanelProps {
  /** What Mercaria measured, or `undefined` when nothing has been inspected. */
  measured?: AssetMeasuredFacts;
  /** What the seller claims. Empty is ordinary and renders no block. */
  claims: readonly AssetSellerClaimRow[];
}

export function AssetTechnicalPanel({ measured, claims }: AssetTechnicalPanelProps) {
  const t = useSharedUiTranslation();
  const locale = useSharedUiLocale();

  if (measured === undefined && claims.length === 0) return null;

  return (
    <View className="gap-space-24">
      {measured === undefined ? null : (
        <View className="gap-space-8 rounded-radius-16 border border-border-secondary p-space-16">
          <Text className="text-captionBold text-text" accessibilityRole="header">
            {t(ASSET_FACTS_MEASURED_TITLE_KEY)}
          </Text>
          <Text className="text-caption text-text-secondary">
            {t(ASSET_FACTS_MEASURED_NOTE_KEY)}
          </Text>
          {/* The provenance itself: who measured, with what, when. */}
          <Text className="text-caption text-text-tertiary">
            {t(ASSET_FACTS_MEASURED_BY_KEY, {
              processor: measured.processorName,
              version: measured.processorVersion,
              date: formatDate(measured.measuredAt, locale),
            })}
          </Text>
          {/* The verdict is a SENTENCE, never the raw `measured`/`unsupported`
              identifier — check J counts one of those as a defect because the
              English would be generated at runtime from a wire enum. */}
          <Text className="text-caption text-text-tertiary">
            {t(ASSET_INSPECTION_VERDICT_KEYS[measured.verdict])}
          </Text>

          {measured.rows.map((row) => (
            <FactRow
              key={`measured:${row.key}`}
              label={row.label}
              /* An absent value is "not measured" and never a zero. */
              value={row.displayValue ?? t(ASSET_FACTS_NOT_MEASURED_KEY)}
              badge={t(ASSET_FACTS_MEASURED_BADGE_KEY)}
            />
          ))}
        </View>
      )}

      {claims.length === 0 ? null : (
        <View className="gap-space-8 rounded-radius-16 bg-bg-fill-secondary p-space-16">
          <Text className="text-captionBold text-text" accessibilityRole="header">
            {t(ASSET_FACTS_CLAIMED_TITLE_KEY)}
          </Text>
          <Text className="text-caption text-text-secondary">
            {t(ASSET_FACTS_CLAIMED_NOTE_KEY)}
          </Text>
          {claims.map((claim) => (
            <FactRow
              key={`claimed:${claim.key}`}
              label={claim.label}
              value={claim.displayValue}
              badge={t(ASSET_FACTS_CLAIMED_BADGE_KEY)}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * One row, in either block.
 *
 * Shared because the LAYOUT of a labelled value is not what distinguishes the
 * two provenances — the words are. The badge is a required prop, so a row
 * cannot be rendered without one: that is the same device `FacetBucketChip`
 * uses for its resolved label, and it is what keeps "this block is obviously the
 * measured one" from becoming the only thing a reader has to go on.
 *
 * The badge is also part of the announced label, so the provenance is spoken
 * with the value rather than sitting in a separate focus stop that reads as
 * another control.
 */
function FactRow({
  label,
  value,
  badge,
}: {
  label: string;
  value: string;
  badge: string;
}) {
  return (
    <View
      className="flex-row items-start justify-between gap-space-16 border-b border-border-secondary py-space-8"
      accessibilityLabel={`${label}: ${value}, ${badge}`}
    >
      <View className="flex-1">
        <Text className="text-caption text-text-secondary">{label}</Text>
      </View>
      <View className="flex-1 items-end gap-space-4">
        <Text className="text-bodySmall text-text">{value}</Text>
        <Text className="text-badge text-text-tertiary">{badge}</Text>
      </View>
    </View>
  );
}
