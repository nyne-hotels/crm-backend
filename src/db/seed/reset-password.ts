// Recovery for when no admin can sign in (e.g. the only admin forgot their password):
//   npm run auth:reset-password -- <username>
// Sets a new temporary password, signs the user out everywhere and makes them
// choose a new password at the next sign-in. Everyone else asks an admin.
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { createAuth } from '../../auth/auth.js';
import * as schema from '../schema/index.js';
import { authUsers } from '../schema/index.js';

const username = process.argv[2]?.toLowerCase();
if (!username) {
  console.error('Usage: npm run auth:reset-password -- <username>');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema });

try {
  const [user] = await db.select().from(authUsers).where(eq(authUsers.username, username));
  if (!user) throw new Error(`No user "${username}"`);

  const auth = createAuth(db, {
    secret: process.env.BETTER_AUTH_SECRET!,
    baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
    trustedOrigins: [],
  });
  const ctx = await auth.$context;
  const password = randomBytes(12).toString('base64url');
  await ctx.internalAdapter.updatePassword(user.id, await ctx.password.hash(password));
  await ctx.internalAdapter.deleteUserSessions(user.id);
  await db.update(authUsers).set({ mustChangePassword: true, updatedAt: new Date() }).where(eq(authUsers.id, user.id));

  console.log(`Temporary password for "${username}": ${password}`);
  console.log('They must choose a new password at the next sign-in.');
} finally {
  await pool.end();
}
