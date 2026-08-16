import React, { useState } from "react";
import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import { ChevronLeft, Plus, Trash2, Percent } from "lucide-react-native";
import type { TaxRate } from "@mercaria/shared-types";
import {
  Text,
  Button,
  Input,
  Label,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  useColorScheme,
} from "@mercaria/ui";
import { toast } from "@oxyhq/bloom/toast";
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
  const [createOpen, setCreateOpen] = useState(false);

  const back = (
    <View className="flex-row items-center gap-2">
      <Pressable
        onPress={() => router.back()}
        className="h-9 flex-row items-center gap-1 rounded-lg border border-border px-3 active:opacity-70"
      >
        <ChevronLeft size={16} color={colors.foreground} />
        <Text className="text-sm font-medium text-foreground">{t("common.back")}</Text>
      </Pressable>
      <Button onPress={() => setCreateOpen(true)}>
        <View className="flex-row items-center gap-2">
          <Plus size={16} color={colors.primaryForeground} />
          <Text className="font-semibold text-primary-foreground">
            {t("settings.tax.newRate")}
          </Text>
        </View>
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

      <CreateTaxRateDialog storeId={storeId} open={createOpen} onOpenChange={setCreateOpen} />
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
  open,
  onOpenChange,
}: {
  storeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
          onOpenChange(false);
        },
        onError: () => toast.error(t("settings.tax.createFailed")),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.tax.newRateTitle")}</DialogTitle>
        </DialogHeader>
        <View className="gap-4">
          <View className="gap-1.5">
            <Label>{t("common.name")}</Label>
            <Input
              value={name}
              onChangeText={setName}
              placeholder={t("settings.tax.namePlaceholder")}
            />
          </View>
          <View className="gap-1.5">
            <Label>{t("settings.tax.rateLabel")}</Label>
            <Input value={percent} onChangeText={setPercent} keyboardType="decimal-pad" placeholder="8" />
          </View>
          <View className="flex-row gap-2">
            <View className="flex-1 gap-1.5">
              <Label>{t("settings.tax.countryLabel")}</Label>
              <Input
                value={country}
                onChangeText={setCountry}
                placeholder={t("settings.tax.countryPlaceholder")}
                autoCapitalize="characters"
              />
            </View>
            <View className="flex-1 gap-1.5">
              <Label>{t("settings.tax.regionLabel")}</Label>
              <Input
                value={region}
                onChangeText={setRegion}
                placeholder={t("settings.tax.regionPlaceholder")}
              />
            </View>
          </View>
          <Button onPress={submit} isLoading={createTaxRate.isPending} className="mt-1">
            <Text className="font-semibold text-primary-foreground">{t("common.create")}</Text>
          </Button>
        </View>
      </DialogContent>
    </Dialog>
  );
}
