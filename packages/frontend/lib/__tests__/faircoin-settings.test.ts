import { describe, expect, it } from 'vitest';
import type { SellerFaircoinStatus, SellerPaymentSettings } from '@mercaria/shared-types';
import { faircoinCard } from '../faircoin-settings';

function settings(
  faircoin: SellerFaircoinStatus,
  onboardingAvailable = true,
): SellerPaymentSettings {
  return {
    account: {} as SellerPaymentSettings['account'],
    faircoin,
    onboardingAvailable,
  };
}

describe("a seller's FairCoin card", () => {
  it('offers the one setup step while nothing is set up, without repeating the reason', () => {
    const card = faircoinCard(
      settings({
        state: 'not_connected',
        network: 'mainnet',
        payable: false,
        unavailableReason: 'seller_not_connected',
      }),
    );
    expect(card).toMatchObject({ state: 'not_connected', offersSetup: true, reasonKey: null });
  });

  it('offers the step again while the confirmation is pending', () => {
    const card = faircoinCard(
      settings({
        state: 'pending',
        network: 'testnet',
        payable: false,
        unavailableReason: 'seller_not_confirmed',
      }),
    );
    expect(card).toMatchObject({ state: 'pending', offersSetup: true, reasonKey: null });
  });

  it('is active and offers nothing once confirmed and payable', () => {
    const card = faircoinCard(
      settings({
        state: 'active',
        network: 'mainnet',
        payable: true,
        confirmedAt: '2026-11-06T00:00:00.000Z',
      }),
    );
    expect(card).toMatchObject({ state: 'active', offersSetup: false, reasonKey: null });
  });

  it('says in words why a confirmed seller cannot be paid right now', () => {
    const card = faircoinCard(
      settings({
        state: 'active',
        network: 'mainnet',
        payable: false,
        unavailableReason: 'faircoin_network_closed',
      }),
    );
    expect(card.state).toBe('active_unavailable');
    expect(card.reasonKey).toBe('settings.payments.faircoin.reasons.networkClosed');
    expect(card.offersSetup).toBe(false);
  });

  it('offers no step where the deployment cannot open one', () => {
    const disabled = faircoinCard(
      settings({
        state: 'not_connected',
        network: 'testnet',
        payable: false,
        unavailableReason: 'rail_disabled',
      }),
    );
    expect(disabled.offersSetup).toBe(false);
    expect(disabled.reasonKey).toBe('settings.payments.faircoin.reasons.railDisabled');
    const noEvents = faircoinCard(
      settings(
        {
          state: 'not_connected',
          network: 'testnet',
          payable: false,
          unavailableReason: 'seller_not_connected',
        },
        false,
      ),
    );
    expect(noEvents.offersSetup).toBe(false);
  });
});
