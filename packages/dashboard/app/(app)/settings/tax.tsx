import React, { useState } from "react";
import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import { ChevronLeft, Plus, Trash2, Percent } from "lucide-react-native";
import type { TaxRate } from "@mercaria/shared-types";
import {
  Text,
  useColorScheme,
  toBloomIcon,
} from "@mercaria/ui";
import { Field } from "@oxy.so/bloom/field";
import { TextFieldInput } from "@oxy.so/bloom/text-field";
import { Button } from "@oxy.so/bloom/button";
import { Dialog, useDialogControl, type DialogControlProps } from "@oxy.so/bloom/dialog";
import { toast } from "@oxy.so/bloom/toast";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { useTranslation } from "@/lib/i18n";
import { useTaxRates, useCreateTaxRate, useDeleteTaxRate } from "@/lib/hooks/use-tax-and-locations";

const BPS_PER_PERCENT = 100;

export default function TaxScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("settings.tax.documentTitle")}</title>
      </Head>
      <RequireStore permission="settings:write">
        {(storeId) => <TaxBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function TaxBody({ storeId }: { storeId: string }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const { data, isPending, isError } = useTaxRates(storeId);
  const deleteTaxRate = useDeleteTaxRate(storeId);
  const createControl = useDialogControl();

  const back = (
    <View className="flex-row items-center gap-2">
      <Pressable
        onPress={() => router.back()}
        className="h-9 flex-row items-center gap-1 rounded-lg border border-border px-3 active:opacity-70"
      >
        <ChevronLeft size={16} color={colors.foreground} />
        <Text className="text-sm font-medium text-foreground">{t("common.back")}</Text>
      </Pressable>
      <Button
        tone="accent"
        leadingIcon={toBloomIcon(Plus)}
        onPress={() => createControl.open()}
      >
        {t("settings.tax.newRate")}
      </Button>
    </View>
  );

  return (
    <Screen title={t("settings.tax.title")} subtitle={t("settings.tax.subtitle")} action={back}>
      {isPending ? (
        <ScreenLoading />
      ) : isError ? (
        <ScreenMessage title={t("settings.tax.loadFailed")} body={t("common.pleaseTryAgain")} />
      ) : (data?.length ?? 0) === 0 ? (
        <ScreenMessage title={t("settings.tax.emptyTitle")} body={t("settings.tax.emptyBody")} />
      ) : (
        <View className="gap-2">
          {data?.map((rate) => (
            <TaxRateRow
              key={rate.id}
              rate={rate}
              onDelete={() =>
                deleteTaxRate.mutate(rate.id, {
                  onSuccess: () => toast.success(t("settings.tax.deleted")),
                  onError: () => toast.error(t("settings.tax.deleteFailed")),
                })
              }
            />
          ))}
        </View>
      )}

      <CreateTaxRateDialog storeId={storeId} control={createControl} />
    </Screen>
  );
}

function TaxRateRow({ rate, onDelete }: { rate: TaxRate; onDelete: () => void }) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  return (
    <View className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-3">
      <View className="h-10 w-10 items-center justify-center rounded-xl bg-muted">
        <Percent size={18} color={colors.mutedForeground} />
      </View>
      <View className="flex-1">
        <Text className="text-sm font-semibold text-foreground">{rate.name}</Text>
        <Text className="text-xs text-muted-foreground">
          {rate.rateBps / BPS_PER_PERCENT}%
          {rate.region.country ? ` · ${rate.region.country}` : ""}
          {rate.region.region ? `, ${rate.region.region}` : ""} ·{" "}
          {rate.isActive ? t("settings.tax.active") : t("settings.tax.inactive")}
        </Text>
      </View>
      <Pressable onPress={onDelete} className="p-2 active:opacity-70">
        <Trash2 size={16} color={colors.mutedForeground} />
      </Pressable>
    </View>
  );
}

function CreateTaxRateDialog({
  storeId,
  control,
}: {
  storeId: string;
  control: DialogControlProps;
}) {
  const createTaxRate = useCreateTaxRate(storeId);
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [percent, setPercent] = useState("");
  const [country, setCountry] = useState("");
  const [region, setRegion] = useState("");

  const submit = () => {
    if (!name.trim()) {
      toast.error(t("settings.tax.nameRequired"));
      return;
    }
    const pct = Number(percent);
    if (!Number.isFinite(pct) || pct <= 0) {
      toast.error(t("settings.tax.invalidRate"));
      return;
    }
    createTaxRate.mutate(
      {
        name: name.trim(),
        rateBps: Math.round(pct * BPS_PER_PERCENT),
        region: {
          ...(country.trim() ? { country: country.trim().toUpperCase() } : {}),
          ...(region.trim() ? { region: region.trim() } : {}),
        },
        isActive: true,
      },
      {
        onSuccess: () => {
          toast.success(t("settings.tax.created"));
          setName("");
          setPercent("");
          setCountry("");
          setRegion("");
          control.close();
        },
        onError: () => toast.error(t("settings.tax.createFailed")),
      },
    );
  };

  return (
    <Dialog control={control} title={t("settings.tax.newRateTitle")}>
      <View className="gap-4">
        <Field label={t("common.name")}>
          <TextFieldInput
            label={t("common.name")}
            value={name}
            onValueChange={setName}
            placeholder={t("settings.tax.namePlaceholder")}
          />
        </Field>
        <Field label={t("settings.tax.rateLabel")}>
          <TextFieldInput
            label={t("settings.tax.rateLabel")}
            value={percent}
            onValueChange={setPercent}
            keyboardType="decimal-pad"
            placeholder="8"
          />
        </Field>
        <View className="flex-row gap-2">
          <View className="flex-1">
            <Field label={t("settings.tax.countryLabel")}>
              <TextFieldInput
                label={t("settings.tax.countryLabel")}
                value={country}
                onValueChange={setCountry}
                placeholder={t("settings.tax.countryPlaceholder")}
                autoCapitalize="characters"
              />
            </Field>
          </View>
          <View className="flex-1">
            <Field label={t("settings.tax.regionLabel")}>
              <TextFieldInput
                label={t("settings.tax.regionLabel")}
                value={region}
                onValueChange={setRegion}
                placeholder={t("settings.tax.regionPlaceholder")}
              />
            </Field>
          </View>
        </View>
        <Button tone="accent" onPress={submit} loading={createTaxRate.isPending} className="mt-1">
          {t("common.create")}
        </Button>
      </View>
    </Dialog>
  );
}
