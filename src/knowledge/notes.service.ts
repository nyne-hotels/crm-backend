import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull, type SQL } from 'drizzle-orm';
import type { SignedInStaff } from '../auth/signed-in-staff.js';
import { createdInfo, creator, joinCreator, softDelete } from '../common/audit.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import { contacts, notes, properties, stays } from '../db/schema/index.js';
import { withActingStaff } from '../db/with-staff.js';
import { assertGuest, assertStayOfGuest, joinStay, joinStayHotel, stayChip, stayColumns } from './knowledge-checks.js';
import type { CreateNote, UpdateNote } from './knowledge.schemas.js';

// Only the author or an admin can edit or delete a note. Notes loaded by an
// import have no author, so only an admin can change those.
export function mayChangeNote(note: { authorId: number | null }, staff: Pick<SignedInStaff, 'id' | 'role'>): boolean {
  return staff.role === 'admin' || (note.authorId !== null && note.authorId === staff.id);
}

// Staff remarks about a guest, newest first. A note written on a stay is
// linked to the stay, and the notes_fill_contact trigger links it to the
// stay's guest, so it shows in both places. Deleted notes are hidden, not erased.
@Injectable()
export class NotesService {
  constructor(@InjectDb() private readonly db: Database) {}

  async forGuest(contactId: number) {
    await assertGuest(this.db, contactId);
    return this.list(eq(notes.contactId, contactId));
  }

  async forStay(stayId: number) {
    await this.assertStay(stayId);
    return this.list(eq(notes.stayId, stayId));
  }

  async addToGuest(contactId: number, input: CreateNote) {
    await assertGuest(this.db, contactId);
    const [row] = await withActingStaff(this.db, async (tx) => {
      await assertStayOfGuest(tx, contactId, input.stayId);
      return tx.insert(notes).values({ contactId, body: input.body, stayId: input.stayId }).returning({ id: notes.id });
    });
    return this.get(row.id);
  }

  async addToStay(stayId: number, body: string) {
    await this.assertStay(stayId);
    // contact_id is left out on purpose: the trigger fills it from the stay
    const [row] = await withActingStaff(this.db, (tx) =>
      tx.insert(notes).values({ stayId, body }).returning({ id: notes.id }),
    );
    return this.get(row.id);
  }

  async update(id: number, input: UpdateNote, staff: SignedInStaff) {
    const note = await this.getForChange(id, staff);
    const changes: Partial<typeof notes.$inferInsert> = {};
    if (input.body !== undefined && input.body !== note.body) {
      changes.body = input.body;
      changes.editedAt = new Date();
    }
    if (input.stayId !== undefined && input.stayId !== (note.stay?.id ?? null)) {
      if (input.stayId && !note.contactId) throw new BadRequestException('Only a guest note can be linked to a stay');
      changes.stayId = input.stayId;
    }
    if (!Object.keys(changes).length) return note;
    await withActingStaff(this.db, async (tx) => {
      if (changes.stayId) await assertStayOfGuest(tx, note.contactId!, changes.stayId);
      await tx.update(notes).set(changes).where(eq(notes.id, id));
    });
    return this.get(id);
  }

  async remove(id: number, staff: SignedInStaff) {
    await this.getForChange(id, staff);
    await withActingStaff(this.db, (tx) => softDelete(tx, notes, id));
  }

  private async getForChange(id: number, staff: SignedInStaff) {
    const note = await this.get(id);
    if (!mayChangeNote(note, staff)) {
      throw new ForbiddenException('Only the person who wrote this note, or an admin, can change it');
    }
    return note;
  }

  private async get(id: number) {
    const [row] = await this.query().where(and(eq(notes.id, id), isNull(notes.deletedAt)));
    if (!row) throw new NotFoundException('Note not found');
    return stayChip(row);
  }

  private async list(condition: SQL) {
    const rows = await this.query()
      .where(and(condition, isNull(notes.deletedAt)))
      .orderBy(desc(notes.createdAt), desc(notes.id));
    return rows.map(stayChip);
  }

  // The stay must be there, and so must its guest.
  private async assertStay(stayId: number) {
    const [stay] = await this.db
      .select({ id: stays.id })
      .from(stays)
      .innerJoin(contacts, eq(contacts.id, stays.contactId))
      .where(and(eq(stays.id, stayId), isNull(stays.deletedAt), isNull(contacts.deletedAt)));
    if (!stay) throw new NotFoundException('Stay not found');
  }

  private query() {
    return this.db
      .select({
        id: notes.id,
        body: notes.body,
        contactId: notes.contactId,
        leadId: notes.leadId, // leads come in Module 7
        ...stayColumns,
        authorId: notes.createdBy,
        created: createdInfo(notes), // author and time; by = null for imported notes
        editedAt: notes.editedAt,
      })
      .from(notes)
      .leftJoin(stays, joinStay(notes.stayId))
      .leftJoin(properties, joinStayHotel)
      .leftJoin(creator, joinCreator(notes))
      .$dynamic();
  }
}
