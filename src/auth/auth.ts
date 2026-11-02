import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { admin, username } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/drizzle.module.js';
import { authAccounts, authSessions, authUsers, authVerifications } from '../db/schema/index.js';
import { SignInThrottle } from './sign-in-throttle.js';

export interface AuthConfig {
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
}

export const USERNAME_PATTERN = /^[a-z0-9]+(\.[a-z0-9]+)*$/i; // letters and numbers, dots between
export const MIN_PASSWORD_LENGTH = 10;
export const INVALID_CREDENTIALS = 'Username or password is incorrect';
export const INACTIVE_ACCOUNT = 'Your account is inactive. Ask an admin.';

// Better Auth needs a unique email per user. Staff sign in by username, so the
// auth email is a placeholder; the real, optional email lives on staff_users.
export const placeholderEmail = (name: string) => `${name.toLowerCase()}@staff.nyne-crm.invalid`;

const SESSION_IDLE_TIMEOUT = 60 * 60 * 12; // seconds: 12 hours without activity ends a session

export function createAuth(db: Database, config: AuthConfig) {
  const throttle = new SignInThrottle(db);

  return betterAuth({
    secret: config.secret,
    baseURL: config.baseURL,
    basePath: '/api/auth',
    trustedOrigins: config.trustedOrigins,
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true, // only admins create accounts
      minPasswordLength: MIN_PASSWORD_LENGTH,
    },
    session: {
      // expiresAt is pushed forward on use (at most every 15 minutes), so a
      // session ends after 12 hours without activity.
      expiresIn: SESSION_IDLE_TIMEOUT,
      updateAge: 60 * 15,
    },
    user: {
      additionalFields: {
        mustChangePassword: { type: 'boolean', defaultValue: false, input: false },
        lastSignInAt: { type: 'date', required: false, input: false },
      },
    },
    // Everything except username sign-in, sign-out and reading the session is
    // done through the NestJS API, which checks roles and keeps staff_users in step.
    // These still work as server-side auth.api calls; only HTTP access is closed.
    disabledPaths: [
      '/sign-up/email',
      '/sign-in/email',
      '/sign-in/social',
      '/request-password-reset',
      '/reset-password',
      '/change-password',
      '/change-email',
      '/update-user',
      '/delete-user',
      '/set-password',
      '/link-social',
      '/unlink-account',
      '/is-username-available',
      ...[
        'set-role',
        'get-user',
        'create-user',
        'update-user',
        'list-users',
        'list-user-sessions',
        'unban-user',
        'ban-user',
        'impersonate-user',
        'stop-impersonating',
        'revoke-user-session',
        'revoke-user-sessions',
        'remove-user',
        'set-user-password',
        'has-permission',
      ].map((p) => `/admin/${p}`),
    ],
    plugins: [
      username({
        minUsernameLength: 3,
        maxUsernameLength: 30,
        usernameValidator: (name) => USERNAME_PATTERN.test(name),
      }),
      // Deactivating a staff user bans their account, which ends every session
      // and blocks sign-in with this message.
      admin({ bannedUserMessage: INACTIVE_ACCOUNT }),
    ],
    databaseHooks: {
      session: {
        create: {
          after: async (session, ctx) => {
            if (ctx?.path !== '/sign-in/username') return;
            await db
              .update(authUsers)
              .set({ lastSignInAt: new Date() })
              .where(eq(authUsers.id, session.userId));
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-in/username') return;
        const name = String(ctx.body?.username ?? '');
        if (await throttle.isLocked(name)) {
          throw new APIError('TOO_MANY_REQUESTS', {
            message: 'Too many wrong attempts. Wait a few minutes and try again.',
            code: 'TOO_MANY_ATTEMPTS',
          });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-in/username') return;
        const name = String(ctx.body?.username ?? '');
        const returned = ctx.context.returned;
        if (returned instanceof APIError) {
          if (returned.status === 'UNAUTHORIZED') await throttle.recordFailure(name);
          return;
        }
        await throttle.clear(name);
      }),
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
