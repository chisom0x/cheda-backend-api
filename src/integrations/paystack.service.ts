import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';
import { PLANS } from '../common/plans';
import { hmac, safeEqual } from '../common/tokens';
import type {
  BillingInterval,
  SubscriptionPlan,
} from '../generated/prisma/client';

const BASE_URL = 'https://api.paystack.co';
const BANKS_TTL_MS = 86_400_000;

type Envelope<T> = { status: boolean; message: string; data: T; meta?: Meta };
type Meta = { page?: number; pageCount?: number };

type PaystackPlan = {
  plan_code: string;
  name: string;
  amount: number;
  interval: string;
  currency: string;
};

export type PaystackCustomer = {
  id: number;
  customer_code: string;
  email: string;
};

export type PaystackSubscription = {
  id: number;
  subscription_code: string;
  email_token: string;
  status: string;
  next_payment_date: string | null;
  createdAt: string;
  plan: { plan_code: string };
};

export type PaystackTransaction = {
  reference: string;
  status: string;
  amount: number;
  currency: string;
  paid_at: string | null;
  customer: PaystackCustomer;
  plan?: unknown;
  metadata?: unknown;
};

export type PaystackBank = { code: string; name: string };

/** A webhook body. Only its signature is trusted, so handlers check every field they read. */
export type PaystackEvent = { event?: unknown; data?: Record<string, unknown> };

export type PlanKey = { plan: SubscriptionPlan; interval: BillingInterval };

/** The Paystack plan for each Cheda plan and interval is named this; its amount tracks PLANS. */
const planName = ({ plan, interval }: PlanKey) =>
  `Cheda ${PLANS[plan].name} (${interval})`;

@Injectable()
export class PaystackService {
  private readonly logger = new Logger(PaystackService.name);
  private plans: Promise<PaystackPlan[]> | null = null;
  private banks: { at: number; value: Promise<PaystackBank[]> } | null = null;

  constructor(private readonly config: ConfigService<Env, true>) {}

  /** Starts a card payment that, because it names a plan, also creates the subscription. */
  initializeSubscription(input: {
    email: string;
    planCode: string;
    amountMinor: number;
    reference: string;
    callbackUrl: string;
    metadata: Record<string, string>;
  }) {
    return this.request<{ authorization_url: string; reference: string }>(
      'POST',
      '/transaction/initialize',
      {
        email: input.email,
        amount: input.amountMinor,
        currency: 'NGN',
        plan: input.planCode,
        reference: input.reference,
        callback_url: input.callbackUrl,
        channels: ['card'],
        metadata: input.metadata,
      },
    );
  }

  verifyTransaction(reference: string) {
    return this.request<PaystackTransaction>(
      'GET',
      `/transaction/verify/${encodeURIComponent(reference)}`,
    );
  }

  /** Every subscription a customer has had, newest first. */
  async customerSubscriptions(customerId: string) {
    const subs = await this.request<PaystackSubscription[]>(
      'GET',
      `/subscription?${new URLSearchParams({ customer: customerId, perPage: '100' })}`,
    );
    return subs.sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
  }

  disableSubscription(code: string, token: string) {
    return this.request<unknown>('POST', '/subscription/disable', {
      code,
      token,
    });
  }

  /** Paystack's hosted page for updating the card or cancelling. */
  async manageLink(code: string) {
    const { link } = await this.request<{ link: string }>(
      'GET',
      `/subscription/${encodeURIComponent(code)}/manage/link`,
    );
    return link;
  }

  /** The Paystack plan for a Cheda plan and interval at today's price, created on first use. */
  async planCode(key: PlanKey) {
    const amount = PLANS[key.plan].prices[key.interval];
    const name = planName(key);
    const match = (p: PaystackPlan) =>
      p.name === name &&
      p.amount === amount &&
      p.interval === key.interval &&
      p.currency === 'NGN';
    const found = (await this.allPlans()).find(match);
    if (found) return found.plan_code;
    const created = await this.request<PaystackPlan>('POST', '/plan', {
      name,
      amount,
      interval: key.interval,
      currency: 'NGN',
    });
    this.plans = null;
    return created.plan_code;
  }

  /** Which Cheda plan a Paystack plan code bills, including plans at an older price. */
  async planFor(planCode: string): Promise<PlanKey | null> {
    const plans = await this.allPlans();
    let found = plans.find((p) => p.plan_code === planCode);
    if (!found) {
      this.plans = null;
      found = (await this.allPlans()).find((p) => p.plan_code === planCode);
    }
    if (!found) return null;
    for (const plan of Object.keys(PLANS) as SubscriptionPlan[])
      for (const interval of Object.keys(
        PLANS[plan].prices,
      ) as BillingInterval[])
        if (found.name === planName({ plan, interval }))
          return { plan, interval };
    return null;
  }

  async resolveAccount(accountNumber: string, bankCode: string) {
    const { account_name } = await this.request<{ account_name: string }>(
      'GET',
      `/bank/resolve?${new URLSearchParams({ account_number: accountNumber, bank_code: bankCode })}`,
    );
    return account_name;
  }

  /** Nigerian banks Paystack can verify accounts at. */
  listBanks() {
    if (this.banks && Date.now() - this.banks.at < BANKS_TTL_MS)
      return this.banks.value;
    const value = this.request<
      { code: string; name: string; active: boolean }[]
    >('GET', '/bank?country=nigeria&perPage=100', undefined, true).then(
      (banks) => {
        const byCode = new Map(
          banks.filter((b) => b.active).map((b) => [b.code, b.name.trim()]),
        );
        return [...byCode]
          .map(([code, name]) => ({ code, name }))
          .sort((a, b) => a.name.localeCompare(b.name));
      },
    );
    this.banks = { at: Date.now(), value };
    value.catch(() => (this.banks = null));
    return value;
  }

  /** Paystack signs the raw body with HMAC-SHA512 of the secret key. */
  isValidSignature(rawBody: Buffer, signature: string | undefined) {
    const secret = this.config.get('PAYSTACK_SECRET_KEY', { infer: true });
    return Boolean(
      secret &&
      signature &&
      safeEqual(hmac(secret, rawBody.toString('utf8'), 'sha512'), signature),
    );
  }

  private allPlans() {
    if (!this.plans) {
      this.plans = this.request<PaystackPlan[]>(
        'GET',
        '/plan?perPage=100',
        undefined,
        true,
      );
      this.plans.catch(() => (this.plans = null));
    }
    return this.plans;
  }

  /** `paginate` follows every page of a list endpoint. */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    paginate = false,
  ): Promise<T> {
    if (!paginate) return (await this.send<T>(method, path, body)).data;
    const items: unknown[] = [];
    for (let page = 1; ; page++) {
      const res = await this.send<unknown[]>(
        method,
        `${path}${path.includes('?') ? '&' : '?'}page=${page}`,
      );
      items.push(...res.data);
      const pageCount = res.meta?.pageCount ?? 1;
      if (page >= pageCount || !res.data.length) break;
    }
    return items as T;
  }

  private async send<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Envelope<T>> {
    const secret = this.config.get('PAYSTACK_SECRET_KEY', { infer: true });
    if (!secret)
      throw new ServiceUnavailableException('Billing is not configured.');
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method,
        signal: AbortSignal.timeout(20_000),
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      this.logger.warn(
        `Paystack ${method} ${path.split('?')[0]} unreachable: ${(e as Error).message}`,
      );
      throw new BadGatewayException(
        'The payment provider is unavailable. Please try again.',
      );
    }
    const json = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (!res.ok || !json?.status) {
      this.logger.warn(
        `Paystack ${method} ${path.split('?')[0]} failed: ${res.status} ${json?.message ?? ''}`,
      );
      throw new BadGatewayException(
        json?.message ||
          'The payment provider is unavailable. Please try again.',
      );
    }
    return json;
  }
}
