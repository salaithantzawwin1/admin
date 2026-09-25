import { Injectable, Logger } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

export type AmsEventType = 'assignment.updated' | 'driver.updated' | 'request.updated' | 'notification';

/** Lightweight push signal — no row data, clients refetch through the normal API. */
export interface AmsEvent {
  type: AmsEventType;
  /** context ids so a client can ignore events it does not display */
  requestId?: string;
  driverId?: string;
  userId?: string;
  at: string;
}

const HEARTBEAT_MS = 25_000; // nginx read timeout is 60s — tick well inside it

/**
 * Tiny in-process SSE broker.
 *
 * Deliberately no Redis/websocket layer: this AMS runs as ONE backend container
 * on the office LAN, so an in-memory Map is complete and race-free. If the app
 * ever scales to multiple replicas, swap the publish() body for a Redis pub/sub
 * fan-out — the interface stays the same.
 */
@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);
  /** userId → live subscriber subjects (a user may have several tabs open) */
  private subscribers = new Map<string, Set<Subject<AmsEvent>>>();
  private heartbeat?: NodeJS.Timeout;

  /** Long-lived SSE stream for one user (all their tabs share the same key). */
  subscribeUser(userId: string): Observable<AmsEvent> {
    this.ensureHeartbeat();
    return new Observable<AmsEvent>((observer) => {
      const subject = new Subject<AmsEvent>();
      const sub = subject.subscribe(observer);
      if (!this.subscribers.has(userId)) this.subscribers.set(userId, new Set());
      this.subscribers.get(userId)!.add(subject);
      // opening ping so proxies flush their headers immediately
      queueMicrotask(() => {
        try {
          subject.next({ type: 'notification', at: new Date().toISOString(), userId });
        } catch {
          /* client gone already */
        }
      });
      return () => {
        sub.unsubscribe();
        this.subscribers.get(userId)?.delete(subject);
        if (this.subscribers.get(userId)?.size === 0) this.subscribers.delete(userId);
      };
    });
  }

  /** Fan out a signal to every open stream of the given user(s). */
  publish(type: AmsEventType, targets: { userIds?: string[]; requestId?: string; driverId?: string } = {}) {
    const evt: AmsEvent = { type, at: new Date().toISOString(), ...targets };
    const userIds = targets.userIds ?? [...this.subscribers.keys()]; // no userIds = broadcast
    let delivered = 0;
    for (const userId of userIds) {
      for (const subject of this.subscribers.get(userId) ?? []) {
        try {
          subject.next(evt);
          delivered++;
        } catch (e) {
          this.logger.warn(`publish to ${userId} failed: ${(e as Error).message}`);
        }
      }
    }
    return delivered;
  }

  /** Used by Nest's @Sse teardown when a client disconnects. */
  unsubscribe(userId: string, stream$: Observable<AmsEvent>) {
    // the Subject inside the observable already got unsubscribed by Nest;
    // nothing to do beyond keeping the API explicit for future use
    void userId;
    void stream$;
  }

  /** Comment-only tick keeps half-open connections from piling up behind proxies. */
  private ensureHeartbeat() {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const set of this.subscribers.values()) {
        for (const subject of set) {
          try {
            subject.next({ type: 'notification', at: new Date().toISOString() }); // cheap no-op signal
          } catch {
            /* dropped below */
          }
        }
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  clearAll() {
    for (const set of this.subscribers.values()) for (const s of set) s.complete();
    this.subscribers.clear();
  }
}
