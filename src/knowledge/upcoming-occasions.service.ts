import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, isNull, lte, not, or, sql, type SQL } from 'drizzle-orm';
import { blank, inList, noMethod, whenFields, whenYesNo } from '../common/filters.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import { upcomingSpecialDates } from '../db/schema/index.js';
import { hotelToday } from '../stays/stay-rules.js';
import type { ListUpcoming } from './knowledge.schemas.js';

const u = upcomingSpecialDates;

// Guests → Upcoming occasions: birthdays and anniversaries in the next 60
// days, soonest first, so the hotels can plan a cake or an offer. Reads the
// upcoming_special_dates view (active, not-deleted guests; "today" in Colombo).
@Injectable()
export class UpcomingOccasionsService {
  constructor(@InjectDb() private readonly db: Database) {}

  async list(filter: ListUpcoming) {
    const conditions: (SQL | undefined)[] = [];
    conditions.push(inList(u.occasion, filter.occasion));
    if (filter.propertyId) {
      conditions.push(or(inList(u.nextStayPropertyId, filter.propertyId), inList(u.lastStayPropertyId, filter.propertyId)));
    }
    if (filter.canEmail) conditions.push(eq(u.canEmail, filter.canEmail === 'yes'));
    // the "More filters" panel
    if (filter.within !== undefined) conditions.push(lte(u.daysAway, filter.within));
    conditions.push(inList(u.lifecycleStage, filter.stage));
    conditions.push(
      whenYesNo(filter.nextStay, isNotNull(u.nextStayId)),
      whenYesNo(filter.milestone, sql`coalesce(${u.turningOrYears} > 0 and ${u.turningOrYears} % 5 = 0, false)`),
      whenFields(filter, {
        // only partners' and children's birthdays and "other" need one
        label: {
          missing: and(inArray(u.occasion, ['partner_birthday', 'child_birthday', 'other']), blank(u.label))!,
          filled: not(blank(u.label)),
        },
        year: isNull(u.year),
        guestEmail: noMethod(u.contactId, 'email'),
        guestPhone: noMethod(u.contactId, 'phone'),
      }),
    );

    const rows = await this.db
      .select({
        id: u.specialDateId,
        nextDate: u.nextDate,
        daysAway: u.daysAway,
        occasion: u.occasion,
        label: u.label,
        year: u.year,
        years: u.turningOrYears, // age turning or years married, when the year is known
        guest: { id: u.contactId, firstName: u.firstName, lastName: u.lastName, lifecycleStage: u.lifecycleStage },
        emailConsent: u.emailConsent,
        canEmail: u.canEmail,
        nextStayId: u.nextStayId,
        nextStayArrival: u.nextStayArrival,
        nextStayHotel: u.nextStayHotel,
        lastStayHotel: u.lastStayHotel,
      })
      .from(u)
      .where(and(...conditions))
      .orderBy(asc(u.nextDate), asc(u.lastName), asc(u.specialDateId));

    return {
      today: hotelToday(),
      rows: rows.map(({ nextStayId, nextStayArrival, nextStayHotel, ...r }) => ({
        ...r,
        nextStay: nextStayId ? { id: nextStayId, arrivalDate: nextStayArrival, hotel: nextStayHotel! } : null,
      })),
    };
  }
}
