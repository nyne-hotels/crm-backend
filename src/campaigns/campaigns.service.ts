import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, inArray, isNull, like, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { joinUpdater, lastUpdated, updater } from '../common/audit.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import { campaigns, contacts, leads, OPEN_LEAD_STATUSES, staffUsers } from '../db/schema/index.js';
import { withActingStaff, type Transaction } from '../db/with-staff.js';
import { slugFor, uniqueSlug } from './campaign-rules.js';
import type { CreateCampaign, UpdateCampaign } from './campaigns.schemas.js';

const owner = alias(staffUsers, 'owner');

// Marketing → Campaigns. Each campaign has a public form (campaigns/) whose
// responses become leads for its owner; see CampaignFormService.
@Injectable()
export class CampaignsService {
  // where the campaign site runs; the first of CAMPAIGN_FORM_URL's addresses
  private readonly formUrl: string;

  constructor(
    @InjectDb() private readonly db: Database,
    config: ConfigService,
  ) {
    const urls = config.get<string>('CAMPAIGN_FORM_URL') ?? 'http://localhost:5174';
    this.formUrl = urls.split(',')[0].trim().replace(/\/+$/, '');
  }

  async list() {
    const rows = await this.baseQuery()
      .where(isNull(campaigns.deletedAt))
      .orderBy(desc(campaigns.isActive), desc(campaigns.createdAt), desc(campaigns.id));
    return rows.map((r) => this.withLink(r));
  }

  async get(id: number) {
    const [row] = await this.baseQuery().where(and(eq(campaigns.id, id), isNull(campaigns.deletedAt)));
    if (!row) throw new NotFoundException('Campaign not found');
    return this.withLink(row);
  }

  async create(input: CreateCampaign) {
    const id = await withActingStaff(this.db, async (tx) => {
      await assertOwner(tx, input.ownerId);
      const base = slugFor(input.name);
      const taken = await tx
        .select({ slug: campaigns.slug })
        .from(campaigns)
        // a slug is only letters, digits and dashes, so it has no LIKE wildcards to escape
        .where(or(eq(campaigns.slug, base), like(campaigns.slug, `${base}-%`)));
      const [row] = await tx
        .insert(campaigns)
        .values({
          name: input.name,
          slug: uniqueSlug(base, taken.map((t) => t.slug)),
          ownerId: input.ownerId,
        })
        .returning({ id: campaigns.id });
      return row.id;
    });
    return this.get(id);
  }

  async update(id: number, input: UpdateCampaign) {
    const current = await this.get(id);
    const changes = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    if (!Object.keys(changes).length) return current;
    await withActingStaff(this.db, async (tx) => {
      if (input.ownerId && input.ownerId !== current.owner.id) await assertOwner(tx, input.ownerId);
      if (input.slug && input.slug !== current.slug) await assertSlugFree(tx, input.slug, id);
      await tx.update(campaigns).set(changes).where(eq(campaigns.id, id));
    });
    return this.get(id);
  }

  private withLink<T extends { slug: string }>(row: T) {
    return { ...row, link: `${this.formUrl}/${row.slug}` };
  }

  private baseQuery() {
    // the campaign's leads, of guests not deleted
    const count = (where?: ReturnType<typeof sql>) => sql<number>`(select count(*)::int from ${leads} l
      join ${contacts} p on p.id = l.contact_id and p.deleted_at is null
      where l.campaign_id = ${campaigns.id} and l.deleted_at is null ${where ? sql`and ${where}` : sql``})`;
    return this.db
      .select({
        id: campaigns.id,
        name: campaigns.name,
        slug: campaigns.slug,
        isActive: campaigns.isActive,
        // isActive: false = they've left; their campaign still gives them leads until it's handed on
        owner: {
          id: owner.id,
          name: sql<string>`concat_ws(' ', ${owner.firstName}, ${owner.lastName})`,
          isActive: owner.isActive,
        },
        leads: count(),
        open: count(sql`l.status in (${sql.join(
          OPEN_LEAD_STATUSES.map((s) => sql`${s}`),
          sql`, `,
        )})`),
        booked: count(sql`l.status = 'booked'`),
        createdAt: campaigns.createdAt,
        lastUpdated: lastUpdated(campaigns),
      })
      .from(campaigns)
      .innerJoin(owner, eq(owner.id, campaigns.ownerId))
      .leftJoin(updater, joinUpdater(campaigns))
      .$dynamic();
  }
}

// A new link can't be one another campaign has, even a closed or deleted
// one: its emails may still be in inboxes (see uniqueSlug()).
async function assertSlugFree(tx: Transaction, slug: string, id: number) {
  const [taken] = await tx
    .select({ name: campaigns.name, deletedAt: campaigns.deletedAt })
    .from(campaigns)
    .where(and(eq(campaigns.slug, slug), ne(campaigns.id, id)));
  if (taken) {
    throw new ConflictException(
      taken.deletedAt ? 'A deleted campaign used that link. Choose another.' : `${taken.name} already uses that link`,
    );
  }
}

// Leads need an active admin or management owner, as in the leads module.
async function assertOwner(tx: Transaction, ownerId: number) {
  const [row] = await tx
    .select({ id: staffUsers.id })
    .from(staffUsers)
    .where(
      and(
        eq(staffUsers.id, ownerId),
        eq(staffUsers.isActive, true),
        inArray(staffUsers.role, ['admin', 'management']),
        isNull(staffUsers.deletedAt),
      ),
    );
  if (!row) throw new BadRequestException('Choose an active admin or management user as the owner');
}
