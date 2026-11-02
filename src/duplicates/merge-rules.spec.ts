import { filledFields, listInWords, mergePreview, pairOf, suggestKeep, type MergeOutcome } from './merge-rules.js';

describe('pairs', () => {
  it('are stored lowest id first', () => {
    expect(pairOf(7, 3)).toEqual([3, 7]);
    expect(pairOf(3, 7)).toEqual([3, 7]);
  });
});

describe('which profile to suggest keeping', () => {
  const size = (id: number, stays = 0, knowledge = 0, details = 1) => ({ id, stays, knowledge, details });

  it('prefers the one with more stays, then more notes and preferences, then more details', () => {
    expect(suggestKeep(size(1, 0), size(2, 1))).toBe(2);
    expect(suggestKeep(size(1, 1, 0), size(2, 1, 3))).toBe(2);
    expect(suggestKeep(size(1, 1, 3, 1), size(2, 1, 3, 2))).toBe(2);
    expect(suggestKeep(size(5, 2), size(2, 1, 9, 9))).toBe(5);
  });

  it('falls back to the older profile', () => {
    expect(suggestKeep(size(9), size(4))).toBe(4);
    expect(suggestKeep(size(4), size(9))).toBe(4);
  });
});

describe('fields filled in by a merge', () => {
  const blank = { firstName: null, lastName: null, countryCode: null, companyId: null, designation: null, vipReason: null };

  it('lists the empty fields that got a value, never ones that already had one', () => {
    const before = { ...blank, firstName: 'Avee', countryCode: 'IN' };
    const after = { ...before, lastName: 'Raam', designation: 'Sales manager' };
    expect(filledFields(before, after)).toEqual(['surname', 'job title']);
    expect(filledFields(before, before)).toEqual([]);
  });

  it('says "name" when the kept profile had none', () => {
    expect(filledFields(blank, { ...blank, firstName: 'Avee', lastName: 'Raam' })).toEqual(['name']);
  });
});

describe('the merge preview in plain words', () => {
  const avee: MergeOutcome = {
    keptName: 'Avee Raam',
    removedName: 'Avee Raam',
    emails: 2,
    phones: 2,
    stays: 1,
    upcoming: 0,
    sharedStayHotels: ['Rock Villa'],
    consent: { email: 'unknown', whatsapp: 'unknown' },
    stageBefore: 'stayed',
    stage: 'stayed',
    moved: { notes: 0, preferences: 0, specialDates: 0, leads: 0, interactions: 0 },
    tagsAdded: [],
    filled: [],
    doNotContactCarried: false,
  };

  it("reads like the spec's Avee Raam example", () => {
    expect(mergePreview(avee)).toEqual([
      'Avee Raam will have 2 emails, 2 phones, 1 stay (both profiles had the same Rock Villa stay), consent unknown.',
      'Stage stays Stayed.',
      'The other profile is removed; a full copy is kept in the merge history.',
    ]);
  });

  it('names the other profile when the names differ, and lists what moves', () => {
    const lines = mergePreview({
      ...avee,
      removedName: 'A. Raam',
      emails: 1,
      phones: 0,
      stays: 2,
      upcoming: 1,
      sharedStayHotels: [],
      consent: { email: 'opted_out', whatsapp: 'unknown' },
      stage: 'repeat_guest',
      moved: { notes: 3, preferences: 1, specialDates: 0, leads: 1, interactions: 0 },
      tagsAdded: ['VIP / industry', 'Friends & family'],
      filled: ['country', 'job title'],
      doNotContactCarried: true,
    });
    expect(lines).toEqual([
      'Avee Raam will have 1 email, 0 phones, 2 stays, 1 upcoming booking, email opted out, WhatsApp unknown.',
      'Stage becomes Repeat guest.',
      'Moves across from A. Raam: 3 notes, 1 like or dislike and 1 lead.',
      'Adds the tags VIP / industry and Friends & family.',
      'Fills in the country and job title from A. Raam.',
      'Do not contact carries over from A. Raam.',
      "A. Raam's profile is removed; a full copy is kept in the merge history.",
    ]);
  });

  it('says when both channels agree', () => {
    expect(mergePreview({ ...avee, consent: { email: 'opted_out', whatsapp: 'opted_out' } })[0]).toContain(
      'opted out of email and WhatsApp.',
    );
    expect(mergePreview({ ...avee, consent: { email: 'opted_in', whatsapp: 'opted_in' } })[0]).toContain(
      'opted in to email and WhatsApp.',
    );
  });

  it('lists several shared stays once per hotel', () => {
    const [first] = mergePreview({ ...avee, stays: 2, sharedStayHotels: ['Rock Villa', 'Mayur Lodge', 'Rock Villa'] });
    expect(first).toContain('(both profiles had the same Rock Villa and Mayur Lodge stays)');
  });

  it('joins lists in words', () => {
    expect(listInWords([])).toBe('');
    expect(listInWords(['a'])).toBe('a');
    expect(listInWords(['a', 'b', 'c'])).toBe('a, b and c');
  });
});
