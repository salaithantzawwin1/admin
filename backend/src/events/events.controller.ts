import { Controller, Get, OnModuleDestroy, Req, Sse } from '@nestjs/common';
import { map, Observable } from 'rxjs';
import { EventsService, AmsEvent } from './events.service';

/**
 * SSE endpoint — GET /events?token=<JWT>
 *
 * The global JwtAuthGuard lifts the `token` query parameter into the
 * Authorization header (same mechanism inventory image tags already use),
 * because EventSource cannot send custom headers.
 *
 * Payloads are lightweight signals (no row data):
 *   { type: 'assignment.updated', requestId }
 *   { type: 'driver.updated', driverId }
 *   { type: 'request.updated', requestId }
 *   { type: 'notification' }
 * Clients refetch the affected views on signal — the API stays the single
 * source of truth and the 15s polling keeps working as the fallback.
 *
 * Nest's @Sse unsubscribes the observable on client disconnect, which runs
 * subscribeUser's teardown (subject removed from the broker map).
 *
 * WIRE FORMAT — Nest's SseStream serialises `message.type` as the SSE `event:`
 * line and `message.data` as the payload. Emitting the bare AmsEvent (whose
 * field is literally named `type`) produced `event: assignment.updated` with an
 * EMPTY data buffer, and the SSE spec discards a frame whose data buffer is
 * empty without dispatching anything — so no open panel ever received a signal
 * and only a manual reload showed the change. Wrapping the signal in `data`
 * emits a plain `data: {...}` frame, delivered as the default `message` event
 * that the client's onmessage handler parses.
 */
@Controller('events')
export class EventsController implements OnModuleDestroy {
  constructor(private events: EventsService) {}

  @Get()
  @Sse()
  stream(@Req() req: { user: { id: string } }): Observable<{ data: AmsEvent }> {
    return this.events.subscribeUser(req.user.id).pipe(map((evt) => ({ data: evt })));
  }

  onModuleDestroy() {
    this.events.clearAll();
  }
}
