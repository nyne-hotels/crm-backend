import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { joinUpdater, lastUpdated, updater } from '../../common/audit.js';
import { InjectDb, type Database } from '../../db/drizzle.module.js';
import { properties } from '../../db/schema/index.js';
import { withActingStaff } from '../../db/with-staff.js';

const optionalText = z
  .string()
  .trim()
  .nullish()
  .transform((v) => v || null);

const propertyFields = z.object({
  name: z.string().trim().min(1, 'Enter a name'),
  location: optionalText,
  propertyType: optionalText,
  webUrl: z
    .union([z.literal(''), z.url('Enter a full web address, starting with https://')])
    .nullish()
    .transform((v) => v || null),
  isActive: z.boolean(),
});

export const createPropertySchema = propertyFields.partial().required({ name: true });
export type CreateProperty = z.infer<typeof createPropertySchema>;

export const updatePropertySchema = propertyFields.partial();
export type UpdateProperty = z.infer<typeof updatePropertySchema>;

// The hotel id after the highest P-number in use: P11 → P12. Deleted hotels'
// ids count too, so an id is never reused for a different hotel.
export function nextPropertyId(ids: string[]): string {
  const highest = Math.max(0, ...ids.map((id) => /^P(\d+)$/.exec(id)).map((m) => (m ? Number(m[1]) : 0)));
  return `P${String(highest + 1).padStart(2, '0')}`;
}

// The hotels. They can be added but never deleted from the app; the Active
// switch hides one from drop-downs while its history stays.
@Injectable()
export class PropertiesService {
  constructor(@InjectDb() private readonly db: Database) {}

  list() {
    return this.baseQuery().where(isNull(properties.deletedAt)).orderBy(asc(properties.id));
  }

  async get(id: string) {
    const [row] = await this.baseQuery().where(and(eq(properties.id, id), isNull(properties.deletedAt)));
    if (!row) throw new NotFoundException('Hotel not found');
    return row;
  }

  async create(input: CreateProperty) {
    const id = await withActingStaff(this.db, async (tx) => {
      // one add at a time, so two people adding at once don't pick the same id
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('properties.create'))`);
      const rows = await tx.select({ id: properties.id }).from(properties);
      const next = nextPropertyId(rows.map((r) => r.id));
      await tx.insert(properties).values({ ...input, id: next });
      return next;
    });
    return this.get(id);
  }

  async update(id: string, input: UpdateProperty) {
    await this.get(id);
    if (Object.values(input).some((v) => v !== undefined)) {
      await withActingStaff(this.db, (tx) => tx.update(properties).set(input).where(eq(properties.id, id)));
    }
    return this.get(id);
  }

  private baseQuery() {
    return this.db
      .select({
        id: properties.id,
        name: properties.name,
        location: properties.location,
        propertyType: properties.propertyType,
        webUrl: properties.webUrl,
        isActive: properties.isActive,
        lastUpdated: lastUpdated(properties),
      })
      .from(properties)
      .leftJoin(updater, joinUpdater(properties))
      .$dynamic();
  }
}
