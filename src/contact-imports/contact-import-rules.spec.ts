import {
  parseContact,
  parseImportPhone,
  parseYesNo,
  planContactImport,
  type ContactLookups,
  type ExistingContact,
  type ExistingContacts,
  type RawContact,
  type RowChoice,
} from './contact-import-rules.js';

const lookups: ContactLookups = {
  countries: [
    { code: 'GB', name: 'United Kingdom' },
    { code: 'LK', name: 'Sri Lanka' },
    { code: 'SA', name: 'Saudi Arabia' },
  ],
  properties: [
    { id: 'P02', name: 'Rock Villa' },
    { id: 'P04', name: 'Mayur Lodge' },
  ],
  tags: [
    { id: 1, name: 'VIP / industry' },
    { id: 2, name: 'Friends & family' },
  ],
  companies: [{ id: 7, name: 'Relax Lanka Tours' }],
  vipTagId: 1,
};

const parse = (raw: RawContact, index = 0) => parseContact(raw, index, lookups);

const ahmed = (overrides: Partial<ExistingContact> = {}): ExistingContact => ({
  id: 42,
  firstName: 'Ahmed',
  lastName: 'Daoud',
  contactType: 'guest',
  lifecycleStage: 'stayed',
  market: 'foreign',
  countryCode: 'SA',
  companyId: null,
  companyName: null,
  designation: null,
  vipReason: null,
  doNotContact: false,
  emails: [{ value: 'ahmeddaoud.1985@gmail.com', isPrimary: true, isShared: false }],
  phones: [{ value: '+966 54 148 8817', isPrimary: true, isShared: false }],
  consent: { email: 'unknown', whatsapp: 'unknown' },
  tagIds: [],
  likes: [],
  dislikes: [],
  notes: [],
  hotelIds: ['P02'],
  checkedOutStays: 1,
  ...overrides,
});

const crmWith = (...people: ExistingContact[]): ExistingContacts => {
  const data: ExistingContacts = { byEmail: new Map(), byPhone: new Map(), contacts: new Map() };
  for (const p of people) {
    data.contacts.set(p.id, p);
    for (const m of p.emails) if (!m.isShared) data.byEmail.set(m.value.toLowerCase(), [...(data.byEmail.get(m.value.toLowerCase()) ?? []), p.id]);
    for (const m of p.phones) {
      const digits = m.value.replace(/\D/g, '');
      if (!m.isShared) data.byPhone.set(digits, [...(data.byPhone.get(digits) ?? []), p.id]);
    }
  }
  return data;
};

const plan = (rows: RawContact[], existing = crmWith(), choices: [number, RowChoice][] = []) =>
  planContactImport(
    rows.map((r, i) => parse(r, i)),
    existing,
    lookups,
    new Map(choices),
  );

describe('parseImportPhone', () => {
  it('reads numbers with their country code, and Sri Lankan numbers starting with 0', () => {
    expect(parseImportPhone('+44 7911 123456').phone).toBe('+44 7911 123456');
    expect(parseImportPhone('0044 7911 123456').phone).toBe('+44 7911 123456');
    expect(parseImportPhone('077 123 4567').phone).toBe('+94 77 123 4567');
    // Excel dropped the +
    expect(parseImportPhone('94771234567').phone).toBe('+94 77 123 4567');
  });

  it('refuses numbers Excel rounded, and numbers without a country code', () => {
    expect(parseImportPhone('9.47712E+10').error).toMatch(/rounded by Excel/);
    expect(parseImportPhone('94771200000').error).toMatch(/rounded by Excel/);
    expect(parseImportPhone('12345').error).toMatch(/isn't a phone number/);
  });
});

describe('parseYesNo', () => {
  it('reads Yes, No and blank; anything else is a mistake', () => {
    expect(parseYesNo('Yes')).toBe('opted_in');
    expect(parseYesNo(' no ')).toBe('opted_out');
    expect(parseYesNo('')).toBeUndefined();
    expect(parseYesNo('maybe')).toBeNull();
  });
});

describe('parseContact', () => {
  it('reads a full template row', () => {
    const row = parse({
      firstName: 'Priya',
      lastName: 'De Silva',
      contactType: 'Guest',
      email: 'Priya@Example.com',
      otherEmails: 'priya.work@example.com; priya@example.com',
      phone: '077 123 4567',
      country: 'Sri Lanka',
      tags: 'Friends & family',
      vipReason: 'Travel writer',
      hotels: 'Rock Villa; P04',
      emailMarketing: 'Yes',
      whatsappMarketing: 'No',
    });
    expect(row.errors).toEqual([]);
    expect(row.values).toMatchObject({
      firstName: 'Priya',
      lastName: 'De Silva',
      contactType: 'guest',
      countryCode: 'LK',
      primaryEmail: 'priya@example.com',
      emails: ['priya@example.com', 'priya.work@example.com'],
      phones: ['+94 77 123 4567'],
      tagIds: [2, 1], // the VIP reason adds the VIP tag
      hotelIds: ['P02', 'P04'],
      consent: { email: 'opted_in', whatsapp: 'opted_out' },
    });
  });

  it('splits a single Name column as the booking import does', () => {
    expect(parse({ fullName: 'Mr John Smith', email: 'j@x.com' }).values).toMatchObject({ firstName: 'John', lastName: 'Smith' });
  });

  it('needs a name, and an email or a phone', () => {
    expect(parse({ firstName: 'Ahmed' }).errors).toEqual(['Needs an email or a phone']);
    expect(parse({ email: 'a@x.com' }).errors).toEqual(['Needs a name']);
  });

  it("lets an agent contact use the company's name", () => {
    expect(parse({ contactType: 'Agent contact', company: 'Relax Lanka Tours', sharedEmail: 'info@relax.lk' }).errors).toEqual([]);
  });

  it('only takes values the CRM lists', () => {
    const row = parse({
      firstName: 'A',
      email: 'not-an-email',
      contactType: 'Friend',
      country: 'Atlantis',
      market: 'Overseas',
      tags: 'Gold',
      hotels: 'The Ritz',
      emailMarketing: 'maybe',
    });
    expect(row.errors).toEqual([
      `Type "Friend" isn't Guest, Prospect, Agent contact or Influencer`,
      `Country "Atlantis" isn't one the CRM lists`,
      `Market "Overseas" isn't Local, Foreign or Unknown`,
      `Email "not-an-email" isn't a valid address`,
      `Email marketing "maybe" should be Yes, No or empty`,
      `Tag "Gold" isn't one of the CRM's tags`,
      `Hotel "The Ritz" isn't one of the CRM's hotels`,
    ]);
  });
});

describe('planContactImport', () => {
  it('adds new people, with consent as the file says', () => {
    const p = plan([
      { firstName: 'Nimal', email: 'nimal@example.com', emailMarketing: 'Yes' },
      { firstName: 'Sara', phone: '+44 7911 123456', whatsappMarketing: 'No' },
    ]);
    expect(p.rows.map((r) => r.outcome)).toEqual(['new', 'new']);
    expect(p.creates[0]).toMatchObject({
      contact: { firstName: 'Nimal', contactType: 'lead', lifecycleStage: 'lead', market: 'unknown' },
      methods: [{ kind: 'email', value: 'nimal@example.com', isPrimary: true, isShared: false }],
      consent: [{ channel: 'email', status: 'opted_in' }],
    });
    expect(p.creates[1].consent).toEqual([{ channel: 'whatsapp', status: 'opted_out' }]);
  });

  it('never matches on name alone, nor on a shared address', () => {
    const office = ahmed({ emails: [{ value: 'office@agency.com', isPrimary: true, isShared: true }], phones: [] });
    const p = plan([{ firstName: 'Ahmed', lastName: 'Daoud', email: 'office@agency.com' }], crmWith(office));
    expect(p.rows[0].group).toBe('new');
  });

  it('shows a contact already in the CRM, and ignores them unless told otherwise', () => {
    const p = plan([{ firstName: 'Ahmad', email: 'AhmedDaoud.1985@gmail.com', phone: '+966 50 000 1111' }], crmWith(ahmed()));
    expect(p.rows[0]).toMatchObject({ group: 'existing', outcome: 'ignored', decision: 'ignore', contactId: 42 });
    expect(p.rows[0].matches[0]).toMatchObject({ contactId: 42, name: 'Ahmed Daoud', by: ['email'] });
    expect(p.updates).toEqual([]);
    expect(p.creates).toEqual([]);
  });

  it('updates: the file wins, and the old phone stays as an extra', () => {
    const p = plan(
      [{ firstName: 'Ahmad', lastName: 'Daoud', email: 'ahmeddaoud.1985@gmail.com', phone: '+966 50 000 1111' }],
      crmWith(ahmed()),
      [[0, { decision: 'update' }]],
    );
    const [u] = p.updates;
    expect(p.rows[0].outcome).toBe('updated');
    expect(u.set).toEqual({ firstName: 'Ahmad' });
    expect(u.primary).toEqual([{ kind: 'phone', value: '+966 50 000 1111', onFile: false }]);
    expect(u.changes).toEqual([
      { field: 'firstName', old: 'Ahmed', new: 'Ahmad' },
      { field: 'primaryPhone', old: '+966 54 148 8817', new: '+966 50 000 1111' },
    ]);
    expect(p.summary).toMatchObject({ changedContacts: 1, primaryChanges: 1 });
  });

  it('empty cells change nothing', () => {
    const p = plan([{ email: 'ahmeddaoud.1985@gmail.com', fullName: 'Ahmed' }], crmWith(ahmed()), [[0, { decision: 'update' }]]);
    expect(p.updates[0].changes).toEqual([]);
    expect(p.rows[0].warnings).toContain('Nothing to change: the CRM already has these values');
  });

  it('consent follows the file, even over an opt-out, and counts it for the warning', () => {
    const p = plan(
      [{ fullName: 'Ahmed Daoud', email: 'ahmeddaoud.1985@gmail.com', emailMarketing: 'Yes', whatsappMarketing: 'No' }],
      crmWith(ahmed({ consent: { email: 'opted_out', whatsapp: 'opted_in' } })),
      [[0, { decision: 'update' }]],
    );
    expect(p.updates[0].consent).toEqual([
      { channel: 'email', status: 'opted_in' },
      { channel: 'whatsapp', status: 'opted_out' },
    ]);
    expect(p.summary.optedBackIn).toEqual({ email: 1, whatsapp: 0 });
    expect(p.summary.optedOut).toEqual({ email: 0, whatsapp: 1 });
  });

  it('records a do-not-contact guest who says Yes, and lists them', () => {
    const p = plan(
      [{ fullName: 'Ahmed Daoud', email: 'ahmeddaoud.1985@gmail.com', emailMarketing: 'Yes' }],
      crmWith(ahmed({ doNotContact: true, consent: { email: 'opted_out', whatsapp: 'opted_out' } })),
      [[0, { decision: 'update' }]],
    );
    expect(p.doNotContact).toEqual([42]);
    expect(p.summary.doNotContactOptIns).toBe(1);
  });

  it('changing the type moves the stage, as the guest form does', () => {
    const p = plan(
      [{ fullName: 'Ahmed Daoud', email: 'ahmeddaoud.1985@gmail.com', contactType: 'Agent contact' }],
      crmWith(ahmed()),
      [[0, { decision: 'update' }]],
    );
    expect(p.updates[0].set).toEqual({ contactType: 'agent_contact', lifecycleStage: 'agent_contact' });
  });

  it('adds tags, hotels, likes and notes only when new', () => {
    const p = plan(
      [
        {
          fullName: 'Ahmed Daoud',
          email: 'ahmeddaoud.1985@gmail.com',
          tags: 'Friends & family; VIP / industry',
          hotels: 'Rock Villa; Mayur Lodge',
          likes: 'Sea view',
          notes: 'Prefers  WhatsApp',
        },
      ],
      crmWith(ahmed({ tagIds: [2], likes: ['sea view'], notes: ['prefers whatsapp'] })),
      [[0, { decision: 'update' }]],
    );
    const [u] = p.updates;
    expect(u.tagIds).toEqual([1]);
    expect(u.hotelIds).toEqual(['P04']);
    expect(u.preferences).toEqual([]);
    expect(u.notes).toEqual([]);
  });

  it('Add creates a new contact although the email is taken', () => {
    const p = plan([{ fullName: 'Layla Daoud', email: 'ahmeddaoud.1985@gmail.com' }], crmWith(ahmed()), [[0, { decision: 'add' }]]);
    expect(p.rows[0].outcome).toBe('added_again');
    expect(p.creates[0]).toMatchObject({ addedAgain: true, contact: { firstName: 'Layla' } });
  });

  it('shows both contacts when the email matches one and the phone another, and updates the one chosen', () => {
    const other = ahmed({ id: 77, firstName: 'Ahmad', emails: [], phones: [{ value: '+966 50 000 1111', isPrimary: true, isShared: false }] });
    const rows = [{ fullName: 'Ahmed Daoud', email: 'ahmeddaoud.1985@gmail.com', phone: '+966 50 000 1111' }];
    const p = plan(rows, crmWith(ahmed(), other), [[0, { decision: 'update', contactId: 77 }]]);
    expect(p.rows[0].matches.map((m) => [m.contactId, m.by])).toEqual([
      [42, ['email']],
      [77, ['phone']],
    ]);
    expect(p.rows[0].warnings[0]).toMatch(/email belongs to one contact and the phone to another/);
    expect(p.updates[0].contactId).toBe(77);
  });

  it('a later row with the same email or phone is repeated, not imported', () => {
    const p = plan([
      { firstName: 'Nimal', email: 'nimal@example.com' },
      { firstName: 'Nimal', lastName: 'Perera', email: 'NIMAL@example.com ' },
      { firstName: 'Sunil', phone: '+94 77 123 4567' },
      { firstName: 'Sunil', phone: '0771234567' },
    ]);
    expect(p.rows.map((r) => r.group)).toEqual(['new', 'repeated', 'new', 'repeated']);
    expect(p.rows[1].errors).toEqual(['Same email as row 1']);
    expect(p.rows[3].errors).toEqual(['Same phone as row 3']);
    expect(p.summary.outcomes).toMatchObject({ new: 2, error: 2 });
  });

  it('uploading the same file twice: every row is already in the CRM', () => {
    const rows = [{ fullName: 'Ahmed Daoud', email: 'ahmeddaoud.1985@gmail.com' }];
    const p = plan(rows, crmWith(ahmed()));
    expect(p.summary.groups).toEqual({ new: 0, existing: 1, error: 0, repeated: 0 });
    expect(p.summary.outcomes.ignored).toBe(1);
  });

  it('one row updates a contact; a second row for the same contact is ignored', () => {
    const p = plan(
      [
        { fullName: 'Ahmed Daoud', email: 'ahmeddaoud.1985@gmail.com' },
        { fullName: 'Ahmed D', phone: '+966 54 148 8817' },
      ],
      crmWith(ahmed()),
      [
        [0, { decision: 'update' }],
        [1, { decision: 'update' }],
      ],
    );
    expect(p.rows.map((r) => r.outcome)).toEqual(['updated', 'ignored']);
    expect(p.rows[1].warnings[0]).toMatch(/Row 1 already updates this contact/);
  });

  it('creates a new company once, and only for rows that are imported', () => {
    const p = plan(
      [
        { contactType: 'Agent contact', company: 'Blue Lagoon Travel', firstName: 'Kamal', email: 'k@blue.lk' },
        { contactType: 'Agent contact', company: 'blue lagoon travel', firstName: 'Ravi', email: 'r@blue.lk' },
        { company: 'Ignored Travel', fullName: 'Ahmed Daoud', email: 'ahmeddaoud.1985@gmail.com' },
        { company: 'Relax Lanka Tours', firstName: 'Mala', email: 'm@relax.lk' },
      ],
      crmWith(ahmed()),
    );
    expect(p.newCompanies).toEqual([{ key: 0, name: 'Blue Lagoon Travel' }]);
    expect(p.creates.map((c) => c.company)).toEqual([{ newKey: 0 }, { newKey: 0 }, { id: 7 }]);
    expect(p.summary.newCompanies).toEqual(['Blue Lagoon Travel']);
  });
});
