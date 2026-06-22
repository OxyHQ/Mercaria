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
import { toast } from "@/components/sonner";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { useLocations, useCreateLocation, useDeleteLocation } from "@/lib/hooks/use-tax-and-locations";

const TYPES: LocationType[] = ["warehouse", "retail", "pop_up", "virtual"];

export default function LocationsScreen() {
  return (
    <>
      <Head>
        <title>Locations | Mercaria Dashboard</title>
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
        <Text className="text-sm font-medium text-foreground">Back</Text>
      </Pressable>
      <Button onPress={() => setCreateOpen(true)}>
        <View className="flex-row items-center gap-2">
          <Plus size={16} color={colors.primaryForeground} />
          <Text className="font-semibold text-primary-foreground">New</Text>
        </View>
      </Button>
    </View>
  );

  return (
    <Screen title="Locations" subtitle="Where you stock inventory" action={back}>
      {isPending ? (
        <ScreenLoading />
      ) : isError ? (
        <ScreenMessage title="Couldn't load locations" body="Please try again." />
      ) : (
        <View className="gap-2">
          {data?.map((location) => (
            <LocationRow
              key={location.id}
              location={location}
              onDelete={() =>
                deleteLocation.mutate(location.id, {
                  onSuccess: () => toast.success("Location deleted"),
                  onError: () => toast.error("Couldn't delete the location"),
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
  return (
    <View className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-3">
      <View className="h-10 w-10 items-center justify-center rounded-xl bg-muted">
        <MapPin size={18} color={colors.mutedForeground} />
      </View>
      <View className="flex-1">
        <Text className="text-sm font-semibold text-foreground">{location.name}</Text>
        <Text className="text-xs capitalize text-muted-foreground">
          {location.type.replace("_", " ")}
          {location.isDefault ? " · default" : ""}
          {location.isActive ? "" : " · inactive"}
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
  const [name, setName] = useState("");
  const [type, setType] = useState<LocationType>("warehouse");

  const submit = () => {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    createLocation.mutate(
      { name: name.trim(), type },
      {
        onSuccess: () => {
          toast.success("Location created");
          setName("");
          setType("warehouse");
          onOpenChange(false);
        },
        onError: () => toast.error("Couldn't create the location"),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New location</DialogTitle>
        </DialogHeader>
        <View className="gap-4">
          <View className="gap-1.5">
            <Label>Name</Label>
            <Input value={name} onChangeText={setName} placeholder="Main warehouse" />
          </View>
          <View className="gap-1.5">
            <Label>Type</Label>
            <ToggleGroup
              type="single"
              value={type}
              onValueChange={(v) => typeof v === "string" && v && setType(v as LocationType)}
            >
              {TYPES.map((t) => (
                <ToggleGroupItem key={t} value={t}>
                  <Text className="text-sm capitalize text-foreground">{t.replace("_", " ")}</Text>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </View>
          <Button onPress={submit} isLoading={createLocation.isPending} className="mt-1">
            <Text className="font-semibold text-primary-foreground">Create</Text>
          </Button>
        </View>
      </DialogContent>
    </Dialog>
  );
}
