import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { placeholderEmail, type Auth } from '../../auth/auth.js';
import { InjectAuth } from '../../auth/decorators.js';
import type { StaffRole } from '../../auth/permissions.js';
import type { SignedInStaff } from '../../auth/signed-in-staff.js';
import { joinUpdater, lastUpdated, updater } from '../../common/audit.js';
import { likePattern } from '../../common/sql.js';
import { InjectDb, type Database } from '../../db/drizzle.module.js';
import { authUsers, properties, staffUsers } from '../../db/schema/index.js';
import { withActingStaff } from '../../db/with-staff.js';
import type { CreateStaffUser, ListStaffUsers, UpdateStaffUser } from './staff-users.schemas.js';

// Better Auth only knows 'admin' and 'user'; the CRM role is on staff_users.
const authRole = (role: StaffRole) => (role === 'admin' ? 'admin' : 'user');
const fullName = (first: string, last: string | null | undefined) => [first, last].filter(Boolean).join(' ');

// Staff users are a staff_users row (the CRM record every *_by column points
// to) plus a Better Auth account (username, password, sessions, ban). The
// account calls go through auth.api with the admin's own request headers, so
// Better Auth's admin checks apply as well as ours.
@Injectable()
export class StaffUsersService {
  constructor(
    @InjectDb() private readonly db: Database,
    @InjectAuth() private readonly auth: Auth,
  ) {}

  async list(filter: ListStaffUsers) {
    const conditions: SQL[] = [isNull(staffUsers.deletedAt)];
    if (filter.q) {
      const pattern = likePattern(filter.q);
      conditions.push(
        or(
          ilike(sql`concat_ws(' ', ${staffUsers.firstName}, ${staffUsers.lastName})`, pattern),
          ilike(authUsers.username, pattern),
        )!,
      );
    }
    if (filter.role) conditions.push(eq(staffUsers.role, filter.role));
    if (filter.propertyId === 'all') conditions.push(isNull(staffUsers.propertyId));
    else if (filter.propertyId) conditions.push(eq(staffUsers.propertyId, filter.propertyId));

    return this.baseQuery()
      .where(and(...conditions))
      .orderBy(asc(staffUsers.firstName), asc(staffUsers.lastName));
  }

  async get(id: number) {
    const [row] = await this.baseQuery().where(and(eq(staffUsers.id, id), isNull(staffUsers.deletedAt)));
    if (!row) throw new NotFoundException('Staff user not found');
    return row;
  }

  async create(input: CreateStaffUser, headers: Headers) {
    await this.assertUsernameFree(input.username);
    const { user } = await this.auth.api.createUser({
      headers,
      body: {
        email: placeholderEmail(input.username),
        password: input.temporaryPassword,
        name: fullName(input.firstName, input.lastName),
        role: authRole(input.role),
        data: { username: input.username, mustChangePassword: true },
      },
    });
    try {
      const [row] = await withActingStaff(this.db, (tx) =>
        tx
          .insert(staffUsers)
          .values({
            firstName: input.firstName,
            lastName: input.lastName,
            email: input.email,
            role: input.role,
            propertyId: input.propertyId,
            authUserId: user.id,
          })
          .returning({ id: staffUsers.id }),
      );
      return this.get(row.id);
    } catch (err) {
      // don't leave a sign-in account without a staff user
      await this.auth.api.removeUser({ headers, body: { userId: user.id } });
      throw err;
    }
  }

  async update(id: number, input: UpdateStaffUser, headers: Headers, actor: SignedInStaff) {
    const current = await this.get(id);
    if (id === actor.id && input.role && input.role !== current.role) {
      throw new BadRequestException("You can't change your own role");
    }
    const usernameChanged = input.username !== undefined && input.username !== current.username;
    if (usernameChanged) await this.assertUsernameFree(input.username!);

    const { username: _, ...fields } = input;
    if (!Object.values(fields).some((v) => v !== undefined) && !usernameChanged) return current;

    await withActingStaff(this.db, async (tx) => {
      // the username lives on the auth account, but touch the row so
      // "Last updated by" reflects a username-only change too
      await tx
        .update(staffUsers)
        .set({ ...fields, firstName: fields.firstName ?? current.firstName })
        .where(eq(staffUsers.id, id));

      // inside the transaction, so a refused account change also undoes the row change
      const firstName = input.firstName ?? current.firstName;
      const lastName = input.lastName !== undefined ? input.lastName : current.lastName;
      await this.auth.api.adminUpdateUser({
        headers,
        body: {
          userId: current.authUserId!,
          data: {
            name: fullName(firstName, lastName),
            role: authRole(input.role ?? current.role),
            // only send the username when it changes: the username plugin treats
            // an unchanged one as taken when the admin edits someone else
            ...(usernameChanged ? { username: input.username, email: placeholderEmail(input.username!) } : {}),
          },
        },
      });
    });
    return this.get(id);
  }

  // Sets a new temporary password; the old one stops working at once and the
  // user must choose their own at the next sign-in.
  async resetPassword(id: number, temporaryPassword: string, headers: Headers) {
    const { authUserId } = await this.get(id);
    await this.auth.api.setUserPassword({ headers, body: { userId: authUserId!, newPassword: temporaryPassword } });
    await this.db
      .update(authUsers)
      .set({ mustChangePassword: true, updatedAt: new Date() })
      .where(eq(authUsers.id, authUserId!));
    await this.auth.api.revokeUserSessions({ headers, body: { userId: authUserId! } });
  }

  async signOutEverywhere(id: number, headers: Headers) {
    const { authUserId } = await this.get(id);
    await this.auth.api.revokeUserSessions({ headers, body: { userId: authUserId! } });
  }

  // Deactivated users are signed out everywhere and can't sign in, but their
  // name stays on everything they did.
  async setActive(id: number, active: boolean, headers: Headers, actor: SignedInStaff) {
    if (id === actor.id && !active) throw new BadRequestException("You can't deactivate yourself");
    const { authUserId } = await this.get(id);
    await withActingStaff(this.db, async (tx) => {
      await tx.update(staffUsers).set({ isActive: active }).where(eq(staffUsers.id, id));
      if (active) await this.auth.api.unbanUser({ headers, body: { userId: authUserId! } });
      else await this.auth.api.banUser({ headers, body: { userId: authUserId!, banReason: 'Deactivated' } });
    });
    return this.get(id);
  }

  private baseQuery() {
    return this.db
      .select({
        id: staffUsers.id,
        firstName: staffUsers.firstName,
        lastName: staffUsers.lastName,
        username: authUsers.username,
        email: staffUsers.email,
        role: staffUsers.role,
        propertyId: staffUsers.propertyId,
        propertyName: properties.name,
        isActive: staffUsers.isActive,
        mustChangePassword: authUsers.mustChangePassword,
        lastSignInAt: authUsers.lastSignInAt,
        authUserId: staffUsers.authUserId,
        lastUpdated: lastUpdated(staffUsers),
      })
      .from(staffUsers)
      .leftJoin(authUsers, eq(authUsers.id, staffUsers.authUserId))
      .leftJoin(properties, eq(properties.id, staffUsers.propertyId))
      .leftJoin(updater, joinUpdater(staffUsers))
      .$dynamic();
  }

  private async assertUsernameFree(username: string) {
    const [taken] = await this.db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.username, username.toLowerCase()));
    if (taken) throw new ConflictException('That username is already taken');
  }
}
