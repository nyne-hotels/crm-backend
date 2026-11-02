import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

// Per-request state that the database layer needs without every service
// passing it around: the signed-in staff member, set by the AuthGuard.
interface RequestContext {
  staffId: number | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

// Express middleware – must run before anything that reads the context.
export function requestContextMiddleware(_req: Request, _res: Response, next: NextFunction) {
  storage.run({ staffId: null }, next);
}

export function setActingStaff(staffId: number) {
  const ctx = storage.getStore();
  if (ctx) ctx.staffId = staffId;
}

// The staff member making the current request, or null outside a signed-in
// request (imports, jobs, the seed script) – those changes show as "System".
export function actingStaffId(): number | null {
  return storage.getStore()?.staffId ?? null;
}
