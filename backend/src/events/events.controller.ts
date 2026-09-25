import { Controller, Get, OnModuleDestroy, Req, Sse } from '@nestjs/common';
import { Observable } from 'rxjs';
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
 */
@Controller('events')
export class EventsController implements OnModuleDestroy {
  constructor(private events: EventsService) {}

  @Get()
  @Sse()
  stream(@Req() req: { user: { id: string } }): Observable<AmsEvent> {
    return this.events.subscribeUser(req.user.id);
  }

  onModuleDestroy() {
    this.events.clearAll();
  }
}
