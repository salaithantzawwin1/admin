import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { IsNotEmpty } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WorkflowService } from './workflow.service';
import { DelegationsService } from './delegations.service';
import { CreateDelegationDto } from './dto/delegation.dto';
import { Actor } from '../org/org.service';

// Note: CAR_REQUEST is intentionally excluded — it must be created via POST /cars/requests
// so the CarRequest extension row (destination, dates, vehicle type…) always exists.
export class CreateRequestDto {
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @IsOptional() @IsIn(['GENERIC_REQUEST', 'MEETING_ROOM_REQUEST', 'PURCHASE_REQUEST', 'OFFICE_SUPPLY_REQUEST', 'TRAVEL_REQUEST', 'MAINTENANCE_REQUEST'])
  docType?: string;
}

export class UpdateRequestDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
}

export class ApprovalCommentDto {
  @IsOptional() @IsString() @MaxLength(2000) comment?: string;
}

@ApiTags('workflow')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class WorkflowController {
  constructor(
    private workflow: WorkflowService,
    private delegations: DelegationsService,
  ) {}

  private actor(req): Actor {
    return { userId: req.user.id, username: req.user.username };
  }

  // ---------- requests ----------
  @Get('requests')
  list(
    @Req() req,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('scope') scope?: string,
    @Query('docType') docType?: string,
    @Query('archived') archived?: string,
  ) {
    return this.workflow.list({
      page: Math.max(1, Number(page || 1)),
      pageSize: Math.min(100, Number(pageSize || 20)),
      status,
      docType,
      archived,
      mine: scope === 'mine',
      dept: scope === 'dept',
    }, this.actor(req));
  }

  @Post('requests')
  create(@Req() req, @Body() dto: CreateRequestDto) {
    return this.workflow.create(dto, this.actor(req));
  }

  @Get('requests/inbox')
  inbox(@Req() req, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.workflow.inbox(this.actor(req), Math.max(1, Number(page || 1)), Math.min(100, Number(pageSize || 20)));
  }

  @Get('requests/:id')
  detail(@Req() req, @Param('id') id: string) {
    return this.workflow.detail(id, this.actor(req));
  }

  @Patch('requests/:id')
  update(@Req() req, @Param('id') id: string, @Body() dto: UpdateRequestDto) {
    return this.workflow.update(id, dto, this.actor(req));
  }

  @Post('requests/:id/submit')
  submit(@Req() req, @Param('id') id: string) {
    return this.workflow.submit(id, this.actor(req));
  }

  @Post('requests/:id/approve')
  approve(@Req() req, @Param('id') id: string, @Body() dto: ApprovalCommentDto) {
    return this.workflow.approve(id, dto.comment, this.actor(req));
  }

  @Post('requests/:id/reject')
  reject(@Req() req, @Param('id') id: string, @Body() dto: ApprovalCommentDto) {
    return this.workflow.reject(id, dto.comment, this.actor(req));
  }

  @Post('requests/:id/return')
  returnRequest(@Req() req, @Param('id') id: string, @Body() dto: ApprovalCommentDto) {
    return this.workflow.returnToRequester(id, dto.comment, this.actor(req));
  }

  @Delete('requests/:id')
  cancel(@Req() req, @Param('id') id: string) {
    return this.workflow.cancel(id, this.actor(req));
  }

  /** Requester cancels an APPROVED request — routed to the owning module so the
   *  vehicle/room/stock is freed and Administration + driver get notified. */
  @Post('requests/:id/cancel-approved')
  cancelApproved(@Req() req, @Param('id') id: string) {
    return this.workflow.cancelApproved(id, this.actor(req));
  }

  // ---------- delegations ----------
  @Get('delegations')
  listDelegations(@Req() req) {
    return this.delegations.listMine(this.actor(req));
  }

  @Post('delegations')
  createDelegation(@Req() req, @Body() dto: CreateDelegationDto) {
    return this.delegations.create(dto, this.actor(req));
  }

  @Patch('delegations/:id/end')
  endDelegation(@Req() req, @Param('id') id: string) {
    return this.delegations.end(id, this.actor(req));
  }
}
