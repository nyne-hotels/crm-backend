import { eventFromWebhook, eventsFromMembers } from './mailchimp-audience-rules.js';

describe('Mailchimp unsubscribes and bounces', () => {
  it('turns unsubscribed members into opt-outs, dated when they changed', () => {
    const [e] = eventsFromMembers(
      [{ email_address: ' Jane@Example.com ', last_changed: '2026-11-17T12:00:00+00:00', unsubscribe_reason: 'No longer interested' }],
      'unsubscribed',
    );
    expect(e).toMatchObject({ email: 'jane@example.com', kind: 'unsubscribe', optOut: true, bounce: false });
    expect(e.at.toISOString()).toBe('2026-11-17T12:00:00.000Z');
    expect(e.evidence).toBe('Unsubscribed in Mailchimp: No longer interested (daily check)');
  });

  it('marks cleaned members bounced, not opted out', () => {
    const [e] = eventsFromMembers([{ email_address: 'gone@example.com', last_changed: '2026-11-14T00:00:00Z' }], 'cleaned');
    expect(e).toMatchObject({ kind: 'cleaned', optOut: false, bounce: true });
  });

  it('skips members without a usable address or date', () => {
    expect(
      eventsFromMembers(
        [
          { email_address: 'not an email', last_changed: '2026-11-14T00:00:00Z' },
          { email_address: 'a@b.com', last_changed: 'never' },
        ],
        'cleaned',
      ),
    ).toEqual([]);
  });

  it('reads the webhook’s unsubscribe, in UTC, without Mailchimp’s "manual"', () => {
    const e = eventFromWebhook({ type: 'unsubscribe', fired_at: '2026-11-18 10:24:30', data: { email: 'Jane@example.com', reason: 'manual' } });
    expect(e).toMatchObject({ email: 'jane@example.com', kind: 'unsubscribe', optOut: true });
    expect(e!.at.toISOString()).toBe('2026-11-18T10:24:30.000Z');
    expect(e!.evidence).toBe('Unsubscribed in Mailchimp (webhook)');
  });

  it('treats an address cleaned for a spam report as a no, not a bounce', () => {
    const e = eventFromWebhook({ type: 'cleaned', data: { email: 'x@example.com', reason: 'abuse' } });
    expect(e).toMatchObject({ optOut: true, bounce: false });
    expect(e!.evidence).toContain('spam');
    expect(eventFromWebhook({ type: 'cleaned', data: { email: 'x@example.com', reason: 'hard' } })).toMatchObject({ optOut: false, bounce: true });
  });

  it('ignores the webhook’s other kinds and bad addresses', () => {
    expect(eventFromWebhook({ type: 'subscribe', data: { email: 'x@example.com' } })).toBeNull();
    expect(eventFromWebhook({ type: 'unsubscribe', data: { email: '' } })).toBeNull();
    expect(eventFromWebhook({})).toBeNull();
  });
});
