import React from "react";
import { View } from "react-native";
import type { AuthoringDraft, AuthoringSchema } from "@mercaria/shared-types";
import { Text } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";
import { hasAnswer } from "@/lib/authoring/answers";
import { toMinorUnits } from "@/lib/money";
import {
  effectiveRequirements,
  isVisible,
  productScopeFields,
  type WizardFormState,
} from "@/lib/authoring/wizard-state";
import { axisSummary } from "./VariantRows";

interface ReviewPanelProps {
  readonly draft: AuthoringDraft;
  readonly schema: AuthoringSchema;
  readonly form: WizardFormState;
}

/**
 * What is about to be published, read back.
 *
 * Read-only, and deliberately so: every value here is edited on the step that
 * owns it. A review screen with editable controls is a second form over the
 * same state, and the two disagree the moment one of them forgets a rule.
 *
 * ## What it reports, and what it will not claim
 *
 * The classification is the draft's PINNED category and product-type version,
 * read off the draft rather than off whatever the picker last held — that pin
 * is what the answers were given under.
 *
 * Media is not listed and there is no attachment control anywhere in this
 * wizard: no upload path to Oxy's file service exists in this repository, so a
 * picker here would be a control that cannot finish. A draft's stored
 * `imageFileIds` are left untouched by every save rather than being replaced
 * with an empty list — which is why nothing here reports "no images".
 */
export function ReviewPanel({ draft, schema, form }: ReviewPanelProps) {
  const { t } = useTranslation();
  const requirements = effectiveRequirements(schema, form.productEntries);

  const visibleFields = productScopeFields(schema).filter((field) =>
    isVisible(requirements.get(field.key) ?? field.requirement),
  );
  const answered = visibleFields.filter((field) => hasAnswer(form.productEntries[field.key]));
  const soldRows = form.rows.filter((row) => row.enabled);
  const priced = soldRows.filter((row) => toMinorUnits(row.priceMajor, row.currency) !== null);

  const productTypeName = schema.text.productTypeName?.value ?? schema.productType.key;
  const categoryName = schema.text.categoryName?.value ?? draft.categoryId;

  return (
    <View className="gap-4">
      <Section title={t("products.wizard.steps.classification")}>
        <Row label={t("products.wizard.review.category")} value={categoryName} />
        <Row
          label={t("products.wizard.review.productType")}
          value={t("products.wizard.review.productTypeVersion", {
            name: productTypeName,
            version: draft.productType.version,
          })}
        />
        <Row label={t("products.wizard.review.market")} value={draft.market} />
        <Row
          label={t("products.wizard.review.canonicalLink")}
          value={
            form.selectedCanonicalProductId === null
              ? t("products.wizard.review.canonicalNone")
              : t("products.wizard.review.canonicalDeclared")
          }
        />
      </Section>

      <Section title={t("products.wizard.steps.details")}>
        <Row
          label={t("products.wizard.review.fieldsAnswered")}
          value={`${answered.length}/${visibleFields.length}`}
        />
      </Section>

      <Section title={t("products.wizard.steps.variants")}>
        <Row label={t("products.wizard.review.soldVariants")} value={String(soldRows.length)} />
        <Row
          label={t("products.wizard.review.pricedVariants")}
          value={`${priced.length}/${soldRows.length}`}
        />
        <View className="mt-1 gap-1">
          {soldRows.slice(0, 8).map((row) => {
            const summary = axisSummary(row, schema);
            return (
              <Text key={row.key} className="text-xs text-muted-foreground">
                {summary.length > 0 ? summary : t("products.wizard.variants.singleVariant")}
              </Text>
            );
          })}
          {soldRows.length > 8 ? (
            <Text className="text-xs text-muted-foreground">
              {t("products.wizard.review.moreVariants", { count: soldRows.length - 8 })}
            </Text>
          ) : null}
        </View>
      </Section>

      <Section title={t("products.wizard.steps.listing")}>
        <Row
          label={t("common.title")}
          value={form.title.trim().length > 0 ? form.title.trim() : t("products.wizard.review.empty")}
        />
        <Row
          label={t("common.description")}
          value={
            form.description.trim().length > 0
              ? t("products.wizard.review.provided")
              : t("products.wizard.review.empty")
          }
        />
      </Section>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="gap-2 rounded-2xl border border-border bg-surface p-4">
      <Text className="text-sm font-semibold text-foreground">{title}</Text>
      <View className="gap-1.5">{children}</View>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-start justify-between gap-4">
      <Text className="text-sm text-muted-foreground">{label}</Text>
      {/*
        `text-right` and not `text-end`: the logical spelling compiles to
        `text-align: end`, which react-native-css's `parseTextAlign` rejects
        outright — the rule is DROPPED and the compiler emits a warning nobody
        reads. Measured through the real pipeline for #397; the dashboard is not
        mirrored (#434), so the physical spelling costs nothing today.
      */}
      <Text className="flex-1 text-right text-sm text-foreground" numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}
