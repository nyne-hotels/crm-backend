import { Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { optOutEmails, markEmailsBounced } from '../consent/email-changes.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import { consents, contacts, mailchimpAudienceEvents, mailchimpAudienceSyncs } from '../db/schema/index.js';
import { withStaff, type Transaction } from '../db/with-staff.js';
import { isQuietHour, SYNC_TICK_MS } from '../campaigns/mailchimp-sync-rules.js';
import { MailchimpClient, MailchimpError } from './mailchimp.client.js';
import {
  CHECK_EVERY_MS,
  CHECK_OVERLAP_MS,
  eventsFromMembers,
  eventFromWebhook,
  type AudienceEvent,
  type McMembers,
  type McWebhook,
} from './mailchimp-audience-rules.js';

const PAGE = 1000;
const MIN_SECRET = 24;

// ---------------------------------------------------------------------
// Mailchimp unsubscribes and bounces, applied to the CRM by themselves
// (they replace Marketing → Upload unsubscribes or bounces):
//   the webhook – Mailchimp calls /api/public/mailchimp/webhook/<secret> the
//     moment someone unsubscribes or an address is cleaned (bounced). The
//     secret is MAILCHIMP_WEBHOOK_SECRET; Mailchimp doesn't sign its calls.
//   the daily check – asks Mailchimp for every unsubscribed and cleaned
//     member changed since the last check, so nothing is missed while the
//     API was down. The first check brings in everyone so far.
// Each is applied with the rules in consent/email-changes.ts and logged in
// mailchimp_audience_events (once, however it was heard of).
// ---------------------------------------------------------------------
@Injectable()
export class MailchimpAudienceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailchimpAudienceService.name);
  private readonly secret: string | undefined;
  private readonly scheduled: boolean;
  private readonly publicApiUrl: string;
  private timer: NodeJS.Timeout | undefined;
  private checking = false;

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly mailchimp: MailchimpClient,
    config: ConfigService,
  ) {
    const secret = config.get<string>('MAILCHIMP_WEBHOOK_SECRET')?.trim();
    this.secret = secret && secret.length >= MIN_SECRET ? secret : undefined;
    if (secret && !this.secret) this.logger.error(`MAILCHIMP_WEBHOOK_SECRET is shorter than ${MIN_SECRET} characters, so the webhook is off`);
    this.scheduled = mailchimp.configured && config.get<string>('MAILCHIMP_SYNC') !== 'off';
    // where Mailchimp can reach the API: MAILCHIMP_WEBHOOK_BASE_URL, or the API's own address
    this.publicApiUrl = (config.get<string>('MAILCHIMP_WEBHOOK_BASE_URL') || config.get<string>('BETTER_AUTH_URL') || '').replace(
      /\/+$/,
      '',
    );
  }

  onModuleInit() {
    if (!this.scheduled) return;
    this.timer = setInterval(() => void this.tick(), SYNC_TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  // The scheduler: the check, once a day, not at night.
  async tick(now = new Date()) {
    if (this.checking || isQuietHour(now)) return;
    const [last] = await this.db
      .select({ at: sql<Date | null>`max(${mailchimpAudienceSyncs.lastCheckedAt})` })
      .from(mailchimpAudienceSyncs);
    if (last?.at && now.getTime() - new Date(last.at).getTime() < CHECK_EVERY_MS) return;
    await this.check().catch(() => undefined); // logged and kept for the page
  }

  // The check, for every audience (Nyne has one). Check now runs it too.
  async check() {
    if (this.checking) return;
    this.checking = true;
    try {
      const { lists } = await this.mailchimp.get<{ lists: { id: string; name: string }[] }>(
        '/lists',
        { fields: 'lists.id,lists.name', count: 100 },
        { noCache: true },
      );
      for (const list of lists) await this.checkList(list);
    } catch (err) {
      const problem = err instanceof MailchimpError ? err.problem : 'check_failed';
      if (!(err instanceof MailchimpError)) this.logger.error('Mailchimp audience check failed', err instanceof Error ? err.stack : err);
      await this.db
        .update(mailchimpAudienceSyncs)
        .set({ lastError: problem, lastErrorAt: new Date() });
      throw err;
    } finally {
      this.checking = false;
    }
  }

  private async checkList(list: { id: string; name: string }) {
    const [state] = await this.db.select().from(mailchimpAudienceSyncs).where(eq(mailchimpAudienceSyncs.listId, list.id));
    const startedAt = new Date();
    const since = state?.changedUntil ? new Date(state.changedUntil.getTime() - CHECK_OVERLAP_MS).toISOString() : undefined;
    const events: AudienceEvent[] = [];
    for (const status of ['unsubscribed', 'cleaned'] as const) {
      const members = await this.members(list.id, status, since);
      events.push(...eventsFromMembers(members, status));
    }
    await withStaff(this.db, null, async (tx) => {
      await this.apply(tx, events, 'check');
      const values = { listName: list.name, changedUntil: startedAt, lastCheckedAt: new Date(), lastError: null, lastErrorAt: null };
      await tx
        .insert(mailchimpAudienceSyncs)
        .values({ listId: list.id, ...values })
        .onConflictDoUpdate({ target: mailchimpAudienceSyncs.listId, set: values });
    });
  }

  private async members(listId: string, status: 'unsubscribed' | 'cleaned', since: string | undefined): Promise<McMembers['members']> {
    const all: McMembers['members'] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await this.mailchimp.get<McMembers>(
        `/lists/${encodeURIComponent(listId)}/members`,
        {
          status,
          count: PAGE,
          offset,
          fields: 'members.email_address,members.last_changed,members.unsubscribe_reason,total_items',
          ...(since ? { since_last_changed: since } : {}),
        },
        { noCache: true },
      );
      all.push(...page.members);
      if (offset + PAGE >= page.total_items) return all;
    }
  }

  // Applies events not heard of before; returns how many were new.
  private async apply(tx: Transaction, events: AudienceEvent[], via: 'webhook' | 'check') {
    if (!events.length) return 0;
    const fresh = await tx
      .insert(mailchimpAudienceEvents)
      .values(events.map((e) => ({ email: e.email, kind: e.kind, at: e.at, reason: e.reason, via })))
      .onConflictDoNothing()
      .returning({ id: mailchimpAudienceEvents.id, email: mailchimpAudienceEvents.email, kind: mailchimpAudienceEvents.kind });
    if (!fresh.length) return 0;
    const key = (e: { kind: string; email: string }) => `${e.kind}:${e.email}`;
    const isNew = new Set(fresh.map(key));
    const kept = events.filter((e) => isNew.has(key(e)));
    const byKey = new Map(kept.map((e) => [key(e), e]));

    // unsubscribes, and spam complaints (Mailchimp cleans those with reason 'abuse'): opt out
    const outs = kept.filter((e) => e.optOut);
    const outcome = await optOutEmails(
      tx,
      outs.map((e) => ({ email: e.email, at: e.at, evidence: e.evidence })),
    );
    // cleaned addresses: bounced
    const bounced = await markEmailsBounced(
      tx,
      kept.filter((e) => e.bounce).map((e) => e.email),
    );

    const count = <T extends { email: string }>(rows: T[]) => {
      const n = new Map<string, number>();
      for (const r of rows) n.set(r.email, (n.get(r.email) ?? 0) + 1);
      return n;
    };
    const optedOut = count(outcome.optedOut);
    const bouncedBy = count(bounced);
    const later = new Map<string, number[]>();
    for (const l of outcome.optedInLater) later.set(l.email, [...(later.get(l.email) ?? []), l.contactId]);
    for (const f of fresh) {
      const e = byKey.get(key(f))!;
      const o = e.optOut ? (optedOut.get(f.email) ?? 0) : 0;
      const b = e.bounce ? (bouncedBy.get(f.email) ?? 0) : 0;
      const l = e.optOut ? (later.get(f.email) ?? []) : [];
      if (o || b || l.length) {
        await tx.update(mailchimpAudienceEvents).set({ optedOut: o, bounced: b, optedInLater: l }).where(eq(mailchimpAudienceEvents.id, f.id));
      }
    }
    return fresh.length;
  }

  // ---------- the webhook ----------
  secretMatches(given: string) {
    if (!this.secret) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(this.secret);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async webhook(secret: string, body: McWebhook) {
    if (!this.secretMatches(secret)) throw new NotFoundException();
    const event = eventFromWebhook(body);
    await withStaff(this.db, null, async (tx) => {
      if (event) await this.apply(tx, [event], 'webhook');
      const listId = body.data?.list_id;
      if (listId) {
        await tx
          .insert(mailchimpAudienceSyncs)
          .values({ listId, lastWebhookAt: new Date() })
          .onConflictDoUpdate({ target: mailchimpAudienceSyncs.listId, set: { lastWebhookAt: new Date() } });
      }
    });
    return { ok: true };
  }

  // ---------- for Marketing → Unsubscribes & bounces ----------
  async status() {
    const audiences = await this.db.select().from(mailchimpAudienceSyncs);
    const recent = await this.db
      .select({
        id: mailchimpAudienceEvents.id,
        email: mailchimpAudienceEvents.email,
        kind: mailchimpAudienceEvents.kind,
        at: mailchimpAudienceEvents.at,
        reason: mailchimpAudienceEvents.reason,
        via: mailchimpAudienceEvents.via,
        optedOut: mailchimpAudienceEvents.optedOut,
        bounced: mailchimpAudienceEvents.bounced,
        leftOptedIn: sql<number>`cardinality(${mailchimpAudienceEvents.optedInLater})`,
      })
      .from(mailchimpAudienceEvents)
      .orderBy(desc(mailchimpAudienceEvents.at), desc(mailchimpAudienceEvents.id))
      .limit(50);
    const [totals] = (
      await this.db.execute<{ unsubscribes: number; cleaned: number; last30: number }>(sql`
        select count(*) filter (where kind = 'unsubscribe')::int as unsubscribes,
               count(*) filter (where kind = 'cleaned')::int as cleaned,
               count(*) filter (where at > now() - interval '30 days')::int as last30
          from mailchimp_audience_events`)
    ).rows;
    // unsubscribed in Mailchimp but opted in again in the CRM later, and still opted in: for staff to check
    const laterIds = (
      await this.db.execute<{ id: string }>(sql`select distinct unnest(opted_in_later) as id from mailchimp_audience_events`)
    ).rows.map((r) => Number(r.id));
    const toCheck = laterIds.length
      ? await this.db
          .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, givenAt: consents.givenAt })
          .from(contacts)
          .innerJoin(consents, sql`${consents.contactId} = ${contacts.id} and ${consents.channel} = 'email' and ${consents.deletedAt} is null`)
          .where(sql`${inArray(contacts.id, laterIds)} and ${contacts.deletedAt} is null and ${consents.status} = 'opted_in'`)
      : [];
    return {
      configured: this.mailchimp.configured,
      webhook: { on: !!this.secret },
      audiences: audiences.map((a) => ({
        listId: a.listId,
        name: a.listName,
        lastCheckedAt: a.lastCheckedAt,
        lastError: a.lastError,
        lastErrorAt: a.lastErrorAt,
        lastWebhookAt: a.lastWebhookAt,
      })),
      totals,
      recent,
      toCheck,
    };
  }

  // the webhook's address, for an admin to paste into Mailchimp
  webhookUrl() {
    if (!this.secret) return { url: null, reachable: false };
    const url = `${this.publicApiUrl}/api/public/mailchimp/webhook/${this.secret}`;
    return { url, reachable: url.startsWith('https://') && !/localhost|127\.0\.0\.1/.test(url) };
  }
}
