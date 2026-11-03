import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { notDeleted } from './_helpers.js';
import { auditColumns, id, staffUsers } from './core.js';

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
  filled?: string[]; // "Filled in" / "Missing": firstName, country …
  filledMatch?: 'any' | 'all';
  missing?: string[];
  missingMatch?: 'any' | 'all';
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

// =====================================================================
// 25. CAMPAIGNS – a marketing campaign (Halloween 2026 …). Its emails link
//     to the public form in campaigns/, at /<slug>; each form sent becomes a
//     lead (source 'campaign') for the campaign's owner. The slug is made
//     from the name once and never changes, so renaming doesn't break links
//     already sent. Closed with the Active switch rather than deleted: a
//     closed campaign's form says it has ended.
// =====================================================================
export const campaigns = pgTable(
  'campaigns',
  {
    id: id(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    // who its leads go to: an admin or management user, like any lead owner
    ownerId: bigint('owner_id', { mode: 'number' })
      .notNull()
      .references(() => staffUsers.id),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('campaigns_name_uq').on(sql`lower(${t.name})`).where(notDeleted(t.deletedAt)),
    uniqueIndex('campaigns_slug_uq').on(t.slug),
    check('campaigns_slug_check', sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  ],
);
