import { and, gte, inArray, lt, lte, not, type SQL, type SQLWrapper } from 'drizzle-orm';
import { z } from 'zod';
import { addDays } from '../stays/stay-rules.js';

// Building blocks for the lists' filters (the "More filters" panels).
// Every filter is optional; an empty one is left out of the address.

export const yesNo = z.enum(['yes', 'no']).optional();
export type YesNo = z.infer<typeof yesNo>;

// Several values of one filter, any of which may match: '?stage=stayed,repeat_guest'
// (or the key repeated). A single value, as older links have, is a list of one.
export const anyOf = <T extends z.ZodType>(item: T) =>
  z.preprocess(
    (v) => {
      if (v === undefined || v === null || v === '') return undefined;
      const list = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(','));
      const values = [...new Set(list.map((x) => x.trim()).filter(Boolean))];
      return values.length ? values : undefined;
    },
    z.array(item).max(500).optional(),
  );

// The rows whose column is one of the values; no values, no condition.
export const inList = <T>(column: SQLWrapper, values: T[] | undefined): SQL | undefined =>
  values?.length ? inArray(column, values) : undefined;

export const countryCodes = anyOf(z.string().trim().toUpperCase().length(2));
export const ids = anyOf(z.coerce.number().int().positive());

export const filterDay = z.iso.date('Enter a date').optional();
export const filterCount = z.coerce.number().int().min(0).max(100_000).optional();
export const filterAmount = z.coerce.number().min(0).max(9_999_999_999).optional();
export const filterMonth = z.coerce.number().int().min(1).max(12).optional();

// "yes" keeps the rows where the condition holds, "no" the rest.
export const whenYesNo = (value: YesNo, condition: SQL): SQL | undefined =>
  value === 'yes' ? condition : value === 'no' ? not(condition) : undefined;

// A min / max pair on a number column. Empty means no limit on that side.
export function between(column: SQLWrapper, min: number | undefined, max: number | undefined): SQL | undefined {
  return and(min !== undefined ? gte(column, min) : undefined, max !== undefined ? lte(column, max) : undefined);
}

// A from / to pair of days on a date column, both ends included.
export function betweenDays(column: SQLWrapper, from: string | undefined, to: string | undefined): SQL | undefined {
  return and(from ? gte(column, from) : undefined, to ? lte(column, to) : undefined);
}

// The start of a day in Colombo, for timestamps such as "added" or "received".
export const startOfDay = (day: string) => new Date(`${day}T00:00:00+05:30`);

// A from / to pair of days on a timestamp column, counted in Colombo.
export function betweenTimes(column: SQLWrapper, from: string | undefined, to: string | undefined): SQL | undefined {
  return and(from ? gte(column, startOfDay(from)) : undefined, to ? lt(column, startOfDay(addDays(to, 1))) : undefined);
}

// For superRefine(): the end of each range can't come before its start.
export const rangesInOrder =
  (...pairs: [string, string][]) =>
  (v: Record<string, unknown>, ctx: z.RefinementCtx) => {
    for (const [from, to] of pairs) {
      const a = v[from] as string | number | undefined;
      const b = v[to] as string | number | undefined;
      if (a !== undefined && b !== undefined && a > b) {
        ctx.addIssue({ code: 'custom', path: [to], message: 'The end of the range is before its start' });
      }
    }
  };
