import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { createdInfo, creator, joinCreator, joinUpdater, lastUpdated, updater } from '../common/audit.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import {
  CONSENT_CHANNELS,
  consents,
  contactImportChanges,
  contactImports,
  contactMethods,
  contacts,
  staffUsers,
  type CONTACT_STATUSES,
} from '../db/schema/index.js';
import { withActingStaff } from '../db/with-staff.js';
import { assertGuest } from '../knowledge/knowledge-checks.js';
import { HOTEL_TIME_ZONE } from '../stays/stay-rules.js';
import {
  choiceIsLatest,
  givenAtFor,
  givenOnError,
  notOnListReasons,
  type ConsentChannel,
} from './consent-rules.js';
import { recordConsentChoices } from './consent-writer.js';
import type { ChangeConsent } from './consent.schemas.js';

const dncStaff = alias(staffUsers, 'dnc_staff');

const dayFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: HOTEL_TIME_ZONE });

// The Consent panel on the guest profile: email and WhatsApp consent, do not
// contact, and whether the guest is on the marketing email list (and why not).
@Injectable()
export class GuestConsentService {
  constructor(@InjectDb() private readonly db: Database) {}

  async get(guestId: number) {
    const [guest] = await this.db
      .select({
        status: contacts.status,
        doNotContactAt: contacts.doNotContactAt,
        doNotContactBy: dncStaff.firstName,
        doNotContactByLast: dncStaff.lastName,
      })
      .from(contacts)
      .leftJoin(dncStaff, eq(dncStaff.id, contacts.doNotContactBy))
      .where(and(eq(contacts.id, guestId), isNull(contacts.deletedAt)));
    if (!guest) throw new NotFoundException('Guest not found');

    const [rows, [primaryEmail], imported] = await Promise.all([
      this.db
        .select({
          channel: consents.channel,
          status: consents.status,
          source: consents.source,
          evidence: consents.evidence,
          givenAt: consents.givenAt,
          lastUpdated: lastUpdated(consents),
        })
        .from(consents)
        .leftJoin(updater, joinUpdater(consents))
        .where(and(eq(consents.contactId, guestId), isNull(consents.deletedAt))),
      this.db
        .select({ isShared: contactMethods.isShared, status: contactMethods.status })
        .from(contactMethods)
        .where(
          and(
            eq(contactMethods.contactId, guestId),
            eq(contactMethods.kind, 'email'),
            eq(contactMethods.isPrimary, true),
            isNull(contactMethods.deletedAt),
          ),
        ),
      // consent set by a contact import (Module 9): which import, who and when.
      // A new contact's consent came with its 'contact' row.
      this.db
        .select({ field: contactImportChanges.field, id: contactImports.id, imported: createdInfo(contactImports) })
        .from(contactImportChanges)
        .innerJoin(contactImports, eq(contactImports.id, contactImportChanges.importId))
        .leftJoin(creator, joinCreator(contactImports))
        .where(
          and(
            eq(contactImportChanges.contactId, guestId),
            inArray(contactImportChanges.field, ['contact', 'emailConsent', 'whatsappConsent']),
          ),
        )
        .orderBy(desc(contactImportChanges.id)),
    ]);
    const importOf = (channel: ConsentChannel) => {
      const found = imported.find((i) => i.field === `${channel}Consent` || i.field === 'contact');
      return found ? { id: found.id, at: found.imported.at, by: found.imported.by } : null;
    };

    // a guest without a row for a channel (loaded before consent was tracked) is unknown
    const channels = CONSENT_CHANNELS.map((channel) => {
      const row = rows.find((r) => r.channel === channel);
      if (!row) {
        return { channel, status: 'unknown' as const, source: null, evidence: null, givenAt: null, lastUpdated: null, contactImport: null };
      }
      return { ...row, contactImport: row.source === 'contact_import' ? importOf(channel) : null };
    });
    const doNotContact = guest.status === 'do_not_contact';
    const reasons = notOnListReasons({
      doNotContact,
      emailConsent: channels[0].status,
      primaryEmail: primaryEmail ?? null,
    });
    return {
      channels,
      doNotContact: doNotContact
        ? {
            at: guest.doNotContactAt,
            by: [guest.doNotContactBy, guest.doNotContactByLast].filter(Boolean).join(' ') || null,
          }
        : null,
      // an opt-in recorded after do-not-contact was set: staff should confirm with the guest
      optInWhileDoNotContact: doNotContact && channels.some((c) => c.status === 'opted_in'),
      emailList: { onList: reasons.length === 0, reasons },
    };
  }

  // A yes or no the guest gave, from the Change dialog. Refused when the
  // choice on file is later than this one (the latest choice wins).
  async change(guestId: number, channel: ConsentChannel, input: ChangeConsent) {
    const problem = givenOnError(input.givenOn);
    if (problem) throw new BadRequestException(problem);
    const givenAt = givenAtFor(input.givenOn);

    await withActingStaff(this.db, async (tx) => {
      await assertGuest(tx, guestId);
      const [onFile] = await tx
        .select({ status: consents.status, givenAt: consents.givenAt })
        .from(consents)
        .where(and(eq(consents.contactId, guestId), eq(consents.channel, channel), isNull(consents.deletedAt)))
        .for('update');
      if (!choiceIsLatest(onFile, givenAt)) {
        const status = onFile.status === 'opted_in' ? 'Opted in' : onFile.status === 'opted_out' ? 'Opted out' : 'A choice';
        throw new ConflictException(
          `${status} on ${dayFormat.format(onFile.givenAt!)} is later than this, so it still stands. ` +
            "If the guest has changed their mind since, record it with today's date.",
        );
      }
      await recordConsentChoices(tx, [
        { contactId: guestId, channel, status: input.status, source: input.source, evidence: input.evidence ?? null, givenAt },
      ]);
    });
    return this.get(guestId);
  }

  // Do not contact: the database switches every channel to opted out and
  // stamps who set it and when. Setting it twice changes nothing.
  async setDoNotContact(guestId: number) {
    await this.setStatus(guestId, 'do_not_contact');
    return this.get(guestId);
  }

  // Clearing it leaves consent as it is: the guest stays opted out unless
  // they opted in again (a ticked box) while it was on.
  async clearDoNotContact(guestId: number) {
    await this.setStatus(guestId, 'active');
    return this.get(guestId);
  }

  private async setStatus(guestId: number, status: (typeof CONTACT_STATUSES)[number]) {
    await withActingStaff(this.db, async (tx) => {
      await assertGuest(tx, guestId);
      await tx
        .update(contacts)
        .set({ status })
        .where(and(eq(contacts.id, guestId), ne(contacts.status, status), isNull(contacts.deletedAt)));
    });
  }
}
