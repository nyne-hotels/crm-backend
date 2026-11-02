// One-off setup: pick-lists and the first admin account.
//   npm run db:seed
// Safe to re-run: existing rows are left alone.
// The admin's temporary password comes from SEED_ADMIN_PASSWORD, or is
// generated and printed; it must be changed at the first sign-in.
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { createAuth, placeholderEmail } from '../../auth/auth.js';
import * as schema from '../schema/index.js';
import { authUsers, countries, occasions, properties, staffUsers, tags } from '../schema/index.js';
import { withStaff } from '../with-staff.js';
import { COUNTRIES } from './countries.js';
import { OCCASIONS, PROPERTIES, TAGS } from './reference-data.js';

const ADMIN = { username: 'tehan', firstName: 'Tehan', lastName: null };

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema });

async function seedReferenceData() {
  // null staff id: these rows show as created by "System"
  await withStaff(db, null, async (tx) => {
    await tx.insert(properties).values(PROPERTIES).onConflictDoNothing();
    await tx
      .insert(countries)
      .values(COUNTRIES.map(([code, name, dialCode]) => ({ code, name, dialCode })))
      .onConflictDoNothing();

    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(occasions);
    if (count === 0) {
      await tx.insert(occasions).values(OCCASIONS.map((name, i) => ({ name, sortOrder: (i + 1) * 10 })));
    }

    const [{ tagCount }] = await tx.select({ tagCount: sql<number>`count(*)::int` }).from(tags);
    if (tagCount === 0) await tx.insert(tags).values(TAGS.map((name) => ({ name })));
  });
  console.log(`Hotels, ${COUNTRIES.length} countries, occasions and tags are in place.`);
}

async function seedFirstAdmin() {
  const [existing] = await db.select().from(authUsers).where(eq(authUsers.username, ADMIN.username));
  if (existing) {
    console.log(`Admin "${ADMIN.username}" already exists – left unchanged.`);
    return;
  }

  const auth = createAuth(db, {
    secret: process.env.BETTER_AUTH_SECRET!,
    baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
    trustedOrigins: [],
  });
  const password = process.env.SEED_ADMIN_PASSWORD || randomBytes(12).toString('base64url');
  // no request headers: a server-side call, allowed without a signed-in admin
  const { user } = await auth.api.createUser({
    body: {
      email: placeholderEmail(ADMIN.username),
      password,
      name: ADMIN.firstName,
      role: 'admin',
      data: { username: ADMIN.username, mustChangePassword: true },
    },
  });
  await withStaff(db, null, (tx) =>
    tx.insert(staffUsers).values({
      firstName: ADMIN.firstName,
      lastName: ADMIN.lastName,
      role: 'admin',
      propertyId: null, // all hotels
      authUserId: user.id,
    }),
  );

  console.log(`Created admin "${ADMIN.username}".`);
  if (!process.env.SEED_ADMIN_PASSWORD) console.log(`Temporary password: ${password}`);
  console.log('A new password must be chosen at the first sign-in.');
}

try {
  await seedReferenceData();
  await seedFirstAdmin();
} finally {
  await pool.end();
}
