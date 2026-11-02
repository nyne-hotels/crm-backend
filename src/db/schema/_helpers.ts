import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

// Builds the body of a CHECK (col IN (...)) constraint from a list of allowed values.
// The schema uses CHECK constraints instead of ENUM types so new values only need an ALTER TABLE.
export function oneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;
}

export function notDeleted(deletedAt: AnyPgColumn): SQL {
  return sql`${deletedAt} IS NULL`;
}
