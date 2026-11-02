import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { DRIZZLE, type Database } from '../db/drizzle.module.js';
import { createAuth } from './auth.js';
import { AuthGuard } from './auth.guard.js';
import { AUTH } from './decorators.js';
import { MeController } from './me.controller.js';

// Better Auth itself is mounted on /api/auth/* in main.ts (it needs the raw
// request body). This module provides the instance and the global AuthGuard.
@Global()
@Module({
  controllers: [MeController],
  providers: [
    {
      provide: AUTH,
      inject: [DRIZZLE, ConfigService],
      useFactory: (db: Database, config: ConfigService) =>
        createAuth(db, {
          secret: config.getOrThrow<string>('BETTER_AUTH_SECRET'),
          baseURL: config.get<string>('BETTER_AUTH_URL') ?? 'http://localhost:3000',
          trustedOrigins: (config.get<string>('FRONTEND_URL') ?? 'http://localhost:5173')
            .split(',')
            .map((o) => o.trim()),
        }),
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AUTH],
})
export class AuthModule {}
