import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, ilike, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { likePattern } from '../../common/sql.js';
import { InjectDb, type Database } from '../../db/drizzle.module.js';
import { companies, contactMethods, contacts, properties, staffUsers, stays } from '../../db/schema/index.js';

export const DELETED_KINDS = ['guests', 'stays', 'companies'] as const;
export type DeletedKind = (typeof DELETED_KINDS)[number];

export const listDeletedSchema = z.object({
  kind: z.enum(DELETED_KINDS).default('guests'),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListDeleted = z.infer<typeof listDeletedSchema>;

const deleter = alias(staffUsers, 'deleter');
const deletedInfo = (table: { deletedAt: AnyPgColumn }) => ({
  at: table.deletedAt,
  by: sql<string | null>`nullif(concat_ws(' ', ${deleter.firstName}, ${deleter.lastName}), '')`,
});

const guestName = sql`concat_ws(' ', ${contacts.firstName}, ${contacts.lastName})`;
const primary = (kind: 'email' | 'phone') => sql<string | null>`(select ${contactMethods.value} from ${contactMethods}
  where ${contactMethods.contactId} = ${contacts.id} and ${contactMethods.kind} = ${kind}
    and ${contactMethods.isPrimary} and ${contactMethods.deletedAt} is null limit 1)`;

// Settings → Deleted items (admin): the guests, stays and companies staff
// deleted (soft delete), newest first, with who deleted them. Restoring goes
// through each record's own restore endpoint. A guest merged away is not here:
// the merge removes them for good and Merge history keeps the copy.
@Injectable()
export class DeletedItemsService {
  constructor(@InjectDb() private readonly db: Database) {}

  async list({ kind, q, page, pageSize }: ListDeleted) {
    const offset = (page - 1) * pageSize;
    const [rows, total, counts] = await Promise.all([
      this.rows(kind, q, pageSize, offset),
      this.count(kind, q),
      this.counts(),
    ]);
    return { kind, rows, total, page, pageSize, counts };
  }

  private rows(kind: DeletedKind, q: string | undefined, limit: number, offset: number) {
    if (kind === 'guests') {
      return this.db
        .select({
          id: contacts.id,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          email: primary('email'),
          phone: primary('phone'),
          stays: sql<number>`(select count(*)::int from ${stays}
            where ${stays.contactId} = ${contacts.id} and ${stays.deletedAt} is null)`,
          deleted: deletedInfo(contacts),
        })
        .from(contacts)
        .leftJoin(deleter, eq(deleter.id, contacts.deletedBy))
        .where(this.where(kind, q))
        .orderBy(desc(contacts.deletedAt), desc(contacts.id))
        .limit(limit)
        .offset(offset);
    }
    if (kind === 'stays') {
      return this.db
        .select({
          id: stays.id,
          guest: {
            id: contacts.id,
            firstName: contacts.firstName,
            lastName: contacts.lastName,
            deleted: sql<boolean>`${contacts.deletedAt} is not null`,
          },
          hotel: properties.name,
          arrivalDate: stays.arrivalDate,
          departureDate: stays.departureDate,
          bookingReference: stays.bookingReference,
          status: stays.status,
          deleted: deletedInfo(stays),
        })
        .from(stays)
        .innerJoin(contacts, eq(contacts.id, stays.contactId))
        .innerJoin(properties, eq(properties.id, stays.propertyId))
        .leftJoin(deleter, eq(deleter.id, stays.deletedBy))
        .where(this.where(kind, q))
        .orderBy(desc(stays.deletedAt), desc(stays.id))
        .limit(limit)
        .offset(offset);
    }
    return this.db
      .select({
        id: companies.id,
        name: companies.name,
        companyType: companies.companyType,
        deleted: deletedInfo(companies),
      })
      .from(companies)
      .leftJoin(deleter, eq(deleter.id, companies.deletedBy))
      .where(this.where(kind, q))
      .orderBy(desc(companies.deletedAt), desc(companies.id))
      .limit(limit)
      .offset(offset);
  }

  private async count(kind: DeletedKind, q: string | undefined) {
    const query =
      kind === 'guests'
        ? this.db.select({ n: count() }).from(contacts)
        : kind === 'stays'
          ? this.db.select({ n: count() }).from(stays).innerJoin(contacts, eq(contacts.id, stays.contactId))
          : this.db.select({ n: count() }).from(companies);
    const [{ n }] = await query.where(this.where(kind, q));
    return n;
  }

  // the tab counts, without the search
  private async counts(): Promise<Record<DeletedKind, number>> {
    const [guests, staysCount, companiesCount] = await Promise.all(DELETED_KINDS.map((k) => this.count(k, undefined)));
    return { guests, stays: staysCount, companies: companiesCount };
  }

  // Guests by name, email or phone; stays by guest name or booking reference; companies by name.
  private where(kind: DeletedKind, q: string | undefined): SQL | undefined {
    const term = q ? likePattern(q) : null;
    if (kind === 'guests') {
      return and(
        isNotNull(contacts.deletedAt),
        term
          ? or(
              ilike(guestName, term),
              sql`exists (select 1 from ${contactMethods} where ${contactMethods.contactId} = ${contacts.id}
                and ${contactMethods.value} ilike ${term})`,
            )
          : undefined,
      );
    }
    if (kind === 'stays') {
      return and(isNotNull(stays.deletedAt), term ? or(ilike(guestName, term), ilike(stays.bookingReference, term)) : undefined);
    }
    return and(isNotNull(companies.deletedAt), term ? ilike(companies.name, term) : undefined);
  }
}
