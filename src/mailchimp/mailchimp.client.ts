import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// ---------------------------------------------------------------------
// Mailchimp's Marketing API (https://<dc>.api.mailchimp.com/3.0), read only.
// The key is MAILCHIMP_API_KEY in the API's .env; its end ("…-us3") names the
// data centre. Keys stop working a year after they're made, so a rejected key
// is reported as its own error (mailchimp_key_rejected) for the app to explain.
//
// Answers are kept for a few minutes: a report changes slowly, and Mailchimp
// allows only 10 requests at once per account. Two people opening the same
// report at once share one request.
// ---------------------------------------------------------------------
export type MailchimpProblem =
  | 'mailchimp_not_configured' // no key in .env
  | 'mailchimp_key_rejected' // expired, revoked or mistyped
  | 'mailchimp_not_found' // e.g. an email deleted in Mailchimp
  | 'mailchimp_busy' // too many requests
  | 'mailchimp_unavailable'; // can't be reached, or answered with an error

const MESSAGES: Record<MailchimpProblem, string> = {
  mailchimp_not_configured: 'Mailchimp isn’t connected: the API has no MAILCHIMP_API_KEY.',
  mailchimp_key_rejected:
    'Mailchimp didn’t accept the CRM’s API key. Keys expire a year after they’re created, so it has probably expired.',
  mailchimp_not_found: 'Mailchimp no longer has this email. It may have been deleted there.',
  mailchimp_busy: 'Mailchimp is busy. Try again in a minute.',
  mailchimp_unavailable: 'Couldn’t reach Mailchimp. Try again in a few minutes.',
};

const STATUS: Record<MailchimpProblem, HttpStatus> = {
  mailchimp_not_configured: HttpStatus.SERVICE_UNAVAILABLE,
  mailchimp_key_rejected: HttpStatus.SERVICE_UNAVAILABLE,
  mailchimp_not_found: HttpStatus.NOT_FOUND,
  mailchimp_busy: HttpStatus.SERVICE_UNAVAILABLE,
  mailchimp_unavailable: HttpStatus.SERVICE_UNAVAILABLE,
};

// The API's usual error shape, with the problem as `code` for the app.
export class MailchimpError extends HttpException {
  constructor(readonly problem: MailchimpProblem) {
    super({ statusCode: STATUS[problem], message: MESSAGES[problem], code: problem }, STATUS[problem]);
  }
}

// Which problem an answer from Mailchimp is. 401 and 403 both mean the key:
// Mailchimp says "API Key Invalid" for an expired one too.
export function problemFor(status: number): MailchimpProblem {
  if (status === 401 || status === 403) return 'mailchimp_key_rejected';
  if (status === 404) return 'mailchimp_not_found';
  if (status === 429) return 'mailchimp_busy';
  return 'mailchimp_unavailable';
}

// "abc123…-us3" → "us3"; null when the key doesn't end in a data centre
export function dataCentreOf(key: string): string | null {
  return /-([a-z]{2,4}\d{1,3})$/.exec(key)?.[1] ?? null;
}

const CACHE_MS = 5 * 60_000;
const REFRESH_MIN_MS = 30_000; // a Refresh within 30 seconds of the last fetch reuses it
const TIMEOUT_MS = 20_000;
const MAX_CACHED = 500;

@Injectable()
export class MailchimpClient {
  private readonly logger = new Logger(MailchimpClient.name);
  private readonly key: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(config: ConfigService) {
    this.key = config.get<string>('MAILCHIMP_API_KEY')?.trim() || undefined;
    const dc = this.key && dataCentreOf(this.key);
    this.baseUrl = dc ? `https://${dc}.api.mailchimp.com/3.0` : undefined;
    if (!this.key) this.logger.warn('MAILCHIMP_API_KEY is not set: campaign reports are off');
    else if (!dc) this.logger.error('MAILCHIMP_API_KEY doesn’t end in a data centre (e.g. -us3), so Mailchimp can’t be called');
  }

  get configured() {
    return !!this.key;
  }

  // GET a path, e.g. '/reports/d610b94234'. `fresh` skips the kept answer
  // (the Refresh button), unless it was fetched in the last 30 seconds.
  // `noCache` always asks Mailchimp and keeps nothing (the sync).
  async get<T>(
    path: string,
    query: Record<string, string | number> = {},
    { fresh = false, noCache = false } = {},
  ): Promise<T> {
    if (!this.key) throw new MailchimpError('mailchimp_not_configured');
    if (!this.baseUrl) throw new MailchimpError('mailchimp_key_rejected');
    const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;

    if (noCache) return this.fetch<T>(url, path, false);
    const kept = this.cache.get(url);
    const age = kept ? Date.now() - kept.at : Infinity;
    if (kept && age < (fresh ? REFRESH_MIN_MS : CACHE_MS)) return kept.value as T;
    const pending = this.inFlight.get(url);
    if (pending) return pending as Promise<T>;

    const request = this.fetch<T>(url, path).finally(() => this.inFlight.delete(url));
    this.inFlight.set(url, request);
    return request;
  }

  private async fetch<T>(url: string, path: string, keep = true): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Basic ${Buffer.from(`nyne-crm:${this.key}`).toString('base64')}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.error(`Mailchimp ${path}: ${err instanceof Error ? err.message : err}`);
      throw new MailchimpError('mailchimp_unavailable');
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { title?: string; detail?: string } | null;
      const problem = problemFor(res.status);
      const log = `Mailchimp ${path} answered ${res.status}: ${body?.title ?? ''} ${body?.detail ?? ''}`.trim();
      if (problem === 'mailchimp_not_found') this.logger.warn(log);
      else this.logger.error(log);
      throw new MailchimpError(problem);
    }
    const value = (await res.json()) as T;
    if (!keep) return value;
    if (this.cache.size >= MAX_CACHED) this.forgetOld();
    this.cache.set(url, { at: Date.now(), value });
    return value;
  }

  private forgetOld() {
    const now = Date.now();
    for (const [url, { at }] of this.cache) if (now - at >= CACHE_MS) this.cache.delete(url);
    // still full: drop the oldest half
    if (this.cache.size >= MAX_CACHED) [...this.cache.keys()].slice(0, MAX_CACHED / 2).forEach((u) => this.cache.delete(u));
  }
}
