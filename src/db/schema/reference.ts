import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  index,
  pgTable,
  smallint,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { notDeleted, oneOf } from './_helpers.js';
import { auditColumns, id, properties, staffUsers } from './core.js';

// =====================================================================
// 3. EMPLOYEES – everyone who works at the hotels (chefs, drivers, butlers …)
//    Most never log into the CRM; staff_user_id links the ones who do.
// =====================================================================
export const DEPARTMENTS = [
  'front_office',
  'housekeeping',
  'food_beverage',
  'kitchen',
  'spa',
  'transport',
  'activities',
  'maintenance',
  'management',
  'other',
] as const;

export const employees = pgTable(
  'employees',
  {
    id: id(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name'),
    propertyId: text('property_id').references(() => properties.id), // NULL = works across the group
    department: text('department', { enum: DEPARTMENTS }).notNull().default('other'),
    jobTitle: text('job_title'), // e.g. 'Butler', 'Head Chef', 'Driver'
    staffUserId: bigint('staff_user_id', { mode: 'number' }).references(() => staffUsers.id),
    isActive: boolean('is_active').notNull().default(true), // false once they leave; their feedback stays
    ...auditColumns(),
  },
  (t) => [
    check('employees_department_check', oneOf(t.department, DEPARTMENTS)),
    index('employees_property_idx').on(t.propertyId, t.department).where(notDeleted(t.deletedAt)),
    uniqueIndex('employees_staff_user_uq')
      .on(t.staffUserId)
      .where(sql`${t.staffUserId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  ],
);

// =====================================================================
// 4. COUNTRIES – fixed list (ISO 3166)
// =====================================================================
export const countries = pgTable(
  'countries',
  {
    code: char('code', { length: 2 }).primaryKey(), // 'LK', 'GB', 'IN' …
    name: text('name').notNull(),
    dialCode: text('dial_code'), // '+94'
    ...auditColumns(),
  },
  (t) => [uniqueIndex('countries_name_uq').on(t.name).where(notDeleted(t.deletedAt))],
);

// =====================================================================
// 5. OCCASIONS – pick-list for why someone is staying or asking about a stay
// =====================================================================
export const occasions = pgTable(
  'occasions',
  {
    id: id(),
    name: text('name').notNull(),
    sortOrder: smallint('sort_order').notNull().default(100), // order shown in the drop-down
    isActive: boolean('is_active').notNull().default(true), // false = retired, hidden from drop-downs
    ...auditColumns(),
  },
  (t) => [uniqueIndex('occasions_name_uq').on(sql`lower(${t.name})`).where(notDeleted(t.deletedAt))],
);

// =====================================================================
// 6. COMPANIES – travel agents, DMCs, OTAs, corporates
// =====================================================================
export const COMPANY_TYPES = [
  'travel_agent',
  'inbound_dmc',
  'outbound_agent',
  'ota',
  'corporate',
  'media',
  'other',
] as const;
export const COMPANY_STATUSES = ['active', 'prospect', 'dormant'] as const;

export const companies = pgTable(
  'companies',
  {
    id: id(),
    name: text('name').notNull(),
    companyType: text('company_type', { enum: COMPANY_TYPES }).notNull().default('travel_agent'),
    countryCode: char('country_code', { length: 2 }).references(() => countries.code),
    address: text('address'),
    website: text('website'),
    commissionNotes: text('commission_notes'),
    accountOwnerId: bigint('account_owner_id', { mode: 'number' }).references(() => staffUsers.id),
    status: text('status', { enum: COMPANY_STATUSES }).notNull().default('active'),
    ...auditColumns(),
  },
  (t) => [
    check('companies_company_type_check', oneOf(t.companyType, COMPANY_TYPES)),
    check('companies_status_check', oneOf(t.status, COMPANY_STATUSES)),
    uniqueIndex('companies_name_uq').on(sql`lower(${t.name})`).where(notDeleted(t.deletedAt)),
  ],
);

// =====================================================================
// 15. TAGS – flexible labels (VIP, friends & family, …)
// =====================================================================
export const tags = pgTable(
  'tags',
  {
    id: id(),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true), // false = retired: hidden from the picker, kept on guests
    ...auditColumns(),
  },
  (t) => [uniqueIndex('tags_name_uq').on(sql`lower(${t.name})`).where(notDeleted(t.deletedAt))],
);
