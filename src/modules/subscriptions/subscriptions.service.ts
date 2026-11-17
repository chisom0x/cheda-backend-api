import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { Env } from '../../config/env';
import { paystackFee } from '../../common/money';
import type { SellerUser } from '../../common/auth/auth.decorator';
import {
  INTERVAL_MONTHS,
  isEntitled,
  isProType,
  PlanLimits,
  PLANS,
  PRO_TYPES,
  ProType,
} from '../../common/plans';
import type {
  BillingInterval,
  ProductStatus,
  ProductType,
  SubscriptionPlan,
  SubscriptionStatus,
} from '../../generated/prisma/client';
import {
  PaystackEvent,
  PaystackService,
  PaystackSubscription,
} from '../../integrations/paystack.service';
import { PrismaService } from '../../prisma/prisma.service';

const PRO_LABEL: Record<ProType, string> = {
  course: 'courses',
  media: 'audio/video products',
};
const NO_LIMITS: PlanLimits = { course: 0, media: 0 };
const INTERVAL_LABEL: Record<BillingInterval, string> = {
  monthly: 'monthly',
  quarterly: 'quarterly',
  annually: 'yearly',
};
const STATUS: Record<string, SubscriptionStatus> = {
  active: 'active',
  'non-renewing': 'non_renewing',
  attention: 'attention',
  completed: 'completed',
  complete: 'completed',
  cancelled: 'cancelled',
};
const RENEWING: SubscriptionStatus[] = ['active', 'attention'];
/** Paystack events that can change a seller's plan; each one re-reads the plan from Paystack. */
const PLAN_EVENTS = new Set([
  'charge.success',
  'subscription.create',
  'subscription.disable',
  'subscription.not_renew',
  'invoice.create',
  'invoice.update',
  'invoice.payment_failed',
]);

const str = (v: unknown) =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
const obj = (v: unknown): Record<string, unknown> => {
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
};
/** Paystack sends a plan as its code, or as an object holding it. */
const planCodeOf = (plan: unknown) => str(plan) || str(obj(plan).plan_code);

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly paystack: PaystackService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async summary(sellerId: string) {
    const [sub, usage] = await Promise.all([
      this.prisma.subscription.findUnique({ where: { sellerId } }),
      this.usage(sellerId),
    ]);
    const active = isEntitled(sub);
    return {
      plan: sub?.plan ?? null,
      interval: sub?.interval ?? null,
      status: sub?.status ?? null,
      active,
      currentPeriodEnd: sub?.currentPeriodEnd?.toISOString() ?? null,
      /** Paystack's page for changing the card or cancelling is available. */
      manageable: Boolean(sub?.paystackCode),
      limits: sub && active ? PLANS[sub.plan].limits : NO_LIMITS,
      usage,
    };
  }

  /**
   * Starts a Paystack card payment for the plan, which creates its subscription. Choosing another
   * plan or interval subscribes again; the old subscription is cancelled once the new one is active.
   */
  async checkout(
    user: SellerUser,
    plan: SubscriptionPlan,
    interval: BillingInterval,
  ) {
    const [sub, usage] = await Promise.all([
      this.prisma.subscription.findUnique({
        where: { sellerId: user.sellerId },
      }),
      this.usage(user.sellerId),
    ]);
    if (
      sub?.paystackCode &&
      sub.plan === plan &&
      sub.interval === interval &&
      RENEWING.includes(sub.status) &&
      isEntitled(sub)
    )
      throw new BadRequestException(
        sub.status === 'attention'
          ? 'Update your card from "Manage subscription" to keep this plan.'
          : `You're already on ${PLANS[plan].name}, billed ${INTERVAL_LABEL[interval]}.`,
      );
    for (const type of PRO_TYPES) {
      const over = usage[type] - PLANS[plan].limits[type];
      if (over > 0)
        throw new BadRequestException(
          `${PLANS[plan].name} includes ${PLANS[plan].limits[type]} published ${PRO_LABEL[type]}. Unpublish ${over} first, or choose a bigger plan.`,
        );
    }

    const planCode = await this.paystack.planCode({ plan, interval });
    const tx = await this.paystack.initializeSubscription({
      email: user.email,
      planCode,
      amountMinor: PLANS[plan].prices[interval],
      reference: `SUB_${randomUUID().replace(/-/g, '')}`,
      callbackUrl: `${this.config.get('FRONTEND_URL', { infer: true })}/dashboard/billing`,
      metadata: { sellerId: user.sellerId, plan, interval },
    });
    return { authorizationUrl: tx.authorization_url };
  }

  /** Called when Paystack sends the seller back, so the plan shows before the webhook lands. */
  async confirm(user: SellerUser, reference: string) {
    const tx = await this.paystack.verifyTransaction(reference);
    if (str(obj(tx.metadata).sellerId) !== user.sellerId)
      throw new NotFoundException("We couldn't find that payment.");
    if (tx.status === 'success') await this.applyCharge(user.sellerId, tx);
    return this.summary(user.sellerId);
  }

  /** A short-lived link to Paystack's page for updating the card or cancelling. */
  async manageLink(sellerId: string) {
    const sub = await this.prisma.subscription.findUnique({
      where: { sellerId },
    });
    if (!sub?.paystackCode)
      throw new BadRequestException("You don't have a subscription to manage.");
    return { url: await this.paystack.manageLink(sub.paystackCode) };
  }

  /** A verified Paystack webhook event. Throwing makes Paystack deliver it again. */
  async handleEvent(event: PaystackEvent) {
    const type = str(event.event);
    if (!type || !PLAN_EVENTS.has(type)) return;
    const data = obj(event.data);
    const customer = obj(data.customer);
    const sellerId = await this.findSeller(
      str(obj(data.metadata).sellerId),
      str(customer.id),
      str(customer.email),
    );
    if (!sellerId) return;
    if (type === 'charge.success') {
      await this.applyCharge(sellerId, data);
      return;
    }
    const customerId = str(customer.id);
    if (customerId) await this.sync(sellerId, customerId);
  }

  /** Drafts of Pro products need a plan too, so sellers never build something they can't sell. */
  async assertCanCreate(sellerId: string, type: ProductType) {
    if (!isProType(type)) return;
    const sub = await this.prisma.subscription.findUnique({
      where: { sellerId },
    });
    if (!isEntitled(sub))
      throw new ForbiddenException(
        `Selling ${PRO_LABEL[type]} needs a Pro or Premium plan.`,
      );
  }

  async assertCanPublish(
    sellerId: string,
    products: { type: ProductType; status: ProductStatus }[],
  ) {
    const adding = { course: 0, media: 0 };
    for (const p of products)
      if (isProType(p.type) && p.status !== 'published') adding[p.type]++;
    if (!adding.course && !adding.media) return;

    const { active, plan, limits, usage } = await this.summary(sellerId);
    const type = adding.course ? 'course' : 'media';
    if (!active || !plan)
      throw new ForbiddenException(
        `Publishing ${PRO_LABEL[type]} needs a Pro or Premium plan.`,
      );
    for (const t of PRO_TYPES) {
      if (adding[t] && usage[t] + adding[t] > limits[t])
        throw new ForbiddenException(
          `Your ${PLANS[plan].name} plan includes ${limits[t]} published ${PRO_LABEL[t]}. Upgrade or unpublish one first.`,
        );
    }
  }

  /** Records a successful plan charge (first payment or renewal), then re-reads the plan. */
  private async applyCharge(sellerId: string, tx: Record<string, unknown>) {
    const reference = str(tx.reference);
    const planCode = planCodeOf(tx.plan);
    const customerId = str(obj(tx.customer).id);
    if (!reference || !planCode || tx.status !== 'success') return;
    const key = await this.paystack.planFor(planCode);
    if (!key) return;
    if (tx.currency !== 'NGN' || typeof tx.amount !== 'number') return;
    await this.prisma.subscriptionPayment.createMany({
      data: {
        sellerId,
        ...key,
        amount: tx.amount,
        // Paystack reports what it charged; the published rate covers a payload without it
        providerFee:
          typeof tx.fees === 'number' ? tx.fees : paystackFee(tx.amount),
        reference,
        paidAt: new Date(str(tx.paid_at) ?? str(tx.paidAt) ?? Date.now()),
      },
      skipDuplicates: true,
    });
    if (customerId) await this.sync(sellerId, customerId);
  }

  /**
   * Mirrors the seller's Paystack subscriptions: the newest renewing one is their plan, and any
   * other renewing one (left from a plan switch) is cancelled. Reading Paystack's current state
   * makes duplicate and out-of-order webhooks harmless.
   */
  private async sync(sellerId: string, customerId: string) {
    await this.linkCustomer(sellerId, customerId);
    const subs: {
      sub: PaystackSubscription;
      status: SubscriptionStatus;
      plan: SubscriptionPlan;
      interval: BillingInterval;
    }[] = [];
    for (const sub of await this.paystack.customerSubscriptions(customerId)) {
      const status = STATUS[sub.status];
      const key = await this.paystack.planFor(planCodeOf(sub.plan) ?? '');
      if (status && key) subs.push({ sub, status, ...key });
    }
    const current = subs.find((s) => RENEWING.includes(s.status)) ?? subs[0];
    if (!current) return;

    if (RENEWING.includes(current.status))
      for (const old of subs)
        if (old !== current && RENEWING.includes(old.status))
          await this.paystack
            .disableSubscription(old.sub.subscription_code, old.sub.email_token)
            .catch((e: Error) =>
              this.logger.warn(
                `Could not cancel replaced subscription ${old.sub.subscription_code}: ${e.message}`,
              ),
            );

    const existing = await this.prisma.subscription.findUnique({
      where: { sellerId },
    });
    const data = {
      plan: current.plan,
      interval: current.interval,
      status: current.status,
      currentPeriodEnd: await this.periodEnd(sellerId, current, existing),
      paystackCode: current.sub.subscription_code,
      emailToken: current.sub.email_token,
    };
    await this.prisma.subscription.upsert({
      where: { sellerId },
      create: { sellerId, ...data },
      update: data,
    });
  }

  /** Paystack's next payment date; once cancelled it has none, so keep the end we knew. */
  private async periodEnd(
    sellerId: string,
    current: {
      sub: PaystackSubscription;
      plan: SubscriptionPlan;
      interval: BillingInterval;
    },
    existing: {
      paystackCode: string | null;
      currentPeriodEnd: Date | null;
    } | null,
  ) {
    if (current.sub.next_payment_date)
      return new Date(current.sub.next_payment_date);
    if (existing?.paystackCode === current.sub.subscription_code)
      return existing.currentPeriodEnd;
    const last = await this.prisma.subscriptionPayment.findFirst({
      where: { sellerId, plan: current.plan, interval: current.interval },
      orderBy: { paidAt: 'desc' },
    });
    if (!last) return null;
    const end = new Date(last.paidAt);
    end.setMonth(end.getMonth() + INTERVAL_MONTHS[current.interval]);
    return end;
  }

  /** The seller a Paystack payment belongs to: from our own metadata, else the customer. */
  private async findSeller(
    metadataSellerId: string | undefined,
    customerId: string | undefined,
    email: string | undefined,
  ) {
    if (metadataSellerId) {
      const seller = await this.prisma.seller.findUnique({
        where: { id: metadataSellerId },
        select: { id: true },
      });
      if (seller) return seller.id;
    }
    if (customerId) {
      const seller = await this.prisma.seller.findUnique({
        where: { paystackCustomerId: customerId },
        select: { id: true },
      });
      if (seller) return seller.id;
    }
    if (email) {
      const user = await this.prisma.user.findUnique({
        where: { email: email.toLowerCase() },
        select: { seller: { select: { id: true } } },
      });
      if (user?.seller) return user.seller.id;
    }
    return null;
  }

  private async linkCustomer(sellerId: string, customerId: string) {
    await this.prisma.seller.updateMany({
      where: { id: sellerId, paystackCustomerId: null },
      data: { paystackCustomerId: customerId },
    });
  }

  /** Published Pro products, which is what each plan's limits count. */
  private async usage(sellerId: string): Promise<PlanLimits> {
    const groups = await this.prisma.product.groupBy({
      by: ['type'],
      where: { sellerId, status: 'published', type: { in: [...PRO_TYPES] } },
      _count: { _all: true },
    });
    const usage = { ...NO_LIMITS };
    for (const g of groups)
      if (isProType(g.type)) usage[g.type] = g._count._all;
    return usage;
  }
}
