import type { Response } from 'express';

// Copies Set-Cookie headers from a server-side auth.api call onto the HTTP response.
export function forwardSetCookies(headers: Headers | null | undefined, res: Response) {
  const cookies = headers?.getSetCookie() ?? [];
  for (const cookie of cookies) res.append('Set-Cookie', cookie);
}
