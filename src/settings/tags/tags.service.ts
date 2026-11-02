import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { joinUpdater, lastUpdated, updater } from '../../common/audit.js';
import { InjectDb, type Database } from '../../db/drizzle.module.js';
import { contacts, contactTags, tags } from '../../db/schema/index.js';
import { withActingStaff } from '../../db/with-staff.js';

const name = z.string().trim().min(1, 'Enter a name').max(40);

export const createTagSchema = z.object({ name });
export const updateTagSchema = z.object({ name, isActive: z.boolean() }).partial();

// Labels for grouping guests (VIP / industry, Friends & family …). Retired
// with the Active switch rather than deleted: a retired tag leaves the picker
// but stays on the guests who have it.
@Injectable()
export class TagsService {
  constructor(@InjectDb() private readonly db: Database) {}

  list() {
    return this.baseQuery()
      .where(isNull(tags.deletedAt))
      .orderBy(asc(sql`lower(${tags.name})`));
  }

  async get(id: number) {
    const [row] = await this.baseQuery().where(and(eq(tags.id, id), isNull(tags.deletedAt)));
    if (!row) throw new NotFoundException('Tag not found');
    return row;
  }

  async create(input: z.infer<typeof createTagSchema>) {
    const [row] = await withActingStaff(this.db, (tx) =>
      tx.insert(tags).values({ name: input.name }).returning({ id: tags.id }),
    );
    return this.get(row.id);
  }

  async update(id: number, input: z.infer<typeof updateTagSchema>) {
    await this.get(id);
    if (Object.values(input).some((v) => v !== undefined)) {
      await withActingStaff(this.db, (tx) => tx.update(tags).set(input).where(eq(tags.id, id)));
    }
    return this.get(id);
  }

  private baseQuery() {
    // guests (not deleted) who have the tag
    const guests = sql<number>`(select count(*)::int from ${contactTags}
      join ${contacts} on ${contacts.id} = ${contactTags.contactId} and ${contacts.deletedAt} is null
      where ${contactTags.tagId} = ${tags.id})`;
    return this.db
      .select({
        id: tags.id,
        name: tags.name,
        isActive: tags.isActive,
        guests,
        lastUpdated: lastUpdated(tags),
      })
      .from(tags)
      .leftJoin(updater, joinUpdater(tags))
      .$dynamic();
  }
}
