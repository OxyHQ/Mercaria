import type { OxyServices } from '@oxy.so/core';
import { io } from 'socket.io-client';

/** One notification subscription, bound to the originating Oxy session context. */
export function connectNotificationSocket(
  oxy: OxyServices,
  baseURL: string,
  events: {
    onNotification(): void;
    onContextEnd(): void;
  },
): () => void {
  const linked = oxy.createLinkedClient({ baseURL });
  const epoch = oxy.http.getSessionEpoch();
  const controller = new AbortController();
  const socket = io(baseURL, {
    autoConnect: false,
    transports: ['websocket'],
    auth: (callback) => {
      void linked.getAccessToken(baseURL, { signal: controller.signal }).then(
        (token) => {
          if (!controller.signal.aborted) callback({ token });
        },
        () => {
          if (!controller.signal.aborted) callback({});
        },
      );
    },
  });
  const unsubscribe = oxy.http.addTokenChangeListener(() => {
    if (oxy.http.getSessionEpoch() === epoch) return;
    dispose();
    events.onContextEnd();
  });
  function dispose(): void {
    if (controller.signal.aborted) return;
    controller.abort();
    unsubscribe();
    socket.removeAllListeners();
    socket.disconnect();
    linked.dispose();
  }
  socket.on('notification', () => {
    if (!controller.signal.aborted) events.onNotification();
  });
  socket.connect();
  return dispose;
}
