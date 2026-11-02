import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { joinUpdater, lastUpdated, softDelete, updater } from '../common/audit.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import { specialDates } from '../db/schema/index.js';
import { withActingStaff } from '../db/with-staff.js';
import { hotelToday } from '../stays/stay-rules.js';
import { assertGuest } from './knowledge-checks.js';
import type { CreateSpecialDate, UpdateSpecialDate } from './knowledge.schemas.js';
import { specialDateError, upcoming } from './special-date-rules.js';

// Birthdays and anniversaries: day and month, and the year when known.
// A guest can have several, including two of the same kind (two children).
// Each comes with when it next comes round, so the panel can say "in 12 days".
@Injectable()
export class SpecialDatesService {
  constructor(@InjectDb() private readonly db: Database) {}

  async list(contactId: number) {
    await assertGuest(this.db, contactId);
    const today = hotelToday();
    const rows = await this.query().where(and(eq(specialDates.contactId, contactId), isNull(specialDates.deletedAt)));
    return rows
      .map((r) => ({ ...r, ...upcoming(r.month, r.day, r.year, today) }))
      .sort((a, b) => a.daysAway - b.daysAway || a.id - b.id);
  }

  async create(contactId: number, input: CreateSpecialDate) {
    await assertGuest(this.db, contactId);
    this.check(input.day, input.month, input.year ?? null);
    const [row] = await withActingStaff(this.db, (tx) =>
      tx
        .insert(specialDates)
        .values({
          contactId,
          occasion: input.occasion,
          label: input.label,
          month: input.month,
          day: input.day,
          year: input.year ?? null,
        })
        .returning({ id: specialDates.id }),
    );
    return this.get(contactId, row.id);
  }

  async update(contactId: number, id: number, input: UpdateSpecialDate) {
    const current = await this.get(contactId, id);
    const changes = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    if (!Object.keys(changes).length) return current;
    // checked as a whole, since only the day or the year may be sent
    this.check(input.day ?? current.day, input.month ?? current.month, input.year !== undefined ? input.year : current.year);
    await withActingStaff(this.db, (tx) => tx.update(specialDates).set(changes).where(eq(specialDates.id, id)));
    return this.get(contactId, id);
  }

  async remove(contactId: number, id: number) {
    await this.get(contactId, id);
    await withActingStaff(this.db, (tx) => softDelete(tx, specialDates, id));
  }

  private check(day: number, month: number, year: number | null) {
    const error = specialDateError(day, month, year, Number(hotelToday().slice(0, 4)));
    if (error) throw new BadRequestException(error);
  }

  private async get(contactId: number, id: number) {
    const [row] = await this.query().where(
      and(eq(specialDates.id, id), eq(specialDates.contactId, contactId), isNull(specialDates.deletedAt)),
    );
    if (!row) throw new NotFoundException('Date not found');
    return { ...row, ...upcoming(row.month, row.day, row.year, hotelToday()) };
  }

  private query() {
    return this.db
      .select({
        id: specialDates.id,
        occasion: specialDates.occasion,
        label: specialDates.label,
        month: specialDates.month,
        day: specialDates.day,
        year: specialDates.year,
        lastUpdated: lastUpdated(specialDates),
      })
      .from(specialDates)
      .leftJoin(updater, joinUpdater(specialDates))
      .$dynamic();
  }
}
