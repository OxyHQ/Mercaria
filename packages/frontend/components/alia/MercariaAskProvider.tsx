/**
 * Alia in Mercaria: the SDK's one sheet, mounted once above the app frame.
 *
 * It is the storefront's ONLY chat surface — there is no shopping-thread page.
 * The composer asks it (`useAskAgent().ask(undefined, turn)`), "Keep shopping"
 * reopens a conversation in it (`resume`), and signed out the SDK opens Oxy's
 * sign-in instead. Alia leads; she reaches the catalogue through Mercaria's
 * capability catalogue (`oxy_mercaria__searchProducts`), and the person present
 * pays with their own Alia credits (Alia ADR 0020).
 *
 * Mercaria brings only what is Mercaria's: its name (`MERCARIA_APP`, which
 * labels the conversations the sheet starts), the product cards
 * (`MERCARIA_TOOL_RENDERERS`) and the screen's context.
 *
 * Must sit inside `OxyProvider` (auth), the router and the query client the
 * cards read.
 */

import { AliaAskProvider } from '@alia.onl/sdk/ask';
import type { ReactNode } from 'react';
import { MERCARIA_TOOL_RENDERERS } from '@/components/thread/mercariaToolRenderers';
import { MERCARIA_APP } from '@/lib/alia/mercaria-app';
import { useTranslation } from '@/lib/i18n';

export function MercariaAskProvider({ children }: { children: ReactNode }) {
  const { locale } = useTranslation();
  return (
    <AliaAskProvider
      app={MERCARIA_APP}
      toolRenderers={MERCARIA_TOOL_RENDERERS}
      clientContext={`Mercaria, Oxy's marketplace. Locale: ${locale}. Search Mercaria's catalogue for products; the app draws the products the search returns, so name them without repeating their details.`}
    >
      {children}
    </AliaAskProvider>
  );
}
