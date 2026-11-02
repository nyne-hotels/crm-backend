import { bigint, check, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { oneOf } from './_helpers.js';
import { auditColumns, id, staffUsers } from './core.js';
import { contacts } from './contacts.js';

// =====================================================================
// 19. DATA ISSUES – review queue for bad emails/phones etc.
// =====================================================================
export const DATA_ISSUE_STATUSES = ['open', 'fixed', 'ignored'] as const;

export const dataIssues = pgTable(
  'data_issues',
  {
    id: id(),
    contactId: bigint('contact_id', { mode: 'number' }).references(() => contacts.id, { onDelete: 'cascade' }),
    field: text('field').notNull(),
    rawValue: text('raw_value'),
    issue: text('issue').notNull(),
    suggestedFix: text('suggested_fix'),
    status: text('status', { enum: DATA_ISSUE_STATUSES }).notNull().default('open'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: bigint('resolved_by', { mode: 'number' }).references(() => staffUsers.id),
    ...auditColumns(),
  },
  (t) => [check('data_issues_status_check', oneOf(t.status, DATA_ISSUE_STATUSES))],
);
