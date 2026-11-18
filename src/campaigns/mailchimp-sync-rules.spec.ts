import { addedNote, isDue, isQuietHour, mergeName, syncInterval, toDelivery } from './mailchimp-sync-rules.js';

const at = (iso: string) => new Date(iso);
const MIN = 60_000;

describe('when an email is synced', () => {
  const sent = at('2026-11-17T11:30:00Z');

  it('syncs often while it’s new, then less, then stops', () => {
    expect(syncInterval(sent, at('2026-11-18T11:30:00Z'))).toBe(15 * MIN);
    expect(syncInterval(sent, at('2026-11-22T11:30:00Z'))).toBe(60 * MIN);
    expect(syncInterval(sent, at('2026-12-10T11:30:00Z'))).toBe(24 * 60 * MIN);
    expect(syncInterval(sent, at('2027-02-01T11:30:00Z'))).toBeNull();
  });

  it('is due when never synced, or once its interval has passed', () => {
    expect(isDue(null, at('2026-11-18T12:00:00Z'))).toBe(true);
    expect(isDue({ sentAt: sent, lastSyncedAt: null }, at('2026-11-18T12:00:00Z'))).toBe(true);
    expect(isDue({ sentAt: sent, lastSyncedAt: at('2026-11-18T12:00:00Z') }, at('2026-11-18T12:10:00Z'))).toBe(false);
    // a tick a few seconds early still counts
    expect(isDue({ sentAt: sent, lastSyncedAt: at('2026-11-18T12:00:00Z') }, at('2026-11-18T12:14:30Z'))).toBe(true);
    expect(isDue({ sentAt: sent, lastSyncedAt: at('2027-01-30T12:00:00Z') }, at('2027-02-02T12:00:00Z'))).toBe(false);
  });

  it('rests from 11pm to 7am in Colombo (UTC+5:30)', () => {
    expect(isQuietHour(at('2026-11-18T17:29:00Z'))).toBe(false); // 22:59
    expect(isQuietHour(at('2026-11-18T17:30:00Z'))).toBe(true); // 23:00
    expect(isQuietHour(at('2026-11-19T01:29:00Z'))).toBe(true); // 06:59
    expect(isQuietHour(at('2026-11-19T01:30:00Z'))).toBe(false); // 07:00
  });
});

describe('recipients', () => {
  it('reads Mailchimp’s delivery status', () => {
    expect(toDelivery('sent')).toBe('sent');
    expect(toDelivery('soft')).toBe('soft_bounce');
    expect(toDelivery('hard')).toBe('hard_bounce');
    expect(toDelivery(undefined)).toBe('sent');
  });

  it('takes a name only when there is one', () => {
    expect(mergeName(' Jane ')).toBe('Jane');
    expect(mergeName('  ')).toBeNull();
    expect(mergeName(undefined)).toBeNull();
  });

  it('notes how someone the sync adds came to be in the CRM', () => {
    expect(addedNote('Table by Nyne', 'In the spotlight', at('2026-11-17T11:30:00Z'), false)).toBe(
      'Added from Mailchimp: they received the Table by Nyne email ("In the spotlight") on 17 Nov 2026, but weren’t in the CRM.\n' +
        'Their name and email are as Mailchimp has them.\n' +
        'They’re subscribed in Mailchimp, so they’re opted in to email marketing.',
    );
    expect(addedNote('Table by Nyne', null, null, true)).toContain('unsubscribed from that email');
  });
});
