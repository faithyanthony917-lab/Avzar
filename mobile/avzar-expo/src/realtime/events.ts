import { HubConnectionBuilder, LogLevel, type HubConnection } from '@microsoft/signalr';
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { BUSINESS_EVENTS_URL, realtimeAccessToken } from '@/api/client';

export type LiveState = 'connecting' | 'live' | 'reconnecting' | 'offline';

const RECONNECT_DELAYS_MS = [0, 2000, 10000, 30000];
const RETRY_AFTER_FAILED_START_MS = 30000;

/**
 * Keeps a live connection to the server while the app is in the foreground.
 * Calls onTaskUpdated whenever the server reports a task change, and once each time the connection (re)starts.
 * The server decides which business the connection belongs to; the app never names a group.
 */
export function useTaskEvents(onTaskUpdated: () => void): LiveState {
  const [state, setState] = useState<LiveState>('offline');
  const handler = useRef(onTaskUpdated);

  useEffect(() => {
    handler.current = onTaskUpdated;
  }, [onTaskUpdated]);

  useEffect(() => {
    let connection: HubConnection | null = null;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const clearRetry = () => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    };

    const start = async () => {
      if (connection || cancelled) return;
      clearRetry();
      const next = new HubConnectionBuilder()
        .withUrl(BUSINESS_EVENTS_URL, { accessTokenFactory: realtimeAccessToken })
        .withAutomaticReconnect(RECONNECT_DELAYS_MS)
        .configureLogging(LogLevel.None)
        .build();
      connection = next;
      next.on('task.updated', () => handler.current());
      next.onreconnecting(() => setState('reconnecting'));
      next.onreconnected(() => {
        setState('live');
        handler.current();
      });
      next.onclose(() => {
        if (!cancelled) setState('offline');
      });

      setState('connecting');
      try {
        await next.start();
        if (cancelled) {
          await next.stop();
          return;
        }
        setState('live');
        handler.current();
      } catch {
        // Could not connect (no network, signed out, server asleep). Try again later; the manual refresh still works.
        if (connection === next) connection = null;
        if (!cancelled) {
          setState('offline');
          retryTimer = setTimeout(() => void start(), RETRY_AFTER_FAILED_START_MS);
        }
      }
    };

    const stop = async () => {
      clearRetry();
      const current = connection;
      connection = null;
      if (current) {
        try {
          await current.stop();
        } catch {
          // Already closed.
        }
      }
      if (!cancelled) setState('offline');
    };

    void start();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void start();
      else void stop();
    });

    return () => {
      cancelled = true;
      subscription.remove();
      void stop();
    };
  }, []);

  return state;
}
