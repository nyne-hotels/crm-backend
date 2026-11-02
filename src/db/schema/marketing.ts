import { index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { notDeleted } from './_helpers.js';
import { auditColumns, id } from './core.js';

// =====================================================================
// 23. MARKETING EXPORTS – one row per download of the marketing email list
//     (Module 5). created_by = who exported it, created_at = when.
// =====================================================================
// A filter can have several values, any of which may match. Exports logged
// before that (November 2026) kept a single value rather than a list.
export interface MarketingExportFilters {
  market?: string[];
  country?: string[];
  propertyId?: string[]; // hotels stayed at
  stage?: string[];
  lastStayFrom?: string; // 'YYYY-MM-DD'
  lastStayTo?: string;
  tagId?: number[];
  // the "More filters" panel
  contactType?: string[];
  lastHotelId?: string[]; // hotel of the last stay
  staysMin?: number; // checked-out stays
  staysMax?: number;
  birthdayMonth?: number[];
  optedInFrom?: string; // when they opted in, 'YYYY-MM-DD'
  optedInTo?: string;
  addedFrom?: string; // added to the CRM
  addedTo?: string;
  upcomingStay?: 'yes' | 'no';
  lowRating?: 'yes' | 'no';
}

export const marketingExports = pgTable(
  'marketing_exports',
  {
    id: id(),
    filters: jsonb('filters').$type<MarketingExportFilters>().notNull(),
    summary: text('summary').notNull(), // the filters in words: "Foreign · Stayed at Rock Villa"
    rowCount: integer('row_count').notNull(),
    ...auditColumns(),
  },
  (t) => [index('marketing_exports_created_idx').on(t.createdAt.desc()).where(notDeleted(t.deletedAt))],
);
