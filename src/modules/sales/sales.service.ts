import { Injectable, NotFoundException } from '@nestjs/common';
import { toOrder } from '../../common/presenters';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DashboardRange, OrderFiltersDto, RANGE_DAYS } from './sales.dto';

const DAY_MS = 86_400_000;
const LIST_LIMIT = 500;

type CustomerRow = {
  email: string;
  name: string;
  orders_count: number;
  total_spent: bigint;
  first_purchase_at: Date;
  last_purchase_at: Date;
  products: string[];
};

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const change = (current: number, previous: number) =>
  previous === 0 ? (current > 0 ? 1 : 0) : (current - previous) / previous;

@Injectable()
export class SalesService {
  constructor(private readonly prisma: PrismaService) {}

  async stats(sellerId: string, range: DashboardRange) {
    const days = RANGE_DAYS[range];
    const now = new Date();
    const start = new Date(now.getTime() - days * DAY_MS);
    const prevStart = new Date(start.getTime() - days * DAY_MS);
    const paid = (from: Date, to: Date): Prisma.OrderWhereInput => ({
      sellerId,
      status: 'paid',
      paidAt: { gt: from, lte: to },
    });

    const [current, previous, daily, top, visits] = await Promise.all([
      this.prisma.order.aggregate({
        where: paid(start, now),
        _sum: { total: true },
        _count: true,
      }),
      this.prisma.order.aggregate({
        where: paid(prevStart, start),
        _sum: { total: true },
        _count: true,
      }),
      this.prisma.$queryRaw<{ day: string; sales: number; revenue: bigint }[]>`
        SELECT to_char(date_trunc('day', paid_at), 'YYYY-MM-DD') AS day, count(*)::int AS sales, coalesce(sum(total), 0)::bigint AS revenue
        FROM orders WHERE seller_id = ${sellerId} AND status = 'paid' AND paid_at > ${start} AND paid_at <= ${now}
        GROUP BY 1`,
      this.prisma.order.groupBy({
        by: ['productId', 'productTitle'],
        where: paid(start, now),
        _sum: { total: true },
        _count: true,
        orderBy: { _sum: { total: 'desc' } },
        take: 5,
      }),
      this.prisma.visit.findMany({
        where: { sellerId, day: { gte: new Date(dayKey(prevStart)) } },
        select: { day: true, count: true },
      }),
    ]);

    const visitsByDay = new Map(visits.map((v) => [dayKey(v.day), v.count]));
    const dailyByDay = new Map(daily.map((d) => [d.day, d]));
    const visitorsBetween = (from: Date, to: Date) =>
      visits
        .filter((v) => v.day > new Date(dayKey(from)) && v.day <= to)
        .reduce((sum, v) => sum + v.count, 0);

    const revenue = current._sum.total ?? 0;
    const prevRevenue = previous._sum.total ?? 0;
    const visitors = visitorsBetween(start, now);
    const prevVisitors = visitorsBetween(prevStart, start);
    const conversion = visitors ? current._count / visitors : 0;
    const prevConversion = prevVisitors ? previous._count / prevVisitors : 0;

    const series = Array.from({ length: days }, (_, i) => {
      const date = new Date(now.getTime() - (days - 1 - i) * DAY_MS);
      const row = dailyByDay.get(dayKey(date));
      return {
        date: date.toISOString(),
        revenue: Number(row?.revenue ?? 0),
        sales: row?.sales ?? 0,
        visitors: visitsByDay.get(dayKey(date)) ?? 0,
      };
    });

    return {
      range,
      currency: 'NGN',
      revenue,
      revenueChange: change(revenue, prevRevenue),
      sales: current._count,
      salesChange: change(current._count, previous._count),
      visitors,
      visitorsChange: change(visitors, prevVisitors),
      conversion,
      conversionChange: change(conversion, prevConversion),
      series,
      topProducts: top.map((t) => ({
        productId: t.productId,
        title: t.productTitle,
        sales: t._count,
        revenue: t._sum.total ?? 0,
      })),
    };
  }

  async orders(sellerId: string, f: OrderFiltersDto) {
    const contains = f.search
      ? { contains: f.search, mode: 'insensitive' as const }
      : undefined;
    const orders = await this.prisma.order.findMany({
      where: {
        sellerId,
        status: f.status && f.status !== 'all' ? f.status : { not: 'pending' },
        ...(f.productId && f.productId !== 'all'
          ? { productId: f.productId }
          : {}),
        ...(f.range && f.range !== 'all'
          ? {
              createdAt: {
                gte: new Date(Date.now() - RANGE_DAYS[f.range] * DAY_MS),
              },
            }
          : {}),
        ...(contains
          ? {
              OR: [
                { buyerName: contains },
                { buyerEmail: contains },
                { productTitle: contains },
                ...this.numberFilter(f.search!),
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
    });
    return orders.map(toOrder);
  }

  async customers(sellerId: string, search?: string) {
    const rows = await this.customerRows(
      sellerId,
      search
        ? Prisma.sql`AND (buyer_email ILIKE ${`%${search}%`} OR buyer_name ILIKE ${`%${search}%`})`
        : Prisma.empty,
    );
    return rows.map(toCustomer);
  }

  async customer(sellerId: string, email: string) {
    const normalized = email.trim().toLowerCase();
    const [[row], orders] = await Promise.all([
      this.customerRows(sellerId, Prisma.sql`AND buyer_email = ${normalized}`),
      this.prisma.order.findMany({
        where: { sellerId, buyerEmail: normalized, status: { not: 'pending' } },
        orderBy: { createdAt: 'desc' },
        take: LIST_LIMIT,
      }),
    ]);
    if (!orders.length) throw new NotFoundException('Customer not found.');
    // Buyers whose orders all failed/refunded have no paid row; show their history with zero spend.
    const customer = row
      ? toCustomer(row)
      : {
          email: normalized,
          name: orders[0].buyerName,
          ordersCount: 0,
          totalSpent: 0,
          currency: 'NGN',
          firstPurchaseAt: orders[orders.length - 1].createdAt.toISOString(),
          lastPurchaseAt: orders[0].createdAt.toISOString(),
          products: [],
        };
    return { customer, orders: orders.map(toOrder) };
  }

  private customerRows(sellerId: string, filter: Prisma.Sql) {
    return this.prisma.$queryRaw<CustomerRow[]>`
      SELECT buyer_email AS email, max(buyer_name) AS name, count(*)::int AS orders_count, sum(total)::bigint AS total_spent,
             min(created_at) AS first_purchase_at, max(created_at) AS last_purchase_at, array_agg(DISTINCT product_title) AS products
      FROM orders WHERE seller_id = ${sellerId} AND status = 'paid' ${filter}
      GROUP BY buyer_email ORDER BY last_purchase_at DESC LIMIT ${LIST_LIMIT}`;
  }

  private numberFilter(search: string): Prisma.OrderWhereInput[] {
    const match = /^(?:chd-)?(\d{5,})$/i.exec(search.trim());
    return match ? [{ seq: Number(match[1]) - 10000 }] : [];
  }
}

function toCustomer(row: CustomerRow) {
  return {
    email: row.email,
    name: row.name,
    ordersCount: row.orders_count,
    totalSpent: Number(row.total_spent),
    currency: 'NGN',
    firstPurchaseAt: row.first_purchase_at.toISOString(),
    lastPurchaseAt: row.last_purchase_at.toISOString(),
    products: row.products,
  };
}
