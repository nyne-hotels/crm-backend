import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
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

export const updatePropertySchema = z
  .object({
    name: z.string().trim().min(1, 'Enter a name'),
    location: optionalText,
    propertyType: optionalText,
    webUrl: z
      .union([z.literal(''), z.url('Enter a full web address, starting with https://')])
      .nullish()
      .transform((v) => v || null),
    isActive: z.boolean(),
  })
  .partial();
export type UpdateProperty = z.infer<typeof updatePropertySchema>;

// The 8 hotels. They are never added or deleted from the app; the Active
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
