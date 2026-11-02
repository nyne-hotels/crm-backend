import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, count, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { softDelete, touch } from '../common/audit.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import { CONTACT_METHOD_KINDS, contactMethods, contacts } from '../db/schema/index.js';
import { withActingStaff, type Transaction } from '../db/with-staff.js';
import { matchKey } from './guest-rules.js';
import { emailValue, type CreateContactMethod, type UpdateContactMethod } from './guests.schemas.js';
import { GuestsService, phoneOrThrow } from './guests.service.js';

type Kind = (typeof CONTACT_METHOD_KINDS)[number];

const KIND_LABEL: Record<Kind, string> = { email: 'email', phone: 'phone number' };

// A guest's emails and phones. Each kind has exactly one primary while the
// guest has any: the first one added becomes primary, making another primary
// moves the star in the same transaction, and removing the primary promotes
// the newest one left. Every change also bumps the guest's "Last updated".
// Each call returns the whole guest profile, so the page can redraw from it.
@Injectable()
export class ContactMethodsService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly guests: GuestsService,
  ) {}

  async add(contactId: number, input: CreateContactMethod) {
    const guest = await this.guests.get(contactId);
    const value =
      input.kind === 'phone' ? phoneOrThrow(input.value, input.country ?? guest.countryCode) : input.value;

    await withActingStaff(this.db, async (tx) => {
      await this.assertNotOnGuest(tx, contactId, input.kind, value);
      const [{ existing }] = await tx
        .select({ existing: count() })
        .from(contactMethods)
        .where(this.sameKind(contactId, input.kind));
      const isPrimary = existing === 0 || !!input.isPrimary;
      if (isPrimary) await this.clearPrimary(tx, contactId, input.kind);

      await tx.insert(contactMethods).values({
        contactId,
        kind: input.kind,
        value,
        isPrimary,
        isShared: input.isShared ?? false,
        isWhatsapp: input.kind === 'phone' ? (input.isWhatsapp ?? null) : null,
        status: input.status,
      });
      await touch(tx, contacts, contactId);
    });
    return this.guests.get(contactId);
  }

  async update(contactId: number, methodId: number, input: UpdateContactMethod) {
    const guest = await this.guests.get(contactId);
    const current = await this.getMethod(contactId, methodId);
    const changes: Partial<typeof contactMethods.$inferInsert> = {};

    if (input.value !== undefined) {
      const value = this.normalise(current.kind, input.value, input.country ?? guest.countryCode);
      if (value !== current.value) changes.value = value;
    }
    if (input.isShared !== undefined) changes.isShared = input.isShared;
    if (input.status !== undefined) {
      if (current.kind === 'phone' && input.status === 'bounced') {
        throw new BadRequestException('A phone number can be wrong, not bounced');
      }
      changes.status = input.status;
    }
    if (input.isWhatsapp !== undefined && current.kind === 'phone') changes.isWhatsapp = input.isWhatsapp;
    if (input.isPrimary === false && current.isPrimary) {
      throw new BadRequestException(`To change the primary, make another ${KIND_LABEL[current.kind]} primary`);
    }
    const makePrimary = input.isPrimary === true && !current.isPrimary;
    if (!Object.keys(changes).length && !makePrimary) return guest;

    await withActingStaff(this.db, async (tx) => {
      if (changes.value) await this.assertNotOnGuest(tx, contactId, current.kind, changes.value, methodId);
      if (makePrimary) {
        await this.clearPrimary(tx, contactId, current.kind);
        changes.isPrimary = true;
      }
      await tx.update(contactMethods).set(changes).where(eq(contactMethods.id, methodId));
      await touch(tx, contacts, contactId);
    });
    return this.guests.get(contactId);
  }

  async remove(contactId: number, methodId: number) {
    await this.guests.get(contactId);
    const current = await this.getMethod(contactId, methodId);
    await withActingStaff(this.db, async (tx) => {
      await softDelete(tx, contactMethods, methodId);
      if (current.isPrimary) {
        const [next] = await tx
          .select({ id: contactMethods.id })
          .from(contactMethods)
          .where(this.sameKind(contactId, current.kind))
          .orderBy(desc(contactMethods.createdAt), desc(contactMethods.id))
          .limit(1);
        if (next) await tx.update(contactMethods).set({ isPrimary: true }).where(eq(contactMethods.id, next.id));
      }
      await touch(tx, contacts, contactId);
    });
    return this.guests.get(contactId);
  }

  private async getMethod(contactId: number, methodId: number) {
    const [row] = await this.db
      .select({
        id: contactMethods.id,
        kind: contactMethods.kind,
        value: contactMethods.value,
        isPrimary: contactMethods.isPrimary,
      })
      .from(contactMethods)
      .where(
        and(eq(contactMethods.id, methodId), eq(contactMethods.contactId, contactId), isNull(contactMethods.deletedAt)),
      );
    if (!row) throw new NotFoundException('Email or phone not found');
    return row;
  }

  private normalise(kind: Kind, value: string, country: string | null | undefined): string {
    if (kind === 'phone') return phoneOrThrow(value, country);
    const email = emailValue.safeParse(value);
    if (!email.success) throw new BadRequestException('Enter a valid email');
    return email.data;
  }

  private sameKind(contactId: number, kind: Kind) {
    return and(eq(contactMethods.contactId, contactId), eq(contactMethods.kind, kind), isNull(contactMethods.deletedAt));
  }

  private async clearPrimary(tx: Transaction, contactId: number, kind: Kind) {
    await tx
      .update(contactMethods)
      .set({ isPrimary: false })
      .where(and(this.sameKind(contactId, kind), eq(contactMethods.isPrimary, true)));
  }

  // The same address can't be on one guest twice (case and spaces ignored).
  private async assertNotOnGuest(tx: Transaction, contactId: number, kind: Kind, value: string, exceptId?: number) {
    const key =
      kind === 'email' ? sql`lower(${contactMethods.value})` : sql`regexp_replace(${contactMethods.value}, '[^0-9]', '', 'g')`;
    const [taken] = await tx
      .select({ id: contactMethods.id })
      .from(contactMethods)
      .where(
        and(
          this.sameKind(contactId, kind),
          eq(key, matchKey(kind, value)),
          exceptId ? ne(contactMethods.id, exceptId) : undefined,
        ),
      )
      .limit(1);
    if (taken) throw new ConflictException(`This guest already has that ${KIND_LABEL[kind]}`);
  }
}
