import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { chunks } from '../common/sql.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import { consents, contactMethods, contacts } from '../db/schema/index.js';
import { withActingStaff, type Transaction } from '../db/with-staff.js';
import { cleanEmails } from './consent-rules.js';
import { recordConsentChoices } from './consent-writer.js';
import type { CommitUpload, PreviewUpload, UploadKind } from './consent.schemas.js';

type Reader = Database | Transaction;

export interface MatchedGuest {
  id: number;
  firstName: string | null;
  lastName: string | null;
  done: boolean; // already opted out, or the email already bounced
}

// What the preview shows
export interface UploadSummary {
  kind: UploadKind;
  total: number; // distinct valid emails in the file
  invalid: string[]; // values that aren't email addresses
  matched: { email: string; guests: MatchedGuest[] }[];
  unmatched: string[];
  changes: number; // unsubscribes: guests to opt out; bounces: email addresses to mark bounced
  unchanged: number; // already done
}

// ...and what the upload writes
interface UploadPlan {
  summary: UploadSummary;
  optOut: { contactId: number; email: string }[];
  bounce: { methodId: number; contactId: number }[];
}

// Marketing → Upload unsubscribes or bounces. The app reads the email tool's
// file and sends its emails. Preview saves nothing; upload re-checks and
// saves in one transaction.
//   Unsubscribes: every guest with that email opts out of email (source
//     "email unsubscribe", dated now). Shared addresses (an agent's office,
//     a family email) never match a person, as everywhere else.
//   Bounces: every copy of that address is marked bounced, shared or not,
//     since it's the address that bounced, so it drops off the email list.
@Injectable()
export class EmailUploadsService {
  constructor(@InjectDb() private readonly db: Database) {}

  async preview(input: PreviewUpload) {
    const { summary } = await this.plan(this.db, input);
    return summary;
  }

  async commit(input: CommitUpload) {
    return withActingStaff(this.db, async (tx) => {
      const { summary, optOut, bounce } = await this.plan(tx, input);
      if (summary.kind === 'unsubscribes') {
        const now = new Date();
        await recordConsentChoices(
          tx,
          optOut.map((o) => ({
            contactId: o.contactId,
            channel: 'email' as const,
            status: 'opted_out' as const,
            source: 'email_unsubscribe' as const,
            evidence: `Unsubscribed ${o.email} (${input.fileName})`,
            givenAt: now,
          })),
        );
      } else {
        for (const part of chunks(bounce)) {
          await tx
            .update(contactMethods)
            .set({ status: 'bounced' })
            .where(inArray(contactMethods.id, part.map((b) => b.methodId)));
        }
        // the guest's "Last updated" shows the change, as when staff edit an email
        for (const part of chunks([...new Set(bounce.map((b) => b.contactId))])) {
          await tx
            .update(contacts)
            .set({ updatedAt: sql`now()` })
            .where(inArray(contacts.id, part));
        }
      }
      return {
        kind: summary.kind,
        updated: summary.changes,
        unchanged: summary.unchanged,
        unmatched: summary.unmatched,
        invalid: summary.invalid,
      };
    });
  }

  private async plan(db: Reader, input: PreviewUpload): Promise<UploadPlan> {
    const { emails, invalid } = cleanEmails(input.emails);
    const unsubscribing = input.kind === 'unsubscribes';

    const rows: {
      methodId: number;
      contactId: number;
      email: string;
      methodStatus: string;
      firstName: string | null;
      lastName: string | null;
      consent: string | null;
    }[] = [];
    for (const part of chunks(emails)) {
      rows.push(
        ...(await db
          .select({
            methodId: contactMethods.id,
            contactId: contactMethods.contactId,
            email: sql<string>`lower(${contactMethods.value})`,
            methodStatus: contactMethods.status,
            firstName: contacts.firstName,
            lastName: contacts.lastName,
            consent: consents.status,
          })
          .from(contactMethods)
          .innerJoin(contacts, and(eq(contacts.id, contactMethods.contactId), isNull(contacts.deletedAt)))
          .leftJoin(
            consents,
            and(eq(consents.contactId, contacts.id), eq(consents.channel, 'email'), isNull(consents.deletedAt)),
          )
          .where(
            and(
              eq(contactMethods.kind, 'email'),
              isNull(contactMethods.deletedAt),
              inArray(sql`lower(${contactMethods.value})`, part),
              unsubscribing ? eq(contactMethods.isShared, false) : undefined,
            ),
          )),
      );
    }

    const byEmail = new Map<string, MatchedGuest[]>();
    const optOut = new Map<number, string>(); // guest → the email that opted them out
    const bounce: UploadPlan['bounce'] = [];
    let unchanged = 0;
    const alreadyOut = new Set<number>();
    for (const r of rows) {
      const done = unsubscribing ? r.consent === 'opted_out' : r.methodStatus === 'bounced';
      const guests = byEmail.get(r.email) ?? [];
      if (!guests.some((g) => g.id === r.contactId)) {
        guests.push({ id: r.contactId, firstName: r.firstName, lastName: r.lastName, done });
      }
      byEmail.set(r.email, guests);

      if (unsubscribing) {
        // a guest can match through two of their emails; they count once
        if (done) alreadyOut.add(r.contactId);
        else if (!optOut.has(r.contactId)) optOut.set(r.contactId, r.email);
      } else if (done) {
        unchanged++;
      } else {
        bounce.push({ methodId: r.methodId, contactId: r.contactId });
      }
    }

    return {
      summary: {
        kind: input.kind,
        total: emails.length,
        invalid,
        matched: emails.filter((e) => byEmail.has(e)).map((email) => ({ email, guests: byEmail.get(email)! })),
        unmatched: emails.filter((e) => !byEmail.has(e)),
        changes: unsubscribing ? optOut.size : bounce.length,
        unchanged: unsubscribing ? alreadyOut.size : unchanged,
      },
      optOut: [...optOut].map(([contactId, email]) => ({ contactId, email })),
      bounce,
    };
  }
}
