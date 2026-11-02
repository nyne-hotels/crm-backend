import { inArray, sql } from 'drizzle-orm';
import { chunks } from '../common/sql.js';
import { contacts } from '../db/schema/index.js';
import type { Transaction } from '../db/with-staff.js';
import { latestChoices, type ConsentChannel, type ConsentChoiceStatus, type ConsentSource } from './consent-rules.js';

export interface ConsentChoice {
  contactId: number;
  channel: ConsentChannel;
  status: ConsentChoiceStatus;
  source: ConsentSource;
  evidence: string | null; // the wording agreed to, or where the choice came from
  givenAt: Date;
}

// Records yes / no choices with "the latest explicit choice wins": each one
// replaces the guest's consent for that channel – status, source, evidence
// and date – unless the choice on file was given later (see choiceIsLatest()).
// A yes on top of a yes refreshes the date and wording. Guests with no
// consent row for the channel yet get one. Do-not-contact guests are recorded
// too; marketing_email_list keeps leaving them out until staff clear it.
//
// The one place consent changes: the Change dialog, unsubscribe uploads and
// the booking import's tick box all come through here. Run inside
// withActingStaff(); returns the guests whose consent changed, whose
// "Last updated" is bumped.
export async function recordConsentChoices(tx: Transaction, choices: ConsentChoice[]): Promise<number[]> {
  const changed = new Set<number>();
  for (const part of chunks(latestChoices(choices))) {
    const values = sql.join(
      part.map(
        (c) =>
          sql`(${c.contactId}::bigint, ${c.channel}::text, ${c.status}::text, ${c.source}::text, ${c.evidence}::text, ${c.givenAt.toISOString()}::timestamptz)`,
      ),
      sql`, `,
    );
    const { rows } = await tx.execute<{ contact_id: string }>(sql`
      with v (contact_id, channel, status, source, evidence, given_at) as (values ${values}),
      updated as (
        update consents k
           set status = v.status, source = v.source, evidence = v.evidence, given_at = v.given_at
          from v
         where k.contact_id = v.contact_id and k.channel = v.channel and k.deleted_at is null
           and (k.given_at is null or k.given_at <= v.given_at)
        returning k.contact_id
      ),
      added as (
        insert into consents (contact_id, channel, status, source, evidence, given_at)
        select v.contact_id, v.channel, v.status, v.source, v.evidence, v.given_at from v
         where not exists (select 1 from consents k where k.contact_id = v.contact_id
                             and k.channel = v.channel and k.deleted_at is null)
        returning contact_id
      )
      select contact_id from updated union select contact_id from added`);
    for (const r of rows) changed.add(Number(r.contact_id));
  }

  const ids = [...changed];
  for (const part of chunks(ids)) {
    await tx
      .update(contacts)
      .set({ updatedAt: sql`now()` })
      .where(inArray(contacts.id, part));
  }
  return ids;
}
