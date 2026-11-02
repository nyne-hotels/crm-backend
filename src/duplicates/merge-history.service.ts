import { Injectable, NotFoundException } from '@nestjs/common';
import { count, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { createdInfo, creator, joinCreator } from '../common/audit.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import { contactMerges, contacts, countries } from '../db/schema/index.js';
import type { ListMerges } from './duplicates.schemas.js';

const kept = alias(contacts, 'kept');
const m = contactMerges;
const snapshotName = sql<string | null>`nullif(concat_ws(' ',
  ${m.removedSnapshot}->'contact'->>'first_name', ${m.removedSnapshot}->'contact'->>'last_name'), '')`;

// The removed guest as merge_contacts() copied it: to_jsonb() of each row, so
// the keys are the database's column names. Merges logged before migration
// 0012 have only the contact, emails and phones, consents and tags.
interface Row {
  id: number;
  deleted_at: string | null;
}
interface Snapshot {
  contact: Record<string, unknown> & { id: number; first_name: string | null; last_name: string | null };
  contact_methods: (Row & { kind: 'email' | 'phone'; value: string; is_primary: boolean; is_shared: boolean; status: string })[];
  consents: (Row & { channel: string; status: string; source: string | null; given_at: string | null })[];
  tags: string[];
  stays?: (Row & {
    hotel: string;
    arrival_date: string | null;
    departure_date: string | null;
    status: string;
    booking_reference: string | null;
  })[];
  notes?: (Row & { body: string; created_at: string })[];
  preferences?: (Row & { kind: string; body: string })[];
  special_dates?: (Row & { occasion: string; label: string | null; month: number; day: number; year: number | null })[];
  leads?: Row[];
  interactions?: Row[];
  duplicate_stays: Row[];
}

const live = <T extends Row>(rows: T[] | undefined) => (rows ?? []).filter((r) => !r.deleted_at);

// Settings → Merge history (admin): who merged which guests and when, with a
// read-only copy of the removed profile and what moved to the kept one.
@Injectable()
export class MergeHistoryService {
  constructor(@InjectDb() private readonly db: Database) {}

  async list({ page, pageSize }: ListMerges) {
    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select({
          id: m.id,
          merged: createdInfo(m),
          keptId: m.keptContactId,
          keptFirstName: kept.firstName,
          keptLastName: kept.lastName,
          removedId: m.removedContactId,
          removedName: snapshotName,
          note: m.note,
        })
        .from(m)
        .leftJoin(kept, eq(kept.id, m.keptContactId))
        .leftJoin(creator, joinCreator(m))
        .orderBy(desc(m.createdAt), desc(m.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ total: count() }).from(m),
    ]);
    return {
      rows: rows.map(({ keptFirstName, keptLastName, ...r }) => ({
        ...r,
        keptName: [keptFirstName, keptLastName].filter(Boolean).join(' ') || null,
      })),
      total,
      page,
      pageSize,
    };
  }

  async get(id: number) {
    const [row] = await this.db
      .select({
        id: m.id,
        merged: createdInfo(m),
        note: m.note,
        keptId: m.keptContactId,
        keptFirstName: kept.firstName,
        keptLastName: kept.lastName,
        keptDeleted: sql<boolean>`${kept.deletedAt} is not null`,
        snapshot: m.removedSnapshot,
        movedRows: m.movedRows,
      })
      .from(m)
      .leftJoin(kept, eq(kept.id, m.keptContactId))
      .leftJoin(creator, joinCreator(m))
      .where(eq(m.id, id));
    if (!row) throw new NotFoundException('Merge not found');

    const snap = row.snapshot as Snapshot;
    const c = snap.contact;
    const [country] = c.country_code
      ? await this.db.select({ name: countries.name }).from(countries).where(eq(countries.code, String(c.country_code)))
      : [];
    const methods = live(snap.contact_methods).map((x) => ({
      id: x.id,
      kind: x.kind,
      value: x.value,
      isPrimary: x.is_primary,
      isShared: x.is_shared,
      status: x.status,
    }));
    const keptOnce = new Set(snap.duplicate_stays.map((s) => s.id));
    const movedIds = (key: string) => new Set(row.movedRows[key] ?? []);
    const movedMethods = movedIds('contact_methods');

    return {
      id: row.id,
      merged: row.merged,
      note: row.note,
      kept: row.keptId
        ? {
            id: row.keptId,
            name: [row.keptFirstName, row.keptLastName].filter(Boolean).join(' ') || null,
            deleted: row.keptDeleted,
          }
        : null, // the kept guest was later merged into someone else, or removed for good
      removed: {
        id: c.id,
        firstName: c.first_name,
        lastName: c.last_name,
        contactType: c.contact_type,
        lifecycleStage: c.lifecycle_stage,
        market: c.market,
        country: country?.name ?? null,
        countryCode: c.country_code ?? null,
        designation: c.designation ?? null,
        vipReason: c.vip_reason ?? null,
        status: c.status,
        doNotContactAt: c.do_not_contact_at ?? null,
        createdAt: c.created_at,
        emails: methods.filter((x) => x.kind === 'email'),
        phones: methods.filter((x) => x.kind === 'phone'),
        consents: live(snap.consents).map((x) => ({
          channel: x.channel,
          status: x.status,
          source: x.source,
          givenAt: x.given_at,
        })),
        tags: snap.tags,
        // copies of stays, notes and the rest are kept from Module 6 on
        detailRecorded: snap.stays !== undefined,
        stays: live(snap.stays).map((s) => ({
          id: s.id,
          hotel: s.hotel,
          arrivalDate: s.arrival_date,
          departureDate: s.departure_date,
          status: s.status,
          bookingReference: s.booking_reference,
          keptOnce: keptOnce.has(s.id), // the kept guest had the same stay, so this copy was dropped
        })),
        notes: live(snap.notes).map((n) => ({ id: n.id, body: n.body, createdAt: n.created_at })),
        preferences: live(snap.preferences).map((p) => ({ id: p.id, kind: p.kind, body: p.body })),
        specialDates: live(snap.special_dates).map((s) => ({
          id: s.id,
          occasion: s.occasion,
          label: s.label,
          month: s.month,
          day: s.day,
          year: s.year,
        })),
        leads: live(snap.leads).length,
        interactions: live(snap.interactions).length,
      },
      // what moved to the kept guest (deleted rows included, so a rebuild finds them)
      moved: {
        emails: methods.filter((x) => x.kind === 'email' && movedMethods.has(x.id)).length,
        phones: methods.filter((x) => x.kind === 'phone' && movedMethods.has(x.id)).length,
        stays: movedIds('stays').size,
        notes: movedIds('notes').size,
        preferences: movedIds('preferences').size,
        specialDates: movedIds('special_dates').size,
        leads: movedIds('leads').size,
        interactions: movedIds('interactions').size,
      },
    };
  }
}
