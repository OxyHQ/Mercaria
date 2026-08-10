/**
 * Who books the transport (#126 §"Supplier-to-Moovo fulfilment modes").
 *
 * Every case here exists because the two functions fail in OPPOSITE directions:
 * `determinePermittedFulfilmentMode` refusing too readily blocks a sale that a
 * signed agreement permits, and permitting too readily hands a supplier a
 * logistics document its warehouse never agreed to accept. So the fixtures
 * exercise each grant independently rather than only the both-granted and
 * neither-granted corners, which are the two that agree under every plausible
 * implementation.
 */

import { describe, expect, it } from 'vitest';
import {
  chooseFulfilmentMode,
  determinePermittedFulfilmentMode,
} from '../fulfilment-mode.js';

describe('determinePermittedFulfilmentMode', () => {
  it('refuses an agreement that is not in force, whatever it grants', () => {
    // A lapsed agreement granting BOTH rights is the fixture that matters: an
    // implementation reading the grants first and the window afterwards passes
    // every neither-granted case and permits this one.
    expect(
      determinePermittedFulfilmentMode({
        inForce: false,
        dropshipRightsGranted: true,
        moovoLabelDispatchPermitted: true,
      }),
    ).toEqual({ outcome: 'refused', reason: 'agreement_not_in_force' });
  });

  it('refuses an in-force agreement that grants no dispatch right at all', () => {
    expect(
      determinePermittedFulfilmentMode({
        inForce: true,
        dropshipRightsGranted: false,
        moovoLabelDispatchPermitted: false,
      }),
    ).toEqual({ outcome: 'refused', reason: 'no_dispatch_right_granted' });
  });

  it('permits ONLY supplier-controlled when dropship alone is granted', () => {
    expect(
      determinePermittedFulfilmentMode({
        inForce: true,
        dropshipRightsGranted: true,
        moovoLabelDispatchPermitted: false,
      }),
    ).toEqual({ outcome: 'permitted', permitted: 'supplier_controlled' });
  });

  it('permits ONLY Moovo-controlled when the label flow alone is granted', () => {
    // The asymmetric fixture. A supplier can grant Moovo label dispatch without
    // granting its own dropship carriage, and an implementation that treated
    // `moovoLabelDispatchPermitted` as an ADDITION to dropship would answer
    // `either` here — permitting a mode the agreement withheld.
    expect(
      determinePermittedFulfilmentMode({
        inForce: true,
        dropshipRightsGranted: false,
        moovoLabelDispatchPermitted: true,
      }),
    ).toEqual({ outcome: 'permitted', permitted: 'moovo_controlled' });
  });

  it('permits either when both are granted', () => {
    expect(
      determinePermittedFulfilmentMode({
        inForce: true,
        dropshipRightsGranted: true,
        moovoLabelDispatchPermitted: true,
      }),
    ).toEqual({ outcome: 'permitted', permitted: 'either' });
  });
});

describe('chooseFulfilmentMode', () => {
  it('is undecided before the supplier has accepted, however much is permitted', () => {
    expect(
      chooseFulfilmentMode({
        permitted: 'either',
        procurementAccepted: false,
        packageFactsVerified: true,
        moovoBookingAvailable: true,
      }),
    ).toEqual({ outcome: 'undecided', reason: 'procurement_not_accepted' });
  });

  it('prefers Moovo when it is permitted and both preconditions hold', () => {
    expect(
      chooseFulfilmentMode({
        permitted: 'either',
        procurementAccepted: true,
        packageFactsVerified: true,
        moovoBookingAvailable: true,
      }),
    ).toEqual({ outcome: 'chosen', mode: 'moovo_controlled' });
  });

  it('falls back to supplier-controlled when Moovo cannot book — with `either`', () => {
    // Not a degradation: a supplier booking its own carrier is a complete
    // fulfilment path, and refusing it because Mode A was unavailable would
    // strand a paid order for a preference.
    expect(
      chooseFulfilmentMode({
        permitted: 'either',
        procurementAccepted: true,
        packageFactsVerified: true,
        moovoBookingAvailable: false,
      }),
    ).toEqual({ outcome: 'chosen', mode: 'supplier_controlled' });
  });

  it('falls back to supplier-controlled when package facts are unverified', () => {
    expect(
      chooseFulfilmentMode({
        permitted: 'either',
        procurementAccepted: true,
        packageFactsVerified: false,
        moovoBookingAvailable: true,
      }),
    ).toEqual({ outcome: 'chosen', mode: 'supplier_controlled' });
  });

  it('never falls back to a mode the agreement did NOT permit', () => {
    // The load-bearing case. With only Moovo permitted and its preconditions
    // unmet there is nothing to fall back to, and answering
    // `supplier_controlled` would grant carriage the agreement withheld — the
    // row's own CHECK would refuse the write, but a service that got here would
    // be reporting a decision it had no right to make.
    expect(
      chooseFulfilmentMode({
        permitted: 'moovo_controlled',
        procurementAccepted: true,
        packageFactsVerified: false,
        moovoBookingAvailable: true,
      }),
    ).toEqual({ outcome: 'undecided', reason: 'package_facts_unverified' });

    expect(
      chooseFulfilmentMode({
        permitted: 'moovo_controlled',
        procurementAccepted: true,
        packageFactsVerified: true,
        moovoBookingAvailable: false,
      }),
    ).toEqual({ outcome: 'undecided', reason: 'moovo_booking_unavailable' });
  });

  it('names the package facts before Moovo when BOTH are missing', () => {
    // The reason routes an operator to a system. Reporting "Moovo is
    // unavailable" for an order whose supplier has not confirmed what it is
    // handing over sends them to the wrong one.
    expect(
      chooseFulfilmentMode({
        permitted: 'moovo_controlled',
        procurementAccepted: true,
        packageFactsVerified: false,
        moovoBookingAvailable: false,
      }),
    ).toEqual({ outcome: 'undecided', reason: 'package_facts_unverified' });
  });

  it('has no `mode` property at all on the undecided branch', () => {
    // #126 rule "unknown stays unknown", held by the TYPE. A caller cannot read
    // an undecided answer as a mode without writing the coercion out loud, and
    // this asserts the runtime value matches what the type promises.
    const answer = chooseFulfilmentMode({
      permitted: 'either',
      procurementAccepted: false,
      packageFactsVerified: true,
      moovoBookingAvailable: true,
    });
    expect(Object.keys(answer).sort()).toEqual(['outcome', 'reason']);
  });
});
