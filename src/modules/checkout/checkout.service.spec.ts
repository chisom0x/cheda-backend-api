import { ServiceUnavailableException } from '@nestjs/common';
import type { BachsEvent } from '../../integrations/bachs.service';
import { CheckoutService } from './checkout.service';

type Order = Record<string, unknown> & { id: string; status: string };

function setup(checkout: Record<string, unknown>) {
  const order: Order = {
    id: 'ord_1',
    status: 'pending',
    paymentReference: 'CHD_1',
    providerReference: 'chk_1',
    total: 150000,
    currency: 'NGN',
    productId: 'p1',
    couponId: null,
    seq: 1,
    net: 139000,
    buyerEmail: 'b@example.com',
    buyerName: 'Buyer',
    productTitle: 'Guide',
    createdAt: new Date(),
  };
  const events: string[] = [];
  const updateMany = jest.fn(
    ({
      where,
      data,
    }: {
      where: { status: { in?: string[] } | string };
      data: Partial<Order>;
    }) => {
      const allowed =
        typeof where.status === 'string' ? [where.status] : where.status.in!;
      if (!allowed.includes(order.status)) return { count: 0 };
      Object.assign(order, data);
      return { count: 1 };
    },
  );
  const orderApi = {
    findFirst: jest.fn(() => ({ ...order })),
    findUniqueOrThrow: jest.fn(() => ({ ...order })),
    updateMany,
  };
  const tx = {
    order: orderApi,
    product: { update: jest.fn() },
    coupon: { update: jest.fn() },
    webhookEvent: {
      create: jest.fn(({ data }: { data: { id: string } }) => {
        if (events.includes(data.id)) throw new Error('duplicate');
        events.push(data.id);
      }),
    },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    accessLink: { create: jest.fn() },
    seller: {
      findUniqueOrThrow: jest.fn(() => ({
        displayName: 'S',
        notifications: { newSale: false },
        user: { email: 's@x', name: 'S' },
      })),
    },
  };
  const bachs = { getCheckout: jest.fn(() => Promise.resolve(checkout)) };
  const mail = { send: jest.fn() };
  const config = { get: () => 'https://cheda.test' };
  const service = new CheckoutService(
    prisma as never,
    bachs as never,
    mail as never,
    config as never,
  );
  return { service, order, bachs, events };
}

const event = (type: string, id = 'evt_1'): BachsEvent => ({
  id,
  type,
  created_at: '2026-11-16T00:00:00Z',
  organization_id: 'acct_1',
  data: { reference: 'CHD_1', checkout_id: 'chk_1' },
});

const completed = {
  checkout_id: 'chk_1',
  status: 'completed',
  amount: '1500.00',
  currency: 'NGN',
  reference: 'CHD_1',
};

describe('CheckoutService.handleEvent', () => {
  it('pays the order once from a completed checkout and records the event', async () => {
    const { service, order, events } = setup(completed);
    await service.handleEvent(event('checkout.completed'));
    expect(order.status).toBe('paid');
    expect(events).toEqual(['evt_1']);
  });

  it('ignores a redelivery or the second fulfilment event once paid', async () => {
    const { service, bachs } = setup(completed);
    await service.handleEvent(event('checkout.completed', 'evt_1'));
    await service.handleEvent(event('checkout.completed', 'evt_1'));
    await service.handleEvent(event('collection.succeeded', 'evt_2'));
    expect(bachs.getCheckout).toHaveBeenCalledTimes(1);
  });

  it('asks Bachs to retry when the checkout is not completed yet', async () => {
    const { service, order } = setup({ ...completed, status: 'open' });
    await expect(
      service.handleEvent(event('collection.succeeded')),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(order.status).toBe('pending');
  });

  it('never delivers when the amount or currency does not match', async () => {
    const short = setup({ ...completed, amount: '1499.99' });
    await short.service
      .handleEvent(event('checkout.completed'))
      .catch(() => undefined);
    expect(short.order.status).toBe('pending');
    const usd = setup({ ...completed, currency: 'USD' });
    await usd.service
      .handleEvent(event('checkout.completed'))
      .catch(() => undefined);
    expect(usd.order.status).toBe('pending');
  });

  it('marks an expired checkout failed, and a late payment still pays it', async () => {
    const s = setup({ ...completed, status: 'expired' });
    await s.service.handleEvent(event('checkout.expired'));
    expect(s.order.status).toBe('failed');
    s.bachs.getCheckout.mockResolvedValueOnce(completed);
    await s.service.handleEvent(event('checkout.completed', 'evt_late'));
    expect(s.order.status).toBe('paid');
  });

  it('lets a provider failure surface so the event is retried', async () => {
    const s = setup(completed);
    s.bachs.getCheckout.mockRejectedValueOnce(new Error('timeout'));
    await expect(
      s.service.handleEvent(event('checkout.completed')),
    ).rejects.toThrow('timeout');
    expect(s.order.status).toBe('pending');
  });
});
