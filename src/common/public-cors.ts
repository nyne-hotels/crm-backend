import type { NextFunction, Request, Response } from 'express';

// CORS for /api/public: browsers on these addresses (comma-separated, as in
// CAMPAIGN_FORM_URL) may call it. No cookies are sent or accepted, so the
// rest of the API stays same-origin only.
export function publicCors(origins: string) {
  const allowed = new Set(origins.split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean));
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}
