import { Module, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { AuthModule } from '../auth/auth.module';
import { TelegramModule } from '../telegram/telegram.module';
import { TelegramService } from '../telegram/telegram.service';
import { WorkflowModule, WorkflowService } from '../workflow/workflow.module';
import { SettingsModule } from '../settings/settings.module';
import { FleetComplianceModule } from '../fleet/compliance.module';
import { CarsController } from './cars.controller';
import { CarsService } from './cars.service';
import { TripRemindersService } from './trip-reminders.service';
import { TelegramCarActionsService } from './telegram-car-actions.service';
import { OdometerReaderService } from './odometer-reader.service';
import { OdometerSevenSegService } from './odometer-7seg/seven-seg.service';
import { OdometerTrainingController } from './odometer-7seg/training.controller';

export { CarsService } from './cars.service';

@Module({
  imports: [
    AuthModule,
    TelegramModule,
    WorkflowModule,
    SettingsModule,
    FleetComplianceModule,
    // odometer photos are sniffed in memory before anything is written
    MulterModule.register({ storage: memoryStorage() }),
  ],
  controllers: [CarsController, OdometerTrainingController],
  providers: [
    CarsService,
    TripRemindersService,
    TelegramCarActionsService,
    OdometerSevenSegService,
    OdometerReaderService,
  ],
  exports: [CarsService],
})
export class CarsModule implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    private cars: CarsService,
    private workflow: WorkflowService,
    private tgActions: TelegramCarActionsService,
    private telegram: TelegramService,
    private ocr: OdometerReaderService,
  ) {
    // 🛣️ the driver's Telegram photo + kilo lands on the same capture path the
    // Administration panel uses (validation, evidence photo, audit trail)
    this.telegram.odoRef = {
      capture: (assignmentId, data, actor) => this.cars.captureOdometer(assignmentId, data, data.photo, actor),
    };
    // 🛣️ OCR shadow read (docs/ODOMETER_OCR_PLAN.md): every photo the bot keeps is
    // handed to the reader, which only stores what it saw. Nothing downstream
    // depends on it — no key, no internet or a provider outage changes nothing.
    this.telegram.odoPhotoRef = {
      afterStore: (assignmentId, photo) => void this.ocr.readAndRecord(assignmentId, photo),
    };
  }

  /** Requester-initiated cancel of an approved car request → module cleanup + notifications. */
  onModuleInit() {
    // origin='requester' so the audit action and the bell wording do not blame
    // Administration for a cancellation the requester made themselves
    this.workflow.registerCancelHook('CAR_REQUEST', (requestId, actor) =>
      this.cars.adminCancelApproved(requestId, 'Cancelled by requester', actor, 'requester'),
    );

    // Status mirroring: CarRequest.status now follows request_documents.status on
    // EVERY workflow transition (submit → PENDING_APPROVAL, approve → APPROVED,
    // reject → REJECTED, return → DRAFT, cancel → CANCELLED). Previously the
    // workflow engine never touched CarRequest.status, so approved bookings sat
    // at DRAFT forever and every CarRequest.status-based query missed them.
    // Module-specific actions (assign/release/trip/admin-cancel) keep writing both
    // sides explicitly as before. Availability/clash/fleet-overview queries use the
    // mirrored status — single source of truth, one place to fix.
    this.workflow.registerStatusMirror('CAR_REQUEST', (requestId, status, tx) =>
      tx.carRequest.update({ where: { requestId }, data: { status } }).then(() => undefined),
    );

    // Final approval → the dispatcher's queue must light up immediately. The
    // approval path itself only rings the requester's bell, so without this the
    // trip waited for the "start time passed, no vehicle" nudge hours later.
    this.workflow.registerFinalApproveHook('CAR_REQUEST', (requestId) =>
      this.cars.notifyReadyToAssign(requestId),
    );

    // Viewer: the requester's department manager may OPEN a car request they
    // neither own nor approve — they are the ones asked for the optional ack.
    // Their eligibility is exactly managerAckUserIds() (same query the
    // manager-ack endpoint authorizes with), so the grant can never outgrow it.
    this.workflow.registerViewerHook('CAR_REQUEST', (requestId) => this.cars.managerAckUserIds(requestId));
  }

  /** Telegram approve/assign surface — wires into the Telegram poll loop. */
  onApplicationBootstrap() {
    this.tgActions.wire();
  }
}
