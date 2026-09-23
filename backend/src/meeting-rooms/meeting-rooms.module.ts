import { Module, OnModuleInit } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkflowModule, WorkflowService } from '../workflow/workflow.module';
import { MeetingRoomsController } from './meeting-rooms.controller';
import { MeetingRoomsService } from './meeting-rooms.service';

@Module({
  imports: [AuthModule, WorkflowModule],
  controllers: [MeetingRoomsController],
  providers: [MeetingRoomsService],
})
export class MeetingRoomsModule implements OnModuleInit {
  constructor(private rooms: MeetingRoomsService, private workflow: WorkflowService) {}

  /** Requester-initiated cancel of an approved meeting → module cleanup + notifications. */
  onModuleInit() {
    this.workflow.registerCancelHook('MEETING_ROOM_REQUEST', (requestId, actor) =>
      this.rooms.adminCancel(requestId, 'Cancelled by requester', actor),
    );
  }
}
