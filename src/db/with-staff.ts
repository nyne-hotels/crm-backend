import { sql } from 'drizzle-orm';
import type { Database } from './drizzle.module.js';
import { actingStaffId } from './request-context.js';

export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

// Runs `fn` in a transaction with `app.staff_id` set, so the audit triggers
// stamp created_by / updated_by / deleted_by with this staff member.
// Pass null for system changes (imports, jobs) – the *_by columns stay NULL.
export function withStaff<T>(
  db: Database,
  staffId: number | null,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // set_config(..., true) is the parameterised form of SET LOCAL
    await tx.execute(sql`select set_config('app.staff_id', ${staffId?.toString() ?? ''}, true)`);
    return fn(tx);
  });
}

// withStaff() for the staff member making the current request (see
// request-context.ts). Use this for every write made on behalf of a user.
export function withActingStaff<T>(db: Database, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return withStaff(db, actingStaffId(), fn);
}
