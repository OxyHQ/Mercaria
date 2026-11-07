import { Redirect, useLocalSearchParams } from 'expo-router';

/** Compatibility for saved purchase/pickup links; checkout lives in Peable's sheet. */
export default function CheckoutLink() {
  const { seller, pickup } = useLocalSearchParams<{ seller?: string; pickup?: string }>();
  return (
    <Redirect
      href={{
        pathname: '/cart',
        params: { pay: '1', ...(seller ? { seller } : {}), ...(pickup ? { pickup } : {}) },
      }}
    />
  );
}
