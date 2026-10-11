import { useState } from 'react';
import { Pressable } from 'react-native';
import { CircleAlert, MoreHorizontal } from 'lucide-react-native';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import { useDialogControl } from '@oxy.so/bloom/dialog';
import { Icon, ShopDetailIcon, Text } from '@mercaria/ui';
import { StoreContactDialog } from '@/components/store/StoreContactDialog';
import { useStoreLocations } from '@/lib/hooks/use-visit-us';
import { AbuseReportDialog } from '@/components/reports/AbuseReportDialog';
import { useTranslation } from '@/lib/i18n';

/** Actions belong to the displayed listing, including a person's secondhand item.
 * Contact reads published, bidirectionally linked GoWay places through the SDK.
 * Canonical products are not moderation listing subjects and cannot use this menu.
 */
export function ProductActionsMenu({
  listingId,
  title,
  store,
  outlined = false,
}: {
  listingId: string;
  title: string;
  store?: { id: string; name: string };
  outlined?: boolean;
}) {
  const { t } = useTranslation();
  const reportControl = useDialogControl();
  const [contactOpen, setContactOpen] = useState(false);
  const locations = useStoreLocations(store?.id ?? '');
  const hasContact = store && (locations.isError || (locations.data?.length ?? 0) > 0);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild label={t('product.moreActions')}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('product.moreActions')}
            hitSlop={8}
            className={`min-h-11 min-w-11 items-center justify-center rounded-full web:hover:bg-muted active:bg-muted ${outlined ? 'border border-border-image bg-bg-fill' : '-my-1.5'}`}
          >
            <Icon as={MoreHorizontal} size={24} className="text-text-tertiary" />
          </Pressable>
        </DropdownMenuTrigger>
        <DropdownMenuContent label={t('product.moreActions')} align="end" minWidth={224}>
          {hasContact ? (
            <DropdownMenuItem
              leading={<ShopDetailIcon name="shopChat" size={24} className="text-text" />}
              accessibilityLabel={t('store.contact.title', { store: store.name })}
              onPress={() => setContactOpen(true)}
            >
              <Text className="text-base leading-[22px] tracking-[-0.5px] text-text">
                {t('store.contact.title', { store: store.name })}
              </Text>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            variant="destructive"
            leading={<Icon as={CircleAlert} size={24} className="text-destructive" />}
            accessibilityLabel={t('product.reportProduct')}
            onPress={reportControl.open}
          >
            <Text className="text-base leading-[22px] tracking-[-0.5px] text-destructive">
              {t('product.reportProduct')}
            </Text>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {store ? (
        <StoreContactDialog
          key={store.id}
          storeId={store.id}
          storeName={store.name}
          open={contactOpen}
          onClose={() => setContactOpen(false)}
        />
      ) : null}
      <AbuseReportDialog
        key={listingId}
        reportedType="listing"
        reportedId={listingId}
        displayName={title}
        control={reportControl}
      />
    </>
  );
}
