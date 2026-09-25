import { useRouter } from "expo-router";
import { PageHeader } from "@oxy.so/bloom/page-header";
import { useTranslation } from "@/lib/i18n";

interface SettingsHeaderProps {
  title: string;
  subtitle?: string;
  showBack?: boolean;
  onBack?: () => void;
}

/**
 * The settings screens' header. Navigation below `md` is the AppShell's
 * BottomBar, so there is no menu button here — only an optional back.
 */
export function SettingsHeader({ title, subtitle, showBack = false, onBack }: SettingsHeaderProps) {
  const router = useRouter();
  const { t } = useTranslation();

  return (
    <PageHeader
      presentation="bar"
      title={title}
      subtitle={subtitle}
      onBack={showBack ? (onBack ?? router.back) : undefined}
      backLabel={t("common.back")}
    />
  );
}
