import * as XLSX from 'xlsx';
import {
  countryFromBasis,
  guestLogHotel,
  isOwnAddress,
  loggedChannel,
  phoneIssues,
  planMasterImport,
  stayChannel,
  vipReason,
  type PlanLookups,
} from './master-import-plan.js';

const lookups: PlanLookups = {
  properties: [
    { id: 'P01', name: 'Lake Lodge' },
    { id: 'P02', name: 'Rock Villa' },
    { id: 'P04', name: 'Mayur Lodge' },
    { id: 'P10', name: 'The Long House' },
  ],
  countryCodes: new Set(['LK', 'GB', 'DE', 'SA', 'FR', 'AE', 'IN']),
};

// A workbook with the four tabs the import reads; each tab gets the rows given, by heading.
function workbook(tabs: Record<string, Record<string, unknown>[]>) {
  const headings: Record<string, string[]> = {
    'Master - Everything': [
      'Name',
      'Email',
      'Other emails',
      'Phone',
      'Other phones',
      'Category',
      'Market',
      'Market basis',
      'Channel',
      'Channel (as logged)',
      'Properties',
      'Repeat / multi-property',
      'Last stay (2018 logs)',
      'Trade / VIP',
      'Company',
      'Designation',
      'Likes',
      'Dislikes',
      'Notes',
      'Address',
      'Shared email (agent / office / family)',
      'Shared phone (agent / office)',
      'Phone issues',
      'Wix subscriber status',
      'Sources',
      'Source rows',
    ],
    'Travel Agents (SL)': [
      'Company',
      'Grade',
      'Location',
      'Address',
      'Email',
      'Other emails',
      'Phone',
      'Other phones',
      'Seasons ticked',
      'Latest season ticked',
      'Also in B2B Agents (contacts)',
      'Issues / to check',
    ],
    'Foreign Tour Operators': [
      'Company',
      'Country',
      'Contact person',
      'Email',
      'Other emails',
      'Phone',
      'Other phones',
      'Address',
      'Category % (as listed)',
      'Wellness list',
      'Also in B2B Agents (contacts)',
      'Issues / to check',
    ],
    'Needs Checking': [
      'Name',
      'Logged as',
      'Status',
      'Note / suggested fix',
      'Used',
      'Source',
    ],
  };
  const wb = XLSX.utils.book_new();
  for (const [tab, columns] of Object.entries(headings)) {
    const rows = (tabs[tab] ?? []).map((r) => columns.map((c) => r[c] ?? null));
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([columns, ...rows]),
      tab,
    );
  }
  return wb;
}

const guest = (cells: Record<string, unknown>) => ({
  Category: 'Guest',
  Market: 'Foreign',
  'Source rows': 'PMS › row 2',
  ...cells,
});

describe('reading the master guest list', () => {
  it('finds the hotel a 2018 guest log was kept at', () => {
    expect(
      guestLogHotel(
        'Guest_Log_RV.xlsx › Sheet1 › row 39 ; Data Base – October 26.xlsx › Taru Villas (Divan) › row 60',
      ),
    ).toBe('Rock Villa');
    expect(guestLogHotel('Guest_Log_December.xlsx › Dec › row 4')).toBe(
      'The Long House',
    );
    // two logs at two hotels: can't tell which stay the date belongs to
    expect(
      guestLogHotel(
        'Guest_Log_RV.xlsx › Sheet1 › row 32 ; Guest_Log.xlsx › AUG › row 30',
      ),
    ).toBeNull();
    expect(
      guestLogHotel('Data Base – October 26.xlsx › LL - PMS › row 9'),
    ).toBeNull();
  });

  it('maps the channel and keeps only the informative part of the logged one', () => {
    expect(stayChannel('Travel agent')).toBe('travel_agent');
    expect(stayChannel("Owner's guest / friends & family")).toBe('owner_guest');
    expect(stayChannel('OTA + Direct / FIT')).toBe('mixed');
    expect(stayChannel('Not recorded')).toBe('unknown');
    expect(loggedChannel('PMS export | Jetwing travels')).toBe(
      'Jetwing travels',
    );
    expect(loggedChannel('Wix: Contact Import | Locals list')).toBeNull();
  });

  it('works out the country from the market basis', () => {
    expect(countryFromBasis('Phone country code (United Kingdom)', 'GB')).toBe(
      'GB',
    );
    expect(
      countryFromBasis('Phone country code (Russian Federation)', null),
    ).toBe('RU');
    // the Locals sheet lists residents: an expat keeps their phone's country
    expect(countryFromBasis("Listed on the 'Locals' sheet", 'DE')).toBe('DE');
    expect(countryFromBasis("Listed on the 'Locals' sheet", null)).toBe('LK');
    expect(countryFromBasis('Email domain (btinternet.com – UK)', null)).toBe(
      'GB',
    );
    expect(countryFromBasis('Email domain (.fr)', null)).toBe('FR');
    expect(countryFromBasis('Email domain (gmx.de)', null)).toBe('DE');
    expect(
      countryFromBasis('Stated in guest log ("lives in dubai")', null),
    ).toBe('AE');
    expect(
      countryFromBasis('Stated in guest log ("first time in sri")', null),
    ).toBeNull();
    expect(
      countryFromBasis('Non-Sri Lankan name (likely – not confirmed)', null),
    ).toBeNull();
  });

  it('keeps only real VIP reasons', () => {
    expect(vipReason('Director of Sales, Taj Samudra')).toBe(
      'Director of Sales, Taj Samudra',
    );
    expect(vipReason('B2B – Relax Lanka Tours (Managing Director)')).toBeNull();
    expect(
      vipReason(
        'Only email on file is shared with other guests (agent / office / family address)',
      ),
    ).toBeNull();
  });

  it("tells a guest's own work address from their travel agent's", () => {
    expect(isOwnAddress('bandula@jetwing.lk', 'Bandula Withana')).toBe(true);
    expect(isOwnAddress('diana@khiri.com', 'Stephen Andrew Wood')).toBe(false);
    expect(
      isOwnAddress('info@srilanka-express.com', 'Maria Pilar & Party'),
    ).toBe(false);
  });

  it('reads every number in the phone issues column', () => {
    expect(
      phoneIssues(
        '"5048924888" – not a valid number in any format tried; "+1 0 5048924888" – not a valid number in any format tried',
      ),
    ).toEqual([
      {
        rawValue: '5048924888',
        issue: 'not a valid number in any format tried',
      },
      {
        rawValue: '+1 0 5048924888',
        issue: 'not a valid number in any format tried',
      },
    ]);
  });
});

describe('planMasterImport', () => {
  it('makes a stay per known hotel, dates the guest-log one and notes what has no hotel', () => {
    const { contacts } = planMasterImport(
      workbook({
        'Master - Everything': [
          guest({
            Name: 'Alexander Unitt',
            Email: 'Alexander.Unitt@gmail.com',
            'Market basis': 'Stated in guest log ("england")',
            Channel: 'Direct / FIT',
            Properties: 'The Long House; Taru Villas',
            'Last stay (2018 logs)': '2018-12-31',
            'Trade / VIP':
              'Commercial Director, Condé Nast International – promised to promote',
            Likes: 'Had a local as well as the set menus.',
            'Source rows':
              'Guest_Log_December.xlsx › Dec › row 4 ; Data Base – October 26.xlsx › Taru Villas (Divan) › row 9',
          }),
          guest({
            Name: 'Ahmed Daoud',
            Phone: '+966 54 148 8817',
            'Market basis': 'Phone country code (Saudi Arabia)',
            Properties: 'Mayur; Rock Villa',
          }),
          guest({
            Name: 'Kumari Perera',
            Market: 'Local',
            'Market basis': "Listed on the 'Locals' sheet",
            Properties: 'Unnamed property – Bentota area (Guest_Log.xlsx)',
            'Last stay (2018 logs)': '2018-08-05',
            'Source rows': 'Guest_Log.xlsx › AUG › row 3',
          }),
        ],
      }),
      lookups,
    );
    const [unitt, daoud, perera] = contacts;
    expect(unitt).toMatchObject({
      firstName: 'Alexander',
      lastName: 'Unitt',
      lifecycleStage: 'stayed',
      countryCode: 'GB',
      vipReason:
        'Commercial Director, Condé Nast International – promised to promote',
      tags: ['VIP / industry'],
      stays: [
        {
          propertyId: 'P10',
          arrivalDate: '2018-12-31',
          channel: 'direct',
          inGuestLog: true,
        },
      ],
      methods: [
        {
          kind: 'email',
          value: 'alexander.unitt@gmail.com',
          isPrimary: true,
          isShared: false,
        },
      ],
      preferences: [
        {
          kind: 'like',
          body: 'Had a local as well as the set menus.',
          onLoggedStay: true,
        },
      ],
    });
    // the Divan list adds nothing once a hotel is known
    expect(unitt.notes).toEqual([]);

    expect(daoud).toMatchObject({
      lifecycleStage: 'repeat_guest',
      countryCode: 'SA',
      market: 'foreign',
    });
    expect(daoud.stays.map((s) => s.propertyId)).toEqual(['P04', 'P02']);

    expect(perera).toMatchObject({
      lifecycleStage: 'stayed_hotel_unknown',
      countryCode: 'LK',
      market: 'local',
      stays: [],
    });
    expect(perera.notes[0]).toBe(
      'From the master guest list:\n' +
        '• Stayed at an unnamed hotel in the Bentota area (2018 guest log Guest_Log.xlsx)\n' +
        '• Last stay in the 2018 guest logs: 5 Aug 2018 (the unnamed hotel)',
    );
  });

  it('records Wix consent and skips rows with nothing to tell who someone is', () => {
    const { contacts, skipped } = planMasterImport(
      workbook({
        'Master - Everything': [
          {
            Name: null,
            Email: 'cherati27@hotmail.com',
            Category: 'Website contact',
            Market: 'Unknown',
            'Wix subscriber status': 'Subscribed',
            'Source rows': 'Wix › row 2',
          },
          {
            Name: 'Zoe',
            Category: 'Website contact',
            Market: 'Unknown',
            'Wix subscriber status': 'Never subscribed',
            'Source rows': 'Wix › row 3',
          },
          guest({
            Name: null,
            Properties: 'Taru Villas',
            'Source rows': 'Divan › row 117',
          }),
        ],
        'Needs Checking': [
          {
            Name: null,
            'Logged as': 'x@nowhere.asia',
            Status: 'Needs checking',
            Used: '—',
            Source: 'Divan › row 117',
          },
        ],
      }),
      lookups,
    );
    expect(
      contacts.map((c) => [
        c.contactType,
        c.lifecycleStage,
        c.emailConsent?.status,
      ]),
    ).toEqual([
      ['lead', 'lead', 'opted_in'],
      ['lead', 'lead', 'not_opted_in'],
    ]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({
      source: { tab: 'Master - Everything', row: 4 },
    });
    expect(skipped[0].details).toContain('Needs Checking: x@nowhere.asia');
  });

  it('gives each agency a company and an office contact, and files B2B agents under it', () => {
    const { contacts, companies, skipped } = planMasterImport(
      workbook({
        'Master - Everything': [
          {
            Name: 'Tracy Mcshane',
            Email: 'tracy@butterfly.lk',
            Phone: '+94 77 111 2233',
            Category: 'B2B agent',
            Market: 'Local',
            'Market basis': 'Sri Lanka-based agency',
            Company: 'Butterfly  Vacations',
            Designation: 'Tour Executive',
            'Source rows': 'B2B › row 2',
          },
          guest({
            Name: 'Rose Van Coevorden',
            Email: 'hello@sancharaka.com',
            Properties: 'Lake Lodge',
          }),
        ],
        'Travel Agents (SL)': [
          {
            Company: 'Butterfly Vacations',
            Grade: 'A',
            Email: 'info@butterfly.lk',
            Phone: '+94 112 345 678',
            'Seasons ticked': 'All 12 (18/19 W → 24 S)',
            'Latest season ticked': '24 S',
            'Also in B2B Agents (contacts)': 'Tracy Mcshane',
          },
          {
            Company: 'Global Island',
            Email: 'hello@sancharaka.com',
            'Seasons ticked': 'None',
          },
          { Company: "Heaven's Trail", 'Seasons ticked': 'None' },
        ],
      }),
      lookups,
    );
    expect(companies.map((c) => [c.name, c.status])).toEqual([
      ['Butterfly Vacations', 'active'],
      ['Global Island', 'prospect'],
      ["Heaven's Trail", 'prospect'],
    ]);
    const [tracy, rose, butterflyOffice] = contacts;
    expect(tracy).toMatchObject({
      contactType: 'agent_contact',
      companyKey: 'butterfly vacations',
      designation: 'Tour Executive',
    });
    expect(tracy.methods.every((m) => m.isShared)).toBe(true);
    // the guest's only email is her agent's
    expect(rose.methods).toEqual([
      {
        kind: 'email',
        value: 'hello@sancharaka.com',
        isPrimary: true,
        isShared: true,
      },
    ]);
    expect(butterflyOffice).toMatchObject({
      firstName: null,
      countryCode: 'LK',
      market: 'local',
      companyKey: 'butterfly vacations',
    });
    expect(butterflyOffice.methods.map((m) => m.value)).toEqual([
      'info@butterfly.lk',
      '+94 112 345 678',
    ]);
    expect(skipped.map((s) => s.name)).toEqual(["Heaven's Trail"]);
  });
});
