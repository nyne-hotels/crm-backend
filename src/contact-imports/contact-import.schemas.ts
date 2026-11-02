import { z } from 'zod';
import { CONTACT_IMPORT_FIELD_KEYS } from './contact-import-rules.js';

const trimmed = z.string().trim();
// spreadsheet cells arrive as text; numbers and ticks are accepted too
const cell = z
  .union([z.string(), z.number(), z.boolean()])
  .transform(String)
  .pipe(z.string().max(4000, 'A cell is too long'));

export const MAX_CONTACT_ROWS = 10_000;

const field = z.enum(CONTACT_IMPORT_FIELD_KEYS);

// The admin's choice for a row already in the CRM; rows without one are ignored.
const choice = z.object({
  index: z.number().int().min(0),
  decision: z.enum(['ignore', 'add', 'update']),
  contactId: z.number().int().positive().optional(), // which matched contact to update
});

export const contactRowsSchema = z.object({
  fileName: trimmed.min(1).max(255),
  rows: z
    .array(z.partialRecord(field, cell))
    .min(1, 'The file has no contacts')
    .max(MAX_CONTACT_ROWS, `Import at most ${MAX_CONTACT_ROWS.toLocaleString('en-GB')} contacts at a time`),
  choices: z.array(choice).max(MAX_CONTACT_ROWS).default([]),
});
export type ContactRows = z.infer<typeof contactRowsSchema>;

export const commitContactImportSchema = contactRowsSchema.extend({
  mapping: z.partialRecord(field, trimmed.min(1).max(200)).default({}), // kept with the import
  warningsRead: z.literal(true, 'Tick "I have read the warnings" first'),
});
export type CommitContactImport = z.infer<typeof commitContactImportSchema>;

// CRM field → the file's column heading
export const saveContactMappingSchema = z.object({ mapping: z.partialRecord(field, trimmed.min(1).max(200)) });
export type SaveContactMapping = z.infer<typeof saveContactMappingSchema>;
