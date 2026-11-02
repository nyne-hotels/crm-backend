import { bigint, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { notDeleted } from './_helpers.js';
import { auditColumns, createdColumns, id, properties } from './core.js';

// =====================================================================
// 21. BOOKING IMPORTS – one row per booking file imported (Module 3).
//     created_by = who imported it, created_at = when.
// =====================================================================
export interface BookingImportDetails {
  newGuests: { id: number; name: string }[]; // created by this import, for staff to check
  doNotContact: { id: number; name: string }[]; // ticked the marketing box while on do-not-contact
  leadsBooked?: { id: number; name: string }[]; // open leads this import marked booked (Module 7; id = lead)
}

export const bookingImports = pgTable(
  'booking_imports',
  {
    id: id(),
    fileName: text('file_name').notNull(),
    propertyId: text('property_id').references(() => properties.id), // the hotel picked for a one-hotel file
    rowsTotal: integer('rows_total').notNull(),
    added: integer('added').notNull(),
    updated: integer('updated').notNull(),
    skipped: integer('skipped').notNull(), // error rows and rows staff skipped
    newGuests: integer('new_guests').notNull(),
    details: jsonb('details').$type<BookingImportDetails>().notNull(),
    ...auditColumns(),
  },
  (t) => [index('booking_imports_created_idx').on(t.createdAt.desc()).where(notDeleted(t.deletedAt))],
);

// =====================================================================
// 22. IMPORT MAPPINGS – which file column feeds which CRM field, remembered
//     per kind of import ('bookings') so the next file is matched for you.
// =====================================================================
export const importMappings = pgTable('import_mappings', {
  kind: text('kind').primaryKey(),
  mapping: jsonb('mapping').$type<Record<string, string>>().notNull(), // CRM field → file column heading
  // not soft-deleted; kept for the audit trigger's created_* / updated_* stamps
  ...auditColumns(),
});

// =====================================================================
// 25. CONTACT IMPORTS – one row per contact list imported in Settings →
//     Import contacts (Module 9). created_by = who imported it, created_at = when.
// =====================================================================
export type ContactImportOutcome = 'new' | 'updated' | 'added_again' | 'ignored' | 'error';

export interface ContactImportDetails {
  newContacts: { id: number; name: string; row: number }[]; // new and added again, with the file row (from 1)
  newCompanies: { id: number; name: string }[];
  doNotContact: { id: number; name: string }[]; // opted in by the file while on do-not-contact
}

// One per row of the upload, for the result file: what happened and why.
export interface ContactImportResultRow {
  row: number; // from 1
  outcome: ContactImportOutcome;
  contactId: number | null;
  reason: string | null; // errors, or the contact a row was ignored for
  values: Record<string, string>; // the row's matched cells, by CRM field
}

export const contactImports = pgTable(
  'contact_imports',
  {
    id: id(),
    fileName: text('file_name').notNull(),
    rowsTotal: integer('rows_total').notNull(),
    created: integer('created').notNull(), // new contacts
    updated: integer('updated').notNull(),
    addedAgain: integer('added_again').notNull(), // new contacts although the email or phone was in the CRM
    ignored: integer('ignored').notNull(),
    errors: integer('errors').notNull(), // including rows repeated in the file
    mapping: jsonb('mapping').$type<Record<string, string>>().notNull(), // CRM field → file column heading
    details: jsonb('details').$type<ContactImportDetails>().notNull(),
    results: jsonb('results').$type<ContactImportResultRow[]>().notNull(),
    ...auditColumns(),
  },
  (t) => [index('contact_imports_created_idx').on(t.createdAt.desc()).where(notDeleted(t.deletedAt))],
);

// =====================================================================
// 26. CONTACT IMPORT CHANGES – the change log: one row per field an import
//     changed on a contact, with the old and new value, so it can be put back
//     by hand. New and added-again contacts have one 'contact' row. Values are
//     as stored (country code, type key, consent status); company, tag and
//     hotel by name. Never edited or deleted (a trigger refuses it).
//     created_by = who imported, created_at = when.
// =====================================================================
export const contactImportChanges = pgTable(
  'contact_import_changes',
  {
    id: id(),
    importId: bigint('import_id', { mode: 'number' })
      .notNull()
      .references(() => contactImports.id),
    rowNumber: integer('row_number').notNull(), // the row in the file, from 1
    contactId: bigint('contact_id', { mode: 'number' }).notNull(), // no FK: the log outlives merged contacts
    field: text('field').notNull(), // 'firstName', 'primaryEmail', 'emailConsent', 'tag' …
    oldValue: text('old_value'),
    newValue: text('new_value'),
    ...createdColumns(),
  },
  (t) => [
    index('contact_import_changes_import_idx').on(t.importId, t.rowNumber),
    index('contact_import_changes_contact_idx').on(t.contactId, t.createdAt.desc()),
  ],
);
