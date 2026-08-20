import React, { useMemo, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import Head from "expo-router/head";
import type { AuthoringDraft, AuthoringSchema } from "@mercaria/shared-types";
import { Button, Input, Label, Text, Textarea } from "@mercaria/ui";
import { toast } from "@oxyhq/bloom/toast";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { CanonicalSearchPanel } from "@/components/catalog-authoring/CanonicalSearchPanel";
import { ErrorSummary } from "@/components/catalog-authoring/ErrorSummary";
import { PricingRows } from "@/components/catalog-authoring/PricingRows";
import { ProductFields } from "@/components/catalog-authoring/ProductFields";
import { ReviewPanel } from "@/components/catalog-authoring/ReviewPanel";
import { SaveStateBadge, StepNav } from "@/components/catalog-authoring/WizardChrome";
import { VariantAxes } from "@/components/catalog-authoring/VariantAxes";
import { VariantRows } from "@/components/catalog-authoring/VariantRows";
import { useTranslation } from "@/lib/i18n";
import { useAuthoringSchema, useProductDraft } from "@/lib/authoring/hooks";
import { useDraftWizard } from "@/lib/authoring/use-draft-wizard";
import { WIZARD_STEPS, type WizardStepId } from "@/lib/authoring/findings";
import { scrollToFinding } from "@/lib/authoring/anchors";
import {
  anyUntranslated,
  authoringLabel,
  UNTRANSLATED_NOTICE_KEY,
} from "@/lib/authoring/untranslated";
import {
  controlledValueStrings,
  generateMatrix,
  singleVariantRow,
  type MatrixAxis,
} from "@/lib/authoring/matrix";
import {
  DEFAULT_DRAFT_CURRENCY,
  fieldsByKey,
  isStepComplete,
  stepCompleteness,
} from "@/lib/authoring/wizard-state";

export default function ProductWizardScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("products.wizard.documentTitle")}</title>
      </Head>
      <RequireStore permission="products:write">
        {(storeId) => <WizardLoader storeId={storeId} />}
      </RequireStore>
    </>
  );
}

/**
 * Load the draft, then the schema it was PINNED to.
 *
 * The version passed is `draft.productType.version` and not the latest, because
 * the answers already stored were answers to that version's questions. A newer
 * version produces an upgrade preview and never a silent rewrite (ADR 0007
 * D10), which is a separate, explicit act.
 *
 * The LOCALE passed is the interface's, not the draft's. The draft pins its
 * locale for the server's own composition; the labels a merchant reads should
 * follow the language they are working in, and the locale cannot change a rule
 * — it changes `schema.text` and nothing in `schema.fields`.
 */
function WizardLoader({ storeId }: { storeId: string }) {
  const { t, locale } = useTranslation();
  const params = useLocalSearchParams<{ draftId: string }>();
  const draftId = typeof params.draftId === "string" ? params.draftId : "";
  const draft = useProductDraft(storeId, draftId);
  const [reloadToken, setReloadToken] = useState(0);

  const schema = useAuthoringSchema({
    productTypeKey: draft.data?.productType.key ?? null,
    categoryId: draft.data?.categoryId ?? null,
    market: draft.data?.market ?? "",
    locale,
    version: draft.data?.productType.version ?? null,
  });

  if (draft.isPending || schema.isPending) return <ScreenLoading />;
  if (draft.isError || draft.data === undefined) {
    return (
      <ScreenMessage
        title={t("products.wizard.load.draftFailedTitle")}
        body={t("products.wizard.load.draftFailedBody")}
      />
    );
  }
  if (schema.isError || schema.data === undefined) {
    return (
      <ScreenMessage
        title={t("products.wizard.load.schemaFailedTitle")}
        body={t("products.wizard.load.schemaFailedBody")}
      />
    );
  }

  // Remounted per draft AND per explicit reload.
  //
  // `useDraftWizard` seeds its state once, from the draft it was given, which is
  // what stops a save's echo moving somebody's cursor. The cost is that a
  // refetch alone changes nothing on screen — so "reload the saved version",
  // whose whole purpose is to replace the local copy with the server's, has to
  // remount. The token is bumped AFTER the refetch resolves, or the remount
  // would re-seed from the same stale cache entry it is trying to leave.
  return (
    <WizardBody
      key={`${draft.data.id}:${reloadToken}`}
      storeId={storeId}
      draft={draft.data}
      schema={schema.data}
      onReload={() => {
        void draft.refetch().then(() => setReloadToken((token) => token + 1));
      }}
    />
  );
}

interface WizardBodyProps {
  readonly storeId: string;
  readonly draft: AuthoringDraft;
  readonly schema: AuthoringSchema;
  readonly onReload: () => void;
}

function WizardBody({ storeId, draft, schema, onReload }: WizardBodyProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const [step, setStep] = useState<WizardStepId>("classification");
  const [truncated, setTruncated] = useState(false);

  const published = draft.status === "published";
  const canEdit = schema.permissions.canEditDraft && draft.status === "open";

  const wizard = useDraftWizard({ storeId, draftId: draft.id, draft, schema, canEdit });
  const { form, setForm, findings, saveState, conflicted } = wizard;

  const completeness = useMemo(
    () => (target: WizardStepId) => stepCompleteness(target, form, schema),
    [form, schema],
  );

  const setAxes = (axes: readonly MatrixAxis[]) => setForm((current) => ({ ...current, axes }));

  const regenerate = () => {
    const { rows, truncated: overflowed } = generateMatrix(form.axes, {
      currency: form.rows[0]?.currency ?? DEFAULT_DRAFT_CURRENCY,
      existing: form.rows,
      fieldsByKey: fieldsByKey(schema),
      valueStringById: controlledValueStrings(schema),
    });
    setTruncated(overflowed);
    if (!overflowed) setForm((current) => ({ ...current, rows }));
  };

  const publish = async () => {
    const outcome = await wizard.publish();
    if (outcome === null) return;
    if (outcome.outcome === "refused") {
      setStep("review");
      return;
    }
    toast.success(t("products.wizard.publish.published"));
    router.replace({ pathname: "/products/[id]", params: { id: outcome.listingId } });
  };

  if (published) {
    return (
      <Screen title={t("products.wizard.title")}>
        <ScreenMessage
          title={t("products.wizard.publish.alreadyPublishedTitle")}
          body={t("products.wizard.publish.alreadyPublishedBody")}
        />
        {draft.publishedListingId === null ? null : (
          <Button
            className="self-center"
            onPress={() =>
              router.replace({
                pathname: "/products/[id]",
                params: { id: draft.publishedListingId ?? "" },
              })
            }
          >
            <Text className="font-semibold text-primary-foreground">
              {t("products.wizard.publish.openListing")}
            </Text>
          </Button>
        )}
      </Screen>
    );
  }

  return (
    <Screen
      title={t("products.wizard.title")}
      subtitle={
        // #740: a dotted product-type key rendered bare as a screen subtitle is
        // indistinguishable from a name somebody wrote. Marked, the key still
        // says WHICH type this draft is being authored against.
        authoringLabel(
          schema.text.productTypeName,
          { kind: "key", key: schema.productType.key },
          t,
        ).text
      }
      action={
        <SaveStateBadge
          state={saveState}
          onRetry={() => {
            void wizard.saveNow();
          }}
          onReload={onReload}
        />
      }
    >
      <StepNav steps={WIZARD_STEPS} current={step} onSelect={setStep} completeness={completeness} />

      {conflicted ? (
        <View className="mb-4 gap-2 rounded-2xl border border-destructive bg-surface p-4">
          <Text className="text-sm font-semibold text-destructive">
            {t("products.wizard.save.conflictTitle")}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {t("products.wizard.save.conflictBody")}
          </Text>
          <Button variant="outline" className="self-start" onPress={onReload}>
            <Text className="text-sm font-medium text-foreground">
              {t("products.wizard.save.reload")}
            </Text>
          </Button>
        </View>
      ) : null}

      {!canEdit && !conflicted ? (
        <View className="mb-4 rounded-2xl border border-border bg-surface p-4">
          <Text className="text-sm text-muted-foreground">
            {t("products.wizard.readOnly")}
          </Text>
        </View>
      ) : null}

      <View className="gap-6">
        {step === "classification" ? (
          <View className="gap-4">
            <ReviewPanelClassification draft={draft} schema={schema} />
            <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
              <Text className="text-sm font-semibold text-foreground">
                {t("products.wizard.canonical.title")}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {t("products.wizard.canonical.body")}
              </Text>
              {schema.permissions.canSelectCanonicalEntity ? (
                <CanonicalSearchPanel
                  selectedId={form.selectedCanonicalProductId}
                  onSelect={(candidate) =>
                    setForm((current) => ({
                      ...current,
                      selectedCanonicalProductId:
                        candidate.kind === "canonical_product"
                          ? candidate.id
                          : candidate.canonicalProductId,
                    }))
                  }
                  onClear={() =>
                    setForm((current) => ({ ...current, selectedCanonicalProductId: null }))
                  }
                />
              ) : (
                <Text className="text-sm text-muted-foreground">
                  {t("products.wizard.canonical.notPermitted")}
                </Text>
              )}
            </View>
          </View>
        ) : null}

        {step === "details" ? (
          <ProductFields
            schema={schema}
            entries={form.productEntries}
            onChange={(productEntries) => setForm((current) => ({ ...current, productEntries }))}
            findings={findings}
            disabled={!canEdit}
          />
        ) : null}

        {step === "variants" ? (
          <View className="gap-5">
            <VariantAxes
              schema={schema}
              axes={form.axes}
              onChange={setAxes}
              onGenerate={regenerate}
              truncated={truncated}
              disabled={!canEdit}
            />
            <VariantRows
              schema={schema}
              rows={form.rows}
              onChange={(rows) => setForm((current) => ({ ...current, rows }))}
              findings={findings}
              canonicalProductId={form.selectedCanonicalProductId}
              disabled={!canEdit}
            />
            {form.rows.length === 0 ? (
              <Button
                variant="outline"
                className="self-start"
                onPress={() =>
                  setForm((current) => ({
                    ...current,
                    rows: [singleVariantRow(DEFAULT_DRAFT_CURRENCY)],
                  }))
                }
              >
                <Text className="text-sm font-medium text-foreground">
                  {t("products.wizard.variants.addSingle")}
                </Text>
              </Button>
            ) : null}
          </View>
        ) : null}

        {step === "pricing" ? (
          <PricingRows
            schema={schema}
            rows={form.rows}
            onChange={(rows) => setForm((current) => ({ ...current, rows }))}
            findings={findings}
            disabled={!canEdit}
          />
        ) : null}

        {step === "listing" ? (
          <View className="gap-5">
            <View className="gap-1.5">
              <Label>{t("common.title")}</Label>
              <Input
                value={form.title}
                onChangeText={(title) => setForm((current) => ({ ...current, title }))}
                accessibilityLabel={t("common.title")}
                editable={canEdit}
              />
            </View>
            <View className="gap-1.5">
              <Label>{t("common.description")}</Label>
              <Textarea
                value={form.description}
                onChangeText={(description) =>
                  setForm((current) => ({ ...current, description }))
                }
                accessibilityLabel={t("common.description")}
                editable={canEdit}
              />
            </View>
            <View className="gap-1.5 rounded-2xl border border-border bg-surface p-4">
              <Text className="text-sm font-semibold text-foreground">
                {t("products.wizard.listing.mediaTitle")}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {t("products.wizard.listing.mediaUnavailable")}
              </Text>
            </View>
          </View>
        ) : null}

        {step === "review" ? (
          <View className="gap-4">
            <ReviewPanel draft={draft} schema={schema} form={form} />
            <ErrorSummary
              findings={findings}
              onNavigate={(finding) => {
                setStep(finding.step);
                scrollToFinding(finding);
              }}
            />
            <View className="flex-row flex-wrap gap-3">
              <Button
                variant="outline"
                onPress={() => {
                  void wizard.validate();
                }}
                isLoading={wizard.isValidating}
              >
                <Text className="font-medium text-foreground">
                  {t("products.wizard.publish.check")}
                </Text>
              </Button>
              <Button
                onPress={() => {
                  void publish();
                }}
                disabled={!canEdit || conflicted}
                isLoading={wizard.isPublishing}
              >
                <Text className="font-semibold text-primary-foreground">
                  {t("products.wizard.publish.publish")}
                </Text>
              </Button>
            </View>
            {wizard.validation !== null && wizard.validation.publishable && findings.length === 0 ? (
              <Text className="text-sm text-muted-foreground">
                {t("products.wizard.publish.readyToPublish")}
              </Text>
            ) : null}
          </View>
        ) : null}

        {step !== "review" ? (
          <View className="flex-row items-center justify-between gap-3">
            <Text className="text-xs text-muted-foreground">
              {isStepComplete(completeness(step))
                ? t("products.wizard.steps.complete")
                : t("products.wizard.steps.incomplete")}
            </Text>
            <Button
              onPress={() => {
                const index = WIZARD_STEPS.indexOf(step);
                const next = WIZARD_STEPS[index + 1];
                if (next !== undefined) setStep(next);
              }}
            >
              <Text className="font-semibold text-primary-foreground">
                {t("products.wizard.steps.next")}
              </Text>
            </Button>
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

/** The pinned classification, read back from the DRAFT rather than from a picker. */
function ReviewPanelClassification({
  draft,
  schema,
}: {
  draft: AuthoringDraft;
  schema: AuthoringSchema;
}) {
  const { t } = useTranslation();
  // #740, and the same split `ReviewPanel` makes for the same reason: the
  // product type has a stable key worth marking up, the category has only a
  // UUID on this DTO and so gets no identifier at all.
  const categoryName = authoringLabel(schema.text.categoryName, { kind: "unidentifiable" }, t);
  const productTypeName = authoringLabel(
    schema.text.productTypeName,
    { kind: "key", key: draft.productType.key },
    t,
  );
  return (
    <View className="gap-1.5 rounded-2xl border border-border bg-surface p-4">
      <Text className="text-sm font-semibold text-foreground">{categoryName.text}</Text>
      <Text className="text-xs text-muted-foreground">
        {t("products.wizard.review.productTypeVersion", {
          name: productTypeName.text,
          version: draft.productType.version,
        })}
      </Text>
      <Text className="text-xs text-muted-foreground">
        {/* `language` and not `locale`: `locale` is an i18n-js OPTION, so it
            switches the lookup instead of filling the slot — this line rendered
            `[missing "…"]` until #437's check G' found it. */}
        {t("products.wizard.review.marketAndLocale", {
          market: draft.market,
          language: draft.locale,
        })}
      </Text>
      <Text className="text-xs text-muted-foreground">
        {t("products.wizard.classification.pinned")}
      </Text>
      {anyUntranslated([categoryName, productTypeName]) ? (
        <Text className="text-xs text-muted-foreground">{t(UNTRANSLATED_NOTICE_KEY)}</Text>
      ) : null}
    </View>
  );
}
