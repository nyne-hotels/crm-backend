import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { chunks } from '../common/sql.js';
import { consents, contactMethods, contacts } from '../db/schema/index.js';
import type { Transaction } from '../db/with-staff.js';
import { recordConsentChoices } from './consent-writer.js';

// ---------------------------------------------------------------------
// Unsubscribes and bounces from the email tool (Mailchimp's webhook and its
// daily check, see mailchimp-audience.service.ts). These are the rules the
// old "Upload unsubscribes or bounces" page used:
//   Unsubscribes: every guest with that personal email opts out of email
//     (source "email unsubscribe", dated when they unsubscribed). Shared
//     addresses (an agent's office, a family email) never match a person.
//     As everywhere, the latest choice wins: a guest who opted in again in
//     the CRM after that date stays opted in, and is reported for staff.
//   Bounces: every copy of the address is marked bounced, shared or not,
//     since it's the address that bounced, so it drops off the email list.
// ---------------------------------------------------------------------
export interface Unsubscribe {
  email: string; // lower case
  at: Date;
  evidence: string;
}

export interface UnsubscribeOutcome {
  optedOut: { contactId: number; email: string }[]; // guests opted out now
  alreadyOut: number[];
  optedInLater: { contactId: number; email: string }[]; // opted in again after unsubscribing: left for staff
}

export async function optOutEmails(tx: Transaction, items: Unsubscribe[]): Promise<UnsubscribeOutcome> {
  const outcome: UnsubscribeOutcome = { optedOut: [], alreadyOut: [], optedInLater: [] };
  if (!items.length) return outcome;
  const byEmail = new Map(items.map((i) => [i.email, i]));
  const rows: { contactId: number; email: string; status: string | null }[] = [];
  for (const part of chunks([...byEmail.keys()])) {
    rows.push(
      ...(await tx
        .select({ contactId: contactMethods.contactId, email: sql<string>`lower(${contactMethods.value})`, status: consents.status })
        .from(contactMethods)
        .innerJoin(contacts, and(eq(contacts.id, contactMethods.contactId), isNull(contacts.deletedAt)))
        .leftJoin(consents, and(eq(consents.contactId, contacts.id), eq(consents.channel, 'email'), isNull(consents.deletedAt)))
        .where(
          and(
            eq(contactMethods.kind, 'email'),
            eq(contactMethods.isShared, false),
            isNull(contactMethods.deletedAt),
            inArray(sql`lower(${contactMethods.value})`, part),
          ),
        )),
    );
  }
  // a guest can match through two of their emails; they count once
  const toOptOut = new Map<number, Unsubscribe>();
  const already = new Set<number>();
  for (const r of rows) {
    if (r.status === 'opted_out') already.add(r.contactId);
    else if (!toOptOut.has(r.contactId)) toOptOut.set(r.contactId, byEmail.get(r.email)!);
  }
  const changed = new Set(
    await recordConsentChoices(
      tx,
      [...toOptOut].map(([contactId, u]) => ({
        contactId,
        channel: 'email' as const,
        status: 'opted_out' as const,
        source: 'email_unsubscribe' as const,
        evidence: u.evidence,
        givenAt: u.at,
      })),
    ),
  );
  for (const [contactId, u] of toOptOut) {
    if (changed.has(contactId)) outcome.optedOut.push({ contactId, email: u.email });
    else outcome.optedInLater.push({ contactId, email: u.email });
  }
  outcome.alreadyOut = [...already].filter((id) => !toOptOut.has(id));
  return outcome;
}

// Returns the addresses marked bounced now, with their guest.
export async function markEmailsBounced(tx: Transaction, emails: string[]): Promise<{ contactId: number; email: string }[]> {
  const touched = new Set<number>();
  const marked: { contactId: number; email: string }[] = [];
  for (const part of chunks(emails)) {
    const rows = await tx
      .update(contactMethods)
      .set({ status: 'bounced' })
      .where(
        and(
          eq(contactMethods.kind, 'email'),
          isNull(contactMethods.deletedAt),
          sql`${contactMethods.status} <> 'bounced'`,
          inArray(sql`lower(${contactMethods.value})`, part),
        ),
      )
      .returning({ contactId: contactMethods.contactId, email: sql<string>`lower(${contactMethods.value})` });
    for (const r of rows) {
      touched.add(r.contactId);
      marked.push(r);
    }
  }
  // the guest's "Last updated" shows the change, as when staff edit an email
  for (const part of chunks([...touched])) {
    await tx.update(contacts).set({ updatedAt: sql`now()` }).where(inArray(contacts.id, part));
  }
  return marked;
}
