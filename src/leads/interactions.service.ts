import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { SignedInStaff } from '../auth/signed-in-staff.js';
import { softDelete } from '../common/audit.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import { companies, contacts, feedback, interactions, leads, staffUsers, stays } from '../db/schema/index.js';
import { withActingStaff, type Transaction } from '../db/with-staff.js';
import { mayChangeNote } from '../knowledge/notes.service.js';
import { isOpen, statusAfterInteraction } from './lead-rules.js';
import { logStatusChanges } from './lead-writer.js';
import type { CreateInteraction, UpdateInteraction } from './leads.schemas.js';
import { interactionItems } from './timeline.js';

// Logged conversations: a call, WhatsApp, email, meeting, visit or Instagram
// DM with a person, a company, or both, optionally on a lead or following up
// a feedback response (Module 8). staff_id is who had the conversation;
// created_by is who logged it. Only the person who logged it, or an admin,
// edits or deletes it (as with notes).
@Injectable()
export class InteractionsService {
  constructor(@InjectDb() private readonly db: Database) {}

  // The conversations with a guest, newest first (on the profile's Leads panel).
  async forGuest(contactId: number) {
    const [guest] = await this.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), isNull(contacts.deletedAt)));
    if (!guest) throw new NotFoundException('Guest not found');
    return interactionItems(this.db, eq(interactions.contactId, contactId));
  }

  // On a lead, the lead gives the person. The first reply on a new lead moves
  // it to contacted, and the next follow-up date can be set at the same time.
  async create(input: CreateInteraction, staff: SignedInStaff) {
    const id = await withActingStaff(this.db, async (tx) => {
      let contactId = input.contactId ?? null;
      let lead: { id: number; contactId: number; status: (typeof leads.$inferSelect)['status'] } | null = null;
      if (input.leadId) {
        [lead] = await tx
          .select({ id: leads.id, contactId: leads.contactId, status: leads.status })
          .from(leads)
          .where(and(eq(leads.id, input.leadId), isNull(leads.deletedAt)));
        if (!lead) throw new BadRequestException('That lead no longer exists');
        if (contactId && contactId !== lead.contactId) throw new BadRequestException("That person isn't on this lead");
        contactId = lead.contactId;
      }
      // a call or message following up a feedback response is with the stay's guest
      if (input.feedbackId) {
        const [response] = await tx
          .select({ contactId: stays.contactId })
          .from(feedback)
          .innerJoin(stays, eq(stays.id, feedback.stayId))
          .where(and(eq(feedback.id, input.feedbackId), isNull(feedback.deletedAt), isNull(stays.deletedAt)));
        if (!response) throw new BadRequestException('That feedback no longer exists');
        if (contactId && contactId !== response.contactId) throw new BadRequestException("That person didn't send this feedback");
        contactId = response.contactId;
      }
      await this.assertTargets(tx, contactId, input.companyId ?? null);
      const staffId = input.staffId ?? staff.id;
      if (input.staffId && input.staffId !== staff.id) await this.assertStaff(tx, input.staffId);

      const [row] = await tx
        .insert(interactions)
        .values({
          contactId,
          companyId: input.companyId ?? null,
          leadId: lead?.id ?? null,
          feedbackId: input.feedbackId ?? null,
          kind: input.kind,
          direction: input.direction ?? null,
          occurredAt: input.occurredAt ? new Date(input.occurredAt) : undefined,
          staffId,
          summary: input.summary,
        })
        .returning({ id: interactions.id });

      if (lead) {
        const next = statusAfterInteraction(lead.status, input.direction ?? null);
        const followUp = input.followUpOn && isOpen(next ?? lead.status) ? { followUpOn: input.followUpOn } : {};
        if (next || followUp.followUpOn) {
          await tx
            .update(leads)
            .set({ ...(next ? { status: next } : {}), ...followUp })
            .where(eq(leads.id, lead.id));
        }
        if (next) await logStatusChanges(tx, [{ leadId: lead.id, from: lead.status, to: next }]);
      }
      return row.id;
    });
    return this.get(id);
  }

  async update(id: number, input: UpdateInteraction, staff: SignedInStaff) {
    const current = await this.getForChange(id, staff);
    const changes: Partial<typeof interactions.$inferInsert> = {};
    if (input.kind !== undefined) changes.kind = input.kind;
    if (input.direction !== undefined) changes.direction = input.direction;
    if (input.summary !== undefined) changes.summary = input.summary;
    if (input.occurredAt !== undefined) changes.occurredAt = new Date(input.occurredAt);
    if (input.staffId !== undefined) changes.staffId = input.staffId;
    if (!Object.keys(changes).length) return current;
    await withActingStaff(this.db, async (tx) => {
      if (input.staffId && input.staffId !== current.staffId) await this.assertStaff(tx, input.staffId);
      await tx.update(interactions).set(changes).where(eq(interactions.id, id));
    });
    return this.get(id);
  }

  async remove(id: number, staff: SignedInStaff) {
    await this.getForChange(id, staff);
    await withActingStaff(this.db, (tx) => softDelete(tx, interactions, id));
  }

  private async get(id: number) {
    const [row] = await interactionItems(this.db, eq(interactions.id, id), 1);
    if (!row) throw new NotFoundException('Conversation not found');
    return row;
  }

  private async getForChange(id: number, staff: SignedInStaff) {
    const row = await this.get(id);
    if (!mayChangeNote(row, staff)) {
      throw new ForbiddenException('Only the person who logged this conversation, or an admin, can change it');
    }
    return row;
  }

  // The person and the company must still be there.
  private async assertTargets(tx: Transaction, contactId: number | null, companyId: number | null) {
    if (contactId) {
      const [person] = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.id, contactId), isNull(contacts.deletedAt)));
      if (!person) throw new BadRequestException('That person no longer exists');
    }
    if (companyId) {
      const [company] = await tx
        .select({ id: companies.id })
        .from(companies)
        .where(and(eq(companies.id, companyId), isNull(companies.deletedAt)));
      if (!company) throw new BadRequestException('That company no longer exists');
    }
    if (!contactId && !companyId) throw new BadRequestException('Choose who the conversation was with');
  }

  // Who had the conversation: any staff member, including one who has since left.
  private async assertStaff(tx: Transaction, staffId: number) {
    const [row] = await tx
      .select({ id: staffUsers.id })
      .from(staffUsers)
      .where(and(eq(staffUsers.id, staffId), isNull(staffUsers.deletedAt)));
    if (!row) throw new BadRequestException('Choose who had the conversation');
  }
}
