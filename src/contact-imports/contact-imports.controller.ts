import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { RequireAccess } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ContactImportHistoryService } from './contact-import-history.service.js';
import {
  commitContactImportSchema,
  contactRowsSchema,
  saveContactMappingSchema,
  type CommitContactImport,
  type ContactRows,
  type SaveContactMapping,
} from './contact-import.schemas.js';
import { ContactImportService } from './contact-import.service.js';

// Settings → Import contacts. Admin only, like the rest of Settings: the
// 'settings' area is closed to Management and Marketing.
@Controller('settings/contact-imports')
@RequireAccess('settings', 'edit')
export class ContactImportsController {
  constructor(
    private readonly imports: ContactImportService,
    private readonly history: ContactImportHistoryService,
  ) {}

  @Get()
  list() {
    return this.history.list();
  }

  // the CRM fields, the column matching saved last time and the template's allowed values
  @Get('setup')
  setup() {
    return this.imports.setup();
  }

  @Put('mapping')
  saveMapping(@Body(new ZodValidationPipe(saveContactMappingSchema)) body: SaveContactMapping) {
    return this.imports.saveMapping(body.mapping);
  }

  @Post('preview')
  @HttpCode(200)
  preview(@Body(new ZodValidationPipe(contactRowsSchema)) body: ContactRows) {
    return this.imports.preview(body);
  }

  @Post()
  commit(@Body(new ZodValidationPipe(commitContactImportSchema)) body: CommitContactImport) {
    return this.imports.commit(body);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.history.get(id);
  }

  @Get(':id/changes')
  changes(@Param('id', ParseIntPipe) id: number) {
    return this.history.changes(id);
  }

  @Get(':id/results')
  results(@Param('id', ParseIntPipe) id: number) {
    return this.history.results(id);
  }
}
