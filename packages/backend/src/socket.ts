import { Server, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import http from 'http';
import { isValidObjectId } from 'mongoose';
import { getRedisClient, getRedisSubClient } from './lib/redis.js';
import { oxyClient } from './middleware/auth.js';
import { Store } from './models/store.js';
import { log } from './lib/logger.js';

const ALLOWED_ORIGINS = [
  process.env.WEB_URL || 'http://localhost:3000',
  'https://mercaria.co',
  'https://console.mercaria.co',
  'https://gateway.mercaria.co',
];

let io: Server | null = null;

/**
 * Authorize a socket to join a store's live-progress room and join it on success.
 *
 * `authSocket()` proves only the socket's USER identity — it does NOT prove the
 * user may read a given store's events. So a `subscribe-store` request is
 * re-checked here against store membership (server-side), never trusting the
 * client-supplied `storeId`. Returns true iff the user is a member and the socket
 * joined `store:${storeId}`. A malformed id or a non-member returns false WITHOUT
 * joining. Exported for unit testing the guard.
 */
export async function authorizeAndJoinStore(
  socket: Pick<Socket, 'join'>,
  userId: string,
  rawStoreId: unknown,
): Promise<boolean> {
  if (typeof rawStoreId !== 'string' || !isValidObjectId(rawStoreId)) {
    return false;
  }
  const isMember = await Store.exists({ _id: rawStoreId, 'members.oxyUserId': userId });
  if (!isMember) {
    return false;
  }
  await socket.join(`store:${rawStoreId}`);
  return true;
}

export function initSocket(server: http.Server) {
  // Hold the instance in a local const so the async adapter callback below
  // references a provably-defined server (no module-level non-null assertion).
  const socketServer = new Server(server, {
    cors: {
      origin: ALLOWED_ORIGINS,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });
  io = socketServer;

  // Attach Redis adapter for horizontal scaling
  const pubClient = getRedisClient();
  const subClient = getRedisSubClient();
  if (pubClient && subClient) {
    Promise.all([pubClient.connect(), subClient.connect()])
      .then(() => {
        socketServer.adapter(createAdapter(pubClient, subClient));
        log.general.info('Socket.IO Redis adapter attached');
      })
      .catch((err) => {
        log.general.warn({ err }, 'Socket.IO Redis adapter failed — using in-memory');
      });
  }

  // Authenticate EVERY connection: validates the Oxy session from
  // `handshake.auth.token` and sets `socket.data.userId`. Unauthenticated
  // connections are rejected. This is the ONLY source of the room identity —
  // clients can no longer name the room they join.
  socketServer.use(oxyClient.authSocket());

  socketServer.on('connection', (socket) => {
    const userId = (socket.data as { userId?: string }).userId;
    if (!userId) {
      // authSocket() guarantees userId, but fail closed if it is ever missing.
      socket.disconnect(true);
      return;
    }
    // Auto-join the user's own room using the SERVER-VERIFIED id only.
    socket.join(`user:${userId}`);

    // Parameterless opt-in event kept for client compatibility — it is a
    // no-op because the verified room is already joined above. It NEVER
    // joins a client-supplied id.
    socket.on('subscribe-notifications', () => {});

    // Opt in to a store's live sync-progress room. The server RE-CHECKS store
    // membership before joining (authSocket only proves user identity), so a
    // non-member is rejected and never receives another store's `sync:progress`.
    socket.on('subscribe-store', (storeId: unknown, ack?: (joined: boolean) => void) => {
      authorizeAndJoinStore(socket, userId, storeId)
        .then((joined) => {
          if (typeof ack === 'function') {
            ack(joined);
          }
        })
        .catch((err) => {
          log.general.warn({ err, userId }, 'subscribe-store failed');
          if (typeof ack === 'function') {
            ack(false);
          }
        });
    });
  });

  return socketServer;
}

export function getIO(): Server | null {
  return io;
}
