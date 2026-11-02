// Loads the master guest list into an empty CRM, as the system (no staff name on the rows):
//   npm run db:seed:master -- "docs/development/Nyne Master Database (1).xlsx" [--dry-run] [--report <file>]
// Everything is saved in one transaction, or nothing is; --dry-run runs the
// whole import and rolls it back. Either way a report workbook is written next
// to the input: the rows that weren't loaded, the ones loaded with problems,
// and the contact id each row became. See master-import-plan.ts for the rules.
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as XLSX from 'xlsx';
import * as schema from '../schema/index.js';
import {
  companies,
  consents,
  contactMethods,
  contacts,
  contactTags,
  countries,
  dataIssues,
  notes,
  preferences,
  properties,
  stays,
  tags,
} from '../schema/index.js';
import { withStaff, type Transaction } from '../with-staff.js';
import {
  planMasterImport,
  type MasterPlan,
  type PlannedContact,
} from './master-import-plan.js';
import { PROPERTIES } from './reference-data.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const reportAt = args.indexOf('--report');
// the first argument that isn't a flag or the --report file
const input = args.find((a, i) => !a.startsWith('--') && (reportAt < 0 || i !== reportAt + 1));
if (!input) {
  console.error(
    'Usage: npm run db:seed:master -- "<Nyne Master Database.xlsx>" [--dry-run] [--report <file>]',
  );
  process.exit(1);
}
const report =
  reportAt >= 0
    ? args[reportAt + 1]
    : path.join(
        path.dirname(input),
        `${path.basename(input, '.xlsx')} – import report${dryRun ? ' (dry run)' : ''}.xlsx`,
      );

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema });

class DryRunDone extends Error {
  constructor(readonly result: ImportResult) {
    super('dry run');
  }
}

interface ImportResult {
  plan: MasterPlan;
  contactIds: number[]; // per plan.contacts
  companyIds: Map<string, number>; // by company key
  propertyNames: Map<string, string>;
  totals: [string, number | string][];
}

const CHUNK = 1000;
function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK)
    out.push(rows.slice(i, i + CHUNK));
  return out;
}

async function insertAll<T>(
  rows: T[],
  insert: (part: T[]) => Promise<unknown>,
) {
  for (const part of chunks(rows)) await insert(part);
}

// Ids taken up front, so children can point at their parents in one insert each.
async function reserveIds(
  tx: Transaction,
  table: string,
  n: number,
): Promise<number[]> {
  if (!n) return [];
  const { rows } = await tx.execute<{ id: string }>(
    sql`select nextval(pg_get_serial_sequence(${table}, 'id')) as id from generate_series(1, ${n})`,
  );
  return rows.map((r) => Number(r.id));
}

async function runImport(
  tx: Transaction,
  workbook: XLSX.WorkBook,
): Promise<ImportResult> {
  const [{ existing }] = await tx
    .select({ existing: sql<number>`count(*)::int` })
    .from(contacts);
  if (existing > 0) {
    throw new Error(
      `The CRM already has ${existing} contacts (deleted ones included). This import is for an empty guest list – ` +
        'remove them first, or load into a fresh database.',
    );
  }

  // the hotels the guest list names (P09–P11 joined the seed with this import)
  await tx.insert(properties).values(PROPERTIES).onConflictDoNothing();
  const hotels = await tx
    .select({ id: properties.id, name: properties.name })
    .from(properties)
    .where(isNull(properties.deletedAt));
  const codes = await tx.select({ code: countries.code }).from(countries);
  const plan = planMasterImport(workbook, {
    properties: hotels,
    countryCodes: new Set(codes.map((c) => c.code)),
  });

  // ---------- companies (a name already in the CRM is reused) ----------
  const companyIds = new Map<string, number>();
  const known = await tx
    .select({ id: companies.id, key: sql<string>`lower(${companies.name})` })
    .from(companies)
    .where(isNull(companies.deletedAt));
  for (const c of known) companyIds.set(c.key, c.id);
  const newCompanies = plan.companies.filter((c) => !companyIds.has(c.key));
  const companyRowIds = await reserveIds(tx, 'companies', newCompanies.length);
  newCompanies.forEach((c, i) => companyIds.set(c.key, companyRowIds[i]));
  await insertAll(newCompanies, (part) =>
    tx.insert(companies).values(
      part.map((c) => ({
        id: companyIds.get(c.key)!,
        name: c.name,
        companyType: c.companyType,
        countryCode: c.countryCode,
        address: c.address,
        status: c.status,
      })),
    ),
  );

  // ---------- contacts ----------
  const contactIds = await reserveIds(tx, 'contacts', plan.contacts.length);
  const withIds = plan.contacts.map((c, i) => ({ c, id: contactIds[i] }));
  await insertAll(withIds, (part) =>
    tx.insert(contacts).values(
      part.map(({ c, id }) => ({
        id,
        firstName: c.firstName,
        lastName: c.lastName,
        contactType: c.contactType,
        lifecycleStage: c.lifecycleStage,
        market: c.market,
        countryCode: c.countryCode,
        companyId: c.companyKey ? companyIds.get(c.companyKey)! : null,
        designation: c.designation,
        vipReason: c.vipReason,
      })),
    ),
  );

  const each = <T>(f: (c: PlannedContact, id: number) => T[]) =>
    withIds.flatMap(({ c, id }) => f(c, id));

  await insertAll(
    each((c, contactId) => c.methods.map((m) => ({ contactId, ...m }))),
    (part) => tx.insert(contactMethods).values(part),
  );
  // email and WhatsApp for everyone, unknown unless Wix says otherwise (as for guests added in the app)
  await insertAll(
    each((c, contactId) => [
      c.emailConsent
        ? { contactId, channel: 'email' as const, ...c.emailConsent }
        : { contactId, channel: 'email' as const },
      { contactId, channel: 'whatsapp' as const },
    ]),
    (part) => tx.insert(consents).values(part),
  );

  // ---------- stays: past visits, so checked out; the lifecycle trigger agrees with the planned stage ----------
  const plannedStays = each((c, contactId) =>
    c.stays.map((s) => ({ contactId, s })),
  );
  const stayIds = await reserveIds(tx, 'stays', plannedStays.length);
  const loggedStayOf = new Map<number, number>(); // contact id → the stay the 2018 guest log describes
  plannedStays.forEach(
    ({ contactId, s }, i) =>
      s.inGuestLog && loggedStayOf.set(contactId, stayIds[i]),
  );
  await insertAll(
    plannedStays.map((p, i) => ({ ...p, id: stayIds[i] })),
    (part) =>
      tx.insert(stays).values(
        part.map(({ id, contactId, s }) => ({
          id,
          contactId,
          propertyId: s.propertyId,
          arrivalDate: s.arrivalDate,
          channel: s.channel,
          status: 'checked_out' as const,
        })),
      ),
  );

  // ---------- what we know about them ----------
  await insertAll(
    each((c, contactId) =>
      c.preferences.map((p) => ({
        contactId,
        kind: p.kind,
        body: p.body,
        stayId: p.onLoggedStay ? (loggedStayOf.get(contactId) ?? null) : null,
      })),
    ),
    (part) => tx.insert(preferences).values(part),
  );
  await insertAll(
    [
      ...each((c, contactId) => c.notes.map((body) => ({ contactId, body }))),
      ...plan.companies.flatMap((c) =>
        // notes only for companies this import created
        newCompanies.includes(c)
          ? c.notes.map((body) => ({ companyId: companyIds.get(c.key)!, body }))
          : [],
      ),
    ],
    (part) => tx.insert(notes).values(part),
  );

  const tagNames = [...new Set(plan.contacts.flatMap((c) => c.tags))];
  const tagIds = new Map<string, number>();
  for (const name of tagNames) {
    const [found] = await tx
      .select({ id: tags.id })
      .from(tags)
      .where(
        sql`lower(${tags.name}) = lower(${name}) and ${tags.deletedAt} is null`,
      );
    tagIds.set(
      name,
      found?.id ??
        (await tx.insert(tags).values({ name }).returning({ id: tags.id }))[0]
          .id,
    );
  }
  await insertAll(
    each((c, contactId) =>
      c.tags.map((t) => ({ contactId, tagId: tagIds.get(t)! })),
    ),
    (part) => tx.insert(contactTags).values(part),
  );

  await insertAll(
    each((c, contactId) => c.dataIssues.map((d) => ({ contactId, ...d }))),
    (part) => tx.insert(dataIssues).values(part),
  );

  // ---------- what the CRM now shows ----------
  const { rows: stages } = await tx.execute<{ stage: string; n: number }>(
    sql`select lifecycle_stage as stage, count(*)::int as n from contact_overview group by 1 order by 2 desc`,
  );
  const [{ mailable }] = (
    await tx.execute<{ mailable: number }>(
      sql`select count(*)::int as mailable from marketing_email_list`,
    )
  ).rows;
  const [{ pairs }] = (
    await tx.execute<{ pairs: number }>(
      sql`select count(*)::int as pairs from possible_duplicates`,
    )
  ).rows;
  const { rows: byHotel } = await tx.execute<{ name: string; n: number }>(
    sql`select p.name, count(*)::int as n from stays s join properties p on p.id = s.property_id
        where s.deleted_at is null group by p.id, p.name order by p.id`,
  );

  const totals: [string, number | string][] = [
    ['Contacts added', plan.contacts.length],
    ...stages.map((s): [string, number] => [`  stage: ${s.stage}`, s.n]),
    ['Rows not loaded as contacts', plan.skipped.length],
    [
      'Contacts loaded with problems',
      plan.contacts.filter((c) => c.problems.length).length,
    ],
    ['Companies added', newCompanies.length],
    [
      'Emails and phones',
      plan.contacts.reduce((n, c) => n + c.methods.length, 0),
    ],
    ['Stays', plannedStays.length],
    ...byHotel.map((h): [string, number] => [`  ${h.name}`, h.n]),
    [
      'Preferences',
      plan.contacts.reduce((n, c) => n + c.preferences.length, 0),
    ],
    [
      'Notes (guests and companies)',
      plan.contacts.reduce((n, c) => n + c.notes.length, 0) +
        newCompanies.reduce((n, c) => n + c.notes.length, 0),
    ],
    ['Data issues', plan.contacts.reduce((n, c) => n + c.dataIssues.length, 0)],
    ['On the marketing email list', mailable],
    ['Possible duplicate pairs', pairs],
  ];
  const result = {
    plan,
    contactIds,
    companyIds,
    propertyNames: new Map(hotels.map((h) => [h.id, h.name])),
    totals,
  };
  if (dryRun) throw new DryRunDone(result);
  return result;
}

// =====================================================================
// The report workbook
// =====================================================================
function sheet(rows: Record<string, unknown>[], widths: number[]) {
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = widths.map((wch) => ({ wch }));
  return ws;
}

function writeReport(file: string, r: ImportResult) {
  const { plan } = r;
  const companyName = new Map(plan.companies.map((c) => [c.key, c.name]));
  const primary = (c: PlannedContact, kind: 'email' | 'phone') =>
    c.methods.find((m) => m.kind === kind && m.isPrimary)?.value ?? '';
  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      [
        {
          Item: dryRun
            ? 'DRY RUN – nothing was saved; the contact ids below were not kept'
            : `Imported ${new Date().toISOString()}`,
          Count: '',
        },
        ...r.totals.map(([Item, Count]) => ({ Item, Count })),
      ],
      [70, 10],
    ),
    'Summary',
  );
  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      plan.skipped.map((s) => ({
        Tab: s.source.tab,
        Row: s.source.row,
        Name: s.name ?? '',
        Email: s.email ?? '',
        Phone: s.phone ?? '',
        Reason: s.reason,
        Details: s.details ?? '',
      })),
      [24, 6, 30, 32, 18, 80, 60],
    ),
    'Not loaded',
  );
  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      plan.contacts.flatMap((c, i) =>
        c.problems.map((p) => ({
          Tab: c.source.tab,
          Row: c.source.row,
          'Contact id': r.contactIds[i],
          Name: c.name ?? '',
          Problem: p.problem,
          Value: p.value ?? '',
        })),
      ),
      [24, 6, 10, 34, 80, 50],
    ),
    'Loaded with problems',
  );
  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      plan.contacts.map((c, i) => ({
        Tab: c.source.tab,
        Row: c.source.row,
        'Contact id': r.contactIds[i],
        Name: c.name ?? '',
        Type: c.contactType,
        Stage: c.lifecycleStage,
        Market: c.market,
        Country: c.countryCode ?? '',
        Email: primary(c, 'email'),
        Phone: primary(c, 'phone'),
        Company: c.companyKey ? companyName.get(c.companyKey) : '',
        'Company id': c.companyKey ? r.companyIds.get(c.companyKey) : '',
        Hotels: c.stays
          .map((s) => r.propertyNames.get(s.propertyId))
          .join(', '),
      })),
      [24, 6, 10, 34, 14, 20, 9, 8, 34, 18, 30, 10, 30],
    ),
    'Loaded',
  );
  writeFileSync(file, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }));
}

try {
  const workbook = XLSX.read(readFileSync(input), { cellDates: true });
  let result: ImportResult;
  try {
    // null staff id: the rows show as created by "System"
    result = await withStaff(db, null, (tx) => runImport(tx, workbook));
  } catch (e) {
    if (!(e instanceof DryRunDone)) throw e;
    result = e.result;
  }
  writeReport(report, result);
  for (const [item, count] of result.totals)
    console.log(`${item.padEnd(40)} ${count}`);
  console.log(
    dryRun ? '\nDry run – rolled back, nothing was saved.' : '\nSaved.',
  );
  console.log(`Report: ${report}`);
} finally {
  await pool.end();
}
