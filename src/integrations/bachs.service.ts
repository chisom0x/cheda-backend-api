import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Bachs,
  BachsApiError,
  BachsError,
  webhooks,
  type CreateCheckoutSessionRequest,
  type WebhookEvent,
} from '@bachs/sdk';
import type { Env } from '../config/env';

export type { WebhookEvent as BachsEvent } from '@bachs/sdk';
export { BachsWebhookError } from '@bachs/sdk';

/** A write Bachs may or may not have applied; reconcile before trying again. */
export class BachsOutcomeUnknown extends BadGatewayException {}

/** Kobo to the decimal string Bachs expects, e.g. 150000 -> "1500.00". */
export const toDecimal = (minor: number) =>
  `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;

/** A Bachs decimal string to kobo without floating point, or null if it isn't one. */
export function toMinor(amount: unknown): number | null {
  if (typeof amount !== 'string') return null;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

@Injectable()
export class BachsService {
  private readonly logger = new Logger(BachsService.name);
  private client: Bachs | null = null;

  constructor(private readonly config: ConfigService<Env, true>) {}

  /** `idempotencyKey` must be stored with the order, so a retry repeats the same write. */
  async createCheckout(
    input: CreateCheckoutSessionRequest,
    idempotencyKey: string,
  ) {
    try {
      return await this.bachs().checkoutSessions.create(input, {
        idempotencyKey,
      });
    } catch (e) {
      throw this.translate(e, 'create a checkout');
    }
  }

  async getCheckout(checkoutId: string) {
    try {
      return await this.bachs().checkoutSessions.get(checkoutId);
    } catch (e) {
      throw this.translate(e, 'retrieve a checkout');
    }
  }

  /** Verifies X-Bachs-Signature-V2 (timestamp and every v1 digest) on the raw body. */
  constructEvent(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent {
    const secret = this.config.get('BACHS_WEBHOOK_SECRET', { infer: true });
    if (!secret)
      throw new ServiceUnavailableException(
        'Bachs webhooks are not configured.',
      );
    return webhooks.constructEvent(new Uint8Array(rawBody), headers, secret);
  }

  private bachs() {
    if (this.client) return this.client;
    const apiKey = this.config.get('BACHS_SECRET_KEY', { infer: true });
    if (!apiKey)
      throw new ServiceUnavailableException('Payments are not configured.');
    const log = this.logger;
    this.client = new Bachs({
      apiKey,
      logger: {
        debug: (m) => log.debug(m),
        info: (m) => log.log(m),
        warn: (m) => log.warn(m),
        error: (m) => log.error(m),
      },
    });
    return this.client;
  }

  /** Logs the status and error code only: provider bodies can hold buyer details. */
  private translate(e: unknown, action: string) {
    if (!(e instanceof BachsError)) return e;
    const status = e instanceof BachsApiError ? e.statusCode : undefined;
    const code = e instanceof BachsApiError ? e.errorCode : undefined;
    const unknown = Boolean((e as { outcomeUnknown?: boolean }).outcomeUnknown);
    this.logger.warn(
      `Bachs could not ${action}: ${e.name} ${status ?? ''} ${code ?? ''}${unknown ? ' (outcome unknown)' : ''}`,
    );
    const message = 'The payment provider is unavailable. Please try again.';
    return unknown
      ? new BachsOutcomeUnknown(message)
      : new BadGatewayException(message);
  }
}
