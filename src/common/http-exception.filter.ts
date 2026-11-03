import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { APIError } from 'better-auth/api';
import type { Response } from 'express';

// Turns errors into the API's JSON error shape { statusCode, message, code? }:
// Better Auth errors from server-side auth.api calls keep their status and message,
// and Postgres constraint errors become 409/400 instead of 500.
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      res
        .status(exception.getStatus())
        .json(typeof body === 'string' ? { statusCode: exception.getStatus(), message: body } : body);
      return;
    }

    if (exception instanceof APIError) {
      res.status(exception.statusCode).json({
        statusCode: exception.statusCode,
        message: exception.body?.message ?? exception.message,
        code: exception.body?.code,
      });
      return;
    }

    const pg = findPgError(exception);
    if (pg?.code === '23505') {
      const message = UNIQUE_MESSAGES[pg.constraint ?? ''] ?? 'That value is already in use';
      res.status(409).json({ statusCode: 409, message, constraint: pg.constraint });
      return;
    }
    if (pg?.code === '23514' || pg?.code === '23503' || pg?.code === '22P02') {
      res.status(400).json({ statusCode: 400, message: 'That value is not allowed', constraint: pg.constraint });
      return;
    }

    this.logger.error(exception);
    res.status(500).json({ statusCode: 500, message: 'Something went wrong' });
  }
}

// Friendly messages for unique indexes users can run into.
const UNIQUE_MESSAGES: Record<string, string> = {
  occasions_name_uq: 'An occasion with that name already exists',
  tags_name_uq: 'A tag with that name already exists',
  properties_name_uq: 'A hotel with that name already exists',
  staff_users_email_uq: 'Another staff user has that email',
  contact_methods_uq: 'This guest already has that email or phone',
  contact_methods_one_primary: 'Someone else just changed the primary. Reload and try again.',
  stays_booking_ref_uq: 'This hotel already has a stay with that booking reference',
  companies_name_uq: 'A company with that name already exists',
  feedback_one_per_stay: 'This stay already has a response',
  employee_mentions_once: 'That employee is already mentioned on this response',
  employees_staff_user_uq: 'That CRM login is already linked to another employee',
  campaigns_name_uq: 'A campaign with that name already exists',
};

interface PgError {
  code: string;
  constraint?: string;
}

// Drizzle wraps driver errors, so look through the cause chain.
function findPgError(err: unknown): PgError | undefined {
  for (let e = err as any, i = 0; e && i < 5; e = e.cause, i++) {
    if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e;
  }
  return undefined;
}
