import { BadRequestException, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { touch } from '../common/audit.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import { contacts, contactTags, tags } from '../db/schema/index.js';
import { withActingStaff } from '../db/with-staff.js';
import { GuestsService } from '../guests/guests.service.js';

// Tags in the profile header. Picked from the admin's list only, and once
// per guest. contact_tags is a plain link (removing a tag deletes it), so
// each change bumps the guest's "Last updated" to record who made it.
// Each call returns the whole guest profile, like emails and phones.
@Injectable()
export class GuestTagsService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly guests: GuestsService,
  ) {}

  async add(contactId: number, tagId: number) {
    const guest = await this.guests.get(contactId);
    if (guest.tags.some((t) => t.id === tagId)) return guest;
    const [tag] = await this.db
      .select({ isActive: tags.isActive })
      .from(tags)
      .where(and(eq(tags.id, tagId), isNull(tags.deletedAt)));
    if (!tag) throw new BadRequestException('Choose a tag from the list');
    // retired tags stay on guests who have them, but can't be given out again
    if (!tag.isActive) throw new BadRequestException('That tag has been retired');

    await withActingStaff(this.db, async (tx) => {
      await tx.insert(contactTags).values({ contactId, tagId }).onConflictDoNothing();
      await touch(tx, contacts, contactId);
    });
    return this.guests.get(contactId);
  }

  async remove(contactId: number, tagId: number) {
    await this.guests.get(contactId);
    await withActingStaff(this.db, async (tx) => {
      const removed = await tx
        .delete(contactTags)
        .where(and(eq(contactTags.contactId, contactId), eq(contactTags.tagId, tagId)))
        .returning({ tagId: contactTags.tagId });
      if (removed.length) await touch(tx, contacts, contactId);
    });
    return this.guests.get(contactId);
  }
}
