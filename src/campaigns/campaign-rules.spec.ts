import { formNote, optInOutcome, slugFor, uniqueSlug, type FormNote } from './campaign-rules.js';

describe('campaign slugs', () => {
  it('makes a lower-case address from the name', () => {
    expect(slugFor('Halloween 2026')).toBe('halloween-2026');
    expect(slugFor('  Christmas & New Year!! ')).toBe('christmas-new-year');
  });

  it('drops accents and keeps only letters and digits', () => {
    expect(slugFor('Café Résumé')).toBe('cafe-resume');
    expect(slugFor('Avurudu — 2027')).toBe('avurudu-2027');
  });

  it('falls back to "campaign" when nothing is left', () => {
    expect(slugFor('!!!')).toBe('campaign');
    expect(slugFor('සිංහල')).toBe('campaign');
  });

  it('keeps long names short, without a trailing dash', () => {
    const slug = slugFor(`${'a'.repeat(59)} b`);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('numbers a slug already in use', () => {
    expect(uniqueSlug('halloween', [])).toBe('halloween');
    expect(uniqueSlug('halloween', ['halloween'])).toBe('halloween-2');
    expect(uniqueSlug('halloween', ['halloween', 'halloween-2'])).toBe('halloween-3');
  });
});

describe('the opt-in box', () => {
  it('changes nothing when not ticked', () => {
    expect(optInOutcome(false, 'unknown', false, 'email')).toBe('not_ticked');
    expect(optInOutcome(false, 'opted_out', false, 'email')).toBe('not_ticked');
  });

  it('opts in someone who has not decided, or has no consent row', () => {
    expect(optInOutcome(true, 'unknown', false, 'new')).toBe('opted_in');
    expect(optInOutcome(true, 'not_opted_in', false, 'email')).toBe('opted_in');
    expect(optInOutcome(true, null, false, 'email')).toBe('opted_in');
  });

  it('never overrules an opt-out or do not contact', () => {
    expect(optInOutcome(true, 'opted_out', false, 'email')).toBe('opted_out');
    expect(optInOutcome(true, 'unknown', true, 'email')).toBe('do_not_contact');
    expect(optInOutcome(true, 'opted_in', true, 'email')).toBe('do_not_contact');
  });

  it('leaves it to staff when only the phone matched', () => {
    expect(optInOutcome(true, 'unknown', false, 'phone')).toBe('phone_match');
    expect(optInOutcome(true, 'opted_out', false, 'phone')).toBe('opted_out');
  });

  it('leaves an existing opt-in as it is', () => {
    expect(optInOutcome(true, 'opted_in', false, 'email')).toBe('already_opted_in');
  });
});

describe('the note on the lead', () => {
  const base: FormNote = {
    campaignName: 'Halloween 2026',
    again: false,
    matchedBy: 'new',
    firstName: 'Jane',
    lastName: 'Perera',
    email: 'jane@example.com',
    phone: '+94 77 123 4567',
    comments: null,
    optIn: 'opted_in',
    optedOutOn: null,
  };

  it('keeps what they typed and the opt-in', () => {
    expect(formNote(base)).toBe(
      [
        'Sent the form for Halloween 2026.',
        'Name: Jane Perera',
        'Email: jane@example.com',
        'Phone: +94 77 123 4567',
        'Opted in to marketing emails.',
      ].join('\n'),
    );
  });

  it('adds their comments after their details', () => {
    expect(formNote({ ...base, comments: 'Two rooms, one with a cot.\nArriving late.' })).toContain(
      'Phone: +94 77 123 4567\nComments: Two rooms, one with a cot.\nArriving late.\nOpted in',
    );
  });

  it('says when the form came again, and when only the phone matched', () => {
    const note = formNote({ ...base, again: true, matchedBy: 'phone', phone: null, lastName: null });
    expect(note).toContain('Sent the form again for Halloween 2026.');
    expect(note).toContain('Name: Jane\n');
    expect(note).not.toContain('Phone:');
    expect(note).toContain('Matched by phone');
  });

  it('asks staff to check an opt-in over an earlier opt-out', () => {
    expect(formNote({ ...base, optIn: 'opted_out', optedOutOn: '12 Mar 2026' })).toContain(
      'but opted out on 12 Mar 2026. Check with them before changing it.',
    );
  });
});
