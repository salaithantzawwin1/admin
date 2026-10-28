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

type Subscription = { wanted: { current: LiveEventType[] }; cb: (e: LiveEvent) => void };

/**
 * ONE shared EventSource per tab.
 *
 * Every panel used to open its own stream — with a request detail, its Car
 * panel and the bell that is three long-lived connections PER TAB, and Chrome
 * allows only six per host over HTTP/1.1. Two open tabs therefore hit the cap
 * and every other request on the page queued behind the streams, which never
 * finish: polling stalled, clicks never reached the server. A single socket
 * with a subscriber list keeps one tab at one connection regardless of how
 * many panels listen.
 *
 * Payloads are lightweight signals (ids only): each subscriber decides whether
 * the event concerns it and refetches through the normal API, so the API stays
 * the truth and the 15s polling stays as the fallback.
 */
const subs = new Set<Subscription>();
const statusListeners = new Set<(live: boolean) => void>();

let socket: EventSource | null = null;
let opening = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let docListeners = false;

function setStatus(live: boolean) {
  for (const fn of statusListeners) fn(live);
}

function teardown() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socket.close();
    socket = null;
  }
  opening = false;
  setStatus(false);
}

function connect() {
  const token = getToken();
  if (socket || opening || reconnectTimer) return;
  if (!token || typeof EventSource === 'undefined') return; // polling fallback only
  if (subs.size === 0 || document.hidden) return;

  opening = true;
  const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  es.onopen = () => {
    opening = false;
    socket = es;
    setStatus(true);
  };
  es.onerror = () => {
    opening = false;
    if (socket === es) socket = null;
    es.close();
    setStatus(false);
    if (subs.size > 0 && !document.hidden && !reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, RECONNECT_MS);
    }
  };
  es.onmessage = (msg) => {
    try {
      const evt = JSON.parse(msg.data) as LiveEvent;
      if (!evt?.type) return;
      for (const s of subs) if (s.wanted.current.includes(evt.type)) s.cb(evt);
    } catch {
      /* ignore malformed frames */
    }
  };
}

/** hidden tabs drop the connection; a visible tab re-establishes immediately */
function onVisibility() {
  if (document.hidden) teardown();
  else connect();
}

function ensureDocListeners() {
  if (docListeners) return;
  docListeners = true;
  document.addEventListener('visibilitychange', onVisibility);
}

function releaseDocListeners() {
  if (!docListeners) return;
  docListeners = false;
  document.removeEventListener('visibilitychange', onVisibility);
}

/**
 * Live updates over SSE (GET /events?token=…).
 *
 * - `onEvent` runs whenever the server pushes a type listed in `types`.
 *   Treat the event as a "data changed" SIGNAL: refetch via the normal API.
 * - While disconnected nothing breaks: the existing 15s polling keeps the view
 *   fresh, and the shared socket reconnects.
 * - Pauses while the tab is hidden; hidden tabs reconnect on visibility.
 */
export function useLiveReload(types: LiveEventType[], onEvent: (e: LiveEvent) => void) {
  const [live, setLive] = useState(false);
  // keep the latest callback without resubscribing on every re-render
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const wanted = useRef(types);
  wanted.current = types;

  useEffect(() => {
    const sub: Subscription = {
      wanted,
      cb: (e) => handler.current(e),
    };
    subs.add(sub);
    statusListeners.add(setLive);
    ensureDocListeners();
    connect();

    return () => {
      subs.delete(sub);
      statusListeners.delete(setLive);
      if (subs.size === 0) {
        releaseDocListeners();
        teardown();
      }
    };
  }, []);

  return live;
}