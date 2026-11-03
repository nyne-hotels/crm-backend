import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Cloudflare Turnstile, the bot check on the campaign form: the form sends the
// token its widget got (campaigns/src/Turnstile.tsx) and this asks Cloudflare
// whether it's good. Each token works once and for five minutes.
//
// Without TURNSTILE_SECRET_KEY nothing is checked, so the API runs locally
// and in tests without Cloudflare keys; set it wherever the form is public.
@Injectable()
export class TurnstileVerifier {
  private readonly logger = new Logger(TurnstileVerifier.name);
  private readonly secret: string | undefined;

  constructor(config: ConfigService) {
    this.secret = config.get<string>('TURNSTILE_SECRET_KEY') || undefined;
    if (!this.secret) this.logger.warn('TURNSTILE_SECRET_KEY is not set: campaign forms are not checked for bots');
  }

  async verify(token: string | undefined, ip: string): Promise<void> {
    if (!this.secret) return;
    if (!token) throw new BadRequestException("We couldn't check your browser. Please refresh the page and try again.");

    let result: { success: boolean; 'error-codes'?: string[] };
    try {
      const res = await fetch(SITEVERIFY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: this.secret, response: token, remoteip: ip }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`siteverify answered ${res.status}`);
      result = await res.json();
    } catch (err) {
      // Cloudflare can't be reached: refuse rather than let the form through unchecked
      this.logger.error(`Turnstile check failed: ${err instanceof Error ? err.message : err}`);
      throw new ServiceUnavailableException("We couldn't send your details just now. Please try again in a moment.");
    }
    if (!result.success) {
      // a bad secret is our mistake, not the guest's
      if (result['error-codes']?.some((c) => c.includes('secret'))) {
        this.logger.error(`Turnstile rejected the secret key: ${result['error-codes'].join(', ')}`);
      }
      throw new BadRequestException("We couldn't confirm you're not a robot. Please try again.");
    }
  }
}
