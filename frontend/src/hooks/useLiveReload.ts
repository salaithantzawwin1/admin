import { useEffect, useRef, useState } from 'react';
import { getToken } from '../api';

export type LiveEventType = 'assignment.updated' | 'driver.updated' | 'request.updated' | 'notification';

export interface LiveEvent {
  type: LiveEventType;
  requestId?: string;
  driverId?: string;
  at: string;
}

const RECONNECT_MS = 10_000; // EventSource also retries on its own; this covers hard errors

/**
 * Live updates over SSE (GET /events?token=…).
 *
 * - `onEvent` runs whenever the server pushes a type listed in `types`.
 *   Treat the event as a "data changed" SIGNAL: refetch via the normal API —
 *   the event carries ids only, never state, so the API stays the truth.
 * - While disconnected (server restart, network hiccup) nothing breaks:
 *   the existing 15s polling keeps the view fresh, and the hook reconnects.
 * - Pauses while the tab is hidden to save resources; hidden tabs reconnect
 *   on visibility.
 */
export function useLiveReload(types: LiveEventType[], onEvent: (e: LiveEvent) => void) {
  const [live, setLive] = useState(false);
  // keep the latest callback without resubscribing on every re-render
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const wanted = useRef(types);
  wanted.current = types;

  useEffect(() => {
    const token = getToken();
    if (!token || typeof EventSource === 'undefined') return; // polling fallback only

    let es: EventSource | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
      es.onopen = () => setLive(true);
      es.onerror = () => {
        setLive(false);
        es?.close();
        es = null;
        if (!closed && !document.hidden && !reconnect) {
          reconnect = setTimeout(() => {
            reconnect = null;
            connect();
          }, RECONNECT_MS);
        }
      };
      es.onmessage = (msg) => {
        try {
          const evt = JSON.parse(msg.data) as LiveEvent;
          if (evt?.type && wanted.current.includes(evt.type)) handler.current(evt);
        } catch {
          /* ignore malformed frames */
        }
      };
    };

    connect();

    // hidden tabs drop the connection; visible tabs re-establish immediately
    const onVisible = () => {
      if (document.hidden) {
        es?.close();
        es = null;
        setLive(false);
      } else if (!es && !closed) {
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      closed = true;
      if (reconnect) clearTimeout(reconnect);
      document.removeEventListener('visibilitychange', onVisible);
      es?.close();
      setLive(false);
    };
  }, []);

  return live;
}
