import { z } from 'zod';
import { IMPORT_FIELD_KEYS } from './booking-import-rules.js';

const trimmed = z.string().trim();
// spreadsheet cells arrive as text; numbers and ticks are accepted too
const cell = z
  .union([z.string(), z.number(), z.boolean()])
  .transform(String)
  .pipe(z.string().max(4000, 'A cell is too long'));

export const MAX_IMPORT_ROWS = 5000;

const field = z.enum(IMPORT_FIELD_KEYS);

export const importRowsSchema = z.object({
  fileName: trimmed.min(1).max(255),
  propertyId: trimmed.max(10).nullish(), // the hotel picked for a one-hotel file
  rows: z
    .array(z.partialRecord(field, cell))
    .min(1, 'The file has no bookings')
    .max(MAX_IMPORT_ROWS, `Import at most ${MAX_IMPORT_ROWS.toLocaleString('en-GB')} bookings at a time`),
});
export type ImportRows = z.infer<typeof importRowsSchema>;

export const commitImportSchema = importRowsSchema.extend({
  skip: z.array(z.number().int().min(0)).default([]), // row indexes staff chose to skip
});
export type CommitImport = z.infer<typeof commitImportSchema>;

// CRM field → the file's column heading
export const saveMappingSchema = z.object({ mapping: z.partialRecord(field, trimmed.min(1).max(200)) });
export type SaveMapping = z.infer<typeof saveMappingSchema>;
