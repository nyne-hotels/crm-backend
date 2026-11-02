import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { chunks } from '../common/sql.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import { contactMethods, contacts, feedback, properties, stays } from '../db/schema/index.js';
import { withActingStaff, type Transaction } from '../db/with-staff.js';
import { emailKey, planUpload, referenceKey, type CandidateStay, type PlannedResponse, type UploadRow } from './feedback-rules.js';

type Reader = Database | Transaction;

// Feedback → Upload responses: a file exported from the form tool. The app
// reads the file and sends the rows with their columns matched to fields.
// Preview saves nothing; upload re-checks every row and saves the matched
// ones in one transaction. The matching rules are planUpload() in feedback-rules.ts.
@Injectable()
export class FeedbackUploadsService {
  constructor(@InjectDb() private readonly db: Database) {}

  async preview(rows: UploadRow[]) {
    return summarise(await this.plan(this.db, rows));
  }

  async commit(rows: UploadRow[]) {
    return withActingStaff(this.db, async (tx) => {
      const plan = await this.plan(tx, rows);
      const saving = plan.filter((p) => p.outcome === 'new');
      for (const part of chunks(saving)) {
        const saved = await tx
          .insert(feedback)
          .values(part.map((p) => ({ stayId: p.stay!.id, rating: p.rating, review: p.review, submittedAt: p.submittedAt! })))
          .returning({ id: feedback.id, stayId: feedback.stayId });
        const ids = new Map(saved.map((s) => [s.stayId, s.id]));
        for (const p of part) p.stay = { ...p.stay!, feedbackId: ids.get(p.stay!.id) ?? null };
      }
      return summarise(plan);
    });
  }

  // Loads the stays the rows could be for (by booking reference and by the
  // guest's email), then plans each row.
  private async plan(db: Reader, rows: UploadRow[]): Promise<PlannedResponse[]> {
    const references = [...new Set(rows.map((r) => referenceKey(r.bookingReference ?? '')).filter(Boolean))];
    const emails = [...new Set(rows.map((r) => emailKey(r.email ?? '')).filter(Boolean))];

    const byReference = new Map<string, CandidateStay[]>();
    for (const part of chunks(references)) {
      const found = await this.candidates(db)
        .where(and(this.liveStay(), inArray(sql`lower(trim(${stays.bookingReference}))`, part)));
      for (const s of found) {
        const key = referenceKey(s.bookingReference!);
        byReference.set(key, [...(byReference.get(key) ?? []), s]);
      }
    }

    // a shared address (an agent's office, a family email) never identifies a guest
    const byEmail = new Map<string, CandidateStay[]>();
    for (const part of chunks(emails)) {
      const owners = await db
        .selectDistinct({ contactId: contactMethods.contactId, email: sql<string>`lower(${contactMethods.value})` })
        .from(contactMethods)
        .where(
          and(
            eq(contactMethods.kind, 'email'),
            eq(contactMethods.isShared, false),
            isNull(contactMethods.deletedAt),
            inArray(sql`lower(${contactMethods.value})`, part),
          ),
        );
      if (!owners.length) continue;
      const found = await this.candidates(db).where(
        and(this.liveStay(), inArray(stays.contactId, [...new Set(owners.map((o) => o.contactId))])),
      );
      for (const o of owners) {
        byEmail.set(o.email, [...(byEmail.get(o.email) ?? []), ...found.filter((s) => s.contactId === o.contactId)]);
      }
    }

    const hotels = await db
      .select({ id: properties.id, name: properties.name })
      .from(properties)
      .where(isNull(properties.deletedAt));
    return planUpload(rows, { byReference, byEmail, hotels, now: new Date() });
  }

  private candidates(db: Reader) {
    return db
      .select({
        id: stays.id,
        contactId: stays.contactId,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        propertyId: stays.propertyId,
        hotel: properties.name,
        bookingReference: stays.bookingReference,
        arrivalDate: stays.arrivalDate,
        departureDate: stays.departureDate,
        status: stays.status,
        feedbackId: feedback.id,
      })
      .from(stays)
      .innerJoin(contacts, eq(contacts.id, stays.contactId))
      .innerJoin(properties, eq(properties.id, stays.propertyId))
      .leftJoin(feedback, and(eq(feedback.stayId, stays.id), isNull(feedback.deletedAt)))
      .$dynamic();
  }

  private liveStay() {
    return and(isNull(stays.deletedAt), isNull(contacts.deletedAt));
  }
}

// What the preview and the result show: a count per outcome and every row
// with its stay and why it won't be saved.
function summarise(plan: PlannedResponse[]) {
  const counts = { new: 0, exists: 0, unmatched: 0, error: 0 };
  for (const p of plan) counts[p.outcome]++;
  return {
    total: plan.length,
    counts,
    rows: plan.map((p) => ({
      row: p.row,
      outcome: p.outcome,
      problem: p.problem,
      rating: p.rating,
      review: p.review,
      submittedAt: p.submittedAt,
      stay: p.stay && {
        id: p.stay.id,
        contactId: p.stay.contactId,
        firstName: p.stay.firstName,
        lastName: p.stay.lastName,
        hotel: p.stay.hotel,
        arrivalDate: p.stay.arrivalDate,
        departureDate: p.stay.departureDate,
        bookingReference: p.stay.bookingReference,
        feedbackId: p.stay.feedbackId,
      },
      raw: p.raw,
    })),
  };
}
