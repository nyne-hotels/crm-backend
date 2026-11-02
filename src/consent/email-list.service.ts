import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { createdInfo, creator, joinCreator } from '../common/audit.js';
import { between, betweenTimes, inList, whenYesNo } from '../common/filters.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import {
  consents,
  contacts,
  contactTags,
  countries,
  feedback,
  marketingEmailList,
  marketingExports,
  properties,
  specialDates,
  stays,
  tags,
  type MarketingExportFilters,
} from '../db/schema/index.js';
import { withActingStaff } from '../db/with-staff.js';
import { LOW_RATING } from '../feedback/feedback-rules.js';
import { hotelToday } from '../stays/stay-rules.js';
import { exportSummary } from './consent-rules.js';
import type { EmailListFilter, ListEmailList } from './consent.schemas.js';

const ml = marketingEmailList;

// A to Z by first name, then last name; nameless guests last.
const byName = [sql`lower(${ml.firstName}) asc nulls last`, sql`lower(${ml.lastName}) asc nulls last`, asc(ml.id)];

// Marketing → Email list: who may receive marketing email right now, read
// from the marketing_email_list view only (active, not deleted, email opted
// in, a primary personal email that hasn't bounced and isn't wrong).
@Injectable()
export class EmailListService {
  constructor(@InjectDb() private readonly db: Database) {}

  async list(filter: ListEmailList) {
    const where = conditions(filter);
    const [rows, [{ total }], [{ listTotal }]] = await Promise.all([
      this.db
        .select({
          id: ml.id,
          firstName: ml.firstName,
          lastName: ml.lastName,
          email: ml.email,
          countryCode: ml.countryCode,
          country: ml.country,
          lifecycleStage: ml.lifecycleStage,
          hotels: ml.hotels,
          lastStay: ml.lastStay,
        })
        .from(ml)
        .where(where)
        .orderBy(...byName)
        .limit(filter.pageSize)
        .offset((filter.page - 1) * filter.pageSize),
      this.db.select({ total: count() }).from(ml).where(where),
      this.db.select({ listTotal: count() }).from(ml),
    ]);
    return { rows, total, listTotal, page: filter.page, pageSize: filter.pageSize };
  }

  // The rows for the spreadsheet (the app writes the file), logged with who,
  // when, the filters and the count in the same transaction.
  async export(filter: EmailListFilter) {
    return withActingStaff(this.db, async (tx) => {
      const rows = await tx
        .select({
          firstName: ml.firstName,
          lastName: ml.lastName,
          email: ml.email,
          country: ml.country,
          lastHotel: ml.lastHotel,
        })
        .from(ml)
        .where(conditions(filter))
        .orderBy(...byName);

      const filters: MarketingExportFilters = Object.fromEntries(
        Object.entries(filter).filter(([, v]) => v !== undefined),
      );
      // names for the summary; small tables, so read whole
      const byKey = <K extends string | number>(rows: { key: K; name: string }[]) =>
        Object.fromEntries(rows.map((r) => [r.key, r.name])) as Record<K, string>;
      const summary = exportSummary(filters, {
        countries: filter.country
          ? byKey(await tx.select({ key: countries.code, name: countries.name }).from(countries))
          : undefined,
        hotels:
          filter.propertyId || filter.lastHotelId
            ? byKey(await tx.select({ key: properties.id, name: properties.name }).from(properties))
            : undefined,
        tags: filter.tagId ? byKey(await tx.select({ key: tags.id, name: tags.name }).from(tags)) : undefined,
      });

      const [saved] = await tx
        .insert(marketingExports)
        .values({ filters, summary, rowCount: rows.length })
        .returning({ id: marketingExports.id, exportedAt: marketingExports.createdAt });
      return { ...saved, summary, count: rows.length, rows };
    });
  }

  // The export log, newest first.
  history() {
    return this.db
      .select({
        id: marketingExports.id,
        summary: marketingExports.summary,
        rowCount: marketingExports.rowCount,
        exported: createdInfo(marketingExports),
      })
      .from(marketingExports)
      .leftJoin(creator, joinCreator(marketingExports))
      .where(isNull(marketingExports.deletedAt))
      .orderBy(desc(marketingExports.createdAt), desc(marketingExports.id))
      .limit(20);
  }
}

function conditions(filter: EmailListFilter): SQL | undefined {
  const list: (SQL | undefined)[] = [];
  list.push(inList(ml.market, filter.market), inList(ml.countryCode, filter.country), inList(ml.lifecycleStage, filter.stage));
  if (filter.lastStayFrom) list.push(gte(ml.lastStay, filter.lastStayFrom));
  if (filter.lastStayTo) list.push(lte(ml.lastStay, filter.lastStayTo));
  if (filter.propertyId) {
    // "Stayed at" any of them: checked-out stays, as counted in the view's hotels
    list.push(
      sql`exists (select 1 from ${stays} where ${stays.contactId} = ${ml.id}
            and ${inArray(stays.propertyId, filter.propertyId)} and ${stays.status} = 'checked_out'
            and ${stays.deletedAt} is null)`,
    );
  }
  if (filter.tagId) {
    list.push(
      sql`exists (select 1 from ${contactTags} where ${contactTags.contactId} = ${ml.id}
            and ${inArray(contactTags.tagId, filter.tagId)})`,
    );
  }
  // the "More filters" panel
  const onContact = (condition: SQL) => sql`exists (select 1 from ${contacts} c where c.id = ${ml.id} and ${condition})`;
  const checkedOut = sql`(select count(*) from ${stays} s where s.contact_id = ${ml.id}
    and s.status = 'checked_out' and s.deleted_at is null)`;
  if (filter.contactType) list.push(onContact(inArray(sql`c.contact_type`, filter.contactType)));
  if (filter.lastHotelId) {
    list.push(sql`${ml.lastHotel} in (select p.name from ${properties} p where ${inArray(sql`p.id`, filter.lastHotelId)})`);
  }
  if (filter.birthdayMonth) {
    list.push(
      sql`exists (select 1 from ${specialDates} d where d.contact_id = ${ml.id} and d.deleted_at is null
            and d.occasion = 'birthday' and ${inArray(sql`d.month`, filter.birthdayMonth)})`,
    );
  }
  if (filter.optedInFrom || filter.optedInTo) {
    // the list is everyone opted in, so this is when that choice was given
    const givenAt = sql`(select k.given_at from ${consents} k where k.contact_id = ${ml.id}
      and k.channel = 'email' and k.deleted_at is null)`;
    list.push(betweenTimes(givenAt, filter.optedInFrom, filter.optedInTo));
  }
  list.push(
    betweenTimes(sql`(select c.created_at from ${contacts} c where c.id = ${ml.id})`, filter.addedFrom, filter.addedTo),
    between(checkedOut, filter.staysMin, filter.staysMax),
    whenYesNo(
      filter.upcomingStay,
      sql`exists (select 1 from ${stays} s where s.contact_id = ${ml.id} and s.deleted_at is null
            and (s.status = 'checked_in' or (s.status = 'booked' and s.arrival_date >= ${hotelToday()})))`,
    ),
    whenYesNo(
      filter.lowRating,
      sql`exists (select 1 from ${feedback} f join ${stays} s on s.id = f.stay_id
            where s.contact_id = ${ml.id} and f.deleted_at is null and s.deleted_at is null and f.rating <= ${LOW_RATING})`,
    ),
  );
  return and(...list);
}
