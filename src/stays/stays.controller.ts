import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { RequireAccess } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  commitImportSchema,
  importRowsSchema,
  saveMappingSchema,
  type CommitImport,
  type ImportRows,
  type SaveMapping,
} from './imports/booking-import.schemas.js';
import { BookingImportService } from './imports/booking-import.service.js';
import {
  changeStatusSchema,
  createStaySchema,
  listStaysSchema,
  updateStaySchema,
  type ChangeStatus,
  type CreateStay,
  type ListStays,
  type UpdateStay,
} from './stays.schemas.js';
import { StaysService } from './stays.service.js';

// Every role sees stays; admin and management add, edit, import and check
// guests in and out (marketing views only).
//
// Registered before StaysController, so /stays/imports isn't read as a stay id.
@Controller('stays/imports')
@RequireAccess('stays', 'edit')
export class BookingImportController {
  constructor(private readonly imports: BookingImportService) {}

  @Get()
  history() {
    return this.imports.history();
  }

  // the CRM fields and the column matching saved last time
  @Get('setup')
  setup() {
    return this.imports.setup();
  }

  @Put('mapping')
  saveMapping(@Body(new ZodValidationPipe(saveMappingSchema)) body: SaveMapping) {
    return this.imports.saveMapping(body.mapping);
  }

  @Post('preview')
  @HttpCode(200)
  preview(@Body(new ZodValidationPipe(importRowsSchema)) body: ImportRows) {
    return this.imports.preview(body);
  }

  @Post()
  commit(@Body(new ZodValidationPipe(commitImportSchema)) body: CommitImport) {
    return this.imports.commit(body);
  }
}

@Controller('stays')
@RequireAccess('stays', 'view')
export class StaysController {
  constructor(private readonly stays: StaysService) {}

  @Get()
  list(@Query(new ZodValidationPipe(listStaysSchema)) query: ListStays) {
    return this.stays.list(query);
  }

  // before :id so "quick-counts" isn't read as an id
  @Get('quick-counts')
  quickCounts() {
    return this.stays.quickCounts();
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.stays.get(id);
  }

  @Post()
  @RequireAccess('stays', 'edit')
  create(@Body(new ZodValidationPipe(createStaySchema)) body: CreateStay) {
    return this.stays.create(body);
  }

  @Patch(':id')
  @RequireAccess('stays', 'edit')
  update(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(updateStaySchema)) body: UpdateStay) {
    return this.stays.update(id, body);
  }

  // check in, check out, no-show, cancel (with a reason), and their undo steps
  @Post(':id/status')
  @HttpCode(200)
  @RequireAccess('stays', 'edit')
  changeStatus(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(changeStatusSchema)) body: ChangeStatus) {
    return this.stays.changeStatus(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireAccess('stays', 'edit')
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.stays.remove(id);
  }

  // Bringing back a deleted stay is for admins, like guests.
  @Post(':id/restore')
  @RequireAccess('settings', 'edit')
  restore(@Param('id', ParseIntPipe) id: number) {
    return this.stays.restore(id);
  }
}

// The Stays panel on the guest profile.
@Controller('guests/:guestId/stays')
@RequireAccess('stays', 'view')
export class GuestStaysController {
  constructor(private readonly stays: StaysService) {}

  @Get()
  list(@Param('guestId', ParseIntPipe) guestId: number) {
    return this.stays.forGuest(guestId);
  }
}
