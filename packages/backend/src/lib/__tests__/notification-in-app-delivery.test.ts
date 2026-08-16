/**
 * `in_app` delivery status distinguishes SENT from DROPPED.
 *
 * The second half of #364. `deliverInApp` returned `true` whenever `getIO()` was
 * non-null, so `deliveryStatus.in_app` recorded `sent` for every notification —
 * including the ones the unattached Redis adapter dropped on the other ECS task.
 *
 * Ask the question that matters of the old code: what would that status report
 * if in-app delivery were completely broken? `sent`. What would it report if it
 * worked perfectly? `sent`. It measured the existence of a `Server` object, not
 * a delivery, which is why the transport defect could sit in production
 * indefinitely with the telemetry showing nothing.
 *
 * So these tests hold the status against ROOM OCCUPANCY, which is adapter-aware:
 * with the Redis adapter attached `fetchSockets()` counts this user's sockets on
 * every task, and without it only this task's.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getIO = vi.fn();
vi.mock('../../socket.js', () => ({
  getIO: () => getIO(),
}));

vi.mock('../logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

const insertNotification = vi.fn();
const updateNotificationDeliveryStatus = vi.fn();
vi.mock('../../db/notifications/notificationRepository.js', () => ({
  insertNotification: (...args: unknown[]) => insertNotification(...args),
  updateNotificationDeliveryStatus: (...args: unknown[]) =>
    updateNotificationDeliveryStatus(...args),
}));

vi.mock('../../db/notifications/pushTokenRepository.js', () => ({
  deactivatePushTokenById: vi.fn(),
  deactivatePushTokensByToken: vi.fn(),
  findPushTokensForDelivery: vi.fn().mockResolvedValue([]),
  hasActivePushToken: vi.fn().mockResolvedValue(false),
  touchPushTokensLastUsed: vi.fn(),
}));

vi.mock('../../db/notifications/webPushSubscriptionRepository.js', () => ({
  deactivateWebPushSubscriptionById: vi.fn(),
  findWebPushSubscriptionsForDelivery: vi.fn().mockResolvedValue([]),
  hasActiveWebPushSubscription: vi.fn().mockResolvedValue(false),
}));

vi.mock('../web-push.js', () => ({
  webPush: { sendNotification: vi.fn() },
  VAPID_PUBLIC_KEY: '',
}));

import { sendNotification } from '../notification-service.js';

const USER_ID = 'oxy-user-1';

/**
 * A Socket.IO `Server` stand-in carrying the two calls `deliverInApp` makes:
 * `to(room).emit(...)` and `in(room).fetchSockets()`.
 *
 * `fetchSockets` is what the adapter answers, so `connectedSockets` here stands
 * in for "how many of this user's sockets exist across the whole fleet".
 */
function fakeIO(connectedSockets: number) {
  const emit = vi.fn();
  const fetchSockets = vi.fn().mockResolvedValue(
    Array.from({ length: connectedSockets }, (_, i) => ({ id: `socket-${i}` })),
  );
  return {
    emit,
    fetchSockets,
    to: vi.fn().mockReturnValue({ emit }),
    in: vi.fn().mockReturnValue({ fetchSockets }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  insertNotification.mockImplementation(async (input: Record<string, unknown>) => ({
    ...input,
    id: 'notification-1',
    // Safely in the PAST. Nothing here reads the clock, but a fixture dated
    // today is the #253 time bomb: it passes until the real clock reaches it and
    // then fails for whoever pushes that day, in a file they did not touch.
    createdAt: new Date('2020-01-01T10:00:00Z'),
  }));
  updateNotificationDeliveryStatus.mockResolvedValue(null);
});

describe('in_app delivery status (#364)', () => {
  it('records SENT when the recipient has a connected socket', async () => {
    const io = fakeIO(1);
    getIO.mockReturnValue(io);

    const result = await sendNotification({
      userId: USER_ID,
      type: 'order_placed',
      title: 'Order placed',
      body: 'Your order is on its way',
      channels: ['in_app'],
    });

    expect(io.to).toHaveBeenCalledWith(`user:${USER_ID}`);
    expect(io.emit).toHaveBeenCalledWith('notification', expect.objectContaining({ id: 'notification-1' }));
    expect(result.deliveryStatus.in_app).toBe('sent');
  });

  it('records FAILED when nobody is connected — the case that used to read `sent`', async () => {
    const io = fakeIO(0);
    getIO.mockReturnValue(io);

    const result = await sendNotification({
      userId: USER_ID,
      type: 'order_placed',
      title: 'Order placed',
      body: 'Your order is on its way',
      channels: ['in_app'],
    });

    // The emit still happens — the notification row is stored either way and a
    // client that reconnects reads it from the feed. What changed is that the
    // status no longer claims a delivery that reached nobody.
    expect(io.emit).toHaveBeenCalled();
    expect(result.deliveryStatus.in_app).toBe('failed');
  });

  it('records FAILED when there is no socket server at all', async () => {
    getIO.mockReturnValue(null);

    const result = await sendNotification({
      userId: USER_ID,
      type: 'order_placed',
      title: 'Order placed',
      body: 'Your order is on its way',
      channels: ['in_app'],
    });

    expect(result.deliveryStatus.in_app).toBe('failed');
  });

  it('counts occupancy on the user OWN room, so another user cannot satisfy it', async () => {
    const io = fakeIO(1);
    getIO.mockReturnValue(io);

    await sendNotification({
      userId: USER_ID,
      type: 'order_placed',
      title: 'Order placed',
      body: 'Your order is on its way',
      channels: ['in_app'],
    });

    // `in()` and `to()` must name the same room, or the status would be
    // reporting on somebody else's connection.
    expect(io.in).toHaveBeenCalledWith(`user:${USER_ID}`);
    expect(io.to).toHaveBeenCalledWith(`user:${USER_ID}`);
  });
});
