import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, isNull, max } from 'drizzle-orm';
import { z } from 'zod';
import { joinUpdater, lastUpdated, updater } from '../../common/audit.js';
import { InjectDb, type Database } from '../../db/drizzle.module.js';
import { occasions } from '../../db/schema/index.js';
import { withActingStaff } from '../../db/with-staff.js';

const name = z.string().trim().min(1, 'Enter a name').max(60);

export const createOccasionSchema = z.object({ name });
export const updateOccasionSchema = z.object({ name, isActive: z.boolean() }).partial();
export const reorderOccasionsSchema = z.object({ ids: z.array(z.number().int()).min(1) });

const SORT_STEP = 10;

// Trip reasons (Honeymoon, Birthday …) used by stays and leads. Retired with
// the Active switch rather than deleted, so old stays keep their value.
@Injectable()
export class OccasionsService {
  constructor(@InjectDb() private readonly db: Database) {}

  list() {
    return this.baseQuery()
      .where(isNull(occasions.deletedAt))
      .orderBy(asc(occasions.sortOrder), asc(occasions.name));
  }

  async get(id: number) {
    const [row] = await this.baseQuery().where(and(eq(occasions.id, id), isNull(occasions.deletedAt)));
    if (!row) throw new NotFoundException('Occasion not found');
    return row;
  }

  async create(input: z.infer<typeof createOccasionSchema>) {
    const [row] = await withActingStaff(this.db, async (tx) => {
      const [{ last }] = await tx
        .select({ last: max(occasions.sortOrder) })
        .from(occasions)
        .where(isNull(occasions.deletedAt));
      return tx
        .insert(occasions)
        .values({ name: input.name, sortOrder: (last ?? 0) + SORT_STEP })
        .returning({ id: occasions.id });
    });
    return this.get(row.id);
  }

  async update(id: number, input: z.infer<typeof updateOccasionSchema>) {
    await this.get(id);
    if (Object.values(input).some((v) => v !== undefined)) {
      await withActingStaff(this.db, (tx) => tx.update(occasions).set(input).where(eq(occasions.id, id)));
    }
    return this.get(id);
  }

  // `ids` is the full drop-down order, as left by drag and drop.
  async reorder(ids: number[]) {
    await withActingStaff(this.db, async (tx) => {
      const existing = await tx
        .select({ id: occasions.id, sortOrder: occasions.sortOrder })
        .from(occasions)
        .where(isNull(occasions.deletedAt));
      const known = new Set(existing.map((o) => o.id));
      if (new Set(ids).size !== ids.length || ids.length !== known.size || !ids.every((id) => known.has(id))) {
        throw new BadRequestException('The list has changed. Reload and try again.');
      }
      const current = new Map(existing.map((o) => [o.id, o.sortOrder]));
      // only touch rows whose position changed, so "Last updated by" stays meaningful
      for (const [index, id] of ids.entries()) {
        const sortOrder = (index + 1) * SORT_STEP;
        if (current.get(id) !== sortOrder) {
          await tx.update(occasions).set({ sortOrder }).where(eq(occasions.id, id));
        }
      }
    });
    return this.list();
  }

  private baseQuery() {
    return this.db
      .select({
        id: occasions.id,
        name: occasions.name,
        sortOrder: occasions.sortOrder,
        isActive: occasions.isActive,
        lastUpdated: lastUpdated(occasions),
      })
      .from(occasions)
      .leftJoin(updater, joinUpdater(occasions))
      .$dynamic();
  }
}
