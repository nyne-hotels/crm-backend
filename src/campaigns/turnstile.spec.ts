import { BadRequestException, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { TurnstileVerifier } from './turnstile.js';

const withSecret = (secret?: string) => new TurnstileVerifier({ get: () => secret } as unknown as ConfigService);
const answer = (body: unknown, status = 200) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe('the Turnstile bot check', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('checks nothing without a secret key', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(withSecret().verify(undefined, '1.2.3.4')).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a form without a token', async () => {
    await expect(withSecret('s').verify(undefined, '1.2.3.4')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sends the secret, token and address to Cloudflare and accepts a good token', async () => {
    const fetch = answer({ success: true });
    await expect(withSecret('s').verify('tok', '1.2.3.4')).resolves.toBeUndefined();
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ secret: 's', response: 'tok', remoteip: '1.2.3.4' });
  });

  it('refuses a token Cloudflare turns down', async () => {
    answer({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    await expect(withSecret('s').verify('tok', '1.2.3.4')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses rather than lets the form through when Cloudflare can’t be reached', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    await expect(withSecret('s').verify('tok', '1.2.3.4')).rejects.toBeInstanceOf(ServiceUnavailableException);
    answer({}, 500);
    await expect(withSecret('s').verify('tok', '1.2.3.4')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
