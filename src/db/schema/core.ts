import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { notDeleted, oneOf } from './_helpers.js';
import { authUsers } from './auth.js';

// ---------------------------------------------------------------------
// Audit columns shared by every table.
// The *_by columns are filled by the set_audit_columns() trigger from
// `app.staff_id` (see withStaff()); NULL means the system did it.
// ---------------------------------------------------------------------
export const staffRef = (name: string) =>
  bigint(name, { mode: 'number' }).references((): AnyPgColumn => staffUsers.id);

export const auditColumns = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: staffRef('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: staffRef('updated_by'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: staffRef('deleted_by'),
});

// For insert-only tables (contact_tags, contact_merges, not_duplicates).
export const createdColumns = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: staffRef('created_by'),
});

export const id = () => bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity();

// =====================================================================
// 1. STAFF USERS – who uses the CRM (every table points here)
// =====================================================================
export const STAFF_ROLES = [
  'admin',
  'management',
  'marketing',
] as const;

export const staffUsers = pgTable(
  'staff_users',
  {
    id: id(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name'),
    email: text('email'), // optional; staff sign in with their username
    role: text('role', { enum: STAFF_ROLES }).notNull(),
    // home hotel; NULL = group-wide
    propertyId: text('property_id').references((): AnyPgColumn => properties.id),
    isActive: boolean('is_active').notNull().default(true),
    // the Better Auth account this staff member signs in with
    authUserId: text('auth_user_id')
      .unique()
      .references(() => authUsers.id),
    ...auditColumns(),
  },
  (t) => [
    check('staff_users_role_check', oneOf(t.role, STAFF_ROLES)),
    uniqueIndex('staff_users_email_uq').on(sql`lower(${t.email})`).where(notDeleted(t.deletedAt)),
  ],
);

// =====================================================================
// 2. PROPERTIES – the hotels
// =====================================================================
export const properties = pgTable(
  'properties',
  {
    id: text('id').primaryKey(), // 'P01' … 'P08'
    name: text('name').notNull(),
    location: text('location'),
    propertyType: text('property_type'),
    webUrl: text('web_url'),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns(),
  },
  (t) => [uniqueIndex('properties_name_uq').on(t.name).where(notDeleted(t.deletedAt))],
);
