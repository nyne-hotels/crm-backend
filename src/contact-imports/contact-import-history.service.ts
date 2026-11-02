import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { createdInfo, creator, joinCreator } from '../common/audit.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import { companies, contactImportChanges, contactImports, contacts } from '../db/schema/index.js';

const counts = {
  id: contactImports.id,
  fileName: contactImports.fileName,
  rowsTotal: contactImports.rowsTotal,
  created: contactImports.created,
  updated: contactImports.updated,
  addedAgain: contactImports.addedAgain,
  ignored: contactImports.ignored,
  errors: contactImports.errors,
  imported: createdInfo(contactImports),
};

// Settings → Import contacts → History (admin only): every import, and the
// change log of one. Nothing here is ever edited or deleted.
@Injectable()
export class ContactImportHistoryService {
  constructor(@InjectDb() private readonly db: Database) {}

  list() {
    return this.db
      .select(counts)
      .from(contactImports)
      .leftJoin(creator, joinCreator(contactImports))
      .where(isNull(contactImports.deletedAt))
      .orderBy(desc(contactImports.createdAt), desc(contactImports.id))
      .limit(200);
  }

  async get(id: number) {
    const [row] = await this.db
      .select({ ...counts, mapping: contactImports.mapping, details: contactImports.details })
      .from(contactImports)
      .leftJoin(creator, joinCreator(contactImports))
      .where(and(eq(contactImports.id, id), isNull(contactImports.deletedAt)));
    if (!row) throw new NotFoundException('Import not found');
    return row;
  }

  // The result file: every row of the upload with what happened to it.
  async results(id: number) {
    const [row] = await this.db
      .select({ fileName: contactImports.fileName, mapping: contactImports.mapping, results: contactImports.results })
      .from(contactImports)
      .where(and(eq(contactImports.id, id), isNull(contactImports.deletedAt)));
    if (!row) throw new NotFoundException('Import not found');
    return row;
  }

  // Every change the import made, in file order. The contact's name is as it
  // is now (an agency office contact goes by the company); null when they were
  // merged away since.
  async changes(id: number) {
    await this.get(id);
    return this.db
      .select({
        id: contactImportChanges.id,
        row: contactImportChanges.rowNumber,
        contactId: contactImportChanges.contactId,
        contactName: sql<string | null>`case when ${contacts.id} is null then null
          else coalesce(nullif(concat_ws(' ', ${contacts.firstName}, ${contacts.lastName}), ''), ${companies.name}, 'No name') end`,
        contactDeleted: sql<boolean>`${contacts.id} is null or ${contacts.deletedAt} is not null`,
        field: contactImportChanges.field,
        oldValue: contactImportChanges.oldValue,
        newValue: contactImportChanges.newValue,
      })
      .from(contactImportChanges)
      .leftJoin(contacts, eq(contacts.id, contactImportChanges.contactId))
      .leftJoin(companies, eq(companies.id, contacts.companyId))
      .where(eq(contactImportChanges.importId, id))
      .orderBy(asc(contactImportChanges.rowNumber), asc(contactImportChanges.id));
  }
}
