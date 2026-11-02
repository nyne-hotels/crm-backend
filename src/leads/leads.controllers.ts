import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentStaff, RequireAccess } from '../auth/decorators.js';
import type { SignedInStaff } from '../auth/signed-in-staff.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { InteractionsService } from './interactions.service.js';
import {
  boardSchema,
  changeLeadStatusSchema,
  createInteractionSchema,
  createLeadSchema,
  leadNoteSchema,
  linkStaySchema,
  listLeadsSchema,
  updateInteractionSchema,
  updateLeadSchema,
  type BoardFilter,
  type ChangeLeadStatus,
  type CreateInteraction,
  type CreateLead,
  type LeadNote,
  type LinkStay,
  type ListLeads,
  type UpdateInteraction,
  type UpdateLead,
} from './leads.schemas.js';
import { LeadsService } from './leads.service.js';

// Leads: every role sees them; admin and management create and work them
// (marketing views only).
@Controller('leads')
@RequireAccess('leads', 'view')
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get()
  list(@Query(new ZodValidationPipe(listLeadsSchema)) query: ListLeads, @CurrentStaff() staff: SignedInStaff) {
    return this.leads.list(query, staff);
  }

  // the named routes come before :id
  @Get('board')
  board(@Query(new ZodValidationPipe(boardSchema)) query: BoardFilter, @CurrentStaff() staff: SignedInStaff) {
    return this.leads.board(query, staff);
  }

  // My follow-ups: the signed-in person's open leads due today or overdue
  @Get('follow-ups')
  followUps(@CurrentStaff() staff: SignedInStaff) {
    return this.leads.followUps(staff);
  }

  // who can own a lead, for the owner pickers and filters
  @Get('owners')
  owners() {
    return this.leads.owners();
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.leads.get(id);
  }

  @Get(':id/timeline')
  timeline(@Param('id', ParseIntPipe) id: number) {
    return this.leads.timeline(id);
  }

  @Post()
  @RequireAccess('leads', 'edit')
  create(@Body(new ZodValidationPipe(createLeadSchema)) body: CreateLead, @CurrentStaff() staff: SignedInStaff) {
    return this.leads.create(body, staff);
  }

  @Patch(':id')
  @RequireAccess('leads', 'edit')
  update(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(updateLeadSchema)) body: UpdateLead) {
    return this.leads.update(id, body);
  }

  // drag on the board, Change status, Mark lost, Reopen
  @Post(':id/status')
  @HttpCode(200)
  @RequireAccess('leads', 'edit')
  changeStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(changeLeadStatusSchema)) body: ChangeLeadStatus,
  ) {
    return this.leads.changeStatus(id, body);
  }

  @Post(':id/link-stay')
  @HttpCode(200)
  @RequireAccess('leads', 'edit')
  linkStay(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(linkStaySchema)) body: LinkStay) {
    return this.leads.linkStay(id, body.stayId);
  }

  // Snooze to tomorrow
  @Post(':id/snooze')
  @HttpCode(200)
  @RequireAccess('leads', 'edit')
  snooze(@Param('id', ParseIntPipe) id: number) {
    return this.leads.snooze(id);
  }

  // returns the timeline with the new note
  @Post(':id/notes')
  @RequireAccess('leads', 'edit')
  addNote(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(leadNoteSchema)) body: LeadNote) {
    return this.leads.addNote(id, body.body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireAccess('leads', 'edit')
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.leads.remove(id);
  }
}

// Logged calls, WhatsApps, emails, meetings, visits and Instagram DMs.
@Controller('interactions')
@RequireAccess('leads', 'edit')
export class InteractionsController {
  constructor(private readonly interactions: InteractionsService) {}

  @Post()
  create(
    @Body(new ZodValidationPipe(createInteractionSchema)) body: CreateInteraction,
    @CurrentStaff() staff: SignedInStaff,
  ) {
    return this.interactions.create(body, staff);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateInteractionSchema)) body: UpdateInteraction,
    @CurrentStaff() staff: SignedInStaff,
  ) {
    return this.interactions.update(id, body, staff);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentStaff() staff: SignedInStaff) {
    await this.interactions.remove(id, staff);
  }
}

// The Leads panel on the guest profile: their leads and conversations.
@Controller('guests/:guestId')
@RequireAccess('leads', 'view')
export class GuestLeadsController {
  constructor(
    private readonly leads: LeadsService,
    private readonly interactions: InteractionsService,
  ) {}

  @Get('leads')
  leadsOf(@Param('guestId', ParseIntPipe) guestId: number) {
    return this.leads.forGuest(guestId);
  }

  @Get('interactions')
  interactionsOf(@Param('guestId', ParseIntPipe) guestId: number) {
    return this.interactions.forGuest(guestId);
  }
}
