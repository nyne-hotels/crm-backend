import { HOTEL_TIME_ZONE } from '../stays/stay-rules.js';

// ---------------------------------------------------------------------
// When a campaign's Mailchimp email is synced (CampaignSyncService). Most
// opens and clicks come in the first days, so a new email is synced often
// and an old one rarely, then not at all; Sync now works at any age. Nothing
// is synced at night in Sri Lanka, so the database can sleep.
// ---------------------------------------------------------------------
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const SYNC_TICK_MS = 15 * MINUTE; // how often the scheduler looks
// Each sync asks for activity from a little before the last one ended:
// Mailchimp can report an open a few minutes late. Repeats are dropped.
export const ACTIVITY_OVERLAP_MS = 30 * MINUTE;
// Bookings within this many days count for the email.
export const BOOKING_WINDOW_DAYS = 30;

// How often an email this old is synced; null = no longer by itself.
export function syncInterval(sentAt: Date, now: Date): number | null {
  const age = now.getTime() - sentAt.getTime();
  if (age < 3 * DAY) return 15 * MINUTE;
  if (age < 14 * DAY) return HOUR;
  if (age < 60 * DAY) return DAY;
  return null;
}

// Is it time to sync? Never synced = yes. A minute's slack, so a 15-minute
// interval isn't missed by a tick that runs a second early.
export function isDue(sync: { sentAt: Date | null; lastSyncedAt: Date | null } | null, now: Date): boolean {
  if (!sync?.lastSyncedAt || !sync.sentAt) return true;
  const interval = syncInterval(sync.sentAt, now);
  if (interval === null) return false;
  return now.getTime() - sync.lastSyncedAt.getTime() >= interval - MINUTE;
}

const colomboHour = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: HOTEL_TIME_ZONE });

// 11pm to 7am in Colombo: no automatic syncs.
export function isQuietHour(now: Date): boolean {
  const hour = Number(colomboHour.format(now));
  return hour >= 23 || hour < 7;
}

// Mailchimp's sent-to status → the recipient's delivery
export function toDelivery(status: string | undefined): 'sent' | 'soft_bounce' | 'hard_bounce' {
  if (status === 'hard') return 'hard_bounce';
  if (status === 'soft') return 'soft_bounce';
  return 'sent';
}

// A merge field Mailchimp has empty, or that only has spaces, is no name.
export const mergeName = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 100) : null);

const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: HOTEL_TIME_ZONE });

// The note on someone the sync adds: how they came to be in the CRM.
export function addedNote(campaignName: string, subject: string | null, sentAt: Date | null, unsubscribed: boolean): string {
  return [
    `Added from Mailchimp: they received the ${campaignName} email${subject ? ` ("${subject}")` : ''}` +
      `${sentAt ? ` on ${day.format(sentAt)}` : ''}, but weren’t in the CRM.`,
    'Their name and email are as Mailchimp has them.',
    unsubscribed
      ? 'They unsubscribed from that email, so they’re opted out of email marketing.'
      : 'They’re subscribed in Mailchimp, so they’re opted in to email marketing.',
  ].join('\n');
}

export const subscribedEvidence = (campaignName: string) =>
  `Subscribed to the Mailchimp audience; added from the ${campaignName} email's recipients`;

export const unsubscribedEvidence = (campaignName: string, reason: string | null) =>
  `Unsubscribed from the ${campaignName} email in Mailchimp${reason ? ` (${reason})` : ''}`;
