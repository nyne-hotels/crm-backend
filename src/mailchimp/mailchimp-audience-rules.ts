// ---------------------------------------------------------------------
// Mailchimp's unsubscribes and cleaned (bounced) addresses, as the CRM
// applies them (MailchimpAudienceService). Pure, so they're tested alone.
// ---------------------------------------------------------------------
export const CHECK_EVERY_MS = 24 * 60 * 60_000; // the daily check
// each check asks from an hour before the last one: Mailchimp can be a little late
export const CHECK_OVERLAP_MS = 60 * 60_000;

export interface AudienceEvent {
  email: string; // lower case
  kind: 'unsubscribe' | 'cleaned';
  at: Date;
  reason: string | null;
  optOut: boolean; // opt the guest out of email
  bounce: boolean; // mark the address bounced
  evidence: string; // the consent evidence, when opting out
}

// Mailchimp's members, from /lists/{id}/members
export interface McMembers {
  members: { email_address: string; last_changed: string; unsubscribe_reason?: string }[];
  total_items: number;
}

// What the webhook sends (form fields, parsed): type and data[...]
export interface McWebhook {
  type?: string; // 'unsubscribe', 'cleaned', 'subscribe', 'profile', 'upemail', 'campaign'
  fired_at?: string; // '2026-11-18 10:24:30', in UTC
  data?: { email?: string; reason?: string; list_id?: string; campaign_id?: string };
}

const clean = (email: string | undefined) => {
  const e = email?.trim().toLowerCase();
  return e && /^[^\s@]+@[^\s@]+$/.test(e) ? e : null;
};

// Mailchimp's own words that say nothing: 'manual' is the webhook's ordinary unsubscribe
const reasonText = (reason: string | null) =>
  reason && !['n/a', 'none given', 'manual'].includes(reason.toLowerCase()) ? reason : null;

function event(email: string, kind: 'unsubscribe' | 'cleaned', at: Date, reason: string | null, from: string): AudienceEvent {
  // Mailchimp cleans an address someone reported as spam with reason 'abuse': that's a no, not a bounce
  const abuse = kind === 'cleaned' && reason === 'abuse';
  const why = reasonText(reason);
  return {
    email,
    kind,
    at,
    reason,
    optOut: kind === 'unsubscribe' || abuse,
    bounce: kind === 'cleaned' && !abuse,
    evidence: abuse
      ? `Reported a Mailchimp email as spam (${from})`
      : `Unsubscribed in Mailchimp${why ? `: ${why}` : ''} (${from})`,
  };
}

export function eventsFromMembers(members: McMembers['members'], status: 'unsubscribed' | 'cleaned'): AudienceEvent[] {
  const out: AudienceEvent[] = [];
  for (const m of members) {
    const email = clean(m.email_address);
    const at = new Date(m.last_changed);
    if (!email || Number.isNaN(at.getTime())) continue;
    out.push(
      event(email, status === 'unsubscribed' ? 'unsubscribe' : 'cleaned', at, m.unsubscribe_reason?.trim() || null, 'daily check'),
    );
  }
  return out;
}

// One webhook call, or null for the kinds the CRM doesn't act on.
export function eventFromWebhook(body: McWebhook): AudienceEvent | null {
  if (body.type !== 'unsubscribe' && body.type !== 'cleaned') return null;
  const email = clean(body.data?.email);
  if (!email) return null;
  const at = body.fired_at ? new Date(`${body.fired_at.trim().replace(' ', 'T')}Z`) : new Date();
  return event(email, body.type === 'unsubscribe' ? 'unsubscribe' : 'cleaned', Number.isNaN(at.getTime()) ? new Date() : at, body.data?.reason?.trim() || null, 'webhook');
}
