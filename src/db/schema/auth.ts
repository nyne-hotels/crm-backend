import { boolean, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// =====================================================================
// SIGN-IN ACCOUNTS – Better Auth's own tables (user, session, account,
// verification), plus the plugin columns for username and admin.
// They are not CRM records, so they have no audit columns or triggers.
// Each staff user links to one auth user through staff_users.auth_user_id.
// Property names must match Better Auth's field names.
// =====================================================================
const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const authUsers = pgTable('auth_users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  // Better Auth needs a unique email; staff sign in by username, so this is a
  // placeholder derived from it. The real (optional) email is staff_users.email.
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  // username plugin – stored lower-case
  username: text('username').unique(),
  displayUsername: text('display_username'),
  // admin plugin – 'admin' or 'user'; the CRM role itself is staff_users.role
  role: text('role'),
  banned: boolean('banned').default(false),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires', { withTimezone: true }),
  // set when an admin sets a temporary password; cleared when the user picks their own
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true }),
  ...timestamps(),
});

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    impersonatedBy: text('impersonated_by'),
    ...timestamps(),
  },
  (t) => [index('auth_sessions_user_idx').on(t.userId)],
);

export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    ...timestamps(),
  },
  (t) => [index('auth_accounts_user_idx').on(t.userId)],
);

export const authVerifications = pgTable(
  'auth_verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (t) => [index('auth_verifications_identifier_idx').on(t.identifier)],
);

// Wrong sign-in attempts per username, for slowing down password guessing.
// Rows are cleared on a successful sign-in.
export const signInFailures = pgTable(
  'auth_sign_in_failures',
  {
    username: text('username').notNull(),
    failedAt: timestamp('failed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('auth_sign_in_failures_idx').on(t.username, t.failedAt)],
);
