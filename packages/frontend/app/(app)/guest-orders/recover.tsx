/**
 * "Send me a link to my order" (#108 recovery, ADR 0003 T5).
 *
 * ## This screen cannot tell the buyer whether anything matched, and that is
 * the whole design
 *
 * The server answers 202 with one fixed sentence whether or not an address
 * placed an order, so there is nothing here to branch on — and the hook it
 * calls deliberately returns that sentence and no flag. A screen that had a
 * `matched` boolean would eventually render it, and rendering it would undo
 * every enumeration defence behind it.
 *
 * The consequence is worth stating plainly to the person using it: the message
 * below says a link is on its way IF the purchase exists, which is honest
 * rather than reassuring. Telling somebody "we found your order" is a fact
 * about somebody else's purchase whenever they typed the wrong address.
 *
 * ## The order number is optional and is a HINT
 *
 * Order numbers are printed, sequential and public (ADR 0003 T6). Offering the
 * field helps a buyer who placed several orders reach an older one; it can
 * never widen what a request reaches, and typing one that belongs to somebody
 * else produces exactly the same answer as typing none.
 */

import { useState } from "react";
import { View } from "react-native";
import Head from "expo-router/head";
import { Button, Input, SectionHeader, Text } from "@mercaria/ui";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { usePortalRecoveryRequest } from "@/lib/hooks/use-guest-portal";
import { useTranslation } from "@/lib/i18n";

function RecoverBody() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
  const request = usePortalRecoveryRequest();

  const submit = () => {
    const trimmed = email.trim();
    if (trimmed.length < 3) return;
    request.mutate({
      email: trimmed,
      ...(orderNumber.trim() === "" ? {} : { orderNumber: orderNumber.trim() }),
    });
  };

  if (request.isSuccess) {
    return (
      <View className="px-4 gap-4" accessibilityLiveRegion="polite">
        <SectionHeader title={t("guestOrders.recover.sentTitle")} />
        {/*
          The SERVER's sentence, rendered verbatim rather than reworded here:
          two places writing this message is two places for one of them to
          become more informative than the other.
        */}
        <Text className="text-sm text-muted-foreground">{request.data}</Text>
        <Text className="text-sm text-muted-foreground">
          {t("guestOrders.recover.sentBody")}
        </Text>
      </View>
    );
  }

  return (
    <View className="px-4 gap-4">
      <SectionHeader title={t("guestOrders.recover.title")} />
      <Text className="text-sm text-muted-foreground">
        {t("guestOrders.recover.body")}
      </Text>

      <Input
        value={email}
        onChangeText={setEmail}
        placeholder={t("guestOrders.recover.emailPlaceholder")}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        accessibilityLabel={t("guestOrders.recover.emailLabel")}
      />
      <Input
        value={orderNumber}
        onChangeText={setOrderNumber}
        placeholder={t("guestOrders.recover.orderNumberPlaceholder")}
        autoCapitalize="characters"
        autoCorrect={false}
        accessibilityLabel={t("guestOrders.recover.orderNumberLabel")}
      />

      <Button onPress={submit} disabled={request.isPending || email.trim().length < 3}>
        <Text className="text-sm font-semibold text-primary-foreground">
          {request.isPending ? t("guestOrders.recover.sending") : t("guestOrders.sendAccessLink")}
        </Text>
      </Button>

      {request.isError ? (
        // A network failure, which is the ONLY error this screen can see: the
        // server never reports a non-match as one.
        <Text className="text-sm text-muted-foreground" accessibilityRole="alert">
          {t("guestOrders.recover.networkError")}
        </Text>
      ) : null}
    </View>
  );
}

export default function GuestOrderRecoverScreen() {
  const { t } = useTranslation();
  return (
    <ScreenShell contentClassName="pt-5 web:max-w-[720px]">
      <Head>
        <title>{t("guestOrders.recover.pageTitle")}</title>
        <meta name="referrer" content="no-referrer" />
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <RecoverBody />
    </ScreenShell>
  );
}
