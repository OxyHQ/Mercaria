import { useMemo } from "react";
import { View } from "react-native";
import type { CheckoutAddressInput, CheckoutContactInput } from "@mercaria/shared-types";
import { Button, Input, Label, Switch, Text } from "@mercaria/ui";

/**
 * The ONE inline destination + contact form, shared by guests and signed-in
 * buyers (#105 frontend rule 7).
 *
 * One form for both actor kinds, deliberately: there is nothing guest-shaped
 * about typing an address, and two forms would be two places for a field, a
 * label, an autofill hint or an accessibility attribute to drift. What differs
 * between the two is decided by the CALLER — whether a saved-address list is
 * offered at all, and whether "save this address" is available — and is passed
 * in as props rather than derived here from an auth hook.
 *
 * ## The draft is CONTROLLED from above
 *
 * Every value comes in and every change goes out. That is what makes #105
 * frontend rule 9 ("preserve input across ordinary validation errors and
 * required payment authentication") true without any persistence: the state
 * lives on the checkout screen, which is not unmounted by a failed mutation,
 * and by the time a payment sheet or a bank redirect happens the order already
 * exists and its contact is snapshotted server-side — so there is nothing left
 * to re-type and nothing to persist.
 *
 * Which is also rule 10: no contact or address value is ever written to a URL,
 * to storage, or to a log. The values exist in React state and in one request
 * body.
 */

/** The draft the screen holds. Strings throughout — this is a form. */
export interface CheckoutDestinationDraft {
  address: CheckoutAddressInput;
  contact: CheckoutContactInput;
  /** Opt-IN, and only meaningful for a signed-in buyer. */
  saveToAddressBook: boolean;
  /** Opt-IN, separate from the purchase's own transactional permission. */
  marketingOptIn: boolean;
}

/** An empty draft — the starting point for both actor kinds. */
export const EMPTY_CHECKOUT_DRAFT: CheckoutDestinationDraft = {
  address: {
    recipientName: "",
    line1: "",
    city: "",
    postalCode: "",
    country: "",
  },
  contact: { email: "" },
  saveToAddressBook: false,
  marketingOptIn: false,
};

export interface CheckoutDestinationFormProps {
  draft: CheckoutDestinationDraft;
  onChange: (next: CheckoutDestinationDraft) => void;
  /**
   * Whether "save this address to my account" may be offered.
   *
   * `false` for a guest — there is no account to save it to, and the server
   * would ignore the field anyway (the address book is Oxy-scoped). Passing it
   * in rather than reading an auth hook here keeps this component a pure form.
   */
  canSaveToAddressBook: boolean;
  /**
   * Collection points this checkout could use.
   *
   * EMPTY today, and the shipping fields are what render as a result. Pickup
   * locations are #93's to supply, and the server refuses a pickup destination
   * until they exist — so offering the choice before then would be a dead end a
   * buyer could walk into. When #93 lands, this prop carries real locations and
   * the chooser below appears with no other change here.
   */
  pickupLocations?: readonly { id: string; name: string }[];
  /** The chosen collection point, when the buyer picked one. */
  pickupLocationId?: string;
  onChangePickupLocation?: (locationId: string | undefined) => void;
}

/** The required-field set the submit button gates on (the server re-checks). */
export function isDraftComplete(draft: CheckoutDestinationDraft): boolean {
  const { address, contact } = draft;
  return (
    contact.email.trim().length > 0 &&
    address.recipientName.trim().length > 0 &&
    address.line1.trim().length > 0 &&
    address.city.trim().length > 0 &&
    address.postalCode.trim().length > 0 &&
    address.country.trim().length === 2
  );
}

/**
 * Trim every field and DROP the empty optionals.
 *
 * An empty optional must not travel as `""`: the server treats an empty string
 * as absent anyway, and a `line2: ""` on the wire is a blank line waiting to be
 * printed on a shipping label by anything less careful.
 */
export function cleanAddress(address: CheckoutAddressInput): CheckoutAddressInput {
  const out: CheckoutAddressInput = {
    recipientName: address.recipientName.trim(),
    line1: address.line1.trim(),
    city: address.city.trim(),
    postalCode: address.postalCode.trim(),
    country: address.country.trim().toUpperCase(),
  };
  if (address.line2?.trim()) out.line2 = address.line2.trim();
  if (address.region?.trim()) out.region = address.region.trim();
  if (address.phone?.trim()) out.phone = address.phone.trim();
  return out;
}

/** {@link cleanAddress} for the contact half. */
export function cleanContact(contact: CheckoutContactInput): CheckoutContactInput {
  const out: CheckoutContactInput = { email: contact.email.trim() };
  if (contact.phone?.trim()) out.phone = contact.phone.trim();
  return out;
}

export function CheckoutDestinationForm({
  draft,
  onChange,
  canSaveToAddressBook,
  pickupLocations = [],
  pickupLocationId,
  onChangePickupLocation,
}: CheckoutDestinationFormProps) {
  const setAddress = (key: keyof CheckoutAddressInput) => (value: string) =>
    onChange({ ...draft, address: { ...draft.address, [key]: value } });
  const setContact = (key: keyof CheckoutContactInput) => (value: string) =>
    onChange({ ...draft, contact: { ...draft.contact, [key]: value } });

  const collecting = pickupLocationId !== undefined;
  // Derived, never stored: the chooser exists only when there is something to
  // choose between, so it cannot present an option the server would refuse.
  const offersPickup = useMemo(() => pickupLocations.length > 0, [pickupLocations.length]);

  return (
    <View className="gap-4">
      {/*
        Contact FIRST. It is what a receipt and every order update are sent to,
        and Stripe's integration expects an email to be collected before the
        payment surface renders (#105 frontend rule 5).
      */}
      <View className="gap-1.5">
        <Label nativeID="checkout-email">Email</Label>
        <Input
          aria-labelledby="checkout-email"
          accessibilityLabel="Email address for your order confirmation"
          value={draft.contact.email}
          onChangeText={setContact("email")}
          placeholder="you@example.com"
          keyboardType="email-address"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="emailAddress"
          returnKeyType="next"
        />
        <Text className="text-xs text-muted-foreground">
          We use this to send your receipt and delivery updates for this order.
        </Text>
      </View>

      {offersPickup ? (
        <View className="gap-2">
          <Text className="text-sm font-semibold text-foreground">How would you like it?</Text>
          <View className="flex-row gap-2">
            <Button
              variant={collecting ? "outline" : "default"}
              accessibilityRole="radio"
              accessibilityState={{ selected: !collecting }}
              onPress={() => onChangePickupLocation?.(undefined)}
            >
              <Text className="text-sm font-medium">Deliver to an address</Text>
            </Button>
            {pickupLocations.map((location) => (
              <Button
                key={location.id}
                variant={pickupLocationId === location.id ? "default" : "outline"}
                accessibilityRole="radio"
                accessibilityState={{ selected: pickupLocationId === location.id }}
                onPress={() => onChangePickupLocation?.(location.id)}
              >
                <Text className="text-sm font-medium">{location.name}</Text>
              </Button>
            ))}
          </View>
        </View>
      ) : null}

      {/*
        Shipping fields render unless the buyer chose collection — the one
        conditional #105 frontend rule 8 asks for, and the reason a collection
        needs no invented street.
      */}
      {collecting ? (
        <View className="gap-1.5">
          <Label nativeID="checkout-pickup-phone">Phone for collection (optional)</Label>
          <Input
            aria-labelledby="checkout-pickup-phone"
            accessibilityLabel="Phone number for collection"
            value={draft.contact.phone ?? ""}
            onChangeText={setContact("phone")}
            placeholder="+34 600 000 000"
            keyboardType="phone-pad"
            inputMode="tel"
            autoComplete="tel"
            textContentType="telephoneNumber"
          />
        </View>
      ) : (
        <>
          <View className="gap-1.5">
            <Label nativeID="checkout-recipient">Recipient name</Label>
            <Input
              aria-labelledby="checkout-recipient"
              accessibilityLabel="Name of the person receiving the parcel"
              value={draft.address.recipientName}
              onChangeText={setAddress("recipientName")}
              placeholder="Jane Doe"
              autoComplete="name"
              textContentType="name"
              returnKeyType="next"
            />
          </View>
          <View className="gap-1.5">
            <Label nativeID="checkout-line1">Address line 1</Label>
            <Input
              aria-labelledby="checkout-line1"
              accessibilityLabel="Street address"
              value={draft.address.line1}
              onChangeText={setAddress("line1")}
              placeholder="1 Market Street"
              autoComplete="street-address"
              textContentType="streetAddressLine1"
              returnKeyType="next"
            />
          </View>
          <View className="gap-1.5">
            <Label nativeID="checkout-line2">Address line 2 (optional)</Label>
            <Input
              aria-labelledby="checkout-line2"
              accessibilityLabel="Apartment, suite or unit"
              value={draft.address.line2 ?? ""}
              onChangeText={setAddress("line2")}
              placeholder="Apt 4B"
              textContentType="streetAddressLine2"
              returnKeyType="next"
            />
          </View>
          <View className="flex-row gap-3">
            <View className="flex-1 gap-1.5">
              <Label nativeID="checkout-city">City</Label>
              <Input
                aria-labelledby="checkout-city"
                accessibilityLabel="City"
                value={draft.address.city}
                onChangeText={setAddress("city")}
                placeholder="Valencia"
                autoComplete="postal-address-locality"
                textContentType="addressCity"
                returnKeyType="next"
              />
            </View>
            <View className="flex-1 gap-1.5">
              <Label nativeID="checkout-region">Region (optional)</Label>
              <Input
                aria-labelledby="checkout-region"
                accessibilityLabel="State, province or region"
                value={draft.address.region ?? ""}
                onChangeText={setAddress("region")}
                placeholder="Valencia"
                autoComplete="postal-address-region"
                textContentType="addressState"
                returnKeyType="next"
              />
            </View>
          </View>
          <View className="flex-row gap-3">
            <View className="flex-1 gap-1.5">
              <Label nativeID="checkout-postal">Postal code</Label>
              <Input
                aria-labelledby="checkout-postal"
                accessibilityLabel="Postal or ZIP code"
                value={draft.address.postalCode}
                onChangeText={setAddress("postalCode")}
                placeholder="46004"
                inputMode="text"
                autoComplete="postal-code"
                textContentType="postalCode"
                returnKeyType="next"
              />
            </View>
            <View className="flex-1 gap-1.5">
              <Label nativeID="checkout-country">Country</Label>
              <Input
                aria-labelledby="checkout-country"
                accessibilityLabel="Two-letter country code"
                value={draft.address.country}
                onChangeText={setAddress("country")}
                placeholder="ES"
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={2}
                autoComplete="postal-address-country"
                textContentType="countryName"
                returnKeyType="next"
              />
            </View>
          </View>
          <View className="gap-1.5">
            <Label nativeID="checkout-phone">Delivery phone (optional)</Label>
            <Input
              aria-labelledby="checkout-phone"
              accessibilityLabel="Phone number the courier can call"
              value={draft.address.phone ?? ""}
              onChangeText={setAddress("phone")}
              placeholder="+34 600 000 000"
              keyboardType="phone-pad"
              inputMode="tel"
              autoComplete="tel"
              textContentType="telephoneNumber"
              returnKeyType="done"
            />
          </View>
        </>
      )}

      {/*
        Saving is an ACCOUNT feature and an explicit, separate opt-in (#105
        actor rule 4). A guest never sees it, because there is no account to
        save into — not because the control is hidden from them.
      */}
      {canSaveToAddressBook && !collecting ? (
        <View className="flex-row items-center justify-between gap-3">
          <Text className="flex-1 text-sm text-foreground">Save this address to my account</Text>
          <Switch
            value={draft.saveToAddressBook}
            onValueChange={(next) => onChange({ ...draft, saveToAddressBook: next })}
            accessibilityLabel="Save this address to my account"
          />
        </View>
      ) : null}

      {/*
        Marketing consent: SEPARATE, optional, and unchecked (#105 privacy rules
        1-2). Permission to send a receipt comes from the purchase itself and is
        stated above the email field; this is the other thing entirely, and
        buying does not depend on it.
      */}
      <View className="flex-row items-center justify-between gap-3">
        <Text className="flex-1 text-sm text-foreground">
          Email me offers and new arrivals. Optional — your order does not depend on it.
        </Text>
        <Switch
          value={draft.marketingOptIn}
          onValueChange={(next) => onChange({ ...draft, marketingOptIn: next })}
          accessibilityLabel="Email me offers and new arrivals"
        />
      </View>

      {/*
        What each seller is told. Stated on the page rather than buried in a
        policy, because #105 privacy rule 3 asks for it to be clear at the point
        of collection — and it is short enough to be true: the fulfilment
        snapshot and nothing else.
      */}
      <Text className="text-xs text-muted-foreground">
        Each seller receives only what they need to fulfil their part of your order: the delivery
        address, the recipient name and any delivery phone you give. Your email address stays with
        Mercaria.
      </Text>
    </View>
  );
}
