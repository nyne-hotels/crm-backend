import { Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { createdInfo, creator, joinCreator, joinUpdater, lastUpdated, softDelete, updater } from '../common/audit.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import { preferences, properties, stays } from '../db/schema/index.js';
import { withActingStaff } from '../db/with-staff.js';
import { assertGuest, assertStayOfGuest, joinStay, joinStayHotel, stayChip, stayColumns } from './knowledge-checks.js';
import type { CreatePreference, UpdatePreference } from './knowledge.schemas.js';

// A guest's likes and dislikes. They belong to the guest, not a hotel, so
// every hotel sees them; the optional stay says where it was noticed.
@Injectable()
export class PreferencesService {
  constructor(@InjectDb() private readonly db: Database) {}

  async list(contactId: number) {
    await assertGuest(this.db, contactId);
    const rows = await this.query()
      .where(and(eq(preferences.contactId, contactId), isNull(preferences.deletedAt)))
      .orderBy(desc(preferences.createdAt), desc(preferences.id));
    return rows.map(stayChip);
  }

  async create(contactId: number, input: CreatePreference) {
    await assertGuest(this.db, contactId);
    const [row] = await withActingStaff(this.db, async (tx) => {
      await assertStayOfGuest(tx, contactId, input.stayId);
      return tx
        .insert(preferences)
        .values({ contactId, kind: input.kind, category: input.category, body: input.body, stayId: input.stayId })
        .returning({ id: preferences.id });
    });
    return this.get(contactId, row.id);
  }

  async update(contactId: number, id: number, input: UpdatePreference) {
    await this.get(contactId, id);
    const changes = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    if (Object.keys(changes).length) {
      await withActingStaff(this.db, async (tx) => {
        await assertStayOfGuest(tx, contactId, input.stayId);
        await tx.update(preferences).set(changes).where(eq(preferences.id, id));
      });
    }
    return this.get(contactId, id);
  }

  async remove(contactId: number, id: number) {
    await this.get(contactId, id);
    await withActingStaff(this.db, (tx) => softDelete(tx, preferences, id));
  }

  private async get(contactId: number, id: number) {
    const [row] = await this.query().where(
      and(eq(preferences.id, id), eq(preferences.contactId, contactId), isNull(preferences.deletedAt)),
    );
    if (!row) throw new NotFoundException('Like or dislike not found');
    return stayChip(row);
  }

  private query() {
    return this.db
      .select({
        id: preferences.id,
        kind: preferences.kind,
        category: preferences.category,
        body: preferences.body,
        ...stayColumns,
        created: createdInfo(preferences), // "who added it, when" on hover
        lastUpdated: lastUpdated(preferences),
      })
      .from(preferences)
      .leftJoin(stays, joinStay(preferences.stayId))
      .leftJoin(properties, joinStayHotel)
      .leftJoin(creator, joinCreator(preferences))
      .leftJoin(updater, joinUpdater(preferences))
      .$dynamic();
  }
}
