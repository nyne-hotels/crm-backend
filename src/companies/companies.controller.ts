import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { asc, isNull, sql } from 'drizzle-orm';
import { RequireAccess } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import { companies } from '../db/schema/index.js';
import {
  addPersonSchema,
  companyNoteSchema,
  companyStaysSchema,
  createCompanySchema,
  listCompaniesSchema,
  updateCompanySchema,
  type AddPerson,
  type CompanyNote,
  type CompanyStays,
  type CreateCompany,
  type ListCompanies,
  type UpdateCompany,
} from './companies.schemas.js';
import { CompaniesService } from './companies.service.js';

// Companies (travel agents, DMCs, OTAs …) are part of the leads area: every
// role sees them, admin and management change them.
@Controller('companies')
@RequireAccess('leads', 'view')
export class CompaniesController {
  constructor(
    private readonly companies: CompaniesService,
    @InjectDb() private readonly db: Database,
  ) {}

  @Get()
  list(@Query(new ZodValidationPipe(listCompaniesSchema)) query: ListCompanies) {
    return this.companies.list(query);
  }

  // The pick-list for the stay's "Agent or OTA" and the contact's company:
  // every company not deleted, dormant ones included. Before :id.
  @Get('options')
  options() {
    return this.db
      .select({ id: companies.id, name: companies.name, companyType: companies.companyType })
      .from(companies)
      .where(isNull(companies.deletedAt))
      .orderBy(asc(sql`lower(${companies.name})`));
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.companies.get(id);
  }

  @Get(':id/people')
  people(@Param('id', ParseIntPipe) id: number) {
    return this.companies.people(id);
  }

  @Get(':id/stays')
  stays(@Param('id', ParseIntPipe) id: number, @Query(new ZodValidationPipe(companyStaysSchema)) query: CompanyStays) {
    return this.companies.stays(id, query);
  }

  @Get(':id/timeline')
  timeline(@Param('id', ParseIntPipe) id: number) {
    return this.companies.timeline(id);
  }

  @Post()
  @RequireAccess('leads', 'edit')
  create(@Body(new ZodValidationPipe(createCompanySchema)) body: CreateCompany) {
    return this.companies.create(body);
  }

  @Patch(':id')
  @RequireAccess('leads', 'edit')
  update(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(updateCompanySchema)) body: UpdateCompany) {
    return this.companies.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireAccess('leads', 'edit')
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.companies.remove(id);
  }

  // Bringing back a deleted company is for admins (Settings → Deleted items).
  @Post(':id/restore')
  @RequireAccess('settings', 'edit')
  restore(@Param('id', ParseIntPipe) id: number) {
    return this.companies.restore(id);
  }

  // returns the company's people
  @Post(':id/people')
  @RequireAccess('leads', 'edit')
  addPerson(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(addPersonSchema)) body: AddPerson) {
    return this.companies.addPerson(id, body);
  }

  @Delete(':id/people/:contactId')
  @RequireAccess('leads', 'edit')
  removePerson(@Param('id', ParseIntPipe) id: number, @Param('contactId', ParseIntPipe) contactId: number) {
    return this.companies.removePerson(id, contactId);
  }

  // returns the timeline with the new note
  @Post(':id/notes')
  @RequireAccess('leads', 'edit')
  addNote(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(companyNoteSchema)) body: CompanyNote) {
    return this.companies.addNote(id, body.body);
  }
}
