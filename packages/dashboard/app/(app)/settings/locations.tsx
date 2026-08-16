import React, { useState } from "react";
import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import { ChevronLeft, Plus, Trash2, MapPin } from "lucide-react-native";
import type { Location, LocationType } from "@mercaria/shared-types";
import {
  Text,
  Button,
  Input,
  Label,
  ToggleGroup,
  ToggleGroupItem,
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
import { useLocations, useCreateLocation, useDeleteLocation } from "@/lib/hooks/use-tax-and-locations";

const TYPES: LocationType[] = ["warehouse", "retail", "pop_up", "virtual"];

/**
 * Display label per location type (#398).
 *
 * A KEY per type rather than the word itself: this map is evaluated at import,
 * before the locale store has rehydrated, and `LocationType` is a wire
 * identifier that must keep reaching the API verbatim. It also replaces the old
 * `type.replace("_", " ")` prettifier, which was English word-splitting applied
 * to an enum.
 */
const LOCATION_TYPE_LABEL_KEYS: Record<LocationType, string> = {
  warehouse: "settings.locations.types.warehouse",
  retail: "settings.locations.types.retail",
  pop_up: "settings.locations.types.popUp",
  virtual: "settings.locations.types.virtual",
};

export default function LocationsScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("settings.locations.documentTitle")}</title>
      </Head>
      <RequireStore permission="locations:write">
        {(storeId) => <LocationsBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function LocationsBody({ storeId }: { storeId: string }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const { data, isPending, isError } = useLocations(storeId);
  const deleteLocation = useDeleteLocation(storeId);
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
          <Text className="font-semibold text-primary-foreground">{t("common.new")}</Text>
        </View>
      </Button>
    </View>
  );

  return (
    <Screen
      title={t("settings.locations.title")}
      subtitle={t("settings.locations.subtitle")}
      action={back}
    >
      {isPending ? (
        <ScreenLoading />
      ) : isError ? (
        <ScreenMessage
          title={t("settings.locations.loadFailed")}
          body={t("common.pleaseTryAgain")}
        />
      ) : (
        <View className="gap-2">
          {data?.map((location) => (
            <LocationRow
              key={location.id}
              location={location}
              onDelete={() =>
                deleteLocation.mutate(location.id, {
                  onSuccess: () => toast.success(t("settings.locations.deleted")),
                  onError: () => toast.error(t("settings.locations.deleteFailed")),
                })
              }
            />
          ))}
        </View>
      )}

      <CreateLocationDialog storeId={storeId} open={createOpen} onOpenChange={setCreateOpen} />
    </Screen>
  );
}

function LocationRow({ location, onDelete }: { location: Location; onDelete: () => void }) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  return (
    <View className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-3">
      <View className="h-10 w-10 items-center justify-center rounded-xl bg-muted">
        <MapPin size={18} color={colors.mutedForeground} />
      </View>
      <View className="flex-1">
        <Text className="text-sm font-semibold text-foreground">{location.name}</Text>
        {/*
          Each flag key carries its own " · " separator, so a translator sees the
          whole visible fragment rather than a word torn off a punctuation mark.
        */}
        <Text className="text-xs capitalize text-muted-foreground">
          {t(LOCATION_TYPE_LABEL_KEYS[location.type])}
          {location.isDefault ? t("settings.locations.defaultFlag") : ""}
          {location.isActive ? "" : t("settings.locations.inactiveFlag")}
        </Text>
      </View>
      {!location.isDefault ? (
        <Pressable onPress={onDelete} className="p-2 active:opacity-70">
          <Trash2 size={16} color={colors.mutedForeground} />
        </Pressable>
      ) : null}
    </View>
  );
}

function CreateLocationDialog({
  storeId,
  open,
  onOpenChange,
}: {
  storeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createLocation = useCreateLocation(storeId);
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [type, setType] = useState<LocationType>("warehouse");

  const submit = () => {
    if (!name.trim()) {
      toast.error(t("settings.locations.nameRequired"));
      return;
    }
    createLocation.mutate(
      { name: name.trim(), type },
      {
        onSuccess: () => {
          toast.success(t("settings.locations.created"));
          setName("");
          setType("warehouse");
          onOpenChange(false);
        },
        onError: () => toast.error(t("settings.locations.createFailed")),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.locations.newTitle")}</DialogTitle>
        </DialogHeader>
        <View className="gap-4">
          <View className="gap-1.5">
            <Label>{t("common.name")}</Label>
            <Input
              value={name}
              onChangeText={setName}
              placeholder={t("settings.locations.namePlaceholder")}
            />
          </View>
          <View className="gap-1.5">
            <Label>{t("common.type")}</Label>
            <ToggleGroup
              type="single"
              value={type}
              onValueChange={(v) => typeof v === "string" && v && setType(v as LocationType)}
            >
              {TYPES.map((locationType) => (
                <ToggleGroupItem key={locationType} value={locationType}>
                  <Text className="text-sm capitalize text-foreground">
                    {t(LOCATION_TYPE_LABEL_KEYS[locationType])}
                  </Text>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </View>
          <Button onPress={submit} isLoading={createLocation.isPending} className="mt-1">
            <Text className="font-semibold text-primary-foreground">{t("common.create")}</Text>
          </Button>
        </View>
      </DialogContent>
    </Dialog>
  );
}
