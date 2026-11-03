import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, ilike, isNotNull, isNull, not, or, sql, type SQL } from 'drizzle-orm';
import { createdInfo, creator, joinCreator, joinUpdater, lastUpdated, updater } from '../common/audit.js';
import { betweenTimes, blank, inList, whenFields, whenYesNo } from '../common/filters.js';
import { chunks, likePattern } from '../common/sql.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import {
  contacts,
  DEPARTMENTS,
  employeeFeedbackSummary,
  employeeMentions,
  employees,
  feedback,
  properties,
  staffUsers,
  stays,
} from '../db/schema/index.js';
import { withActingStaff, type Transaction } from '../db/with-staff.js';
import { employeeKey, planStaffList } from './feedback-rules.js';
import type { CreateEmployee, EmployeeOptions, ListEmployees, StaffList, UpdateEmployee } from './feedback.schemas.js';

const s = employeeFeedbackSummary;
const login = sql<{ id: number; name: string } | null>`case when ${staffUsers.id} is null then null
  else json_build_object('id', ${staffUsers.id}, 'name', concat_ws(' ', ${staffUsers.firstName}, ${staffUsers.lastName})) end`;
const departmentOrder = sql`array_position(array[${sql.raw(DEPARTMENTS.map((d) => `'${d}'`).join(','))}]::text[], ${employees.department})`;
const fullName = sql<string>`concat_ws(' ', ${employees.firstName}, ${employees.lastName})`;

// Everyone who works at the hotels (Module 8): name, hotel (or group-wide),
// department and job title, with what guests said about them. Leavers are
// made inactive, never deleted, so their history stays. Admin and
// management only; marketing never sees praise or criticism of a named person.
@Injectable()
export class EmployeesService {
  constructor(@InjectDb() private readonly db: Database) {}

  // By hotel (group-wide first) and department, with praise and criticism
  // counts for the last 90 days.
  async list(filter: ListEmployees) {
    const conditions: (SQL | undefined)[] = [isNull(employees.deletedAt)];
    if (filter.status !== 'all') conditions.push(eq(employees.isActive, filter.status === 'active'));
    if (filter.propertyId) {
      // any of the hotels, and 'group' for group-wide employees
      const hotels = filter.propertyId.filter((p) => p !== 'group');
      conditions.push(
        or(inList(employees.propertyId, hotels), filter.propertyId.includes('group') ? isNull(employees.propertyId) : undefined),
      );
    }
    conditions.push(inList(employees.department, filter.department));
    if (filter.q) {
      const words = filter.q.replace(/\s+/g, ' ').split(' ').filter(Boolean);
      conditions.push(or(and(...words.map((w) => ilike(fullName, likePattern(w)))), ilike(employees.jobTitle, likePattern(filter.q)))!);
    }
    // the "More filters" panel
    const praised = sql`coalesce(${s.positive90Days}, 0) > 0`;
    const criticised = sql`coalesce(${s.negative90Days}, 0) > 0`;
    conditions.push(
      {
        praised,
        criticised,
        mentioned: or(praised, criticised),
        none: and(not(praised), not(criticised)),
        all: undefined,
      }[filter.recent ?? 'all'],
      betweenTimes(s.lastMentioned, filter.lastMentionedFrom, filter.lastMentionedTo),
      whenFields(filter, {
        lastName: blank(employees.lastName),
        jobTitle: blank(employees.jobTitle),
        login: isNull(employees.staffUserId),
      }),
    );
    return this.db
      .select({
        ...this.columns(),
        positive90Days: s.positive90Days,
        negative90Days: s.negative90Days,
        lastMentioned: s.lastMentioned,
      })
      .from(employees)
      .leftJoin(properties, eq(properties.id, employees.propertyId))
      .leftJoin(staffUsers, eq(staffUsers.id, employees.staffUserId))
      .leftJoin(s, eq(s.id, employees.id))
      .where(and(...conditions))
      .orderBy(sql`${properties.name} asc nulls first`, departmentOrder, asc(sql`lower(${employees.firstName})`), asc(sql`lower(${employees.lastName})`))
      .limit(2000);
  }

  // The picker on a mention: active employees of the stay's hotel first,
  // then group-wide ones, then the rest of the group.
  options(filter: EmployeeOptions) {
    const rank = filter.propertyId
      ? sql`case when ${employees.propertyId} = ${filter.propertyId} then 0 when ${employees.propertyId} is null then 1 else 2 end`
      : sql`case when ${employees.propertyId} is null then 0 else 1 end`;
    return this.db
      .select({
        id: employees.id,
        firstName: employees.firstName,
        lastName: employees.lastName,
        jobTitle: employees.jobTitle,
        department: employees.department,
        propertyId: employees.propertyId,
        hotel: properties.name,
      })
      .from(employees)
      .leftJoin(properties, eq(properties.id, employees.propertyId))
      .where(and(isNull(employees.deletedAt), eq(employees.isActive, true)))
      .orderBy(rank, sql`${properties.name} asc nulls first`, asc(sql`lower(${employees.firstName})`), asc(sql`lower(${employees.lastName})`));
  }

  // CRM logins an employee can be linked to, and who each is linked to already.
  staffOptions() {
    return this.db
      .select({
        id: staffUsers.id,
        firstName: staffUsers.firstName,
        lastName: staffUsers.lastName,
        role: staffUsers.role,
        employeeId: employees.id,
      })
      .from(staffUsers)
      .leftJoin(employees, and(eq(employees.staffUserId, staffUsers.id), isNull(employees.deletedAt)))
      .where(and(eq(staffUsers.isActive, true), isNull(staffUsers.deletedAt)))
      .orderBy(asc(sql`lower(${staffUsers.firstName})`), asc(sql`lower(${staffUsers.lastName})`));
  }

  // ---------- one employee ----------
  // Praise and criticism overall and for the last 90 days.
  async get(id: number) {
    const [row] = await this.db
      .select({
        ...this.columns(),
        counts: {
          positive: s.positive,
          negative: s.negative,
          positive90Days: s.positive90Days,
          negative90Days: s.negative90Days,
          lastMentioned: s.lastMentioned,
        },
        created: createdInfo(employees),
        lastUpdated: lastUpdated(employees),
      })
      .from(employees)
      .leftJoin(properties, eq(properties.id, employees.propertyId))
      .leftJoin(staffUsers, eq(staffUsers.id, employees.staffUserId))
      .leftJoin(s, eq(s.id, employees.id))
      .leftJoin(creator, joinCreator(employees))
      .leftJoin(updater, joinUpdater(employees))
      .where(and(eq(employees.id, id), isNull(employees.deletedAt)));
    if (!row) throw new NotFoundException('Employee not found');
    return row;
  }

  // Every comment about them, newest first, with the guest and the stay's rating.
  async mentions(id: number) {
    await this.get(id);
    return this.db
      .select({
        id: employeeMentions.id,
        feedbackId: feedback.id,
        submittedAt: feedback.submittedAt,
        sentiment: employeeMentions.sentiment,
        comment: employeeMentions.comment,
        nameAsWritten: employeeMentions.nameAsWritten,
        stayRating: feedback.rating,
        stayId: stays.id,
        hotel: properties.name,
        arrivalDate: stays.arrivalDate,
        departureDate: stays.departureDate,
        guest: {
          id: contacts.id,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
        },
      })
      .from(employeeMentions)
      .innerJoin(feedback, and(eq(feedback.id, employeeMentions.feedbackId), isNull(feedback.deletedAt)))
      .innerJoin(stays, and(eq(stays.id, feedback.stayId), isNull(stays.deletedAt)))
      .innerJoin(contacts, and(eq(contacts.id, stays.contactId), isNull(contacts.deletedAt)))
      .innerJoin(properties, eq(properties.id, stays.propertyId))
      .where(and(eq(employeeMentions.employeeId, id), isNull(employeeMentions.deletedAt)))
      .orderBy(desc(feedback.submittedAt), desc(employeeMentions.id));
  }

  // ---------- add, edit, deactivate ----------
  async create(input: CreateEmployee) {
    const [row] = await withActingStaff(this.db, async (tx) => {
      await this.assertHotel(tx, input.propertyId);
      await this.assertLogin(tx, input.staffUserId, null);
      return tx.insert(employees).values(input).returning({ id: employees.id });
    });
    return this.get(row.id);
  }

  // Includes making a leaver inactive (and back, if they return).
  async update(id: number, input: UpdateEmployee) {
    const current = await this.get(id);
    const changes = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    if (!Object.keys(changes).length) return current;
    await withActingStaff(this.db, async (tx) => {
      if (input.propertyId) await this.assertHotel(tx, input.propertyId);
      if (input.staffUserId && input.staffUserId !== current.staffUser?.id) await this.assertLogin(tx, input.staffUserId, id);
      await tx.update(employees).set(changes).where(eq(employees.id, id));
    });
    return this.get(id);
  }

  // ---------- a hotel's staff list ----------
  // Preview saves nothing; the upload re-plans and adds the new names.
  async previewStaffList(input: StaffList) {
    return this.planStaff(this.db, input);
  }

  async commitStaffList(input: StaffList) {
    return withActingStaff(this.db, async (tx) => {
      const plan = await this.planStaff(tx, input);
      const adding = plan.rows.filter((r) => r.outcome === 'new');
      for (const part of chunks(adding)) {
        await tx.insert(employees).values(
          part.map((r) => ({
            firstName: r.firstName!,
            lastName: r.lastName,
            propertyId: input.propertyId,
            department: r.department,
            jobTitle: r.jobTitle,
          })),
        );
      }
      return plan;
    });
  }

  // =====================================================================
  private columns() {
    return {
      id: employees.id,
      firstName: employees.firstName,
      lastName: employees.lastName,
      propertyId: employees.propertyId,
      hotel: properties.name,
      department: employees.department,
      jobTitle: employees.jobTitle,
      isActive: employees.isActive,
      staffUser: login,
    };
  }

  // Someone already on that hotel's list (by name, ignoring case and
  // punctuation, active or not) is left as they are.
  private async planStaff(db: Database | Transaction, input: StaffList) {
    await this.assertHotel(db, input.propertyId);
    const existing = await db
      .select({ firstName: employees.firstName, lastName: employees.lastName })
      .from(employees)
      .where(
        and(
          isNull(employees.deletedAt),
          input.propertyId ? eq(employees.propertyId, input.propertyId) : isNull(employees.propertyId),
        ),
      );
    const rows = planStaffList(input.rows, new Set(existing.map((e) => employeeKey(e.firstName, e.lastName))));
    const counts = { new: 0, exists: 0, error: 0 };
    for (const r of rows) counts[r.outcome]++;
    return { total: rows.length, counts, rows };
  }

  private async assertHotel(db: Database | Transaction, propertyId: string | null | undefined) {
    if (!propertyId) return;
    const [hotel] = await db
      .select({ id: properties.id })
      .from(properties)
      .where(and(eq(properties.id, propertyId), isNull(properties.deletedAt)));
    if (!hotel) throw new BadRequestException('Choose a hotel from the list');
  }

  // A CRM login belongs to one employee.
  private async assertLogin(tx: Transaction, staffUserId: number | null | undefined, employeeId: number | null) {
    if (!staffUserId) return;
    const [staff] = await tx
      .select({ id: staffUsers.id, linkedTo: employees.id })
      .from(staffUsers)
      .leftJoin(employees, and(eq(employees.staffUserId, staffUsers.id), isNull(employees.deletedAt)))
      .where(and(eq(staffUsers.id, staffUserId), isNull(staffUsers.deletedAt)));
    if (!staff) throw new BadRequestException('That CRM login no longer exists');
    if (staff.linkedTo && staff.linkedTo !== employeeId) {
      throw new BadRequestException('That CRM login is already linked to another employee');
    }
  }
}
