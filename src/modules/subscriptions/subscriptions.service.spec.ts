import { SubscriptionsService } from './subscriptions.service';

const PLAN_KEYS: Record<string, { plan: string; interval: string }> = {
  PLN_pro_m: { plan: 'pro', interval: 'monthly' },
  PLN_prem_m: { plan: 'premium', interval: 'monthly' },
};

const sub = (
  code: string,
  plan: string,
  status: string,
  createdAt: string,
  next: string | null,
) => ({
  id: 1,
  subscription_code: code,
  email_token: `tok_${code}`,
  status,
  createdAt,
  next_payment_date: next,
  plan: { plan_code: plan },
});

function setup(
  subs: ReturnType<typeof sub>[],
  existing: Record<string, unknown> | null = null,
) {
  const saved: Record<string, unknown>[] = [];
  const payments: Record<string, unknown>[] = [];
  const prisma = {
    seller: {
      findUnique: jest.fn(
        ({ where }: { where: { id?: string; paystackCustomerId?: string } }) =>
          where.id === 'seller_1' || where.paystackCustomerId === '42'
            ? { id: 'seller_1' }
            : null,
      ),
      updateMany: jest.fn(),
    },
    user: { findUnique: jest.fn(() => null) },
    subscription: {
      findUnique: jest.fn(() => existing),
      upsert: jest.fn(({ update }: { update: Record<string, unknown> }) =>
        saved.push(update),
      ),
    },
    subscriptionPayment: {
      createMany: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        if (!payments.some((p) => p.reference === data.reference))
          payments.push(data);
      }),
      findFirst: jest.fn(() => null),
    },
  };
  const paystack = {
    customerSubscriptions: jest.fn(() => Promise.resolve(subs)),
    planFor: jest.fn((code: string) =>
      Promise.resolve(PLAN_KEYS[code] ?? null),
    ),
    disableSubscription: jest.fn(() => Promise.resolve()),
  };
  const service = new SubscriptionsService(
    prisma as never,
    paystack as never,
    { get: () => '' } as never,
  );
  return { service, saved, payments, paystack };
}

const charge = (reference: string, metadata: unknown = {}) => ({
  event: 'charge.success',
  data: {
    reference,
    status: 'success',
    amount: 750000,
    currency: 'NGN',
    paid_at: '2026-11-16T10:00:00Z',
    plan: { plan_code: 'PLN_prem_m' },
    customer: { id: 42, email: 'seller@example.com' },
    metadata,
  },
});

describe('SubscriptionsService', () => {
  it('switching plans keeps the newest subscription and cancels the old one', async () => {
    const { service, saved, paystack } = setup([
      sub(
        'SUB_new',
        'PLN_prem_m',
        'active',
        '2026-11-16T10:00:00Z',
        '2026-12-16T10:00:00Z',
      ),
      sub(
        'SUB_old',
        'PLN_pro_m',
        'active',
        '2026-10-01T10:00:00Z',
        '2026-12-01T10:00:00Z',
      ),
    ]);
    await service.handleEvent(charge('ref_1', { sellerId: 'seller_1' }));
    expect(paystack.disableSubscription).toHaveBeenCalledWith(
      'SUB_old',
      'tok_SUB_old',
    );
    expect(saved.at(-1)).toMatchObject({
      plan: 'premium',
      status: 'active',
      paystackCode: 'SUB_new',
    });
  });

  it('records each plan charge once, however often Paystack sends it', async () => {
    const { service, payments } = setup([
      sub(
        'SUB_new',
        'PLN_prem_m',
        'active',
        '2026-11-16T10:00:00Z',
        '2026-12-16T10:00:00Z',
      ),
    ]);
    await service.handleEvent(charge('ref_1'));
    await service.handleEvent(charge('ref_1'));
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      sellerId: 'seller_1',
      plan: 'premium',
      amount: 750000,
    });
  });

  it('a cancelled plan keeps the paid period it already had', async () => {
    const end = new Date('2026-12-16T10:00:00Z');
    const { service, saved, paystack } = setup(
      [
        sub(
          'SUB_new',
          'PLN_prem_m',
          'non-renewing',
          '2026-11-16T10:00:00Z',
          null,
        ),
      ],
      { paystackCode: 'SUB_new', currentPeriodEnd: end },
    );
    await service.handleEvent({
      event: 'subscription.not_renew',
      data: { customer: { id: 42 } },
    });
    expect(paystack.disableSubscription).not.toHaveBeenCalled();
    expect(saved.at(-1)).toMatchObject({
      status: 'non_renewing',
      currentPeriodEnd: end,
    });
  });

  it('ignores events for customers that are not Cheda sellers', async () => {
    const { service, paystack } = setup([]);
    await service.handleEvent({
      event: 'subscription.create',
      data: { customer: { id: 7, email: 'x@y.z' } },
    });
    expect(paystack.customerSubscriptions).not.toHaveBeenCalled();
  });
});
