import { BadRequestException, NotFoundException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Database } from '../db/drizzle.module.js';
import { contacts, properties, stays } from '../db/schema/index.js';
import type { Transaction } from '../db/with-staff.js';

type Db = Database | Transaction;

export async function assertGuest(db: Db, contactId: number) {
  const [guest] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), isNull(contacts.deletedAt)));
  if (!guest) throw new NotFoundException('Guest not found');
}

// A note or preference can only point at one of the guest's own stays.
export async function assertStayOfGuest(db: Db, contactId: number, stayId: number | null | undefined) {
  if (!stayId) return;
  const [stay] = await db
    .select({ id: stays.id })
    .from(stays)
    .where(and(eq(stays.id, stayId), eq(stays.contactId, contactId), isNull(stays.deletedAt)));
  if (!stay) throw new BadRequestException("That stay isn't one of this guest's");
}

// The stay chip on a note or preference: "Rock Villa, 3 Nov 2026". Left-join
// `stays` (not deleted) and `properties`, select these, then pass to stayChip().
export const stayColumns = {
  stayId: stays.id,
  stayHotel: properties.name,
  stayArrival: stays.arrivalDate,
};

export const joinStay = (stayIdColumn: AnyPgColumn) => and(eq(stays.id, stayIdColumn), isNull(stays.deletedAt))!;

export const joinStayHotel = eq(properties.id, stays.propertyId);

export function stayChip<T extends { stayId: number | null; stayHotel: string | null; stayArrival: string | null }>(
  row: T,
) {
  const { stayId, stayHotel, stayArrival, ...rest } = row;
  return { ...rest, stay: stayId ? { id: stayId, hotel: stayHotel!, arrivalDate: stayArrival } : null };
}

