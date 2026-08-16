/**
 * Create a product feed (#63's deferred merchant screen, picked up by #87).
 *
 * Two fields carry consequences the form states OUT LOUD rather than leaving in
 * a doc:
 *
 *  - **the identity columns are FROZEN once saved**
 *    (`mercaria_feed_configuration_identity_frozen`). Re-keying re-mints every
 *    object, retires the catalogue behind the old ids, and looks exactly like a
 *    seller who replaced their whole catalogue overnight — so re-keying is a NEW
 *    feed, and the form says so before the merchant commits;
 *  - the **delivery mode** is chosen on the next screen, with the version, and
 *    it has no default there for the same reason.
 */

import React, { useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import { Button, Input, Label, Text } from "@mercaria/ui";
import { toast } from "@oxyhq/bloom/toast";
import { Screen } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { useTranslation } from "@/lib/i18n";
import { useCreateFeed } from "@/lib/hooks/use-feeds";

export default function NewFeedScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("feeds.new.documentTitle")}</title>
      </Head>
      <RequireStore permission="channels:write">
        {(storeId) => <NewFeedBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function NewFeedBody({ storeId }: { storeId: string }) {
  const router = useRouter();
  const { t } = useTranslation();
  const create = useCreateFeed(storeId);
  const [label, setLabel] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [identityColumns, setIdentityColumns] = useState("");

  const submit = () => {
    if (label.trim().length === 0) {
      toast.error(t("feeds.toast.nameRequired"));
      return;
    }
    if (sourceName.trim().length < 3) {
      toast.error(t("feeds.toast.sourceNameTooShort"));
      return;
    }
    // Bounded to four server-side: a composite key longer than that is a row
    // hash wearing a key, and it re-mints the catalogue every time a column
    // moves.
    const identityKeyFields = identityColumns
      .split(",")
      .map((column) => column.trim())
      .filter((column) => column.length > 0);
    if (identityKeyFields.length === 0) {
      toast.error(t("feeds.toast.identityColumnsRequired"));
      return;
    }

    create.mutate(
      { label: label.trim(), sourceName: sourceName.trim(), identityKeyFields },
      {
        onSuccess: (feed) => {
          toast.success(t("feeds.toast.created"));
          router.replace(`/channels/feeds/${feed.id}`);
        },
        onError: () => toast.error(t("feeds.toast.createFailed")),
      },
    );
  };

  return (
    <Screen title={t("feeds.new.title")} subtitle={t("feeds.new.subtitle")}>
      <View className="gap-4 rounded-2xl border border-border bg-surface p-4">
        <View className="gap-1.5">
          <Label>{t("feeds.new.nameLabel")}</Label>
          <Input
            value={label}
            onChangeText={setLabel}
            placeholder={t("feeds.new.namePlaceholder")}
          />
        </View>
        <View className="gap-1.5">
          <Label>{t("feeds.new.sourceNameLabel")}</Label>
          <Input
            value={sourceName}
            onChangeText={setSourceName}
            placeholder={t("feeds.new.sourceNamePlaceholder")}
          />
          <Text className="text-xs text-muted-foreground">{t("feeds.new.sourceNameHint")}</Text>
        </View>
        <View className="gap-1.5">
          <Label>{t("feeds.new.identityColumnsLabel")}</Label>
          <Input
            value={identityColumns}
            onChangeText={setIdentityColumns}
            placeholder={t("feeds.new.identityColumnsPlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text className="text-xs text-muted-foreground">
            {t("feeds.new.identityColumnsHint")}
          </Text>
        </View>
        <Button onPress={submit} isLoading={create.isPending}>
          <Text className="font-semibold text-primary-foreground">{t("feeds.new.create")}</Text>
        </Button>
      </View>
    </Screen>
  );
}
