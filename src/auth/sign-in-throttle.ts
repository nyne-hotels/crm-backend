import { and, desc, eq, lt } from 'drizzle-orm';
import type { Database } from '../db/drizzle.module.js';
import { signInFailures } from '../db/schema/index.js';

const MAX_FAILURES = 5;
const WINDOW_MS = 60_000; // 5 failures within a minute …
const LOCK_MS = 5 * 60_000; // … locks the username for 5 minutes

// Slows down password guessing per username (Better Auth's own rate limit is per IP).
// While locked, attempts are refused before the password is checked, so they
// don't extend the lock.
export class SignInThrottle {
  constructor(private readonly db: Database) {}

  async isLocked(username: string): Promise<boolean> {
    const recent = await this.db
      .select({ failedAt: signInFailures.failedAt })
      .from(signInFailures)
      .where(eq(signInFailures.username, normalise(username)))
      .orderBy(desc(signInFailures.failedAt))
      .limit(MAX_FAILURES);
    if (recent.length < MAX_FAILURES) return false;
    const newest = recent[0].failedAt.getTime();
    const oldest = recent[MAX_FAILURES - 1].failedAt.getTime();
    return newest - oldest <= WINDOW_MS && Date.now() - newest < LOCK_MS;
  }

  async recordFailure(username: string) {
    const name = normalise(username);
    if (!name) return;
    await this.db.insert(signInFailures).values({ username: name });
    // keep the table small
    await this.db
      .delete(signInFailures)
      .where(and(eq(signInFailures.username, name), lt(signInFailures.failedAt, new Date(Date.now() - LOCK_MS * 2))));
  }

  async clear(username: string) {
    await this.db.delete(signInFailures).where(eq(signInFailures.username, normalise(username)));
  }
}

const normalise = (username: string) => username.trim().toLowerCase();
