import { Module } from '@nestjs/common';
import { ContactImportHistoryService } from './contact-import-history.service.js';
import { ContactImportService } from './contact-import.service.js';
import { ContactImportsController } from './contact-imports.controller.js';

// Settings → Import contacts: upload a list, match columns, review, import,
// and the history with its change log (Module 9).
@Module({
  controllers: [ContactImportsController],
  providers: [ContactImportService, ContactImportHistoryService],
})
export class ContactImportsModule {}
