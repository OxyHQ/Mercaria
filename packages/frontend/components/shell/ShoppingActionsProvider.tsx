import { useCallback, useState, type ReactNode } from 'react';
import { useOxy } from '@oxy.so/services/ui/client';
import { Dialog } from '@oxy.so/bloom/dialog';
import { ListingSaveProvider } from '@mercaria/ui';
import { useToggleListingSave } from '@/lib/hooks/use-saves';
import { useTranslation } from '@/lib/i18n';

export function ShoppingActionsProvider({ children }: { children: ReactNode }) {
  const { canUsePrivateApi, openAccountDialog } = useOxy();
  const { mutateAsync } = useToggleListingSave();
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const save = useCallback(
    async (id: string, nextSaved: boolean) => {
      if (!canUsePrivateApi) {
        openAccountDialog();
        return false;
      }
      try {
        await mutateAsync({ listingId: id, saved: !nextSaved });
        return true;
      } catch {
        setFailed(true);
        return false;
      }
    },
    [canUsePrivateApi, mutateAsync, openAccountDialog],
  );
  return (
    <ListingSaveProvider onSave={save}>
      {children}
      <Dialog
        open={failed}
        onClose={() => setFailed(false)}
        title={t('saved.actionFailed')}
        description={t('saved.error.subtitle')}
        actions={[{ label: t('common.confirm'), onPress: () => setFailed(false) }]}
      />
    </ListingSaveProvider>
  );
}
