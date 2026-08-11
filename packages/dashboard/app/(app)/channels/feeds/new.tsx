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
import { useCreateFeed } from "@/lib/hooks/use-feeds";

export default function NewFeedScreen() {
  return (
    <>
      <Head>
        <title>New product feed | Mercaria Dashboard</title>
      </Head>
      <RequireStore permission="channels:write">
        {(storeId) => <NewFeedBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function NewFeedBody({ storeId }: { storeId: string }) {
  const router = useRouter();
  const create = useCreateFeed(storeId);
  const [label, setLabel] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [identityColumns, setIdentityColumns] = useState("");

  const submit = () => {
    if (label.trim().length === 0) {
      toast.error("Give the feed a name");
      return;
    }
    if (sourceName.trim().length < 3) {
      toast.error("The source name needs at least 3 characters");
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
      toast.error("Name at least one column that identifies each product");
      return;
    }

    create.mutate(
      { label: label.trim(), sourceName: sourceName.trim(), identityKeyFields },
      {
        onSuccess: (feed) => {
          toast.success("Feed created");
          router.replace(`/channels/feeds/${feed.id}`);
        },
        onError: () => toast.error("Couldn't create the feed"),
      },
    );
  };

  return (
    <Screen
      title="New product feed"
      subtitle="A CSV, TSV, XML, JSON or JSONL file Mercaria reads on a schedule"
    >
      <View className="gap-4 rounded-2xl border border-border bg-surface p-4">
        <View className="gap-1.5">
          <Label>Feed name</Label>
          <Input value={label} onChangeText={setLabel} placeholder="Main catalog" />
        </View>
        <View className="gap-1.5">
          <Label>Source name</Label>
          <Input
            value={sourceName}
            onChangeText={setSourceName}
            placeholder="Acme Supplies catalog"
          />
          <Text className="text-xs text-muted-foreground">
            How this feed appears in Mercaria&apos;s own catalog records.
          </Text>
        </View>
        <View className="gap-1.5">
          <Label>Columns that identify each product</Label>
          <Input
            value={identityColumns}
            onChangeText={setIdentityColumns}
            placeholder="id, sku"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text className="text-xs text-muted-foreground">
            Comma-separated, up to four. These cannot be changed later: they are how Mercaria
            recognises the same product between one file and the next, so changing them would look
            like you replaced your entire catalogue. If you need different columns, create a new
            feed.
          </Text>
        </View>
        <Button onPress={submit} isLoading={create.isPending}>
          <Text className="font-semibold text-primary-foreground">Create feed</Text>
        </Button>
      </View>
    </Screen>
  );
}
