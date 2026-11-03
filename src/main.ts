import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { toNodeHandler } from 'better-auth/node';
import express from 'express';
import { AppModule } from './app.module.js';
import type { Auth } from './auth/auth.js';
import { AUTH } from './auth/decorators.js';
import { HttpExceptionFilter } from './common/http-exception.filter.js';
import { publicCors } from './common/public-cors.js';
import { requestContextMiddleware } from './db/request-context.js';

async function bootstrap() {
  // Body parsing is added below, after Better Auth, which reads the raw body itself.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.setGlobalPrefix('api');
  app.set('trust proxy', 'loopback');
  app.enableShutdownHooks();

  app.use(requestContextMiddleware);
  // a campaign's form (campaigns/) runs on its own address and calls /api/public without signing in
  app.use('/api/public', publicCors(process.env.CAMPAIGN_FORM_URL ?? 'http://localhost:5174'));
  // Sign-in, sign-out and session: /api/auth/sign-in/username, /api/auth/sign-out, /api/auth/get-session
  app.use('/api/auth', toNodeHandler(app.get<Auth>(AUTH)));
  // a booking file of up to 5,000 rows is sent as JSON
  app.use('/api/stays/imports', express.json({ limit: '15mb' }));
  // a contact list of up to 10,000 rows, with the admin's choices
  app.use('/api/settings/contact-imports', express.json({ limit: '30mb' }));
  // an unsubscribe or bounce list of up to 50,000 emails
  app.use('/api/marketing/uploads', express.json({ limit: '5mb' }));
  app.use(express.json({ limit: '1mb' }));

  app.useGlobalFilters(new HttpExceptionFilter());
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
