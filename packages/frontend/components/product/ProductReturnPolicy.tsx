import { useMemo, useState } from "react";
import { Button } from "@oxy.so/bloom/button";
import { MarketplaceSheet, ProductRichText, Text, prepareProductDescription, useShopControlClassName } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";

/** The policy belongs to the selected merchant offer. Do not derive a return
 * window or eligibility promise from its authored text. */
export function ProductReturnPolicy({ policy }: { policy: string }) {
  const { t } = useTranslation();
  const controlClassName = useShopControlClassName();
  const [open, setOpen] = useState(false);
  const { html, full } = useMemo(() => prepareProductDescription(policy), [policy]);

  return (
    <>
      <Button
        testID="structured-policies-return-policy"
        material="flat"
        className={`${controlClassName("tertiary")} min-h-space-40 ps-space-12 pe-space-16`}
        onPress={() => setOpen(true)}
      >
        <Text className="text-shop-bodyTitleSmall text-text">{t("product.returnPolicy")}</Text>
      </Button>
      <MarketplaceSheet open={open} onClose={() => setOpen(false)} opaque
        title={t("product.returnPolicy")} testID="product-return-policy-dialog">
        {html ? <ProductRichText nodes={full} /> : <Text selectable className="text-shop-bodySmall text-text">{policy}</Text>}
      </MarketplaceSheet>
    </>
  );
}
