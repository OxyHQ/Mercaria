import { Linking } from 'react-native';
import { goWayPlaceUrl } from './goway-url';

/**
 * Open a collection point's GoWay page — in a new tab on web, in the browser
 * or the GoWay app on native.
 *
 * The storefront shows what a shopper needs to choose a shop and collect from
 * it; everything else about the building — its full hours, photos, reviews,
 * how to get there — is GoWay's page (ADR 0013), and the storefront links to it
 * rather than restating it.
 */
export function openGoWayPlace(goWayPlaceId: string): void {
  void Linking.openURL(goWayPlaceUrl(goWayPlaceId));
}
