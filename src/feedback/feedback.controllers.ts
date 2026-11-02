import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentStaff, RequireAccess } from '../auth/decorators.js';
import type { SignedInStaff } from '../auth/signed-in-staff.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { EmployeesService } from './employees.service.js';
import { FeedbackUploadsService } from './feedback-uploads.service.js';
import {
  createEmployeeSchema,
  createFeedbackSchema,
  createMentionSchema,
  employeeOptionsSchema,
  feedbackNoteSchema,
  followUpSchema,
  listEmployeesSchema,
  listFeedbackSchema,
  staffListSchema,
  staySearchSchema,
  updateEmployeeSchema,
  updateFeedbackSchema,
  updateMentionSchema,
  uploadRowsSchema,
  type CreateEmployee,
  type CreateFeedback,
  type CreateMention,
  type EmployeeOptions,
  type FeedbackNote,
  type FollowUp,
  type ListEmployees,
  type ListFeedback,
  type StaffList,
  type StaySearch,
  type UpdateEmployee,
  type UpdateFeedback,
  type UpdateMention,
  type UploadRows,
} from './feedback.schemas.js';
import { FeedbackService } from './feedback.service.js';
import { MentionsService } from './mentions.service.js';

// Upload responses from the form tool's file. Registered before
// FeedbackController, so /feedback/uploads isn't read as an id.
@Controller('feedback/uploads')
@RequireAccess('feedback', 'edit')
export class FeedbackUploadsController {
  constructor(private readonly uploads: FeedbackUploadsService) {}

  @Post('preview')
  @HttpCode(200)
  preview(@Body(new ZodValidationPipe(uploadRowsSchema)) body: UploadRows) {
    return this.uploads.preview(body.rows);
  }

  @Post()
  commit(@Body(new ZodValidationPipe(uploadRowsSchema)) body: UploadRows) {
    return this.uploads.commit(body.rows);
  }
}

// Feedback: every role reads responses and hotel ratings; admin and
// management add them and follow them up. Employee mentions need the
// employees area (management and admin): marketing never sees them.
@Controller('feedback')
@RequireAccess('feedback', 'view')
export class FeedbackController {
  constructor(
    private readonly feedback: FeedbackService,
    private readonly mentions: MentionsService,
  ) {}

  @Get()
  list(@Query(new ZodValidationPipe(listFeedbackSchema)) query: ListFeedback, @CurrentStaff() staff: SignedInStaff) {
    return this.feedback.list(query, staff);
  }

  // the named routes come before :id
  @Get('ratings')
  ratings() {
    return this.feedback.ratings();
  }

  // Add response: find the stay
  @Get('stays')
  @RequireAccess('feedback', 'edit')
  searchStays(@Query(new ZodValidationPipe(staySearchSchema)) query: StaySearch) {
    return this.feedback.searchStays(query.q);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number, @CurrentStaff() staff: SignedInStaff) {
    return this.feedback.get(id, staff);
  }

  @Get(':id/timeline')
  timeline(@Param('id', ParseIntPipe) id: number) {
    return this.feedback.timeline(id);
  }

  @Post()
  @RequireAccess('feedback', 'edit')
  create(@Body(new ZodValidationPipe(createFeedbackSchema)) body: CreateFeedback, @CurrentStaff() staff: SignedInStaff) {
    return this.feedback.create(body, staff);
  }

  @Patch(':id')
  @RequireAccess('feedback', 'edit')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateFeedbackSchema)) body: UpdateFeedback,
    @CurrentStaff() staff: SignedInStaff,
  ) {
    return this.feedback.update(id, body, staff);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireAccess('feedback', 'edit')
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.feedback.remove(id);
  }

  // Mark followed up, with the outcome
  @Post(':id/follow-up')
  @HttpCode(200)
  @RequireAccess('feedback', 'edit')
  followUp(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(followUpSchema)) body: FollowUp,
    @CurrentStaff() staff: SignedInStaff,
  ) {
    return this.feedback.markFollowedUp(id, body.outcome, staff);
  }

  @Delete(':id/follow-up')
  @RequireAccess('feedback', 'edit')
  clearFollowUp(@Param('id', ParseIntPipe) id: number, @CurrentStaff() staff: SignedInStaff) {
    return this.feedback.clearFollowUp(id, staff);
  }

  // returns the timeline with the new note (saved on the stay)
  @Post(':id/notes')
  @RequireAccess('feedback', 'edit')
  addNote(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(feedbackNoteSchema)) body: FeedbackNote) {
    return this.feedback.addNote(id, body.body);
  }

  // ---------- employee mentions (each returns the response's mentions) ----------
  @Post(':id/mentions')
  @RequireAccess('employees', 'edit')
  addMention(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(createMentionSchema)) body: CreateMention) {
    return this.mentions.create(id, body);
  }

  @Patch('mentions/:mentionId')
  @RequireAccess('employees', 'edit')
  updateMention(
    @Param('mentionId', ParseIntPipe) mentionId: number,
    @Body(new ZodValidationPipe(updateMentionSchema)) body: UpdateMention,
  ) {
    return this.mentions.update(mentionId, body);
  }

  @Delete('mentions/:mentionId')
  @RequireAccess('employees', 'edit')
  removeMention(@Param('mentionId', ParseIntPipe) mentionId: number) {
    return this.mentions.remove(mentionId);
  }
}

// The Feedback panels on the guest profile and the stay detail.
@Controller()
@RequireAccess('feedback', 'view')
export class FeedbackPanelsController {
  constructor(private readonly feedback: FeedbackService) {}

  @Get('guests/:guestId/feedback')
  forGuest(@Param('guestId', ParseIntPipe) guestId: number) {
    return this.feedback.forGuest(guestId);
  }

  @Get('stays/:stayId/feedback')
  forStay(@Param('stayId', ParseIntPipe) stayId: number) {
    return this.feedback.forStay(stayId);
  }
}

// Employees: management and admin see and keep the list.
@Controller('employees')
@RequireAccess('employees', 'view')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  list(@Query(new ZodValidationPipe(listEmployeesSchema)) query: ListEmployees) {
    return this.employees.list(query);
  }

  // the named routes come before :id
  @Get('options')
  options(@Query(new ZodValidationPipe(employeeOptionsSchema)) query: EmployeeOptions) {
    return this.employees.options(query);
  }

  @Get('staff-options')
  @RequireAccess('employees', 'edit')
  staffOptions() {
    return this.employees.staffOptions();
  }

  @Post('uploads/preview')
  @HttpCode(200)
  @RequireAccess('employees', 'edit')
  previewStaffList(@Body(new ZodValidationPipe(staffListSchema)) body: StaffList) {
    return this.employees.previewStaffList(body);
  }

  @Post('uploads')
  @RequireAccess('employees', 'edit')
  commitStaffList(@Body(new ZodValidationPipe(staffListSchema)) body: StaffList) {
    return this.employees.commitStaffList(body);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.employees.get(id);
  }

  @Get(':id/mentions')
  mentions(@Param('id', ParseIntPipe) id: number) {
    return this.employees.mentions(id);
  }

  @Post()
  @RequireAccess('employees', 'edit')
  create(@Body(new ZodValidationPipe(createEmployeeSchema)) body: CreateEmployee) {
    return this.employees.create(body);
  }

  @Patch(':id')
  @RequireAccess('employees', 'edit')
  update(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(updateEmployeeSchema)) body: UpdateEmployee) {
    return this.employees.update(id, body);
  }
}
