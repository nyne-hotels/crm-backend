import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { softDelete } from '../common/audit.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import { contacts, employeeMentions, employees, feedback, properties, stays } from '../db/schema/index.js';
import { withActingStaff, type Transaction } from '../db/with-staff.js';
import type { CreateMention, UpdateMention } from './feedback.schemas.js';

type Reader = Database | Transaction;
const employeeHotel = alias(properties, 'employee_hotel');

// The employees a response mentions, in the order they were added. A
// mention is linked to an employee, or holds the name as the guest wrote it
// ("not linked") until staff can tell who was meant.
export async function mentionsOf(db: Reader, feedbackId: number) {
  const rows = await db
    .select({
      id: employeeMentions.id,
      sentiment: employeeMentions.sentiment,
      comment: employeeMentions.comment,
      nameAsWritten: employeeMentions.nameAsWritten,
      employeeId: employees.id,
      firstName: employees.firstName,
      lastName: employees.lastName,
      jobTitle: employees.jobTitle,
      department: employees.department,
      isActive: employees.isActive,
      hotel: employeeHotel.name,
    })
    .from(employeeMentions)
    .leftJoin(employees, eq(employees.id, employeeMentions.employeeId))
    .leftJoin(employeeHotel, eq(employeeHotel.id, employees.propertyId))
    .where(and(eq(employeeMentions.feedbackId, feedbackId), isNull(employeeMentions.deletedAt)))
    .orderBy(asc(employeeMentions.createdAt), asc(employeeMentions.id));
  return rows.map(({ employeeId, firstName, lastName, jobTitle, department, isActive, hotel, ...m }) => ({
    ...m,
    employee: employeeId
      ? { id: employeeId, firstName: firstName!, lastName, jobTitle, department: department!, isActive: isActive!, hotel }
      : null,
  }));
}

// Add mention, edit, link to an employee, delete. Each returns the
// response's mentions. The same employee is counted once per response.
// Management and admin only (the employees area).
@Injectable()
export class MentionsService {
  constructor(@InjectDb() private readonly db: Database) {}

  async create(feedbackId: number, input: CreateMention) {
    await this.assertFeedback(this.db, feedbackId);
    await withActingStaff(this.db, async (tx) => {
      if (input.employeeId) await this.assertCanLink(tx, feedbackId, input.employeeId, null);
      await tx.insert(employeeMentions).values({
        feedbackId,
        employeeId: input.employeeId ?? null,
        nameAsWritten: input.nameAsWritten ?? null,
        sentiment: input.sentiment,
        comment: input.comment ?? null,
      });
    });
    return mentionsOf(this.db, feedbackId);
  }

  // Linking later sets the employee and keeps what the guest wrote.
  async update(id: number, input: UpdateMention) {
    const current = await this.get(id);
    const changes: Partial<typeof employeeMentions.$inferInsert> = {};
    if (input.employeeId !== undefined) changes.employeeId = input.employeeId;
    if (input.nameAsWritten !== undefined) changes.nameAsWritten = input.nameAsWritten;
    if (input.sentiment !== undefined) changes.sentiment = input.sentiment;
    if (input.comment !== undefined) changes.comment = input.comment;
    const employeeId = changes.employeeId !== undefined ? changes.employeeId : current.employeeId;
    const nameAsWritten = changes.nameAsWritten !== undefined ? changes.nameAsWritten : current.nameAsWritten;
    if (!employeeId && !nameAsWritten) throw new BadRequestException('Choose the employee or type the name as written');
    if (Object.keys(changes).length) {
      await withActingStaff(this.db, async (tx) => {
        if (employeeId && employeeId !== current.employeeId) await this.assertCanLink(tx, current.feedbackId, employeeId, id);
        await tx.update(employeeMentions).set(changes).where(eq(employeeMentions.id, id));
      });
    }
    return mentionsOf(this.db, current.feedbackId);
  }

  async remove(id: number) {
    const current = await this.get(id);
    await withActingStaff(this.db, (tx) => softDelete(tx, employeeMentions, id));
    return mentionsOf(this.db, current.feedbackId);
  }

  // =====================================================================
  private async get(id: number) {
    const [row] = await this.db
      .select({
        id: employeeMentions.id,
        feedbackId: employeeMentions.feedbackId,
        employeeId: employeeMentions.employeeId,
        nameAsWritten: employeeMentions.nameAsWritten,
      })
      .from(employeeMentions)
      .where(and(eq(employeeMentions.id, id), isNull(employeeMentions.deletedAt)));
    if (!row) throw new NotFoundException('Mention not found');
    await this.assertFeedback(this.db, row.feedbackId);
    return row;
  }

  private async assertFeedback(db: Reader, feedbackId: number) {
    const [row] = await db
      .select({ id: feedback.id })
      .from(feedback)
      .innerJoin(stays, eq(stays.id, feedback.stayId))
      .innerJoin(contacts, eq(contacts.id, stays.contactId))
      .where(and(eq(feedback.id, feedbackId), isNull(feedback.deletedAt), isNull(stays.deletedAt), isNull(contacts.deletedAt)));
    if (!row) throw new NotFoundException('Feedback not found');
  }

  // Only someone still working can be newly linked (leavers leave the
  // picker), and only once per response.
  private async assertCanLink(tx: Transaction, feedbackId: number, employeeId: number, mentionId: number | null) {
    const [employee] = await tx
      .select({ firstName: employees.firstName, lastName: employees.lastName, isActive: employees.isActive })
      .from(employees)
      .where(and(eq(employees.id, employeeId), isNull(employees.deletedAt)));
    if (!employee) throw new BadRequestException('That employee no longer exists');
    if (!employee.isActive) throw new BadRequestException('That employee is no longer working; choose someone on the list');
    const [taken] = await tx
      .select({ id: employeeMentions.id })
      .from(employeeMentions)
      .where(
        and(
          eq(employeeMentions.feedbackId, feedbackId),
          eq(employeeMentions.employeeId, employeeId),
          isNull(employeeMentions.deletedAt),
          mentionId ? ne(employeeMentions.id, mentionId) : undefined,
        ),
      );
    if (taken) {
      const name = [employee.firstName, employee.lastName].filter(Boolean).join(' ');
      throw new ConflictException(`${name} is already mentioned on this response`);
    }
  }
}
