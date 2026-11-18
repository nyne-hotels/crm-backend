import { Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { chunks } from '../common/sql.js';
import { recordConsentChoices, type ConsentChoice } from '../consent/consent-writer.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import {
  campaigns,
  contactMethods,
  mailchimpActivity,
  mailchimpRecipients,
  mailchimpSyncs,
  notes,
} from '../db/schema/index.js';
import { withStaff, type Transaction } from '../db/with-staff.js';
import { insertGuest } from '../guests/guests.service.js';
import { MailchimpClient, MailchimpError } from '../mailchimp/mailchimp.client.js';
import {
  ACTIVITY_OVERLAP_MS,
  addedNote,
  isDue,
  isQuietHour,
  mergeName,
  subscribedEvidence,
  SYNC_TICK_MS,
  toDelivery,
  unsubscribedEvidence,
} from './mailchimp-sync-rules.js';

const PAGE = 1000; // Mailchimp's largest page

// What Mailchimp sends (only the fields asked for)
interface McSentTo {
  sent_to: { email_address: string; status?: string; merge_fields?: { FNAME?: unknown; LNAME?: unknown } }[];
  total_items: number;
}
interface McUnsubscribed {
  unsubscribes: { email_address: string; timestamp: string; reason?: string }[];
  total_items: number;
}
interface McActivity {
  emails: { email_address: string; activity: { action: string; timestamp: string; url?: string; type?: string }[] }[];
  total_items: number;
}

type Campaign = { id: number; name: string; mailchimpId: string };

// ---------------------------------------------------------------------
// Copies a campaign's Mailchimp email into the CRM: who it went to
// (mailchimp_recipients), and each open, click and bounce
// (mailchimp_activity). Recipients the CRM doesn't have are added as
// contacts of type lead, "Added via Mailchimp", opted in to email (they're
// subscribed there) unless they unsubscribed from it, with a note saying how
// they came. People already in the CRM are never changed here.
//
// Every 15 minutes the scheduler syncs the campaigns that are due (see
// mailchimp-sync-rules.ts), except at night; Sync now runs one at once.
// Fetching happens first, then everything is written in one transaction
// under a lock per campaign, so two syncs of one campaign can't both add the
// same person. MAILCHIMP_SYNC=off stops the scheduler.
// ---------------------------------------------------------------------
@Injectable()
export class CampaignSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CampaignSyncService.name);
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private readonly scheduled: boolean;

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly mailchimp: MailchimpClient,
    config: ConfigService,
  ) {
    this.scheduled = mailchimp.configured && config.get<string>('MAILCHIMP_SYNC') !== 'off';
  }

  onModuleInit() {
    if (!this.scheduled) return;
    this.timer = setInterval(() => void this.tick(), SYNC_TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  // The scheduler: every linked campaign that's due, one after another.
  async tick(now = new Date()) {
    if (this.ticking || isQuietHour(now)) return;
    this.ticking = true;
    try {
      const rows = await this.db
        .select({ id: campaigns.id, sentAt: mailchimpSyncs.sentAt, lastSyncedAt: mailchimpSyncs.lastSyncedAt })
        .from(campaigns)
        .leftJoin(mailchimpSyncs, eq(mailchimpSyncs.campaignId, campaigns.id))
        .where(and(isNotNull(campaigns.mailchimpCampaignId), isNull(campaigns.deletedAt)));
      for (const row of rows) {
        if (!isDue({ sentAt: row.sentAt, lastSyncedAt: row.lastSyncedAt }, now)) continue;
        await this.sync(row.id).catch(() => undefined); // logged and kept on the campaign
      }
    } catch (err) {
      this.logger.error(`Mailchimp sync tick failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.ticking = false;
    }
  }

  // Sync one campaign now. A problem is kept on the campaign (shown on its
  // page) and thrown for Sync now.
  async sync(campaignId: number) {
    const campaign = await this.campaign(campaignId);
    try {
      await this.run(campaign);
    } catch (err) {
      const problem = err instanceof MailchimpError ? err.problem : 'sync_failed';
      if (!(err instanceof MailchimpError)) {
        this.logger.error(`Mailchimp sync of ${campaign.name} failed`, err instanceof Error ? err.stack : err);
      }
      await this.db
        .insert(mailchimpSyncs)
        .values({ campaignId, mailchimpCampaignId: campaign.mailchimpId, lastError: problem, lastErrorAt: new Date() })
        .onConflictDoUpdate({ target: mailchimpSyncs.campaignId, set: { lastError: problem, lastErrorAt: new Date() } });
      throw err;
    }
  }

  private async run(campaign: Campaign) {
    const id = encodeURIComponent(campaign.mailchimpId);
    const startedAt = new Date();
    const [state] = await this.db.select().from(mailchimpSyncs).where(eq(mailchimpSyncs.campaignId, campaign.id));
    const current = state?.mailchimpCampaignId === campaign.mailchimpId ? state : undefined;

    // ---- fetch ----
    const email = await this.mailchimp.get<{ status: string; send_time: string; settings: { subject_line?: string } }>(
      `/campaigns/${id}`,
      { fields: 'status,send_time,settings.subject_line' },
      { noCache: true },
    );
    if (email.status !== 'sent') return; // nothing to sync before it goes out
    const sentAt = email.send_time ? new Date(email.send_time) : null;

    const recipients = current?.recipientsSyncedAt
      ? null // who it went to doesn't change once it's sent
      : await this.pages<McSentTo>(
          `/reports/${id}/sent-to`,
          'sent_to',
          'sent_to.email_address,sent_to.status,sent_to.merge_fields.FNAME,sent_to.merge_fields.LNAME,total_items',
        );
    const unsubscribes = await this.pages<McUnsubscribed>(
      `/reports/${id}/unsubscribed`,
      'unsubscribes',
      'unsubscribes.email_address,unsubscribes.timestamp,unsubscribes.reason,total_items',
    );
    const since = current?.activityUntil ? new Date(current.activityUntil.getTime() - ACTIVITY_OVERLAP_MS) : null;
    const activity = await this.pages<McActivity>(
      `/reports/${id}/email-activity`,
      'emails',
      'emails.email_address,emails.activity,total_items',
      since ? { since: since.toISOString() } : {},
    );

    // ---- write, all or nothing ----
    await withStaff(this.db, null, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mailchimp-sync:${campaign.id}`}))`);
      // another email was linked before: start again for this one
      if (state && !current) {
        await tx.delete(mailchimpRecipients).where(eq(mailchimpRecipients.campaignId, campaign.id));
      }
      const unsubscribed = new Map(
        unsubscribes.unsubscribes.map((u) => [u.email_address.toLowerCase(), { at: new Date(u.timestamp), reason: u.reason?.trim() || null }]),
      );
      if (recipients) {
        await this.saveRecipients(tx, campaign, recipients.sent_to, unsubscribed, sentAt, email.settings.subject_line ?? null);
      }
      await this.saveUnsubscribes(tx, campaign.id, unsubscribed);
      await this.saveActivity(tx, campaign.id, activity.emails);
      const values = {
        mailchimpCampaignId: campaign.mailchimpId,
        sentAt,
        recipientsSyncedAt: recipients ? startedAt : (current?.recipientsSyncedAt ?? null),
        activityUntil: startedAt,
        lastSyncedAt: new Date(),
        lastError: null,
        lastErrorAt: null,
      };
      await tx
        .insert(mailchimpSyncs)
        .values({ campaignId: campaign.id, ...values })
        .onConflictDoUpdate({ target: mailchimpSyncs.campaignId, set: values });
    });
  }

  // Every page of a list, 1,000 at a time.
  private async pages<T extends { total_items: number }>(
    path: string,
    key: keyof T,
    fields: string,
    query: Record<string, string> = {},
  ): Promise<T> {
    const first = await this.mailchimp.get<T>(path, { ...query, fields, count: PAGE, offset: 0 }, { noCache: true });
    const all = [...(first[key] as unknown[])];
    for (let offset = PAGE; offset < first.total_items; offset += PAGE) {
      const page = await this.mailchimp.get<T>(path, { ...query, fields, count: PAGE, offset }, { noCache: true });
      all.push(...(page[key] as unknown[]));
    }
    return { ...first, [key]: all };
  }

  // Who it went to: each address matched to the CRM's contact with it as a
  // personal email (oldest first), or added as a new contact.
  private async saveRecipients(
    tx: Transaction,
    campaign: Campaign,
    sentTo: McSentTo['sent_to'],
    unsubscribed: Map<string, { at: Date; reason: string | null }>,
    sentAt: Date | null,
    subject: string | null,
  ) {
    const byEmail = new Map(sentTo.map((r) => [r.email_address.trim().toLowerCase(), r]));
    const emails = [...byEmail.keys()];
    const known = new Map<string, number | null>(); // email → contact, or null when the CRM has it only as shared
    for (const part of chunks(emails)) {
      const { rows } = await tx.execute<{ email: string; contact_id: string; is_shared: boolean }>(sql`
        select distinct on (lower(m.value)) lower(m.value) as email, m.contact_id, m.is_shared
          from ${contactMethods} m
          join contacts c on c.id = m.contact_id and c.deleted_at is null
         where m.kind = 'email' and m.deleted_at is null
           and lower(m.value) in (${sql.join(part.map((e) => sql`${e}`), sql`, `)})
         order by lower(m.value), m.is_shared, c.id`);
      for (const r of rows) known.set(r.email, r.is_shared ? null : Number(r.contact_id));
    }

    // new people: a contact each, opted in (or out, if they unsubscribed), with a note
    const choices: ConsentChoice[] = [];
    const bounced: number[] = [];
    for (const email of emails.filter((e) => !known.has(e))) {
      const r = byEmail.get(email)!;
      const contactId = await insertGuest(
        tx,
        {
          firstName: mergeName(r.merge_fields?.FNAME),
          lastName: mergeName(r.merge_fields?.LNAME),
          contactType: 'lead',
          email: { value: email, isShared: false },
          phone: null,
        },
        { via: 'mailchimp', campaignId: campaign.id },
      );
      known.set(email, contactId);
      const unsub = unsubscribed.get(email);
      choices.push(
        unsub
          ? {
              contactId,
              channel: 'email',
              status: 'opted_out',
              source: 'email_unsubscribe',
              evidence: unsubscribedEvidence(campaign.name, unsub.reason),
              givenAt: unsub.at,
            }
          : {
              contactId,
              channel: 'email',
              status: 'opted_in',
              source: 'mailchimp',
              evidence: subscribedEvidence(campaign.name),
              givenAt: sentAt ?? new Date(),
            },
      );
      if (toDelivery(r.status) === 'hard_bounce') bounced.push(contactId);
      await tx.insert(notes).values({ contactId, body: addedNote(campaign.name, subject, sentAt, !!unsub) });
    }
    if (choices.length) await recordConsentChoices(tx, choices);
    if (bounced.length) {
      await tx
        .update(contactMethods)
        .set({ status: 'bounced' })
        .where(and(inArray(contactMethods.contactId, bounced), eq(contactMethods.kind, 'email')));
    }

    for (const part of chunks(emails, 500)) {
      await tx
        .insert(mailchimpRecipients)
        .values(
          part.map((email) => ({
            campaignId: campaign.id,
            contactId: known.get(email) ?? null,
            email,
            delivery: toDelivery(byEmail.get(email)!.status),
          })),
        )
        .onConflictDoNothing();
    }
  }

  private async saveUnsubscribes(tx: Transaction, campaignId: number, unsubscribed: Map<string, { at: Date; reason: string | null }>) {
    for (const [email, u] of unsubscribed) {
      await tx
        .update(mailchimpRecipients)
        .set({ unsubscribedAt: u.at, unsubscribeReason: u.reason })
        .where(
          and(
            eq(mailchimpRecipients.campaignId, campaignId),
            eq(mailchimpRecipients.email, email),
            isNull(mailchimpRecipients.unsubscribedAt),
          ),
        );
    }
  }

  // Opens, clicks and bounces since the last sync; ones already in are dropped.
  private async saveActivity(tx: Transaction, campaignId: number, emails: McActivity['emails']) {
    const withActivity = emails.filter((e) => e.activity.length);
    if (!withActivity.length) return;
    const ids = new Map(
      (
        await tx
          .select({ id: mailchimpRecipients.id, email: mailchimpRecipients.email })
          .from(mailchimpRecipients)
          .where(eq(mailchimpRecipients.campaignId, campaignId))
      ).map((r) => [r.email, r.id]),
    );
    const rows: (typeof mailchimpActivity.$inferInsert)[] = [];
    const hardBounces: number[] = [];
    for (const e of withActivity) {
      const recipientId = ids.get(e.email_address.trim().toLowerCase());
      if (!recipientId) continue;
      for (const a of e.activity) {
        if (a.action !== 'open' && a.action !== 'click' && a.action !== 'bounce') continue;
        rows.push({ recipientId, action: a.action, at: new Date(a.timestamp), url: a.action === 'click' ? (a.url ?? '') : '' });
        if (a.action === 'bounce' && a.type === 'hard') hardBounces.push(recipientId);
      }
    }
    for (const part of chunks(rows, 1000)) await tx.insert(mailchimpActivity).values(part).onConflictDoNothing();
    if (hardBounces.length) {
      await tx.update(mailchimpRecipients).set({ delivery: 'hard_bounce' }).where(inArray(mailchimpRecipients.id, hardBounces));
    }
  }

  private async campaign(campaignId: number): Promise<Campaign> {
    const [row] = await this.db
      .select({ id: campaigns.id, name: campaigns.name, mailchimpId: campaigns.mailchimpCampaignId })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt)));
    if (!row) throw new NotFoundException('Campaign not found');
    if (!row.mailchimpId) throw new NotFoundException('This campaign isn’t linked to a Mailchimp email yet');
    return { id: row.id, name: row.name, mailchimpId: row.mailchimpId };
  }
}
