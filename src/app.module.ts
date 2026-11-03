import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { CampaignsModule } from './campaigns/campaigns.module.js';
import { CompaniesModule } from './companies/companies.module.js';
import { ContactImportsModule } from './contact-imports/contact-imports.module.js';
import { ConsentModule } from './consent/consent.module.js';
import { DrizzleModule } from './db/drizzle.module.js';
import { DuplicatesModule } from './duplicates/duplicates.module.js';
import { FeedbackModule } from './feedback/feedback.module.js';
import { GuestsModule } from './guests/guests.module.js';
import { HealthController } from './health/health.controller.js';
import { KnowledgeModule } from './knowledge/knowledge.module.js';
import { LeadsModule } from './leads/leads.module.js';
import { ReferenceController } from './reference/reference.controller.js';
import { SettingsModule } from './settings/settings.module.js';
import { StaysModule } from './stays/stays.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DrizzleModule,
    AuthModule,
    SettingsModule,
    GuestsModule,
    StaysModule,
    KnowledgeModule,
    ConsentModule,
    DuplicatesModule,
    LeadsModule,
    CompaniesModule,
    FeedbackModule,
    ContactImportsModule,
    CampaignsModule,
  ],
  controllers: [AppController, HealthController, ReferenceController],
  providers: [AppService],
})
export class AppModule {}
