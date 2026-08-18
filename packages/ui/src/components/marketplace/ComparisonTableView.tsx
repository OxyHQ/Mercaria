import { ScrollView, View } from "react-native";
import type {
  ComparisonCell,
  ComparisonTable,
  ComparisonTableRow,
} from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { useSharedUiTranslation } from "../../i18n/ui-translation";
import {
  COMPARISON_CELL_A11Y_KEY,
  COMPARISON_CELL_INFERRED_A11Y_KEY,
  COMPARISON_CELL_INFERRED_NOTE_KEY,
  COMPARISON_TABLE_HIGHER_IS_BETTER_KEY,
  COMPARISON_TABLE_IN_UNIT_KEY,
  COMPARISON_TABLE_LOWER_IS_BETTER_KEY,
  COMPARISON_TABLE_NO_DIFFERENCES_KEY,
  COMPARISON_TABLE_SPECIFICATION_KEY,
  COMPARISON_TABLE_UNNAMED_PRODUCT_KEY,
  comparisonNotApplicableTextKey,
  comparisonUnknownTextKey,
} from "../../lib/comparison-labels";

/** How wide one product column is. Fixed, so the row header stays readable. */
const COLUMN_WIDTH = 160;

export interface ComparisonTableViewProps {
  table: ComparisonTable;
  /** Subject ref → the product's name. The table carries refs, never names. */
  namesByRef: Readonly<Record<string, string>>;
  /** Show only the rows whose cells actually differ (#96 UX rule 3's default). */
  differencesOnly?: boolean;
}

/**
 * The DETERMINISTIC comparison table (#96 UX rules 3 and 10).
 *
 * Rendered before any generated narrative and independently of whether one
 * exists — this component takes no explanation prop at all, so a page cannot
 * accidentally make the table conditional on a model having answered.
 *
 * ## Accessible without charts and without colour
 *
 * There is no bar, no sparkline and no colour scale anywhere in it. Every cell
 * is TEXT, an unknown says which kind of unknown it is in words, and a
 * `not applicable` says so rather than rendering an em dash a screen reader
 * announces as nothing. #96 UX rule 10 asks for exactly this, and the
 * `OfferLabelBadge` argument applies twice over here: a green "better" cell
 * would be a recommendation the server did not make, on a row whose direction
 * is usually `not_comparable`.
 *
 * Direction is stated in the row HEADER as words ("higher is better") rather
 * than implied by position or colour, and a row with no declared direction says
 * nothing at all — which is the honest rendering of "these differ and neither
 * is better".
 */
export function ComparisonTableView({
  table,
  namesByRef,
  differencesOnly = false,
}: ComparisonTableViewProps) {
  const t = useSharedUiTranslation();
  const rows = differencesOnly ? table.rows.filter((row) => row.differs) : table.rows;

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator accessibilityRole="none">
      <View className="gap-space-2">
        <View className="flex-row border-b border-border-secondary pb-space-8">
          <View style={{ width: COLUMN_WIDTH }}>
            <Text className="text-captionBold text-text-secondary">
              {t(COMPARISON_TABLE_SPECIFICATION_KEY)}
            </Text>
          </View>
          {table.subjectRefs.map((subjectRef) => (
            <View key={subjectRef} style={{ width: COLUMN_WIDTH }} className="px-space-8">
              {/* A subject ref is an opaque handle, so the miss branch resolves a
                  KEY rather than the subscript — rendering the ref would put a
                  wire identifier in front of a shopper (#596). The map is keyed
                  by ref and cannot be exhaustive over one. */}
              <Text className="text-captionBold text-text">
                {namesByRef[subjectRef] ?? t(COMPARISON_TABLE_UNNAMED_PRODUCT_KEY)}
              </Text>
            </View>
          ))}
        </View>

        {rows.map((row) => (
          <ComparisonRow key={row.key} row={row} subjectRefs={table.subjectRefs} />
        ))}

        {rows.length === 0 ? (
          <Text className="py-space-12 text-body text-text-secondary">
            {t(COMPARISON_TABLE_NO_DIFFERENCES_KEY)}
          </Text>
        ) : null}
      </View>
    </ScrollView>
  );
}

/** One row: its label, its direction in words, and one cell per product. */
function ComparisonRow({
  row,
  subjectRefs,
}: {
  row: ComparisonTableRow;
  subjectRefs: readonly string[];
}) {
  const t = useSharedUiTranslation();

  return (
    <View className="flex-row border-b border-border-secondary py-space-8">
      <View style={{ width: COLUMN_WIDTH }} className="gap-space-2">
        <Text className="text-caption text-text">{row.label}</Text>
        {row.unit === undefined ? null : (
          // ONE frame with a `%{unit}` slot, not a translated word glued to the
          // unit: the preposition inflects and in several of these twelve the
          // unit does not follow it at all.
          <Text className="text-caption text-text-secondary">
            {t(COMPARISON_TABLE_IN_UNIT_KEY, { unit: row.unit })}
          </Text>
        )}
        {row.direction === "not_comparable" ? null : (
          <Text className="text-caption text-text-secondary">
            {t(
              row.direction === "higher_is_better"
                ? COMPARISON_TABLE_HIGHER_IS_BETTER_KEY
                : COMPARISON_TABLE_LOWER_IS_BETTER_KEY,
            )}
          </Text>
        )}
      </View>
      {subjectRefs.map((subjectRef) => (
        <View key={subjectRef} style={{ width: COLUMN_WIDTH }} className="px-space-8">
          <CellText cell={row.cells[subjectRef]} label={row.label} />
        </View>
      ))}
    </View>
  );
}

/**
 * One cell, as words.
 *
 * The five states render five DIFFERENT sentences, and the two that matter most
 * are the last two: "Not recorded" invites a shopper to go and look, while
 * "Does not apply" tells them there is nothing to look for. Collapsing them
 * into a dash would lose the distinction the whole table is built around.
 *
 * An INFERRED value says so beside the figure, because #96 product-comparison
 * rule 5 asks for an inference to be labelled distinctly from a source-backed
 * fact — and a shopper deciding on a converted magnitude should know it was
 * converted.
 */
function CellText({ cell, label }: { cell: ComparisonCell | undefined; label: string }) {
  const t = useSharedUiTranslation();

  // The accessible label is ONE frame with a `%{}` slot rather than a template
  // literal, because its separator is not a colon in every language and the
  // value it carries is itself translated in four of these six branches.
  if (cell === undefined) {
    // The same fact `unknown.not_recorded` states, so it resolves the same key
    // rather than a second sentence that could be translated differently.
    const notRecorded = t(comparisonUnknownTextKey("not_recorded"));
    return (
      <Text
        className="text-caption text-text-secondary"
        accessibilityLabel={t(COMPARISON_CELL_A11Y_KEY, { label, value: notRecorded })}
      >
        {notRecorded}
      </Text>
    );
  }

  switch (cell.state) {
    case "source_backed":
      return (
        <Text
          className="text-caption text-text"
          accessibilityLabel={t(COMPARISON_CELL_A11Y_KEY, {
            label,
            value: cell.value.rendered,
          })}
        >
          {cell.value.rendered}
        </Text>
      );
    case "inferred":
      return (
        <View className="gap-space-2">
          <Text
            className="text-caption text-text"
            accessibilityLabel={t(COMPARISON_CELL_INFERRED_A11Y_KEY, {
              label,
              value: cell.value.rendered,
            })}
          >
            {cell.value.rendered}
          </Text>
          <Text className="text-caption text-text-secondary">
            {t(COMPARISON_CELL_INFERRED_NOTE_KEY)}
          </Text>
        </View>
      );
    case "conflicting": {
      const disagree = t(comparisonUnknownTextKey("conflicting_sources"));
      return (
        <View className="gap-space-2">
          <Text
            className="text-caption text-text"
            accessibilityLabel={t(COMPARISON_CELL_A11Y_KEY, { label, value: disagree })}
          >
            {disagree}
          </Text>
          {cell.candidates.map((value) => (
            <Text key={value.rendered} className="text-caption text-text-secondary">
              {value.rendered}
            </Text>
          ))}
        </View>
      );
    }
    case "unknown": {
      const unknown = t(comparisonUnknownTextKey(cell.reason));
      return (
        <Text
          className="text-caption text-text-secondary"
          accessibilityLabel={t(COMPARISON_CELL_A11Y_KEY, { label, value: unknown })}
        >
          {unknown}
        </Text>
      );
    }
    case "not_applicable": {
      const notApplicable = t(comparisonNotApplicableTextKey(cell.reason));
      return (
        <Text
          className="text-caption text-text-secondary"
          accessibilityLabel={t(COMPARISON_CELL_A11Y_KEY, { label, value: notApplicable })}
        >
          {notApplicable}
        </Text>
      );
    }
    default:
      // Unreachable over the five-state union, and it resolves the SAME key the
      // `undefined` branch above does rather than a second sentence — for that
      // branch's reason: one fact, one message id, so they cannot be translated
      // into two different claims.
      return (
        <Text className="text-caption text-text-secondary">
          {t(comparisonUnknownTextKey("not_recorded"))}
        </Text>
      );
  }
}
