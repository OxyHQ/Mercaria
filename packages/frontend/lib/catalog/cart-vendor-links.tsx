import type { ReactElement } from 'react';
import { Link } from 'expo-router';
import type { CartVendor } from '@mercaria/shared-types';

/** Cart vendors retain their own route; an unavailable store handle is not a link. */
export function renderCartVendorLink(vendor: CartVendor, child: ReactElement) {
  if (vendor.kind === 'user') {
    return (
      <Link href={{ pathname: '/sellers/[oxyUserId]', params: { oxyUserId: vendor.id } }} asChild>
        {child}
      </Link>
    );
  }
  if (!vendor.handle) return null;
  return (
    <Link href={{ pathname: '/stores/[handle]', params: { handle: vendor.handle } }} asChild>
      {child}
    </Link>
  );
}
