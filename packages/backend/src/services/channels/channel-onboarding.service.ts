/**
 * The connection wizard (#87 "Connection wizard").
 *
 * ## The session holds no credential, and there is nowhere to put one
 *
 * Wizard step 4 says credentials are collected only through the provider's own
 * secure flow. That is not enforced here by a check — it is enforced by
 * `channel_onboarding_sessions` having no credential column and
 * {@link ChannelOnboardingSession} having no credential field, so a step that
 * tried to stash a consumer secret would not compile. The credential flows write
 * to `connections` (AES-GCM, both envelopes, `num_nonnulls in (0,3)`) or mint a
 * channel key, and this service records only WHICH connection resulted.
 *
 * ## Activation blockers are re-derived on every read, never trusted
 *
 * The stored `activation_blockers` exist so a resumed wizard shows what it
 * showed. Nothing decides from them: {@link deriveActivationBlockers} runs
 * against the LIVE connection and the LIVE preview record on every read and
 * every activation attempt. A session previewed last week whose connection has
 * since errored must not be activatable because a column still says it was fine
 * — that is the stale-verdict failure, in the one place where it would put a
 * broken channel live.
 *
 * ## A preview that read nothing cannot activate
 *
 * `preview_scanned_nothing` is a blocker in its own right, and it is the vacuity
 * floor #60 pays for elsewhere: a mapping that matches no rows and a feed with
 * nothing in it produce identical output — a clean run with zero problems — and
 * "no problems found" is exactly what a merchant reads before pressing activate.
 */

import type {
  ChannelActivationBlocker,
  ChannelOnboardingSession,
  ChannelOnboardingStep,
  ChannelPreviewCounts,
  ChannelTypeId,
  ConnectorProviderId,
  SyncSettings,
} from '@mercaria/shared-types';
import { channelSupportsDirection } from '@mercaria/shared-types';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { findConnection } from '../../db/connectors/connectionRepository.js';
import {
  closeChannelOnboardingSession,
  findChannelOnboardingSession,
  listChannelOnboardingSessions,
  openChannelOnboardingSession,
  patchChannelOnboardingSession,
  type ChannelOnboardingSessionRow,
} from '../../db/channels/channelOnboardingRepository.js';
import { recordChannelAuditEvent } from '../../db/channels/channelAuditRepository.js';
import {
  activationBlockingLimitations,
  channelTypeForConnection,
  describeChannel,
} from './channel-catalog.js';
import { resolveChannelBinding } from './channel-binding.js';

/** The session projection. Names every field — there is no spread anywhere here. */
export function toChannelOnboardingSessionDTO(
  row: ChannelOnboardingSessionRow,
  blockers: readonly ChannelActivationBlocker[],
): ChannelOnboardingSession {
  return {
    id: row.id,
    storeId: row.storeId,
    channelType: row.channelType,
    state: row.state,
    step: row.step,
    connectionId: row.connectionId ?? undefined,
    feedConfigurationId: row.feedConfigurationId ?? undefined,
    merchantId: row.merchantId ?? undefined,
    storefrontId: row.storefrontId ?? undefined,
    previewCounts:
      row.previewScanned === null
        ? undefined
        : {
            scanned: row.previewScanned,
            matched: row.previewMatched ?? 0,
            created: row.previewCreated ?? 0,
            review: row.previewReview ?? 0,
            invalid: row.previewInvalid ?? 0,
            duplicate: row.previewDuplicate ?? 0,
          },
    previewedAt: row.previewedAt?.toISOString(),
    activationBlockers: [...blockers],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Start (or resume) onboarding for a channel type.
 *
 * Idempotent by construction — the repository's `ON CONFLICT DO NOTHING` on the
 * live-session partial unique means a merchant who opens the wizard twice gets
 * the same session, which is #87 acceptance 2 held at the FIRST step instead of
 * defended at the last. The scope step also runs here: the binding is resolved
 * and recorded immediately, so the wizard can tell the merchant which merchant
 * identity their channel will attach to before they authorize anything.
 *
 * An unavailable channel type is refused BEFORE a row exists. A session for a
 * channel this deployment cannot connect is a dead end that a merchant would
 * then have to abandon, and the partial unique would keep it in their way.
 */
export async function startChannelOnboarding(input: {
  storeId: string;
  channelType: ChannelTypeId;
  actorOxyUserId: string;
}): Promise<{ session: ChannelOnboardingSession }> {
  const descriptor = describeChannel(input.channelType);
  if (descriptor.availability !== 'available') {
    throw validationError(
      descriptor.availability === 'not_implemented'
        ? `${descriptor.name} is not available yet.`
        : `${descriptor.name} is not configured on this deployment.`,
    );
  }
  if (input.channelType === 'native') {
    // The native catalogue is not connected, it simply exists. A wizard for it
    // would be a flow whose every step is a no-op ending in "you were already
    // done", which is worse than saying so.
    throw validationError('The Mercaria catalog is always on — there is nothing to connect.');
  }

  const created = await openChannelOnboardingSession({
    storeId: input.storeId,
    channelType: input.channelType,
    startedByOxyUserId: input.actorOxyUserId,
  });

  // The scope step (#87 wizard 1 and reconcile 1). Recorded rather than
  // recomputed later, so the reconciliation view can say WHICH merchant the
  // already-indexed offers were looked for under — including when the answer is
  // "none", which is the ordinary state of an unclaimed store.
  const binding = await resolveChannelBinding({ storeId: input.storeId });
  const scoped =
    binding.bound && created.merchantId === null
      ? ((await patchChannelOnboardingSession(input.storeId, created.id, {
          step: 'select_channel',
          merchantId: binding.merchantId,
          storefrontId: binding.storefrontId,
        })) ?? created)
      : created;

  await recordChannelAuditEvent({
    storeId: input.storeId,
    action: 'onboarding_started',
    actorOxyUserId: input.actorOxyUserId,
    channelType: input.channelType,
    changedFields: ['state', 'step'],
  });

  return { session: await project(scoped) };
}

/** This store's sessions, newest first, each with live blockers. */
export async function listChannelOnboarding(
  storeId: string,
): Promise<ChannelOnboardingSession[]> {
  const rows = await listChannelOnboardingSessions(storeId);
  return await Promise.all(rows.map((row) => project(row)));
}

/** One session. A stranger's id and an unknown id are the same 404. */
export async function getChannelOnboarding(
  storeId: string,
  sessionId: string,
): Promise<ChannelOnboardingSession> {
  const row = await findChannelOnboardingSession(storeId, sessionId);
  if (!row) throw notFound('Onboarding session not found');
  return await project(row);
}

/**
 * Advance a session.
 *
 * The step is what the merchant reached, and it is stored rather than derived
 * because a merchant can go BACK: deriving it from which fields are filled in
 * would silently drag them forward again on every reload.
 *
 * A `connectionId` is verified to belong to this store before it is recorded —
 * the ONE place a client-supplied id enters the session — so a session cannot be
 * pointed at another tenant's connection and then activated.
 */
export async function advanceChannelOnboarding(input: {
  storeId: string;
  sessionId: string;
  actorOxyUserId: string;
  step?: ChannelOnboardingStep;
  connectionId?: string;
  feedConfigurationId?: string;
  preview?: ChannelPreviewCounts;
}): Promise<ChannelOnboardingSession> {
  const existing = await findChannelOnboardingSession(input.storeId, input.sessionId);
  if (!existing) throw notFound('Onboarding session not found');
  if (existing.state !== 'in_progress') {
    throw conflict('This onboarding session has already finished.');
  }

  if (input.connectionId !== undefined) {
    const connection = await findConnection(input.storeId, input.connectionId);
    if (!connection) throw notFound('Connection not found');
  }

  const changed: string[] = [];
  if (input.step !== undefined) changed.push('step');
  if (input.connectionId !== undefined) changed.push('connectionId');
  if (input.feedConfigurationId !== undefined) changed.push('feedConfigurationId');
  if (input.preview !== undefined) changed.push('preview');

  const patched = await patchChannelOnboardingSession(input.storeId, input.sessionId, {
    step: input.step,
    connectionId: input.connectionId,
    feedConfigurationId: input.feedConfigurationId,
    preview: input.preview,
  });
  if (!patched) throw conflict('This onboarding session has already finished.');

  if (changed.length > 0) {
    await recordChannelAuditEvent({
      storeId: input.storeId,
      action: 'settings_updated',
      actorOxyUserId: input.actorOxyUserId,
      channelType: existing.channelType,
      connectionId: patched.connectionId ?? undefined,
      feedConfigurationId: patched.feedConfigurationId ?? undefined,
      changedFields: changed,
    });
  }

  return await project(patched);
}

/**
 * Refuse, at MINT time, a wizard session an OAuth connect must not be bound to.
 *
 * The callback is a public route acting on claims it verified, so by the time it
 * patches, a bad session id is silent: `patchChannelOnboardingSession` is scoped
 * to the store and to `in_progress`, matches nothing, and the merchant watches
 * the same stall this whole path exists to remove. Checking here puts the refusal
 * in the request the merchant is looking at, BEFORE they are sent to the
 * platform and before a one-time code is spent.
 *
 * It is NOT the security boundary and must not be mistaken for one — the store
 * scope on the patch is. A member who forges another store's session id is
 * refused by that predicate whether or not this function ran.
 *
 * The channel type is compared through `channelTypeForConnection`, the same
 * mapping the rest of the surface reads, rather than by assuming the channel is
 * named after the provider.
 */
export async function assertOnboardingSessionAcceptsConnect(input: {
  storeId: string;
  sessionId: string;
  providerId: ConnectorProviderId;
}): Promise<void> {
  const row = await findChannelOnboardingSession(input.storeId, input.sessionId);
  if (!row) throw notFound('Onboarding session not found');
  if (row.state !== 'in_progress') {
    throw conflict('This onboarding session has already finished.');
  }
  // An OAuth connect always produces a `pull` connection (`connectAndVerify`),
  // so that is the mode the resulting channel type is derived under.
  const expected = channelTypeForConnection({ provider: input.providerId, mode: 'pull' });
  if (row.channelType !== expected) {
    throw validationError('This onboarding session is for a different channel.');
  }
}

/**
 * Link the connection an OAuth callback just created onto the wizard session the
 * merchant started from.
 *
 * The connect leaves the browser, so nothing on the client can do this: the tab
 * that started the flow never sees the connection, and on web the platform
 * answers into a DIFFERENT tab. Without it a Shopify session's `connectionId`
 * stays NULL forever, `deriveActivationBlockers` reports
 * `connection_not_connected` against a connection that is `connected`, and the
 * wizard is unfinishable however many times it is reloaded.
 *
 * A session that is GONE or already finished is reported rather than thrown. By
 * the time this runs the connection exists, the credentials are stored and the
 * one-time code is spent, so a merchant who abandoned the wizard or activated it
 * on another device must not be told their authorized connect failed — and there
 * is no retry that would help. The outcome is RETURNED so the caller can log
 * which happened: "the id named nothing" and "the merchant finished the wizard
 * elsewhere" send an operator to opposite places.
 *
 * A DATABASE failure still propagates, because swallowing one here would make
 * every future caller inherit a silence none of them asked for. Not failing the
 * callback on it is the CALLER's decision and is taken there, where the reason
 * (the connection already exists) is visible.
 *
 * A STRING discriminant, because this backend compiles with `strict: false`: a
 * caller testing `!result.linked` on a boolean one would be left holding the
 * whole union.
 */
export type OnboardingConnectionLinkOutcome =
  | { outcome: 'linked' }
  | { outcome: 'skipped'; reason: 'session_not_found' | 'session_not_live' };

export async function recordOAuthConnectionOnSession(input: {
  storeId: string;
  sessionId: string;
  connectionId: string;
  actorOxyUserId: string;
  channelType: ChannelTypeId;
}): Promise<OnboardingConnectionLinkOutcome> {
  const existing = await findChannelOnboardingSession(input.storeId, input.sessionId);
  if (!existing) return { outcome: 'skipped', reason: 'session_not_found' };

  // The patch's own CAS on `in_progress` is what decides, not the read above —
  // the merchant's own tab can activate or abandon between the two statements,
  // and the read exists only to tell the two skips apart in the log.
  const patched = await patchChannelOnboardingSession(input.storeId, input.sessionId, {
    step: 'configure',
    connectionId: input.connectionId,
  });
  if (!patched) return { outcome: 'skipped', reason: 'session_not_live' };

  await recordChannelAuditEvent({
    storeId: input.storeId,
    action: 'settings_updated',
    actorOxyUserId: input.actorOxyUserId,
    channelType: input.channelType,
    connectionId: input.connectionId,
    changedFields: ['step', 'connectionId'],
  });

  return { outcome: 'linked' };
}

/**
 * Activate — the wizard's terminal step (#87 wizard 11).
 *
 * Blockers are re-derived here rather than read off the row, so an activation
 * cannot rest on a preview taken before something broke. The refusal NAMES the
 * blockers, because "you cannot activate" with no reason is a wizard a merchant
 * abandons.
 */
export async function activateChannelOnboarding(input: {
  storeId: string;
  sessionId: string;
  actorOxyUserId: string;
}): Promise<ChannelOnboardingSession> {
  const row = await findChannelOnboardingSession(input.storeId, input.sessionId);
  if (!row) throw notFound('Onboarding session not found');
  if (row.state === 'activated') {
    // Converge rather than refuse: a client retrying an activation whose
    // response it never saw must not be told it failed.
    return await project(row);
  }
  if (row.state !== 'in_progress') {
    throw conflict('This onboarding session has already finished.');
  }

  const blockers = await deriveActivationBlockers(row);
  if (blockers.length > 0) {
    // Recorded before refusing, so a merchant who reloads sees the same list
    // rather than an empty one that invites another attempt.
    await patchChannelOnboardingSession(input.storeId, input.sessionId, {
      activationBlockers: blockers,
    });
    throw conflict(`This channel is not ready to activate: ${blockers.join(', ')}`);
  }

  const closed = await closeChannelOnboardingSession(
    input.storeId,
    input.sessionId,
    'activated',
    new Date(),
  );
  if (!closed) {
    // Lost the CAS to another device. Read back what the winner wrote rather
    // than reporting a conflict for an outcome the merchant wanted.
    return await getChannelOnboarding(input.storeId, input.sessionId);
  }

  await recordChannelAuditEvent({
    storeId: input.storeId,
    action: 'onboarding_activated',
    actorOxyUserId: input.actorOxyUserId,
    channelType: closed.channelType,
    connectionId: closed.connectionId ?? undefined,
    feedConfigurationId: closed.feedConfigurationId ?? undefined,
    changedFields: ['state', 'activatedAt'],
  });

  return await project(closed);
}

/** Abandon a session, freeing the live slot for this channel type. */
export async function abandonChannelOnboarding(input: {
  storeId: string;
  sessionId: string;
  actorOxyUserId: string;
}): Promise<ChannelOnboardingSession> {
  const closed = await closeChannelOnboardingSession(
    input.storeId,
    input.sessionId,
    'abandoned',
    new Date(),
  );
  if (!closed) {
    const existing = await findChannelOnboardingSession(input.storeId, input.sessionId);
    if (!existing) throw notFound('Onboarding session not found');
    return await project(existing);
  }

  await recordChannelAuditEvent({
    storeId: input.storeId,
    action: 'onboarding_abandoned',
    actorOxyUserId: input.actorOxyUserId,
    channelType: closed.channelType,
    changedFields: ['state', 'abandonedAt'],
  });

  return await project(closed);
}

/**
 * Why this session cannot activate, right now.
 *
 * Every input is read LIVE. The order is the order a merchant should fix them
 * in — the channel's own limitations first (nothing they do will help), then the
 * connection, then the preview.
 */
export async function deriveActivationBlockers(
  row: ChannelOnboardingSessionRow,
): Promise<ChannelActivationBlocker[]> {
  const blockers: ChannelActivationBlocker[] = [];

  if (activationBlockingLimitations(row.channelType).length > 0) {
    blockers.push('channel_limitation');
  }

  if (row.connectionId !== null) {
    const connection = await findConnection(row.storeId, row.connectionId);
    if (!connection || connection.status !== 'connected') {
      blockers.push('connection_not_connected');
    } else if (!settingsAreSupported(row.channelType, connection)) {
      blockers.push('unsupported_direction');
    }
  } else if (row.feedConfigurationId === null) {
    // Neither a connection nor a feed: the credential step has not happened, so
    // there is nothing to activate. Reported as `connection_not_connected`
    // rather than a fifth blocker, because from the merchant's side it is the
    // same sentence — this channel is not connected yet.
    blockers.push('connection_not_connected');
  }

  if (row.previewScanned === null) {
    blockers.push('no_preview');
  } else if (row.previewScanned === 0) {
    blockers.push('preview_scanned_nothing');
  } else if (row.previewInvalid === row.previewScanned) {
    blockers.push('preview_all_invalid');
  }

  return blockers;
}

/**
 * Whether a connection's configured directions are ones the channel implements.
 *
 * The settings form should never offer an unsupported direction, and this is the
 * gate that makes that a guarantee rather than a hope: a direction that reached
 * the row through the existing `PATCH .../settings` endpoint — which predates
 * the channel catalog and validates against `SYNC_RESOURCE_DIRECTIONS` alone —
 * stops the channel activating instead of silently never working.
 */
function settingsAreSupported(
  channelType: ChannelTypeId,
  settings: Pick<
    SyncSettings,
    never
  > & {
    syncSettingsProducts: SyncSettings['products'];
    syncSettingsInventory: SyncSettings['inventory'];
    syncSettingsOrders: SyncSettings['orders'];
  },
): boolean {
  const resources = describeChannel(channelType).resources;
  return (
    channelSupportsDirection(resources, 'products', settings.syncSettingsProducts) &&
    channelSupportsDirection(resources, 'inventory', settings.syncSettingsInventory) &&
    channelSupportsDirection(resources, 'orders', settings.syncSettingsOrders)
  );
}

/** Project a row with its LIVE blockers rather than the stored snapshot. */
async function project(row: ChannelOnboardingSessionRow): Promise<ChannelOnboardingSession> {
  const blockers =
    row.state === 'in_progress'
      ? await deriveActivationBlockers(row)
      : // A finished session's blockers are history, and re-deriving them would
        // show an activated channel a list of reasons it could not have been
        // activated for.
        (row.activationBlockers as ChannelActivationBlocker[]);
  return toChannelOnboardingSessionDTO(row, blockers);
}
