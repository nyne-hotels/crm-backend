import { BadRequestException, GoneException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { recordConsentChoices } from '../consent/consent-writer.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import {
  campaigns,
  consents,
  contactMethods,
  contacts,
  countries,
  leads,
  notes,
  OPEN_LEAD_STATUSES,
} from '../db/schema/index.js';
import { withStaff, type Transaction } from '../db/with-staff.js';
import { formatPhone, matchKey } from '../guests/guest-rules.js';
import { insertGuest } from '../guests/guests.service.js';
import { logStatusChanges } from '../leads/lead-writer.js';
import { HOTEL_TIME_ZONE, hotelToday } from '../stays/stay-rules.js';
import { formNote, OPT_IN_WORDING, optInEvidence, optInOutcome } from './campaign-rules.js';
import type { CampaignResponse } from './campaigns.schemas.js';

const phoneDigits = sql`regexp_replace(${contactMethods.value}, '[^0-9]', '', 'g')`;
const dayFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: HOTEL_TIME_ZONE });

// ---------------------------------------------------------------------
// The public side of a campaign: the form in campaigns/ reads the campaign
// and sends responses here, without signing in. Each response becomes a lead
// (source 'campaign') for the campaign's owner, due for follow-up the day it
// arrives, so it shows on the board and in their My follow-ups.
//
// The person is found by personal email, then phone, as in the imports; a
// new one is added as a contact of type lead. Anyone can type anything into a
// public form, so it never changes a person already in the CRM: what they
// typed goes in a note on the lead, and the opt-in box only opts in someone
// who hasn't decided (see optInOutcome()). The answer is the same either
// way, so the form doesn't tell anyone who is in the CRM.
// ---------------------------------------------------------------------
@Injectable()
export class CampaignFormService {
  private readonly throttle = new SubmissionThrottle();

  constructor(@InjectDb() private readonly db: Database) {}

  async get(slug: string) {
    const campaign = await this.find(slug);
    return { name: campaign.name, isOpen: campaign.isActive, optInWording: OPT_IN_WORDING };
  }

  async submit(slug: string, input: CampaignResponse, ip: string) {
    const campaign = await this.find(slug);
    if (!campaign.isActive) throw new GoneException('This campaign has ended');
    // the hidden field: only a bot fills it in. It's told all went well, so it doesn't try again.
    if (input.website) return { ok: true };
    if (!this.throttle.allow(ip)) {
      throw new HttpException('Too many forms sent from here. Try again in a few minutes.', HttpStatus.TOO_MANY_REQUESTS);
    }
    const phone = input.phone ? formatPhone(input.phone) : null;
    if (input.phone && !phone) {
      throw new BadRequestException('phone: Enter your phone number with its country code, e.g. +94 77 123 4567');
    }

    // NULL staff: the guest sent it, so the audit columns say System
    await withStaff(this.db, null, async (tx) => {
      // the same person sending twice at once (a double click) is added once
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`campaign-form:${input.email}`}))`);
      const found = await findPerson(tx, input.email, phone);
      const contactId =
        found?.id ??
        (await insertGuest(tx, {
          firstName: input.firstName,
          lastName: input.lastName,
          contactType: 'lead',
          countryCode: await countryOfPhone(tx, phone),
          email: { value: input.email, isShared: false },
          phone: phone ? { value: phone, isShared: false } : null,
        }));

      // ---- the opt-in box ----
      const [person] = await tx
        .select({ status: contacts.status, email: consents.status, givenAt: consents.givenAt })
        .from(contacts)
        .leftJoin(
          consents,
          and(eq(consents.contactId, contacts.id), eq(consents.channel, 'email'), isNull(consents.deletedAt)),
        )
        .where(eq(contacts.id, contactId));
      const matchedBy = found?.matchedBy ?? 'new';
      const optIn = optInOutcome(input.optIn, person.email, person.status === 'do_not_contact', matchedBy);
      if (optIn === 'opted_in') {
        await recordConsentChoices(tx, [
          {
            contactId,
            channel: 'email',
            status: 'opted_in',
            source: 'campaign_form',
            evidence: optInEvidence(campaign.name),
            givenAt: new Date(),
          },
        ]);
      }

      // ---- the lead: one open lead per person per campaign ----
      const [open] = await tx
        .select({ id: leads.id })
        .from(leads)
        .where(
          and(
            eq(leads.contactId, contactId),
            eq(leads.campaignId, campaign.id),
            inArray(leads.status, [...OPEN_LEAD_STATUSES]),
            isNull(leads.deletedAt),
          ),
        )
        .orderBy(asc(leads.id))
        .limit(1);
      let leadId = open?.id;
      if (!leadId) {
        const [lead] = await tx
          .insert(leads)
          .values({
            contactId,
            source: 'campaign',
            campaignId: campaign.id,
            ownerId: campaign.ownerId,
            followUpOn: hotelToday(),
            status: 'new',
          })
          .returning({ id: leads.id });
        leadId = lead.id;
        await logStatusChanges(tx, [{ leadId, from: null, to: 'new' }]);
      }
      const body = formNote({
        campaignName: campaign.name,
        again: !!open,
        matchedBy,
        firstName: input.firstName,
        lastName: input.lastName ?? null,
        email: input.email,
        phone,
        comments: input.comments ?? null,
        optIn,
        optedOutOn: optIn === 'opted_out' && person.givenAt ? dayFormat.format(person.givenAt) : null,
      });
      await tx.insert(notes).values({ leadId, contactId, body });
    });
    return { ok: true };
  }

  // Deleted campaigns are gone from the form too.
  private async find(slug: string) {
    const [campaign] = await this.db
      .select({ id: campaigns.id, name: campaigns.name, isActive: campaigns.isActive, ownerId: campaigns.ownerId })
      .from(campaigns)
      .where(and(eq(campaigns.slug, slug), isNull(campaigns.deletedAt)));
    if (!campaign) throw new NotFoundException('Campaign not found');
    return campaign;
  }
}

// The oldest guest with this personal email, or failing that this phone.
// Shared addresses (an agent's office, a family email) never match.
async function findPerson(tx: Transaction, email: string, phone: string | null) {
  const lookups = [
    { matchedBy: 'email' as const, where: and(eq(contactMethods.kind, 'email'), eq(sql`lower(${contactMethods.value})`, matchKey('email', email))) },
    ...(phone
      ? [{ matchedBy: 'phone' as const, where: and(eq(contactMethods.kind, 'phone'), eq(phoneDigits, matchKey('phone', phone))) }]
      : []),
  ];
  for (const { matchedBy, where } of lookups) {
    const [row] = await tx
      .select({ id: contacts.id })
      .from(contactMethods)
      .innerJoin(contacts, eq(contacts.id, contactMethods.contactId))
      .where(and(where, eq(contactMethods.isShared, false), isNull(contactMethods.deletedAt), isNull(contacts.deletedAt)))
      .orderBy(asc(contacts.id))
      .limit(1);
    if (row) return { id: row.id, matchedBy };
  }
  return null;
}

// A new person's country, from their phone's country code, so the market
// (local or foreign) is right for the email list. Only countries the CRM lists.
async function countryOfPhone(tx: Transaction, phone: string | null): Promise<string | null> {
  const code = phone ? parsePhoneNumberFromString(phone)?.country : undefined;
  if (!code) return null;
  const [row] = await tx
    .select({ code: countries.code })
    .from(countries)
    .where(and(eq(countries.code, code), isNull(countries.deletedAt)));
  return row?.code ?? null;
}

// Up to 10 forms per address in 10 minutes, kept in memory: enough for a
// family sharing a connection, not for someone scripting the form.
class SubmissionThrottle {
  private readonly sent = new Map<string, number[]>();

  constructor(
    private readonly limit = 10,
    private readonly windowMs = 10 * 60_000,
  ) {}

  allow(ip: string, now = Date.now()): boolean {
    if (this.sent.size > 10_000) this.forgetOld(now);
    const recent = (this.sent.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) return false;
    recent.push(now);
    this.sent.set(ip, recent);
    return true;
  }

  private forgetOld(now: number) {
    for (const [ip, times] of this.sent) {
      if (times.every((t) => now - t >= this.windowMs)) this.sent.delete(ip);
    }
  }
}
