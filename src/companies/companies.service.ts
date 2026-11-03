import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { createdInfo, creator, joinCreator, joinUpdater, lastUpdated, softDelete, updater } from '../common/audit.js';
import { blank, inList, startOfDay, whenFields, whenYesNo } from '../common/filters.js';
import { likePattern } from '../common/sql.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import {
  companies,
  contactOverview,
  contacts,
  countries,
  interactions,
  leads,
  notes,
  properties,
  staffUsers,
  stays,
} from '../db/schema/index.js';
import { withActingStaff, type Transaction } from '../db/with-staff.js';
import { insertGuest } from '../guests/guests.service.js';
import { interactionItems, newestFirst, noteItems } from '../leads/timeline.js';
import { addDays, hotelToday } from '../stays/stay-rules.js';
import type { AddPerson, CompanyStays, CreateCompany, ListCompanies, UpdateCompany } from './companies.schemas.js';

const accountOwner = alias(staffUsers, 'account_owner');

// Stays that count for an agency: not cancelled or no-show, guest not deleted.
const countedStay = sql`${stays.deletedAt} is null and ${stays.status} not in ('cancelled', 'no_show')
  and exists (select 1 from ${contacts} g where g.id = ${stays.contactId} and g.deleted_at is null)`;

// Travel agents, DMCs, OTAs, corporates and media (Module 7). Each has its
// people (contacts.company_id – a person belongs to one company), the stays
// booked through it (stays.booking_company_id) and a timeline of
// conversations and notes. Names are unique, ignoring case.
@Injectable()
export class CompaniesService {
  constructor(@InjectDb() private readonly db: Database) {}

  // The Companies list: name order, with stays in the last 12 months (arrived
  // since, or still to come) and the last conversation with the company or its people.
  async list(filter: ListCompanies) {
    const conditions: (SQL | undefined)[] = [isNull(companies.deletedAt)];
    if (filter.q) conditions.push(ilike(companies.name, likePattern(filter.q)));
    conditions.push(inList(companies.companyType, filter.type), inList(companies.status, filter.status));
    if (filter.owner) {
      const owners = filter.owner.filter((o) => o !== 'none');
      conditions.push(
        or(inList(companies.accountOwnerId, owners), filter.owner.includes('none') ? isNull(companies.accountOwnerId) : undefined),
      );
    }
    conditions.push(inList(companies.countryCode, filter.country));
    // the "More filters" panel
    const { people, staysLastYear, lastContact } = companyFigures();
    const today = hotelToday();
    conditions.push(
      whenYesNo(filter.people, sql`${people} > 0`),
      whenYesNo(filter.bookedLastYear, sql`${staysLastYear} > 0`),
      {
        '30': sql`${lastContact} >= ${startOfDay(addDays(today, -30))}`,
        '90': sql`${lastContact} >= ${startOfDay(addDays(today, -90))}`,
        over_90: sql`${lastContact} < ${startOfDay(addDays(today, -90))}`,
        never: sql`${lastContact} is null`,
        all: undefined,
      }[filter.lastContact ?? 'all'],
      whenYesNo(
        filter.openLeads,
        sql`exists (select 1 from ${leads} l join ${contacts} p on p.id = l.contact_id
              where p.company_id = ${companies.id} and p.deleted_at is null and l.deleted_at is null
              and l.status in ('new', 'contacted', 'quoted'))`,
      ),
      whenFields(filter, {
        country: isNull(companies.countryCode),
        address: blank(companies.address),
        website: blank(companies.website),
        commissionNotes: blank(companies.commissionNotes),
      }),
    );
    const rows = await this.query()
      .where(and(...conditions))
      .orderBy(asc(sql`lower(${companies.name})`))
      .limit(1000);
    return { rows, today: hotelToday() };
  }

  async get(id: number) {
    const [company] = await this.query().where(and(eq(companies.id, id), isNull(companies.deletedAt)));
    if (!company) throw new NotFoundException('Company not found');
    const [extra] = await this.db
      .select({
        address: companies.address,
        website: companies.website,
        commissionNotes: companies.commissionNotes,
        created: createdInfo(companies),
        lastUpdated: lastUpdated(companies),
      })
      .from(companies)
      .leftJoin(creator, joinCreator(companies))
      .leftJoin(updater, joinUpdater(companies))
      .where(eq(companies.id, id));
    const [{ stays: staysTotal }] = await this.db
      .select({ stays: count() })
      .from(stays)
      .where(and(eq(stays.bookingCompanyId, id), countedStay));
    return { ...company, ...extra, staysTotal };
  }

  async create(input: CreateCompany) {
    const [row] = await withActingStaff(this.db, async (tx) => {
      if (input.accountOwnerId) await assertStaff(tx, input.accountOwnerId);
      return tx.insert(companies).values(input).returning({ id: companies.id });
    });
    return this.get(row.id);
  }

  async update(id: number, input: UpdateCompany) {
    const current = await this.get(id);
    const changes = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    if (!Object.keys(changes).length) return current;
    await withActingStaff(this.db, async (tx) => {
      if (input.accountOwnerId && input.accountOwnerId !== current.accountOwner?.id) await assertStaff(tx, input.accountOwnerId);
      await tx.update(companies).set(changes).where(eq(companies.id, id));
    });
    return this.get(id);
  }

  // Hidden from every list; its stays and people keep the link, so a restore brings it back.
  async remove(id: number) {
    await withActingStaff(this.db, (tx) => softDelete(tx, companies, id));
  }

  // ---------- people ----------
  async people(id: number) {
    await this.get(id);
    const o = contactOverview;
    return this.db
      .select({
        id: o.id,
        firstName: o.firstName,
        lastName: o.lastName,
        contactType: o.contactType,
        lifecycleStage: o.lifecycleStage,
        designation: contacts.designation,
        email: o.email,
        phone: o.phone,
        stayCount: o.stayRows,
      })
      .from(o)
      .innerJoin(contacts, eq(contacts.id, o.id))
      .where(eq(contacts.companyId, id))
      .orderBy(sql`lower(${o.firstName}) asc nulls last`, sql`lower(${o.lastName}) asc nulls last`, asc(o.id));
  }

  // Link someone already in the CRM (moving them from another company), or
  // add a new person, an agent contact unless another type is given.
  async addPerson(id: number, input: AddPerson) {
    await this.get(id);
    await withActingStaff(this.db, async (tx) => {
      if (input.newPerson) {
        await insertGuest(tx, { ...input.newPerson, companyId: id });
        return;
      }
      const rows = await tx
        .update(contacts)
        .set({ companyId: id })
        .where(and(eq(contacts.id, input.contactId!), isNull(contacts.deletedAt)))
        .returning({ id: contacts.id });
      if (!rows.length) throw new BadRequestException('That person no longer exists');
    });
    return this.people(id);
  }

  // Takes the person off the company; they stay in the CRM.
  async removePerson(id: number, contactId: number) {
    await this.get(id);
    await withActingStaff(this.db, async (tx) => {
      const rows = await tx
        .update(contacts)
        .set({ companyId: null })
        .where(and(eq(contacts.id, contactId), eq(contacts.companyId, id)))
        .returning({ id: contacts.id });
      if (!rows.length) throw new NotFoundException("That person isn't at this company");
    });
    return this.people(id);
  }

  // ---------- stays booked through the company ----------
  // Newest arrival first, cancelled ones included (struck through in the app).
  async stays(id: number, page: CompanyStays) {
    await this.get(id);
    const where = and(eq(stays.bookingCompanyId, id), isNull(stays.deletedAt), isNull(contacts.deletedAt));
    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select({
          id: stays.id,
          contactId: stays.contactId,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          hotel: properties.name,
          status: stays.status,
          arrivalDate: stays.arrivalDate,
          departureDate: stays.departureDate,
          nights: stays.nights,
          bookingReference: stays.bookingReference,
        })
        .from(stays)
        .innerJoin(contacts, eq(contacts.id, stays.contactId))
        .innerJoin(properties, eq(properties.id, stays.propertyId))
        .where(where)
        .orderBy(sql`${stays.arrivalDate} desc nulls last`, desc(stays.id))
        .limit(page.pageSize)
        .offset((page.page - 1) * page.pageSize),
      this.db
        .select({ total: count() })
        .from(stays)
        .innerJoin(contacts, eq(contacts.id, stays.contactId))
        .where(where),
    ]);
    return { rows, total, page: page.page, pageSize: page.pageSize };
  }

  // ---------- timeline ----------
  // Conversations with the company or any of its people, and notes on the company.
  async timeline(id: number) {
    await this.get(id);
    const people = this.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.companyId, id), isNull(contacts.deletedAt)));
    const [talks, companyNotes] = await Promise.all([
      interactionItems(this.db, or(eq(interactions.companyId, id), inArray(interactions.contactId, people))!),
      noteItems(this.db, eq(notes.companyId, id)),
    ]);
    return newestFirst([...talks, ...companyNotes]);
  }

  async addNote(id: number, body: string) {
    await this.get(id);
    await withActingStaff(this.db, (tx) => tx.insert(notes).values({ companyId: id, body }));
    return this.timeline(id);
  }

  // =====================================================================
  private query() {
    const { people, staysLastYear, lastContact } = companyFigures();
    return this.db
      .select({
        id: companies.id,
        name: companies.name,
        companyType: companies.companyType,
        countryCode: companies.countryCode,
        country: countries.name,
        status: companies.status,
        accountOwner: sql<{ id: number; name: string } | null>`case when ${accountOwner.id} is null then null
          else json_build_object('id', ${accountOwner.id}, 'name', concat_ws(' ', ${accountOwner.firstName}, ${accountOwner.lastName})) end`,
        people,
        staysLastYear,
        lastContact,
      })
      .from(companies)
      .leftJoin(countries, eq(countries.code, companies.countryCode))
      .leftJoin(accountOwner, eq(accountOwner.id, companies.accountOwnerId))
      .$dynamic();
  }
}

// The figures on each row of the list, which its filters use too.
function companyFigures() {
  const yearAgo = addDays(hotelToday(), -365);
  return {
    staysLastYear: sql<number>`(select count(*)::int from ${stays}
      where ${stays.bookingCompanyId} = ${companies.id} and ${countedStay} and ${stays.arrivalDate} >= ${yearAgo})`,
    people: sql<number>`(select count(*)::int from ${contacts} p
      where p.company_id = ${companies.id} and p.deleted_at is null)`,
    lastContact: sql<string | null>`(select max(i.occurred_at) from ${interactions} i
      where i.deleted_at is null and (i.company_id = ${companies.id}
        or i.contact_id in (select p.id from ${contacts} p where p.company_id = ${companies.id} and p.deleted_at is null)))`,
  };
}

// An account owner is any staff member still in the CRM.
async function assertStaff(tx: Transaction, staffId: number) {
  const [row] = await tx
    .select({ id: staffUsers.id })
    .from(staffUsers)
    .where(and(eq(staffUsers.id, staffId), eq(staffUsers.isActive, true), isNull(staffUsers.deletedAt)));
  if (!row) throw new BadRequestException('Choose an active staff member as the account owner');
}
