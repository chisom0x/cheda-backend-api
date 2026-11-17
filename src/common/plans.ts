import type {
  BillingInterval,
  Prisma,
  ProductType,
  Subscription,
  SubscriptionPlan,
  SubscriptionStatus,
} from '../generated/prisma/client';

/** Product types that need a paid plan to create, publish and sell. */
export const PRO_TYPES = ['course', 'media'] as const satisfies ProductType[];
export type ProType = (typeof PRO_TYPES)[number];

export const isProType = (type: ProductType): type is ProType =>
  (PRO_TYPES as readonly ProductType[]).includes(type);

export type PlanLimits = Record<ProType, number>;

export const INTERVAL_MONTHS: Record<BillingInterval, number> = {
  monthly: 1,
  quarterly: 3,
  annually: 12,
};

/** Monthly costs more per month than quarterly; annually is four quarters less 10%. */
export const PLANS: Record<
  SubscriptionPlan,
  {
    name: string;
    prices: Record<BillingInterval, number>;
    limits: PlanLimits;
  }
> = {
  pro: {
    name: 'Pro',
    prices: { monthly: 200_000, quarterly: 525_000, annually: 1_890_000 },
    limits: { course: 5, media: 5 },
  },
  premium: {
    name: 'Premium',
    prices: { monthly: 750_000, quarterly: 2_000_000, annually: 7_200_000 },
    limits: { course: 20, media: 20 },
  },
};

/** Covers a renewal arriving late, and gives a failed card a few days to be updated. */
const GRACE_MS = 3 * 86_400_000;
/** Still billing: these keep the grace period after the paid period ends. */
const RENEWING_STATUSES: SubscriptionStatus[] = ['active', 'attention'];

/** A plan is usable until its paid period ends, even once cancelled; renewing plans get a grace period. */
export function isEntitled(
  sub: Pick<Subscription, 'status' | 'currentPeriodEnd'> | null,
  now = new Date(),
) {
  if (!sub?.currentPeriodEnd) return false;
  const grace = RENEWING_STATUSES.includes(sub.status) ? GRACE_MS : 0;
  return sub.currentPeriodEnd.getTime() + grace > now.getTime();
}

export function entitledSubscription(
  now = new Date(),
): Prisma.SubscriptionWhereInput {
  return {
    OR: [
      {
        status: { in: RENEWING_STATUSES },
        currentPeriodEnd: { gt: new Date(now.getTime() - GRACE_MS) },
      },
      { currentPeriodEnd: { gt: now } },
    ],
  };
}

/** Pro products are only offered to buyers while their seller's plan is paid up. */
export function sellableProduct(now = new Date()): Prisma.ProductWhereInput {
  return {
    OR: [
      { type: { notIn: [...PRO_TYPES] } },
      { seller: { subscription: { is: entitledSubscription(now) } } },
    ],
  };
}
