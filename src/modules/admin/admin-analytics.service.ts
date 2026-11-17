import { BadRequestException, Injectable } from '@nestjs/common';
import { entitledSubscription } from '../../common/plans';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { inWallet } from '../payouts/payouts.service';
import type { RangeDto } from './admin.dto';

const DAY_MS = 86_400_000;
const MAX_DAYS = 731;

export type Range = { start: Date; end: Date; days: number };

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: bigint | number | null | undefined) => Number(v ?? 0);
const change = (current: number, previous: number) =>
  previous === 0 ? (current > 0 ? 1 : 0) : (current - previous) / previous;

/** UTC days, `to` inclusive; the last 30 days when not given. */
export function toRange(dto: { from?: string; to?: string }): Range {
  const today = Date.parse(dayKey(new Date()));
  const end = (dto.to ? Date.parse(dto.to) : today) + DAY_MS;
  const start = dto.from ? Date.parse(dto.from) : end - 30 * DAY_MS;
  if (Number.isNaN(start) || Number.isNaN(end) || start >= end)
    throw new BadRequestException('Choose a start date before the end date.');
  const days = Math.round((end - start) / DAY_MS);
  if (days > MAX_DAYS)
    throw new BadRequestException('Choose a range of two years or less.');
  return { start: new Date(start), end: new Date(end), days };
}

const EMPTY_DAY = {
  sales: 0,
  gmv: 0,
  saleFees: 0,
  subscriptionRevenue: 0,
  bachsFees: 0,
  paystackFees: 0,
  withdrawalFees: 0,
  signups: 0,
  newSellers: 0,
  visits: 0,
};
type Day = typeof EMPTY_DAY;

@Injectable()
export class AdminAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Dashboard: headline numbers against the previous period of the same length, and a daily chart. */
  async overview(dto: RangeDto) {
    const range = toRange(dto);
    const previous: Range = {
      start: new Date(range.start.getTime() - range.days * DAY_MS),
      end: range.start,
      days: range.days,
    };
    const [
      now,
      before,
      series,
      pendingWithdrawals,
      activeSubscriptions,
      recentOrders,
      recentWithdrawals,
    ] = await Promise.all([
      this.totals(range),
      this.totals(previous),
      this.daily(range),
      this.prisma.payout.aggregate({
        where: { status: 'processing' },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.subscription.count({ where: entitledSubscription() }),
      this.prisma.order.findMany({
        where: { status: 'paid' },
        orderBy: { paidAt: 'desc' },
        take: 6,
        select: {
          id: true,
          seq: true,
          productTitle: true,
          buyerName: true,
          total: true,
          paidAt: true,
          seller: { select: { displayName: true } },
        },
      }),
      this.prisma.payout.findMany({
        where: { status: 'processing' },
        orderBy: { requestedAt: 'asc' },
        take: 6,
        select: {
          id: true,
          amount: true,
          fee: true,
          requestedAt: true,
          seller: { select: { displayName: true } },
        },
      }),
    ]);
    const kpi = (key: keyof typeof now) => ({
      value: now[key],
      change: change(now[key], before[key]),
    });
    return {
      range: {
        from: dayKey(range.start),
        to: dayKey(new Date(range.end.getTime() - DAY_MS)),
      },
      gmv: kpi('gmv'),
      profit: kpi('profit'),
      sales: kpi('sales'),
      newUsers: kpi('newUsers'),
      newSellers: kpi('newSellers'),
      subscriptionRevenue: kpi('subscriptionRevenue'),
      pendingWithdrawals: {
        count: pendingWithdrawals._count,
        amount: num(pendingWithdrawals._sum.amount),
      },
      activeSubscriptions,
      series: series.map(({ date, gmv, profit, sales, signups }) => ({
        date,
        gmv,
        profit,
        sales,
        signups,
      })),
      recentOrders: recentOrders.map((o) => ({
        id: o.id,
        number: `CHD-${10000 + o.seq}`,
        productTitle: o.productTitle,
        buyerName: o.buyerName,
        sellerName: o.seller.displayName,
        total: o.total,
        paidAt: o.paidAt?.toISOString() ?? null,
      })),
      recentWithdrawals: recentWithdrawals.map((p) => ({
        id: p.id,
        sellerName: p.seller.displayName,
        amount: p.amount,
        netAmount: p.amount - p.fee,
        requestedAt: p.requestedAt.toISOString(),
      })),
    };
  }

  /**
   * Cheda's money: what buyers paid, what Cheda kept (sale fees, plans and withdrawal fees),
   * what it owes creators, and what it has paid them.
   */
  async finance(dto: RangeDto) {
    const range = toRange(dto);
    const [totals, series, wallets, processing, paidOut, byPlan, byMethod] =
      await Promise.all([
        this.totals(range),
        this.daily(range),
        this.prisma.order.aggregate({ where: inWallet, _sum: { net: true } }),
        this.prisma.payout.aggregate({
          where: { status: 'processing' },
          _sum: { amount: true },
          _count: true,
        }),
        this.prisma.payout.aggregate({
          where: {
            status: 'paid',
            settledAt: { gte: range.start, lt: range.end },
          },
          _sum: { amount: true, fee: true },
          _count: true,
        }),
        this.prisma.subscriptionPayment.groupBy({
          by: ['plan', 'interval'],
          where: { paidAt: { gte: range.start, lt: range.end } },
          _sum: { amount: true },
          _count: true,
        }),
        this.prisma.order.groupBy({
          by: ['paymentMethod'],
          where: this.paidIn(range),
          _sum: { total: true },
          _count: true,
        }),
      ]);
    return {
      range: {
        from: dayKey(range.start),
        to: dayKey(new Date(range.end.getTime() - DAY_MS)),
      },
      gmv: totals.gmv,
      sales: totals.sales,
      saleFees: totals.saleFees,
      subscriptionRevenue: totals.subscriptionRevenue,
      subscriptionPayments: totals.subscriptionPayments,
      withdrawalFees: totals.withdrawalFees,
      /** Bachs's charges for collecting sales */
      bachsFees: totals.bachsFees,
      /** Paystack's charges for plan payments */
      paystackFees: totals.paystackFees,
      /** Sale fees + plans + withdrawal fees, less Bachs and Paystack fees */
      profit: totals.profit,
      creatorEarnings: totals.gmv - totals.saleFees,
      paidOut: {
        count: paidOut._count,
        amount: num(paidOut._sum.amount) - num(paidOut._sum.fee),
      },
      /** Owed to creators right now: wallet balances plus requested withdrawals */
      liabilities: {
        wallets: num(wallets._sum.net),
        processing: num(processing._sum.amount),
        processingCount: processing._count,
      },
      series: series.map(
        ({
          date,
          gmv,
          saleFees,
          subscriptionRevenue,
          withdrawalFees,
          bachsFees,
          paystackFees,
          profit,
        }) => ({
          date,
          gmv,
          saleFees,
          subscriptionRevenue,
          withdrawalFees,
          providerFees: bachsFees + paystackFees,
          profit,
        }),
      ),
      subscriptionsByPlan: byPlan.map((p) => ({
        plan: p.plan,
        interval: p.interval,
        payments: p._count,
        amount: num(p._sum.amount),
      })),
      salesByMethod: byMethod.map((m) => ({
        method: m.paymentMethod,
        sales: m._count,
        amount: num(m._sum.total),
      })),
    };
  }

  /** Everything happening on Cheda in the range, broken down. */
  async analytics(dto: RangeDto) {
    const range = toRange(dto);
    const paid = this.paidIn(range);
    const [
      totals,
      series,
      visits,
      statuses,
      byType,
      byCategory,
      topProducts,
      topSellers,
      buyers,
      plans,
      productsByType,
      sellersLive,
    ] = await Promise.all([
      this.totals(range),
      this.daily(range),
      this.prisma.visit.aggregate({
        where: { day: { gte: range.start, lt: range.end } },
        _sum: { count: true },
      }),
      this.prisma.order.groupBy({
        by: ['status'],
        where: { createdAt: { gte: range.start, lt: range.end } },
        _count: true,
      }),
      this.prisma.$queryRaw<{ type: string; sales: number; gmv: bigint }[]>`
          SELECT p.type::text AS type, count(*)::int AS sales, coalesce(sum(o.total), 0)::bigint AS gmv
          FROM orders o JOIN products p ON p.id = o.product_id
          WHERE o.status = 'paid' AND o.paid_at >= ${range.start} AND o.paid_at < ${range.end}
          GROUP BY 1 ORDER BY gmv DESC`,
      this.prisma.$queryRaw<{ category: string; sales: number; gmv: bigint }[]>`
          SELECT p.category::text AS category, count(*)::int AS sales, coalesce(sum(o.total), 0)::bigint AS gmv
          FROM orders o JOIN products p ON p.id = o.product_id
          WHERE o.status = 'paid' AND o.paid_at >= ${range.start} AND o.paid_at < ${range.end}
          GROUP BY 1 ORDER BY gmv DESC`,
      this.prisma.order.groupBy({
        by: ['productId'],
        where: paid,
        _sum: { total: true },
        _count: true,
        orderBy: { _sum: { total: 'desc' } },
        take: 10,
      }),
      this.prisma.order.groupBy({
        by: ['sellerId'],
        where: paid,
        _sum: { total: true, net: true },
        _count: true,
        orderBy: { _sum: { total: 'desc' } },
        take: 10,
      }),
      this.prisma.$queryRaw<{ buyers: number; repeat: number }[]>`
          SELECT count(*)::int AS buyers, count(*) FILTER (WHERE n > 1)::int AS repeat
          FROM (SELECT buyer_email, count(*) AS n FROM orders
                WHERE status = 'paid' AND paid_at >= ${range.start} AND paid_at < ${range.end}
                GROUP BY buyer_email) b`,
      this.prisma.subscription.groupBy({
        by: ['plan', 'interval'],
        where: entitledSubscription(),
        _count: true,
      }),
      this.prisma.product.groupBy({
        by: ['type', 'status'],
        _count: true,
      }),
      this.prisma.seller.count({ where: { accountName: { not: null } } }),
    ]);
    // Titles change over time; show each product's current one
    const productTitles = new Map(
      (
        await this.prisma.product.findMany({
          where: { id: { in: topProducts.map((p) => p.productId) } },
          select: { id: true, title: true },
        })
      ).map((p) => [p.id, p.title]),
    );
    const sellerNames = new Map(
      (
        await this.prisma.seller.findMany({
          where: { id: { in: topSellers.map((s) => s.sellerId) } },
          select: { id: true, displayName: true, username: true },
        })
      ).map((s) => [s.id, s]),
    );
    const visitTotal = num(visits._sum.count);
    return {
      range: {
        from: dayKey(range.start),
        to: dayKey(new Date(range.end.getTime() - DAY_MS)),
      },
      totals: {
        ...totals,
        visits: visitTotal,
        conversion: visitTotal ? totals.sales / visitTotal : 0,
        averageOrder: totals.sales ? Math.round(totals.gmv / totals.sales) : 0,
        buyers: buyers[0]?.buyers ?? 0,
        repeatBuyers: buyers[0]?.repeat ?? 0,
        liveStores: sellersLive,
      },
      series,
      ordersByStatus: statuses.map((s) => ({
        status: s.status,
        count: s._count,
      })),
      salesByType: byType.map((t) => ({
        type: t.type,
        sales: t.sales,
        gmv: num(t.gmv),
      })),
      salesByCategory: byCategory.map((c) => ({
        category: c.category,
        sales: c.sales,
        gmv: num(c.gmv),
      })),
      topProducts: topProducts.map((p) => ({
        productId: p.productId,
        title: productTitles.get(p.productId) ?? 'Deleted product',
        sales: p._count,
        gmv: num(p._sum.total),
      })),
      topSellers: topSellers.map((s) => ({
        sellerId: s.sellerId,
        name: sellerNames.get(s.sellerId)?.displayName ?? 'Deleted store',
        username: sellerNames.get(s.sellerId)?.username ?? null,
        sales: s._count,
        gmv: num(s._sum.total),
        earnings: num(s._sum.net),
      })),
      activePlans: plans.map((p) => ({
        plan: p.plan,
        interval: p.interval,
        count: p._count,
      })),
      catalog: productsByType.map((p) => ({
        type: p.type,
        status: p.status,
        count: p._count,
      })),
    };
  }

  private paidIn(range: Range): Prisma.OrderWhereInput {
    return { status: 'paid', paidAt: { gte: range.start, lt: range.end } };
  }

  private async totals(range: Range) {
    const [orders, subs, withdrawals, newUsers, newSellers] = await Promise.all(
      [
        this.prisma.order.aggregate({
          where: this.paidIn(range),
          _sum: { total: true, fee: true, providerFee: true },
          _count: true,
        }),
        this.prisma.subscriptionPayment.aggregate({
          where: { paidAt: { gte: range.start, lt: range.end } },
          _sum: { amount: true, providerFee: true },
          _count: true,
        }),
        this.prisma.payout.aggregate({
          where: {
            status: 'paid',
            settledAt: { gte: range.start, lt: range.end },
          },
          _sum: { fee: true },
        }),
        this.prisma.user.count({
          where: { createdAt: { gte: range.start, lt: range.end } },
        }),
        this.prisma.seller.count({
          where: { joinedAt: { gte: range.start, lt: range.end } },
        }),
      ],
    );
    const saleFees = num(orders._sum.fee);
    const subscriptionRevenue = num(subs._sum.amount);
    const withdrawalFees = num(withdrawals._sum.fee);
    const bachsFees = num(orders._sum.providerFee);
    const paystackFees = num(subs._sum.providerFee);
    return {
      gmv: num(orders._sum.total),
      sales: orders._count,
      saleFees,
      subscriptionRevenue,
      subscriptionPayments: subs._count,
      withdrawalFees,
      bachsFees,
      paystackFees,
      profit:
        saleFees +
        subscriptionRevenue +
        withdrawalFees -
        bachsFees -
        paystackFees,
      newUsers,
      newSellers,
    };
  }

  private async daily(range: Range) {
    const { start, end } = range;
    const [orders, subs, withdrawals, users, sellers, visits] =
      await Promise.all([
        this.prisma.$queryRaw<
          {
            day: string;
            sales: number;
            gmv: bigint;
            fees: bigint;
            provider: bigint;
          }[]
        >`
        SELECT to_char(date_trunc('day', paid_at), 'YYYY-MM-DD') AS day, count(*)::int AS sales,
               coalesce(sum(total), 0)::bigint AS gmv, coalesce(sum(fee), 0)::bigint AS fees,
               coalesce(sum(provider_fee), 0)::bigint AS provider
        FROM orders WHERE status = 'paid' AND paid_at >= ${start} AND paid_at < ${end} GROUP BY 1`,
        this.prisma.$queryRaw<
          { day: string; amount: bigint; provider: bigint }[]
        >`
        SELECT to_char(date_trunc('day', paid_at), 'YYYY-MM-DD') AS day, coalesce(sum(amount), 0)::bigint AS amount,
               coalesce(sum(provider_fee), 0)::bigint AS provider
        FROM subscription_payments WHERE paid_at >= ${start} AND paid_at < ${end} GROUP BY 1`,
        this.prisma.$queryRaw<{ day: string; fees: bigint }[]>`
        SELECT to_char(date_trunc('day', settled_at), 'YYYY-MM-DD') AS day, coalesce(sum(fee), 0)::bigint AS fees
        FROM payouts WHERE status = 'paid' AND settled_at >= ${start} AND settled_at < ${end} GROUP BY 1`,
        this.prisma.$queryRaw<{ day: string; n: number }[]>`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS n
        FROM users WHERE created_at >= ${start} AND created_at < ${end} GROUP BY 1`,
        this.prisma.$queryRaw<{ day: string; n: number }[]>`
        SELECT to_char(date_trunc('day', joined_at), 'YYYY-MM-DD') AS day, count(*)::int AS n
        FROM sellers WHERE joined_at >= ${start} AND joined_at < ${end} GROUP BY 1`,
        this.prisma.$queryRaw<{ day: string; n: number }[]>`
        SELECT to_char(day, 'YYYY-MM-DD') AS day, coalesce(sum(count), 0)::int AS n
        FROM visits WHERE day >= ${start} AND day < ${end} GROUP BY 1`,
      ]);
    const rows = new Map<string, Day>();
    const add = (day: string, values: Partial<Day>) =>
      rows.set(day, { ...(rows.get(day) ?? EMPTY_DAY), ...values });
    for (const r of orders)
      add(r.day, {
        sales: r.sales,
        gmv: num(r.gmv),
        saleFees: num(r.fees),
        bachsFees: num(r.provider),
      });
    for (const r of subs)
      add(r.day, {
        subscriptionRevenue: num(r.amount),
        paystackFees: num(r.provider),
      });
    for (const r of withdrawals) add(r.day, { withdrawalFees: num(r.fees) });
    for (const r of users) add(r.day, { signups: r.n });
    for (const r of sellers) add(r.day, { newSellers: r.n });
    for (const r of visits) add(r.day, { visits: r.n });
    // Every day in the range, so charts have no gaps
    return Array.from({ length: range.days }, (_, i) => {
      const date = dayKey(new Date(start.getTime() + i * DAY_MS));
      const d = rows.get(date) ?? EMPTY_DAY;
      return {
        date,
        ...d,
        profit:
          d.saleFees +
          d.subscriptionRevenue +
          d.withdrawalFees -
          d.bachsFees -
          d.paystackFees,
      };
    });
  }
}
