import { Controller, Get } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import { countries, occasions, properties, tags } from '../db/schema/index.js';

// Pick-lists for drop-downs, for every signed-in user. Only active, not-deleted
// options; the Settings screens list everything. The company pick-list is
// /companies/options (Module 7).
@Controller()
export class ReferenceController {
  constructor(@InjectDb() private readonly db: Database) {}

  // ~250 rows – the country picker searches them in the browser
  @Get('countries')
  countries() {
    return this.db
      .select({ code: countries.code, name: countries.name, dialCode: countries.dialCode })
      .from(countries)
      .where(isNull(countries.deletedAt))
      .orderBy(asc(countries.name));
  }

  @Get('properties')
  properties() {
    return this.db
      .select({ id: properties.id, name: properties.name, location: properties.location })
      .from(properties)
      .where(and(eq(properties.isActive, true), isNull(properties.deletedAt)))
      .orderBy(asc(properties.id));
  }

  @Get('occasions')
  occasions() {
    return this.db
      .select({ id: occasions.id, name: occasions.name })
      .from(occasions)
      .where(and(eq(occasions.isActive, true), isNull(occasions.deletedAt)))
      .orderBy(asc(occasions.sortOrder), asc(occasions.name));
  }

  // The tag picker on the guest profile. Retired tags are left out, though
  // guests who already have them keep them.
  @Get('tags')
  tags() {
    return this.db
      .select({ id: tags.id, name: tags.name })
      .from(tags)
      .where(and(eq(tags.isActive, true), isNull(tags.deletedAt)))
      .orderBy(asc(sql`lower(${tags.name})`));
  }
}
