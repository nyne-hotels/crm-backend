import { NotFoundException } from '@nestjs/common';
import { and, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { alias, type AnyPgColumn, type PgTable } from 'drizzle-orm/pg-core';
import { staffUsers } from '../db/schema/index.js';
import type { Transaction } from '../db/with-staff.js';

// ---------------------------------------------------------------------
// "Last updated by Nisha Silva, 21 Oct 2026"
// Join `updater` and select `lastUpdated(table)`:
//
//   db.select({ ...cols, lastUpdated: lastUpdated(occasions) })
//     .from(occasions)
//     .leftJoin(updater, joinUpdater(occasions))
//
// `by` is null when the system made the change; screens show "System".
// ---------------------------------------------------------------------
export const updater = alias(staffUsers, 'updater');

interface Audited {
  updatedAt: AnyPgColumn;
  updatedBy: AnyPgColumn;
}

export const joinUpdater = (table: Audited): SQL => eq(updater.id, table.updatedBy);

export const lastUpdated = (table: Audited) => ({
  at: table.updatedAt,
  by: sql<string | null>`nullif(concat_ws(' ', ${updater.firstName}, ${updater.lastName}), '')`,
});

export interface LastUpdated {
  at: Date;
  by: string | null;
}

// "Created 6 Oct 2026 by System" – the same, for created_at / created_by:
//   .leftJoin(creator, joinCreator(contacts)) and select createdInfo(contacts)
export const creator = alias(staffUsers, 'creator');

interface Created {
  createdAt: AnyPgColumn;
  createdBy: AnyPgColumn;
}

export const joinCreator = (table: Created): SQL => eq(creator.id, table.createdBy);

export const createdInfo = (table: Created) => ({
  at: table.createdAt,
  by: sql<string | null>`nullif(concat_ws(' ', ${creator.firstName}, ${creator.lastName}), '')`,
});

// Marks a record as changed when only one of its child rows changed (for
// example a guest's phone), so its "Last updated by" stays meaningful. The
// audit trigger stamps updated_at and updated_by; the value set here is replaced.
type Touchable = PgTable & { id: AnyPgColumn; updatedAt: AnyPgColumn };

export async function touch(tx: Transaction, table: Touchable, id: number | string) {
  await tx
    .update(table)
    .set({ updatedAt: sql`now()` } as any)
    .where(eq(table.id, id));
}

// ---------------------------------------------------------------------
// Soft delete: "delete" sets deleted_at, "restore" clears it. The audit
// trigger fills and clears deleted_by. Every list must filter with
// isNull(table.deletedAt) (or read from a view, which already does).
// Run these inside withActingStaff() so the trigger knows who did it.
// ---------------------------------------------------------------------
type SoftDeletable = PgTable & { id: AnyPgColumn; deletedAt: AnyPgColumn };

export async function softDelete(tx: Transaction, table: SoftDeletable, id: number | string) {
  const rows = await tx
    .update(table)
    .set({ deletedAt: new Date() } as any)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning({ id: table.id });
  if (!rows.length) throw new NotFoundException('Not found, or already deleted');
}

export async function restore(tx: Transaction, table: SoftDeletable, id: number | string) {
  const rows = await tx
    .update(table)
    .set({ deletedAt: null } as any)
    .where(and(eq(table.id, id), isNotNull(table.deletedAt)))
    .returning({ id: table.id });
  if (!rows.length) throw new NotFoundException('Not found, or not deleted');
}
